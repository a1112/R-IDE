/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use ride_tauri::sidecar::{race_backend_publication_with_exit, BackendReadinessPublisher};
use ride_tauri::startup::{
    GatewayCapabilitySpec, RuntimePathMode, RuntimePaths, StartupCoordinator,
    GATEWAY_CAPABILITY_PERMISSIONS,
};
use ride_tauri::startup_gateway::{BackendPhase, GatewayError, GatewayLimits, StartupGateway};
use ride_tauri::startup_metrics::{
    ElapsedClock, StartupMetrics, StartupMilestone, StartupMode, StartupReport, StartupReportWriter,
};
use ride_tauri::{
    is_trusted_secondary_window_url, shutdown_gateway_before_backend,
    GATEWAY_WINDOW_VISIBLE_DEADLINE,
};
use std::fs;
use std::io;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::WebviewUrl;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use uuid::Uuid;

struct TemporaryFrontend {
    root: PathBuf,
}

impl TemporaryFrontend {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "ride-startup-gateway-integration-{}",
            Uuid::new_v4()
        ));
        fs::create_dir(&root).expect("create frontend fixture");
        fs::write(
            root.join("index.html"),
            b"<!doctype html><title>R-IDE</title>",
        )
        .expect("write index");
        fs::write(root.join("bundle.js"), b"globalThis.ride = true;").expect("write bundle");
        fs::write(root.join("bundle.css"), b"body { color: white; }").expect("write styles");
        Self { root }
    }
}

impl Drop for TemporaryFrontend {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Debug)]
struct ZeroClock;

impl ElapsedClock for ZeroClock {
    fn elapsed_ms(&self) -> u64 {
        0
    }
}

struct ChannelWriter(mpsc::Sender<serde_json::Value>);

impl StartupReportWriter for ChannelWriter {
    fn write(&mut self, report: &StartupReport) -> io::Result<()> {
        self.0
            .send(serde_json::to_value(report).expect("serialize startup report"))
            .map_err(io::Error::other)
    }
}

struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

fn disabled_metrics(mode: StartupMode) -> StartupMetrics {
    StartupMetrics::with_clock(None, "test", "test", 1, mode, Arc::new(ZeroClock))
}

fn legacy_url() -> WebviewUrl {
    WebviewUrl::App("index.html".into())
}

fn event_index(events: &[&'static str], expected: &'static str) -> usize {
    events
        .iter()
        .position(|event| *event == expected)
        .unwrap_or_else(|| panic!("missing startup event {expected:?}: {events:?}"))
}

#[tokio::test]
async fn gateway_mode_opens_the_window_before_backend_readiness() {
    let frontend = TemporaryFrontend::new();
    let metrics = disabled_metrics(StartupMode::RustGateway);
    metrics
        .record(StartupMilestone::ProcessStarted)
        .expect("record process start");
    let mut launch = StartupCoordinator::with_limits(
        StartupMode::RustGateway,
        metrics,
        GatewayLimits::test_defaults(),
    )
    .launch(frontend.root.clone(), legacy_url())
    .await
    .expect("gateway launch");

    let gateway = launch.gateway.as_ref().expect("bound gateway");
    let authority = gateway.public_authority();
    let events = Arc::new(Mutex::new(vec!["gateway_listening"]));
    let backend_events = Arc::clone(&events);
    let publisher = BackendReadinessPublisher::gateway(
        gateway.state(),
        launch.backend_generation,
        authority,
        launch.window_created_gate(),
    );
    let backend = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(250)).await;
        publisher
            .backend_ready_after_window(SocketAddr::from((Ipv4Addr::LOCALHOST, 32123)), move || {
                backend_events
                    .lock()
                    .expect("event mutex")
                    .push("backend_listening");
                true
            })
            .await
            .expect("publish private backend readiness");
    });

    events.lock().expect("event mutex").push("window_created");
    launch.mark_window_created();
    backend.await.expect("fake backend task");

    let observed = events.lock().expect("event mutex").clone();
    assert!(event_index(&observed, "gateway_listening") < event_index(&observed, "window_created"));
    assert!(event_index(&observed, "window_created") < event_index(&observed, "backend_listening"));
    assert_eq!(launch.mode, StartupMode::RustGateway);
    assert!(
        matches!(launch.initial_url, WebviewUrl::External(ref url) if url.path().starts_with("/_ride/bootstrap/"))
    );

    let state = gateway.state().snapshot().await;
    assert_eq!(state.generation, launch.backend_generation);
    assert_eq!(state.phase, BackendPhase::Ready);

    launch.gateway.take().unwrap().shutdown().await;
}

