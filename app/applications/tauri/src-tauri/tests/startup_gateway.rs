/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use futures_util::poll;
use ride_tauri::startup_gateway::{
    BackendAddressError, BackendGeneration, BackendPhase, GatewayError, GatewayLimits,
    GatewayState, PathError, RouteKind, RouteTable,
};
use ride_tauri::startup_metrics::StartupMode;
use std::net::SocketAddr;
use std::task::Poll;
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
    let waiter = state.wait_for_backend();
    tokio::pin!(waiter);
    assert!(matches!(poll!(&mut waiter), Poll::Pending));

    state.backend_ready(generation, backend_addr).await.unwrap();

    assert_eq!(waiter.await, Ok(backend_addr));
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
async fn backend_ready_accepts_ipv4_and_ipv6_loopback_addresses() {
    for backend_addr in ["127.0.0.1:3000", "[::1]:3001"] {
        let state = GatewayState::new(GatewayLimits::test_defaults());
        let generation = state.begin_backend_start().await.unwrap();
        let backend_addr = backend_addr.parse().unwrap();

        state.backend_ready(generation, backend_addr).await.unwrap();

        assert_eq!(state.wait_for_backend().await, Ok(backend_addr));
    }
}

#[tokio::test]
async fn backend_ready_rejects_remote_and_zero_port_addresses_before_publication() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let generation = state.begin_backend_start().await.unwrap();

    for remote in ["192.0.2.10:3000", "[2001:db8::10]:3000"] {
        assert_eq!(
            state
                .backend_ready(generation, remote.parse().unwrap())
                .await,
            Err(GatewayError::InvalidBackendAddress(
                BackendAddressError::NonLoopback
            ))
        );
        assert_eq!(state.snapshot().await.phase, BackendPhase::Starting);
    }
    assert_eq!(
        state
            .backend_ready(generation, "127.0.0.1:0".parse().unwrap())
            .await,
        Err(GatewayError::InvalidBackendAddress(
            BackendAddressError::ZeroPort
        ))
    );
    assert_eq!(state.snapshot().await.phase, BackendPhase::Starting);
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
async fn backend_waiter_cannot_cross_into_a_retry_generation() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let first = state.begin_backend_start().await.unwrap();
    let waiter = state.wait_for_backend();
    tokio::pin!(waiter);
    assert!(matches!(poll!(&mut waiter), Poll::Pending));

    state.fail_backend(first, "first failed").await.unwrap();
    let second = state.begin_backend_start().await.unwrap();
    let second_addr = "127.0.0.1:3001".parse().unwrap();
    state.backend_ready(second, second_addr).await.unwrap();

    assert_eq!(
        waiter.await,
        Err(GatewayError::BackendGenerationSuperseded {
            expected: first,
            observed: second,
        })
    );
}

#[tokio::test]
async fn backend_waiter_limit_rejects_excess_waiters_without_waiting() {
    let state = GatewayState::new(GatewayLimits {
        backend_wait: Duration::from_secs(30),
        max_waiters: 1,
        ..GatewayLimits::test_defaults()
    });
    state.begin_backend_start().await.unwrap();
    let first = state.wait_for_backend();
    tokio::pin!(first);
    assert!(matches!(poll!(&mut first), Poll::Pending));

    assert_eq!(
        state.wait_for_backend().await,
        Err(GatewayError::TooManyBackendWaiters)
    );

    state.shutdown().await;
    assert_eq!(first.await, Err(GatewayError::ShuttingDown));
}

#[tokio::test]
async fn cancelling_a_backend_waiter_releases_its_permit() {
    let state = GatewayState::new(GatewayLimits {
        backend_wait: Duration::from_secs(30),
        max_waiters: 1,
        ..GatewayLimits::test_defaults()
    });
    state.begin_backend_start().await.unwrap();
    let mut cancelled = Box::pin(state.wait_for_backend());
    assert!(matches!(poll!(&mut cancelled), Poll::Pending));
    drop(cancelled);

    let replacement = state.wait_for_backend();
    tokio::pin!(replacement);
    assert!(matches!(poll!(&mut replacement), Poll::Pending));
    state.shutdown().await;
    assert_eq!(replacement.await, Err(GatewayError::ShuttingDown));
}

