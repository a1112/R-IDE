/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Tauri 应用库模块

pub mod commands;
pub mod download;
pub mod launch_intent;
pub mod native_chrome;
pub mod performance;
pub mod sidecar;
pub mod smoke;
pub mod startup;
pub mod startup_gateway;
mod startup_job;
pub mod startup_metrics;

use std::ffi::OsString;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const MAX_PENDING_LAUNCH_INTENTS: usize = 64;
pub const GATEWAY_WINDOW_VISIBLE_DEADLINE: std::time::Duration =
    std::time::Duration::from_millis(800);
pub const GATEWAY_BIND_CLEANUP_GRACE: std::time::Duration = std::time::Duration::from_millis(50);
pub const WINDOW_PRESENTATION_BUDGET: std::time::Duration = std::time::Duration::from_millis(200);
static NEXT_SECONDARY_WINDOW_ID: AtomicU64 = AtomicU64::new(1);

pub fn is_trusted_secondary_window_url(url: &tauri::Url, public_authority: &str) -> bool {
    let Ok(expected) = public_authority.parse::<SocketAddr>() else {
        return false;
    };
    expected.ip() == Ipv4Addr::LOCALHOST
        && url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str() == Some("127.0.0.1")
        && url.port() == Some(expected.port())
        && url.path() == "/secondary-window.html"
        && url.query().is_none()
        && url.fragment().is_none()
}

pub async fn shutdown_gateway_before_backend<G, B, E>(
    gateway_stop: G,
    backend_cleanup: B,
) -> Result<(), E>
where
    G: Future<Output = ()>,
    B: FnOnce() -> Result<(), E>,
{
    gateway_stop.await;
    backend_cleanup()
}

fn configure_local_proxy_bypass() {
    for name in ["NO_PROXY", "no_proxy"] {
        let mut entries = std::env::var(name)
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();

        for local in ["127.0.0.1", "localhost", "::1"] {
            if !entries.iter().any(|entry| entry == local) {
                entries.push(local.to_string());
            }
        }

        std::env::set_var(name, entries.join(","));
    }
}

// 全局状态：存储 Node.js 后端的端口号
pub struct AppState {
    pub backend_port: Mutex<Option<u16>>,
    pub backend_ownership: Mutex<startup::BackendOwnershipState>,
    pub backend_stop_fallback: Mutex<Option<(u32, tokio::sync::mpsc::UnboundedSender<()>)>>,
    pub downloads: download::DownloadManager,
    pub launch_intent_router: launch_intent::LaunchIntentRouter,
    pub performance: performance::PerformanceSampler,
    pub smoke: smoke::SmokeProtocol,
    pub startup_metrics: startup_metrics::StartupMetrics,
    pub startup_mode: Mutex<startup_metrics::StartupMode>,
    pub gateway: Mutex<Option<startup_gateway::StartupGateway>>,
    pub runtime_paths: startup::RuntimePathsCache,
}

impl AppState {
    fn new(
        initial_launch_intent: Option<launch_intent::LaunchIntent>,
        startup_metrics: startup_metrics::StartupMetrics,
        startup_mode: startup_metrics::StartupMode,
    ) -> Self {
        Self {
            backend_port: Mutex::new(None),
            backend_ownership: Mutex::new(startup::BackendOwnershipState::default()),
            backend_stop_fallback: Mutex::new(None),
            downloads: download::DownloadManager::new(),
            launch_intent_router: launch_intent::LaunchIntentRouter::new(
                MAX_PENDING_LAUNCH_INTENTS,
                initial_launch_intent,
            ),
            performance: performance::PerformanceSampler::default(),
            smoke: smoke::SmokeProtocol::from_process_environment(),
            startup_metrics,
            startup_mode: Mutex::new(startup_mode),
            gateway: Mutex::new(None),
            runtime_paths: startup::RuntimePathsCache::default(),
        }
    }
}

fn performance_snapshot_for_current_process<F>(
    backend_ownership: &Mutex<startup::BackendOwnershipState>,
    sample: F,
) -> Result<performance::PerformanceSnapshot, String>
where
    F: FnOnce(u32, Option<u32>) -> Result<performance::PerformanceSnapshot, String>,
{
    let backend_pid = backend_ownership
        .lock()
        .map_err(|_| "backend ownership mutex is poisoned".to_string())?
        .pid();
    sample(std::process::id(), backend_pid)
}