#[tokio::test]
async fn gateway_failure_falls_back_once_and_explicit_legacy_never_attempts_gateway() {
    let missing = std::env::temp_dir().join(format!("ride-missing-{}", Uuid::new_v4()));
    let (reports_tx, reports_rx) = mpsc::channel();
    let fallback_metrics = StartupMetrics::with_clock_and_writer(
        "test",
        "test",
        1,
        StartupMode::RustGateway,
        Arc::new(ZeroClock),
        Box::new(ChannelWriter(reports_tx)),
    );
    fallback_metrics
        .record(StartupMilestone::ProcessStarted)
        .unwrap();
    assert_eq!(
        reports_rx.recv_timeout(Duration::from_secs(1)).unwrap()["startupMode"],
        "rust-gateway"
    );
    let fallback = StartupCoordinator::with_limits(
        StartupMode::RustGateway,
        fallback_metrics,
        GatewayLimits::test_defaults(),
    )
    .launch(missing.clone(), legacy_url())
    .await
    .expect("availability fallback");
    assert_eq!(fallback.mode, StartupMode::LegacyFallback);
    assert!(fallback.gateway.is_none());
    assert!(fallback
        .fallback_reason
        .as_deref()
        .is_some_and(|reason| reason.len() <= 256));
    assert_eq!(
        reports_rx.recv_timeout(Duration::from_secs(1)).unwrap()["startupMode"],
        "legacy-fallback"
    );
    assert!(reports_rx.recv_timeout(Duration::from_millis(50)).is_err());

    let explicit = StartupCoordinator::with_limits(
        StartupMode::LegacyExplicit,
        disabled_metrics(StartupMode::LegacyExplicit),
        GatewayLimits::test_defaults(),
    )
    .launch(missing, legacy_url())
    .await
    .expect("explicit legacy launch");
    assert_eq!(explicit.mode, StartupMode::LegacyExplicit);
    assert!(explicit.gateway.is_none());
    assert!(explicit.fallback_reason.is_none());
    assert_eq!(explicit.initial_url, legacy_url());
}

#[tokio::test]
async fn backend_readiness_publishes_private_generation_without_navigation() {
    let frontend = TemporaryFrontend::new();
    let mut launch = StartupCoordinator::with_limits(
        StartupMode::RustGateway,
        disabled_metrics(StartupMode::RustGateway),
        GatewayLimits::test_defaults(),
    )
    .launch(frontend.root.clone(), legacy_url())
    .await
    .expect("gateway launch");
    let gateway = launch.gateway.as_ref().unwrap();
    let publisher = BackendReadinessPublisher::gateway(
        gateway.state(),
        launch.backend_generation,
        gateway.public_authority(),
        launch.window_created_gate(),
    );
    let navigations = Arc::new(Mutex::new(Vec::new()));
    let first_navigation = Arc::clone(&navigations);
    assert!(launch.dispatch_initial_navigation(move |url| {
        first_navigation.lock().unwrap().push(url);
    }));
    let duplicate_navigation = Arc::clone(&navigations);
    assert!(!launch.dispatch_initial_navigation(move |url| {
        duplicate_navigation.lock().unwrap().push(url);
    }));
    launch.mark_window_created();
    let private = SocketAddr::from((Ipv4Addr::LOCALHOST, 32124));
    publisher
        .backend_ready(private)
        .await
        .expect("publish readiness");
    let gateway_navigation = Arc::clone(&navigations);
    assert!(!publisher
        .dispatch_readiness_navigation(private.port(), None, move |url| {
            gateway_navigation
                .lock()
                .unwrap()
                .push(WebviewUrl::External(url));
        })
        .expect("gateway navigation decision"));

    assert_eq!(gateway.state().wait_for_backend().await.unwrap(), private);
    let observed = navigations.lock().unwrap();
    assert_eq!(observed.len(), 1);
    assert!(matches!(
        observed.first(),
        Some(WebviewUrl::External(url)) if url.path().starts_with("/_ride/bootstrap/")
    ));
    drop(observed);

    let legacy = BackendReadinessPublisher::legacy();
    let legacy_navigations = Arc::new(Mutex::new(Vec::new()));
    let first_legacy_navigation = Arc::clone(&legacy_navigations);
    assert!(legacy
        .dispatch_readiness_navigation(3000, Some("zh-CN"), move |url| {
            first_legacy_navigation.lock().unwrap().push(url);
        })
        .expect("legacy readiness navigation"));
    let duplicate_legacy_navigation = Arc::clone(&legacy_navigations);
    assert!(!legacy
        .dispatch_readiness_navigation(3000, Some("zh-CN"), move |url| {
            duplicate_legacy_navigation.lock().unwrap().push(url);
        })
        .expect("duplicate legacy readiness navigation"));
    let legacy_observed = legacy_navigations.lock().unwrap();
    assert_eq!(legacy_observed.len(), 1);
    assert_eq!(
        legacy_observed[0].as_str(),
        "http://127.0.0.1:3000/?ride_locale=zh-CN"
    );
    assert_eq!(publisher.theia_hosts(), Some(gateway.public_authority()));
    assert_eq!(legacy.theia_hosts(), None);

    launch.gateway.take().unwrap().shutdown().await;
}