#[tokio::test]
async fn backend_waiter_timeout_is_typed_and_generation_bound() {
    let state = GatewayState::new(GatewayLimits {
        backend_wait: Duration::from_millis(10),
        ..GatewayLimits::test_defaults()
    });
    let generation = state.begin_backend_start().await.unwrap();

    assert_eq!(
        state.wait_for_backend().await,
        Err(GatewayError::BackendWaitTimedOut(generation))
    );
}

#[tokio::test]
async fn shutdown_releases_backend_readiness_waiters() {
    let state = GatewayState::new(GatewayLimits {
        backend_wait: Duration::from_secs(30),
        ..GatewayLimits::test_defaults()
    });
    state.begin_backend_start().await.unwrap();

    let waiter = state.wait_for_backend();
    tokio::pin!(waiter);
    assert!(matches!(poll!(&mut waiter), Poll::Pending));
    state.shutdown().await;

    let result = tokio::time::timeout(Duration::from_millis(250), waiter)
        .await
        .expect("shutdown must wake the readiness waiter");
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
    let routes = RouteTable::new(["/", "/bundle.js", "/bundle.css"]).unwrap();

    assert_eq!(
        routes.classify("/_ride/bootstrap/one-time-value"),
        Ok(RouteKind::Bootstrap)
    );
    assert_eq!(
        routes.classify("/_ride/startup/status"),
        Ok(RouteKind::Control)
    );
    assert_eq!(routes.classify("/bundle.js"), Ok(RouteKind::Static));
    assert_eq!(routes.classify("/bundle.js/"), Ok(RouteKind::Backend));
    assert_eq!(
        routes.classify("/services/filesystem"),
        Ok(RouteKind::Backend)
    );
    assert_eq!(routes.classify("/socket.io/"), Ok(RouteKind::Backend));
}

#[test]
fn route_classification_decodes_each_inventory_and_request_path_once() {
    let routes = RouteTable::new(["/", "/bundle%2Ejs", "/bundle.css"]).unwrap();

    assert_eq!(
        routes.classify("/%5Fride/bootstrap/one-time-value"),
        Ok(RouteKind::Bootstrap)
    );
    assert_eq!(
        routes.classify("/%5Fride/startup/status"),
        Ok(RouteKind::Control)
    );
    assert_eq!(routes.classify("/bundle.js"), Ok(RouteKind::Static));
    assert_eq!(routes.classify("/bundle%2Ejs"), Ok(RouteKind::Static));
}

#[test]
fn invalid_or_ambiguous_route_paths_are_rejected_instead_of_becoming_backend_routes() {
    let routes = RouteTable::new(["/", "/bundle.js"]).unwrap();
    let invalid = [
        ("/bundle%2Fjs", PathError::EncodedSeparator),
        ("/bundle%5cjs", PathError::EncodedSeparator),
        ("//bundle.js", PathError::RepeatedSeparator),
        ("/assets//bundle.js", PathError::RepeatedSeparator),
        ("/./bundle.js", PathError::DotSegment),
        ("/assets/../bundle.js", PathError::DotSegment),
        ("/%2e%2E/bundle.js", PathError::DotSegment),
        ("/assets\\bundle.js", PathError::Backslash),
        ("/nul\0.js", PathError::Nul),
        ("/nul%00.js", PathError::Nul),
        ("/bad%", PathError::MalformedPercentEncoding),
        ("/bad%2", PathError::MalformedPercentEncoding),
        ("/bad%GG", PathError::MalformedPercentEncoding),
        ("/bundle.js?cache=1", PathError::QueryOrFragment),
        ("/bundle.js#fragment", PathError::QueryOrFragment),
        ("/bundle.js%3Fcache=1", PathError::QueryOrFragment),
        ("/%252e%252e/bundle.js", PathError::DoubleEncoding),
        ("/%255Fride/startup/status", PathError::DoubleEncoding),
        ("relative/path", PathError::NotAbsolute),
        ("/%FF", PathError::InvalidUtf8),
    ];

    for (path, expected) in invalid {
        assert_eq!(routes.classify(path), Err(expected), "path {path:?}");
    }
}

#[test]
fn route_inventory_is_rejected_by_the_same_path_rules_as_requests() {
    assert!(matches!(
        RouteTable::new(["/bundle.js", "../outside.js"]),
        Err(PathError::NotAbsolute)
    ));
    assert!(matches!(
        RouteTable::new(["/bundle.js", "/%252e%252e/hidden.js"]),
        Err(PathError::DoubleEncoding)
    ));
}
