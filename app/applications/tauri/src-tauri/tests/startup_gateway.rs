/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use ride_tauri::startup_gateway::{
    BackendGeneration, BackendPhase, GatewayError, GatewayLimits, GatewayState, RouteKind,
    RouteTable,
};
use ride_tauri::startup_metrics::StartupMode;
use std::net::SocketAddr;
use std::time::Duration;

#[test]
fn startup_mode_defaults_to_rust_gateway_and_accepts_explicit_legacy() {
    assert_eq!(StartupMode::from_env_value(None), StartupMode::RustGateway);
    assert_eq!(
        StartupMode::from_env_value(Some("legacy")),
        StartupMode::LegacyExplicit
    );
}

#[tokio::test]
async fn same_backend_generation_transitions_from_starting_to_ready() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let generation = state.begin_backend_start().await.unwrap();

    let starting = state.snapshot().await;
    assert_eq!(starting.generation, generation);
    assert_eq!(starting.phase, BackendPhase::Starting);

    let backend_addr: SocketAddr = "127.0.0.1:3000".parse().unwrap();
    let waiter = tokio::spawn({
        let state = state.clone();
        async move { state.wait_for_backend().await }
    });
    tokio::task::yield_now().await;

    state.backend_ready(generation, backend_addr).await.unwrap();

    assert_eq!(waiter.await.unwrap(), Ok(backend_addr));
    let ready = state.snapshot().await;
    assert_eq!(ready.generation, generation);
    assert_eq!(ready.phase, BackendPhase::Ready);
    assert_eq!(ready.diagnostic, None);
}

#[tokio::test]
async fn stale_backend_generation_cannot_replace_or_fail_the_active_backend() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let first = state.begin_backend_start().await.unwrap();
    state.fail_backend(first, "first failed").await.unwrap();
    let second = state.begin_backend_start().await.unwrap();

    assert_eq!(
        state
            .backend_ready(first, "127.0.0.1:3000".parse().unwrap())
            .await,
        Err(GatewayError::StaleGeneration(first)),
    );
    assert_eq!(
        state.fail_backend(first, "stale failure").await,
        Err(GatewayError::StaleGeneration(first)),
    );

    state
        .backend_ready(second, "127.0.0.1:3001".parse().unwrap())
        .await
        .unwrap();
    assert_eq!(state.snapshot().await.phase, BackendPhase::Ready);
}

#[tokio::test]
async fn only_one_retry_owns_the_next_generation() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let first = state.begin_backend_start().await.unwrap();
    state
        .fail_backend(first, "retryable failure")
        .await
        .unwrap();

    let left = tokio::spawn({
        let state = state.clone();
        async move { state.begin_backend_start().await }
    });
    let right = tokio::spawn({
        let state = state.clone();
        async move { state.begin_backend_start().await }
    });

    let results: [Result<BackendGeneration, GatewayError>; 2] =
        [left.await.unwrap(), right.await.unwrap()];
    let owner = results
        .iter()
        .filter_map(|result| result.as_ref().ok().copied())
        .collect::<Vec<_>>();
    assert_eq!(owner.len(), 1);
    assert_eq!(state.snapshot().await.generation, owner[0]);
    assert_eq!(state.snapshot().await.phase, BackendPhase::Starting);
    assert!(results.iter().any(|result| {
        matches!(
            result,
            Err(GatewayError::BackendStartInProgress(generation)) if *generation == owner[0]
        )
    }));
}

#[tokio::test]
async fn shutdown_releases_backend_readiness_waiters() {
    let state = GatewayState::new(GatewayLimits {
        backend_wait: Duration::from_secs(30),
        ..GatewayLimits::test_defaults()
    });
    state.begin_backend_start().await.unwrap();

    let waiter = tokio::spawn({
        let state = state.clone();
        async move { state.wait_for_backend().await }
    });
    tokio::task::yield_now().await;
    state.shutdown().await;

    let result = tokio::time::timeout(Duration::from_millis(250), waiter)
        .await
        .expect("shutdown must wake the readiness waiter")
        .unwrap();
    assert_eq!(result, Err(GatewayError::ShuttingDown));
    assert_eq!(state.snapshot().await.phase, BackendPhase::Stopping);
}

#[tokio::test]
async fn browser_diagnostics_are_bounded_and_do_not_echo_sensitive_input() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let generation = state.begin_backend_start().await.unwrap();
    let sensitive = concat!(
        "node C:\\Users\\person\\R-IDE\\backend.js --capability=secret ",
        "Cookie: ride_session=session-secret RIDE_TOKEN=environment-secret ",
        "/home/person/private/config.json"
    );

    state.fail_backend(generation, sensitive).await.unwrap();

    let diagnostic = state.snapshot().await.diagnostic.unwrap();
    assert!(diagnostic.len() <= 160);
    for secret in [
        "node",
        "C:\\Users",
        "--capability",
        "Cookie",
        "session-secret",
        "RIDE_TOKEN",
        "environment-secret",
        "/home/",
    ] {
        assert!(!diagnostic.contains(secret), "leaked {secret:?}");
    }
}

#[test]
fn routes_are_classified_from_the_inventory_not_the_filesystem() {
    let routes = RouteTable::new(["/", "/bundle.js", "/bundle.css"]);

    assert_eq!(
        routes.classify("/_ride/bootstrap/one-time-value"),
        RouteKind::Bootstrap
    );
    assert_eq!(routes.classify("/_ride/startup/status"), RouteKind::Control);
    assert_eq!(routes.classify("/bundle.js"), RouteKind::Static);
    assert_eq!(routes.classify("/bundle.js/"), RouteKind::Backend);
    assert_eq!(routes.classify("/services/filesystem"), RouteKind::Backend);
    assert_eq!(routes.classify("/socket.io/"), RouteKind::Backend);
}