#[tokio::test]
async fn same_generation_exit_while_window_gate_waits_never_publishes_backend() {
    let frontend = TemporaryFrontend::new();
    let mut launch = StartupCoordinator::with_limits(
        StartupMode::RustGateway,
        disabled_metrics(StartupMode::RustGateway),
        GatewayLimits::test_defaults(),
    )
    .launch(frontend.root.clone(), legacy_url())
    .await
    .expect("gateway launch");
    let gateway = launch.gateway.as_ref().unwrap();
    let publisher = BackendReadinessPublisher::gateway(
        gateway.state(),
        launch.backend_generation,
        gateway.public_authority(),
        launch.window_created_gate(),
    );
    let backend_listening_recorded = Arc::new(AtomicBool::new(false));
    let observed_recording = Arc::clone(&backend_listening_recorded);
    let (exit_sender, exit_receiver) = oneshot::channel();

    let publication = tokio::spawn(async move {
        race_backend_publication_with_exit(
            async move { exit_receiver.await.expect("fake child exit") },
            publisher.backend_ready_after_window(
                SocketAddr::from((Ipv4Addr::LOCALHOST, 32126)),
                move || {
                    observed_recording.store(true, Ordering::SeqCst);
                    true
                },
            ),
        )
        .await
    });
    tokio::task::yield_now().await;
    exit_sender.send("exit code: 1").unwrap();

    let outcome = publication.await.expect("publication race task");
    assert!(matches!(outcome, Err("exit code: 1")));
    assert!(!backend_listening_recorded.load(Ordering::SeqCst));
    let snapshot = gateway.state().snapshot().await;
    assert_eq!(snapshot.generation, launch.backend_generation);
    assert_eq!(snapshot.phase, BackendPhase::Starting);

    launch.mark_window_created();
    launch.gateway.take().unwrap().shutdown().await;
}

#[tokio::test]
async fn slow_gateway_bind_falls_back_within_deadline_and_releases_listener() {
    let frontend = TemporaryFrontend::new();
    let deadline = Duration::from_millis(20);
    let bind_dropped = Arc::new(AtomicBool::new(false));
    let observed_drop = Arc::clone(&bind_dropped);
    let (address_sender, address_receiver) = oneshot::channel();
    let started = tokio::time::Instant::now();

    let launch = StartupCoordinator::with_limits_and_deadline(
        StartupMode::RustGateway,
        disabled_metrics(StartupMode::RustGateway),
        GatewayLimits::test_defaults(),
        deadline,
    )
    .launch_with_gateway_bind(
        frontend.root.clone(),
        legacy_url(),
        move |_frontend, _metrics, _limits| async move {
            let _drop_flag = DropFlag(observed_drop);
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .map_err(|_| GatewayError::ListenerUnavailable)?;
            address_sender.send(listener.local_addr().unwrap()).unwrap();
            std::future::pending::<Result<StartupGateway, GatewayError>>().await
        },
    )
    .await
    .expect("deadline fallback");

    assert_eq!(launch.mode, StartupMode::LegacyFallback);
    assert!(launch.gateway.is_none());
    assert_eq!(launch.initial_url, legacy_url());
    assert!(
        launch
            .fallback_reason
            .as_deref()
            .is_some_and(
                |reason| reason.contains("window visibility deadline") && reason.len() <= 256
            )
    );
    assert!(started.elapsed() < Duration::from_millis(250));
    assert!(bind_dropped.load(Ordering::SeqCst));

    let bound_address = address_receiver.await.expect("slow binder address");
    let rebound = TcpListener::bind(bound_address)
        .await
        .expect("timed-out binder must release its listener");
    drop(rebound);

    let navigation_count = Arc::new(Mutex::new(0_u8));
    let observed_navigation = Arc::clone(&navigation_count);
    assert!(launch.dispatch_initial_navigation(move |_| {
        *observed_navigation.lock().unwrap() += 1;
    }));
    assert_eq!(*navigation_count.lock().unwrap(), 1);
}