/// Registers the activation plugin first, then injects its state before the
/// returned builder can initialize plugins.
fn configure_activation_builder<B, P, RegisterPlugin, ManageState>(
    builder: B,
    activation_plugin: P,
    initial_launch_intent: Option<launch_intent::LaunchIntent>,
    startup_metrics: startup_metrics::StartupMetrics,
    startup_mode: startup_metrics::StartupMode,
    register_plugin: RegisterPlugin,
    manage_state: ManageState,
) -> B
where
    RegisterPlugin: FnOnce(B, P) -> B,
    ManageState: FnOnce(B, AppState) -> B,
{
    let builder = register_plugin(builder, activation_plugin);
    manage_state(
        builder,
        AppState::new(initial_launch_intent, startup_metrics, startup_mode),
    )
}

fn trusted_secondary_window_authority(app: &tauri::AppHandle) -> Option<String> {
    let state = app.try_state::<AppState>()?;
    if let Some(gateway) = state.gateway.lock().ok()?.as_ref() {
        return Some(gateway.public_authority());
    }
    let mode = *state.startup_mode.lock().ok()?;
    match mode {
        startup_metrics::StartupMode::LegacyExplicit
        | startup_metrics::StartupMode::LegacyFallback => {
            Some(format!("127.0.0.1:{}", sidecar::BACKEND_PORT))
        }
        startup_metrics::StartupMode::RustGateway => None,
    }
}

fn register_gateway_capability(
    app: &tauri::App,
    spec: &startup::GatewayCapabilitySpec,
) -> tauri::Result<()> {
    let mut capability = tauri::ipc::CapabilityBuilder::new(spec.identifier.clone())
        .local(false)
        .remote(spec.origin.clone())
        .windows(["main", "theia-secondary-*"]);
    for permission in &spec.permissions {
        capability = capability.permission(*permission);
    }
    app.add_capability(capability)
}

fn shutdown_application(app_handle: &tauri::AppHandle) -> Result<(), String> {
    let gateway = app_handle
        .try_state::<AppState>()
        .and_then(|state| state.gateway.lock().ok()?.take());
    tauri::async_runtime::block_on(shutdown_gateway_before_backend(
        async move {
            if let Some(gateway) = gateway {
                gateway.shutdown().await;
            }
        },
        || sidecar::stop_backend(app_handle),
    ))
}

fn restore_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        log::warn!("Cannot restore main window for desktop activation: window is unavailable");
        return;
    };

    for (operation, result) in [
        (
            "enable cursor events",
            window.set_ignore_cursor_events(false),
        ),
        ("unminimize", window.unminimize()),
        ("show", window.show()),
        ("focus", window.set_focus()),
    ] {
        if let Err(error) = result {
            log::warn!("Failed to {operation} main window: {error}");
        }
    }
}

fn log_launch_intent_delivery_failures<E: std::fmt::Display>(
    context: &str,
    failures: Vec<launch_intent::LaunchIntentDeliveryFailure<E>>,
) {
    for failure in failures {
        log::warn!(
            "Failed to emit {context} launch intent {}: {}",
            failure.intent.id,
            failure.error
        );
    }
}

fn close_secondary_windows(app_handle: &tauri::AppHandle) {
    for (label, window) in app_handle.webview_windows() {
        if label.starts_with("theia-secondary-") {
            if let Err(error) = window.close() {
                log::warn!("Failed to close secondary window {label}: {error}");
            }
        }
    }
}

#[cfg(unix)]
fn install_shutdown_signal_handlers(app_handle: tauri::AppHandle) {
    use signal_hook::consts::signal::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    let mut signals = match Signals::new([SIGINT, SIGTERM]) {
        Ok(signals) => signals,
        Err(e) => {
            log::warn!("Failed to install shutdown signal handlers: {}", e);
            return;
        }
    };

    std::thread::spawn(move || {
        if signals.forever().next().is_some() {
            if let Err(e) = shutdown_application(&app_handle) {
                log::warn!("Failed to stop application after shutdown signal: {}", e);
            }
            app_handle.exit(0);
        }
    });
}

#[cfg(not(unix))]
fn install_shutdown_signal_handlers(_app_handle: tauri::AppHandle) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let visibility_deadline = startup::StartupVisibilityDeadline::new(
        tokio::time::Instant::now(),
        GATEWAY_WINDOW_VISIBLE_DEADLINE,
        WINDOW_PRESENTATION_BUDGET,
    )
    .expect("the static window visibility budget must be valid");
    let _startup_job_lease = match startup_job::create_for_current_process_if_requested(
        std::env::var_os(startup_metrics::STARTUP_REPORT_ENV).is_some(),
    ) {
        Ok(lease) => lease,
        Err(error) => {
            eprintln!("Failed to establish measured-startup Windows Job Object: {error}");
            std::process::exit(1);
        }
    };
    let requested_startup_mode = startup_metrics::StartupMode::from_env();
    let startup_metrics = startup_metrics::StartupMetrics::from_env(requested_startup_mode);
    if let Err(error) = initialize_current_startup_metrics(&startup_metrics, requested_startup_mode)
    {
        eprintln!("Warning: failed to initialize startup metrics: {error}");
    }
    configure_local_proxy_bypass();
    let _ = env_logger::try_init();

    let initial_cwd = std::env::current_dir().unwrap_or_else(|error| {
        log::warn!("Failed to read initial launch cwd: {error}");
        PathBuf::new()
    });
    let initial_launch_intent = launch_intent::parse_args(
        std::env::args_os(),
        &initial_cwd,
        launch_intent::LaunchSource::Initial,
        1,
    );
    let initial_workspace = initial_launch_intent
        .as_ref()
        .map(|intent| intent.workspace.clone());

    let builder = configure_activation_builder(
        tauri::Builder::default(),
        tauri_plugin_single_instance::init(|app, args, cwd| {
            let state = app.state::<AppState>();
            let report = state.launch_intent_router.route_forwarded_args(
                args.into_iter().map(OsString::from),
                Path::new(&cwd),
                || restore_main_window(app),
                |intent| app.emit_to("main", "ride-open-request", intent),
            );
            log_launch_intent_delivery_failures("single-instance", report.failures);
        }),
        initial_launch_intent,
        startup_metrics,
        requested_startup_mode,
        |builder, plugin| builder.plugin(plugin),
        |builder, state| builder.manage(state),
    );

    let app = builder
        .setup(move |app| {
            native_chrome::install_menu_event_bridge(app.handle());

            let mut main_window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
                .cloned()
                .ok_or_else(|| std::io::Error::other("missing main window configuration"))?;
            let runtime_paths = sidecar::resolve_runtime_paths(app.handle())?;
            let startup_metrics = app.state::<AppState>().startup_metrics.clone();
            let mut launch = tauri::async_runtime::block_on(
                startup::StartupCoordinator::new(
                    requested_startup_mode,
                    startup_metrics,
                    visibility_deadline,
                )
                .launch(
                    runtime_paths.gateway_frontend_directory(),
                    main_window_config.url.clone(),
                ),
            )
            .map_err(|error| std::io::Error::other(error.to_string()))?;
            let presentation = startup::present_startup_window(
                visibility_deadline,
                || -> Result<tauri::WebviewWindow, Box<dyn std::error::Error>> {
                    if let Some(reason) = launch.fallback_reason.as_deref() {
                        log::warn!(
                            "Startup gateway unavailable; using legacy fallback: {reason}"
                        );
                    }
                    *app.state::<AppState>().startup_mode.lock().unwrap() = launch.mode;

                    let readiness_publisher = match launch.gateway.as_ref() {
                        Some(gateway) => {
                            let capability = startup::GatewayCapabilitySpec::for_gateway(gateway);
                            register_gateway_capability(app, &capability)?;
                            sidecar::BackendReadinessPublisher::gateway(
                                gateway.state(),
                                launch.backend_generation,
                                gateway.public_authority(),
                                launch.window_created_gate(),
                            )
                        }
                        None => sidecar::BackendReadinessPublisher::legacy(),
                    };
                    if !launch.dispatch_initial_navigation(|url| main_window_config.url = url) {
                        return Err(std::io::Error::other(
                            "main window initial navigation was already dispatched",
                        )
                        .into());
                    }
                    *app.state::<AppState>().gateway.lock().unwrap() = launch.gateway.take();

                    let app_handle = app.handle().clone();
                    let backend_start = app
                        .state::<AppState>()
                        .backend_ownership
                        .lock()
                        .unwrap()
                        .reserve_start();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = sidecar::start_backend(
                            &app_handle,
                            initial_workspace,
                            backend_start,
                            readiness_publisher,
                        )
                        .await
                        {
                            eprintln!("Failed to start backend: {}", e);
                        }
                    });

                    let secondary_window_app = app.handle().clone();
                    let window =
                        tauri::WebviewWindowBuilder::from_config(app.handle(), &main_window_config)?
                            .on_new_window(move |url, features| {
                                let Some(public_authority) =
                                    trusted_secondary_window_authority(&secondary_window_app)
                                else {
                                    log::warn!(
                                        "Denied secondary-window navigation without an active startup authority"
                                    );
                                    return tauri::webview::NewWindowResponse::Deny;
                                };
                                if !is_trusted_secondary_window_url(&url, &public_authority) {
                                    log::warn!(
                                        "Denied untrusted secondary-window navigation: {url}"
                                    );
                                    return tauri::webview::NewWindowResponse::Deny;
                                }

                                let id =
                                    NEXT_SECONDARY_WINDOW_ID.fetch_add(1, Ordering::Relaxed);
                                let label = format!("theia-secondary-{id}");
                                let blank_url = tauri::Url::parse("about:blank").expect(
                                    "the static secondary-window bootstrap URL must be valid",
                                );
                                let builder = tauri::WebviewWindowBuilder::new(
                                    &secondary_window_app,
                                    label,
                                    tauri::WebviewUrl::External(blank_url),
                                )
                                .window_features(features)
                                .title("R-IDE")
                                .on_document_title_changed(|window, title| {
                                    if let Err(error) = window.set_title(&title) {
                                        log::warn!(
                                            "Failed to update secondary-window title: {error}"
                                        );
                                    }
                                });

                                match builder.build() {
                                    Ok(window) => {
                                        tauri::webview::NewWindowResponse::Create { window }
                                    }
                                    Err(error) => {
                                        log::warn!(
                                            "Failed to create secondary Tauri window: {error}"
                                        );
                                        tauri::webview::NewWindowResponse::Deny
                                    }
                                }
                            })
                            .build()?;
                    launch.mark_window_created();
                    Ok(window)
                },
                |window| {
                    native_chrome::configure_native_window(window);
                    Ok(window.show()?)
                },
                tokio::time::Instant::now,
            )?;
            app.state::<AppState>()
                .startup_metrics
                .record_or_warn(startup_metrics::StartupMilestone::NativeWindowVisible);
            if !presentation.shown_within_deadline {
                log::warn!(
                    "Native window became visible after the absolute {}ms startup deadline (presentation budget: {}ms)",
                    GATEWAY_WINDOW_VISIBLE_DEADLINE.as_millis(),
                    WINDOW_PRESENTATION_BUDGET.as_millis()
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_backend_port,
            commands::ride_plugin_directories,
            commands::download_start,
            commands::download_cancel,
            commands::download_list,
            commands::download_plugin,
            commands::download_configured_plugins,
            native_chrome::ride_show_main_menu,
            native_chrome::ride_start_window_drag,
            native_chrome::ride_window_control,
            native_chrome::ride_frontend_ready,
            native_chrome::ride_record_startup_milestone,
            performance::ride_performance_snapshot,
            smoke::ride_smoke_plan,
            smoke::ride_smoke_record_step,
            smoke::ride_smoke_complete,
            commands::open_directory,
            commands::save_file,
            commands::show_in_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    install_shutdown_signal_handlers(app.handle().clone());

    app.run(|app_handle, event| match event {
        tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed,
            ..
        } if label == "main" => {
            close_secondary_windows(app_handle);
            if let Err(error) = shutdown_application(app_handle) {
                log::warn!("Failed to stop application while closing the main window: {error}");
            }
            app_handle.exit(0);
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Opened { urls } => {
            let state = app_handle.state::<AppState>();
            let report = state.launch_intent_router.route_opened_urls(
                &urls,
                || restore_main_window(app_handle),
                |intent| app_handle.emit_to("main", "ride-open-request", intent),
            );
            log_launch_intent_delivery_failures("macOS opened URL", report.failures);
        }
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            if let Err(e) = shutdown_application(app_handle) {
                log::warn!("Failed to stop application during shutdown: {}", e);
            }
        }
        _ => {}
    });
}