#[tokio::test]
async fn stale_generation_never_runs_the_readiness_publication_callback() {
    let frontend = TemporaryFrontend::new();
    let mut launch = StartupCoordinator::with_limits(
        StartupMode::RustGateway,
        disabled_metrics(StartupMode::RustGateway),
        GatewayLimits::test_defaults(),
    )
    .launch(frontend.root.clone(), legacy_url())
    .await
    .expect("gateway launch");
    let gateway = launch.gateway.as_ref().unwrap();
    let state = gateway.state();
    let stale_generation = launch.backend_generation;
    state
        .fail_backend(stale_generation, "first generation failed")
        .await
        .unwrap();
    let current_generation = state.begin_backend_start().await.unwrap();
    let publisher = BackendReadinessPublisher::gateway(
        state.clone(),
        stale_generation,
        gateway.public_authority(),
        launch.window_created_gate(),
    );
    let callback_ran = Arc::new(AtomicBool::new(false));
    let observed_callback = Arc::clone(&callback_ran);
    launch.mark_window_created();

    assert!(publisher
        .backend_ready_after_window(SocketAddr::from((Ipv4Addr::LOCALHOST, 32125)), move || {
            observed_callback.store(true, Ordering::SeqCst);
            true
        },)
        .await
        .is_err());
    assert!(!callback_ran.load(Ordering::SeqCst));
    assert_eq!(state.snapshot().await.generation, current_generation);

    launch.gateway.take().unwrap().shutdown().await;
}

#[tokio::test]
async fn gateway_capability_and_secondary_window_are_scoped_to_the_runtime_origin() {
    let frontend = TemporaryFrontend::new();
    let mut launch = StartupCoordinator::with_limits(
        StartupMode::RustGateway,
        disabled_metrics(StartupMode::RustGateway),
        GatewayLimits::test_defaults(),
    )
    .launch(frontend.root.clone(), legacy_url())
    .await
    .expect("gateway launch");
    let gateway = launch.gateway.as_ref().unwrap();
    let capability = GatewayCapabilitySpec::for_gateway(gateway);
    let authority = gateway.public_authority();
    let origin = format!("http://{authority}");

    assert_eq!(capability.origin, origin);
    assert_eq!(capability.windows, ["main", "theia-secondary-*"]);
    assert!(!capability.origin.contains('*'));
    assert!(!capability.origin.ends_with(":3000"));
    assert_eq!(capability.permissions, GATEWAY_CAPABILITY_PERMISSIONS);

    let trusted = tauri::Url::parse(&format!("{origin}/secondary-window.html")).unwrap();
    assert!(is_trusted_secondary_window_url(&trusted, &authority));
    for untrusted in [
        format!("http://127.0.0.1:3000/secondary-window.html"),
        format!("http://user@{authority}/secondary-window.html"),
        format!("{origin}/other.html"),
        format!("{origin}/secondary-window.html?target=external"),
        format!("{origin}/secondary-window.html#external"),
    ] {
        assert!(!is_trusted_secondary_window_url(
            &tauri::Url::parse(&untrusted).unwrap(),
            &authority
        ));
    }

    launch.gateway.take().unwrap().shutdown().await;
}

#[tokio::test]
async fn shutdown_stops_gateway_before_backend_cleanup_completes() {
    let events = Arc::new(Mutex::new(Vec::new()));
    let gateway_events = Arc::clone(&events);
    let backend_events = Arc::clone(&events);
    shutdown_gateway_before_backend(
        async move {
            gateway_events
                .lock()
                .unwrap()
                .push("gateway_stop_accepting");
        },
        move || {
            backend_events
                .lock()
                .unwrap()
                .push("backend_cleanup_complete");
            Ok::<_, String>(())
        },
    )
    .await
    .expect("ordered shutdown");

    assert_eq!(
        *events.lock().unwrap(),
        ["gateway_stop_accepting", "backend_cleanup_complete"]
    );
}

#[test]
fn runtime_paths_keep_backend_static_root_separate_from_gateway_assets() {
    let packaged = RuntimePaths::resolve(
        RuntimePathMode::Packaged(PathBuf::from("package-root")),
        PathBuf::from("config"),
    )
    .unwrap();
    assert_eq!(
        packaged.gateway_frontend_directory(),
        PathBuf::from("package-root/lib/frontend")
    );
    assert_eq!(
        packaged.frontend_directory(),
        PathBuf::from("package-root/lib/frontend")
    );

    let development = RuntimePaths::resolve(
        RuntimePathMode::Development(PathBuf::from("checkout")),
        PathBuf::from("config"),
    )
    .unwrap();
    assert_eq!(
        development.gateway_frontend_directory(),
        PathBuf::from("checkout/app/applications/tauri/browser-frontend")
    );
    assert_eq!(
        development.frontend_directory(),
        PathBuf::from("checkout/app/applications/browser/lib/frontend")
    );
    assert!(GATEWAY_WINDOW_VISIBLE_DEADLINE <= Duration::from_millis(800));
}