pub fn initialize_current_startup_metrics(
    startup_metrics: &startup_metrics::StartupMetrics,
    requested_mode: startup_metrics::StartupMode,
) -> Result<(), startup_metrics::StartupMetricError> {
    startup_metrics.record(startup_metrics::StartupMilestone::ProcessStarted)?;
    let _ = requested_mode;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    struct CapturingStartupReportWriter {
        reports: mpsc::Sender<serde_json::Value>,
    }

    impl startup_metrics::StartupReportWriter for CapturingStartupReportWriter {
        fn write(&mut self, report: &startup_metrics::StartupReport) -> std::io::Result<()> {
            self.reports
                .send(serde_json::to_value(report).expect("serialize startup report"))
                .map_err(std::io::Error::other)
        }
    }

    struct ProbePlugin {
        setup: Box<dyn FnOnce(&AppState)>,
    }

    struct ProbeBuilder {
        plugin: Option<ProbePlugin>,
        state: Option<AppState>,
        assembly_order: Vec<&'static str>,
    }

    impl ProbeBuilder {
        fn build(mut self) -> AppState {
            assert_eq!(self.assembly_order, ["plugin", "state"]);
            let state = self.state.take().expect("managed AppState");
            let plugin = self.plugin.take().expect("registered activation plugin");
            (plugin.setup)(&state);
            state
        }
    }

    #[test]
    fn app_state_is_available_during_first_plugin_setup() {
        let initial = launch_intent::LaunchIntent {
            id: 1,
            source: launch_intent::LaunchSource::Initial,
            workspace: "workspace".into(),
            files: vec!["workspace/initial.R".into()],
        };
        let setup_next_id = Arc::new(Mutex::new(None));
        let observed_setup_next_id = Arc::clone(&setup_next_id);
        let probe = ProbePlugin {
            setup: Box::new(move |state| {
                *observed_setup_next_id
                    .lock()
                    .expect("setup observation mutex") = state.launch_intent_router.next_id();
            }),
        };

        let app = configure_activation_builder(
            ProbeBuilder {
                plugin: None,
                state: None,
                assembly_order: Vec::new(),
            },
            probe,
            Some(initial.clone()),
            startup_metrics::StartupMetrics::with_clock(
                None,
                "test",
                "test",
                1,
                startup_metrics::StartupMode::LegacyExplicit,
                Arc::new(TestClock),
            ),
            startup_metrics::StartupMode::LegacyExplicit,
            |mut builder, plugin| {
                builder.assembly_order.push("plugin");
                builder.plugin = Some(plugin);
                builder
            },
            |mut builder, state| {
                builder.assembly_order.push("state");
                builder.state = Some(state);
                builder
            },
        )
        .build();

        let _performance_sampler: &performance::PerformanceSampler = &app.performance;

        assert_eq!(
            *setup_next_id.lock().expect("setup observation mutex"),
            Some(2)
        );
        let mut delivered = Vec::new();
        app.launch_intent_router.frontend_ready(|intent| {
            delivered.push(intent.clone());
            Ok::<_, ()>(())
        });
        assert_eq!(delivered, vec![initial]);
    }

    #[test]
    fn secondary_window_url_is_limited_to_the_packaged_theia_page() {
        let trusted = tauri::Url::parse("http://127.0.0.1:3000/secondary-window.html")
            .expect("trusted secondary-window URL");
        assert!(is_trusted_secondary_window_url(&trusted, "127.0.0.1:3000"));

        for untrusted in [
            "https://127.0.0.1:3000/secondary-window.html",
            "http://localhost:3000/secondary-window.html",
            "http://127.0.0.1:3001/secondary-window.html",
            "http://127.0.0.1:3000/secondary-window.html?target=external",
            "http://127.0.0.1:3000/secondary-window.html#external",
            "http://127.0.0.1:3000/other.html",
            "https://example.com/secondary-window.html",
        ] {
            let url = tauri::Url::parse(untrusted).expect("untrusted URL fixture");
            assert!(
                !is_trusted_secondary_window_url(&url, "127.0.0.1:3000"),
                "accepted {url}"
            );
        }
    }

    #[derive(Debug)]
    struct TestClock;

    impl startup_metrics::ElapsedClock for TestClock {
        fn elapsed_ms(&self) -> u64 {
            0
        }
    }

    #[test]
    fn current_startup_without_mode_env_waits_for_gateway_bind_outcome() {
        let requested_mode = startup_metrics::StartupMode::from_env_value(None);
        assert_eq!(requested_mode, startup_metrics::StartupMode::RustGateway);
        let (reports_tx, reports_rx) = mpsc::channel();
        let metrics = startup_metrics::StartupMetrics::with_clock_and_writer(
            "windows",
            "x86_64",
            42,
            requested_mode,
            Arc::new(TestClock),
            Box::new(CapturingStartupReportWriter {
                reports: reports_tx,
            }),
        );

        initialize_current_startup_metrics(&metrics, requested_mode)
            .expect("initialize current startup metrics");
        let initialized = reports_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("published startup report");
        assert_eq!(initialized["startupMode"], "rust-gateway");
        assert!(reports_rx.recv_timeout(Duration::from_millis(50)).is_err());
    }

    #[test]
    fn current_startup_keeps_explicit_legacy_mode_valid() {
        let requested_mode = startup_metrics::StartupMode::from_env_value(Some("legacy"));
        let (reports_tx, reports_rx) = mpsc::channel();
        let metrics = startup_metrics::StartupMetrics::with_clock_and_writer(
            "windows",
            "x86_64",
            42,
            requested_mode,
            Arc::new(TestClock),
            Box::new(CapturingStartupReportWriter {
                reports: reports_tx,
            }),
        );

        initialize_current_startup_metrics(&metrics, requested_mode)
            .expect("initialize explicit legacy startup metrics");
        for milestone in [
            startup_metrics::StartupMilestone::BackendSpawned,
            startup_metrics::StartupMilestone::BackendListening,
            startup_metrics::StartupMilestone::NativeWindowVisible,
            startup_metrics::StartupMilestone::FrontendShellAttached,
            startup_metrics::StartupMilestone::TargetFileOpened,
        ] {
            metrics.record(milestone).expect("record current milestone");
        }

        let final_report = (0..6)
            .map(|_| {
                reports_rx
                    .recv_timeout(Duration::from_secs(1))
                    .expect("published startup report")
            })
            .last()
            .expect("final startup report");
        assert_eq!(final_report["startupMode"], "legacy-explicit");
        assert_eq!(final_report["milestones"]["target_file_opened"], 0);
    }

    #[test]
    fn performance_snapshot_forwards_current_root_and_owned_backend_pid_after_unlocking() {
        let mut backend = startup::BackendOwnershipState::default();
        let token = backend.reserve_start();
        assert!(backend.register_spawn(token, 4242));
        let backend_ownership = Mutex::new(backend);
        let observed = Arc::new(Mutex::new(None));
        let observed_by_sampler = Arc::clone(&observed);

        performance_snapshot_for_current_process(&backend_ownership, |root_pid, backend_pid| {
            assert!(backend_ownership.try_lock().is_ok());
            *observed_by_sampler.lock().expect("observation mutex") = Some((root_pid, backend_pid));
            Ok(performance::PerformanceSnapshot {
                sampled_at_ms: 0,
                total: performance::UsageGroup::default(),
                main: performance::UsageGroup::default(),
                backend: performance::UsageGroup::default(),
                plugin_host: performance::UsageGroup::default(),
                other: performance::UsageGroup::default(),
            })
        })
        .expect("performance snapshot");

        assert_eq!(
            *observed.lock().expect("observation mutex"),
            Some((std::process::id(), Some(4242)))
        );
    }

    #[test]
    fn poisoned_backend_ownership_mutex_returns_a_clear_error() {
        let backend_ownership = Arc::new(Mutex::new(startup::BackendOwnershipState::default()));
        let backend_for_poisoning = Arc::clone(&backend_ownership);
        let _ = std::thread::spawn(move || {
            let _guard = backend_for_poisoning
                .lock()
                .expect("backend ownership mutex");
            panic!("poison backend ownership mutex");
        })
        .join();

        let error = performance_snapshot_for_current_process(&backend_ownership, |_, _| {
            panic!("sampler must not run when backend ownership is poisoned")
        })
        .expect_err("poisoned backend ownership must fail");

        assert_eq!(error, "backend ownership mutex is poisoned");
    }
}
