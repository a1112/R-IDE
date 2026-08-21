/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use ride_tauri::startup::{
    finish_backend_stop, parse_linux_listener_inodes, resolve_tauri_config_directory,
    wait_for_loopback, wait_for_owned_loopback, BackendLaunchPlan, BackendOwnershipState,
    BackendReadinessPolicy, BackendSpawnStrategy, BackendStartupAction, BackendStartupEvent,
    BackendStartupState, BackendTransport, RuntimePathMode, RuntimePaths, RuntimePathsCache,
};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[test]
fn workspace_is_a_single_positional_argument() {
    let workspace = PathBuf::from("workspace with spaces");
    let plan = BackendLaunchPlan::new(Some(workspace.clone()));

    assert_eq!(
        plan.arguments(),
        [OsString::from("--"), workspace.into_os_string()]
    );
}

#[test]
fn option_looking_workspace_is_protected_by_the_argument_terminator() {
    let workspace = PathBuf::from("--inspect");
    let plan = BackendLaunchPlan::new(Some(workspace.clone()));

    assert_eq!(
        plan.arguments(),
        [OsString::from("--"), workspace.into_os_string()]
    );
}

#[test]
fn no_workspace_adds_no_arguments_and_preserves_recent_workspace_behavior() {
    let plan = BackendLaunchPlan::new(None);

    assert!(plan.arguments().is_empty());
}

#[test]
fn direct_pipes_are_default_and_pty_is_an_explicit_compatibility_override() {
    assert_eq!(
        BackendTransport::from_env_value(None).expect("default transport"),
        BackendTransport::DirectPipes
    );
    assert_eq!(
        BackendTransport::from_env_value(Some("pty")).expect("PTY compatibility transport"),
        BackendTransport::Pty
    );
    assert!(BackendTransport::from_env_value(Some("unknown")).is_err());
}

#[test]
fn transport_selects_direct_pipe_or_pty_spawn_without_hybrid_stdio() {
    assert_eq!(
        BackendSpawnStrategy::for_transport(BackendTransport::DirectPipes),
        BackendSpawnStrategy::DirectPipes
    );
    assert_eq!(
        BackendSpawnStrategy::for_transport(BackendTransport::Pty),
        BackendSpawnStrategy::Pty
    );
    assert!(BackendSpawnStrategy::for_backend(BackendTransport::DirectPipes, true).is_err());
    assert_eq!(
        BackendSpawnStrategy::for_backend(BackendTransport::Pty, true)
            .expect("PTY can preserve watcher-process compatibility"),
        BackendSpawnStrategy::Pty
    );
}

#[test]
fn loopback_readiness_policy_is_bounded() {
    let policy = BackendReadinessPolicy::new(
        Duration::from_secs(30),
        Duration::from_millis(100),
        Duration::from_millis(250),
    )
    .expect("bounded readiness policy");

    assert_eq!(policy.startup_timeout(), Duration::from_secs(30));
    assert_eq!(policy.probe_interval(), Duration::from_millis(100));
    assert_eq!(policy.connect_timeout(), Duration::from_millis(250));
    assert_eq!(policy.maximum_probe_attempts(), 300);
    assert!(BackendReadinessPolicy::new(
        Duration::ZERO,
        Duration::from_millis(100),
        Duration::from_millis(250),
    )
    .is_err());
}

#[tokio::test]
async fn loopback_readiness_connects_without_log_evidence_and_times_out_boundedly() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback listener");
    let port = listener.local_addr().expect("listener address").port();
    let ready_policy = BackendReadinessPolicy::new(
        Duration::from_secs(1),
        Duration::from_millis(10),
        Duration::from_millis(50),
    )
    .expect("ready policy");
    wait_for_loopback(port, ready_policy)
        .await
        .expect("listening backend is ready without stdout parsing");

    drop(listener);
    // TCP port zero is reserved and cannot be a listening service endpoint.
    // Releasing an ephemeral listener here would introduce a race with other
    // processes that can claim the port before the readiness probe runs.
    let unavailable_port = 0;
    let timeout_policy = BackendReadinessPolicy::new(
        Duration::from_millis(40),
        Duration::from_millis(5),
        Duration::from_millis(5),
    )
    .expect("timeout policy");
    let started = std::time::Instant::now();
    wait_for_loopback(unavailable_port, timeout_policy)
        .await
        .expect_err("unavailable loopback port times out");
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn owned_loopback_accepts_the_actual_listener_owner_without_stdout() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind owned listener");
    let port = listener.local_addr().expect("listener address").port();
    let policy = BackendReadinessPolicy::new(
        Duration::from_secs(2),
        Duration::from_millis(10),
        Duration::from_millis(50),
    )
    .expect("owned readiness policy");

    wait_for_owned_loopback(port, std::process::id(), policy)
        .await
        .expect("the actual listener owner attests readiness without log evidence");
}

#[tokio::test]
async fn owned_loopback_rejects_a_preflight_racing_external_listener() {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind external listener");
    let port = listener.local_addr().expect("listener address").port();
    let policy = BackendReadinessPolicy::new(
        Duration::from_millis(80),
        Duration::from_millis(5),
        Duration::from_millis(10),
    )
    .expect("external-listener policy");

    let started = std::time::Instant::now();
    wait_for_owned_loopback(port, u32::MAX, policy)
        .await
        .expect_err("a listener owned by another process must not satisfy readiness");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "owner attestation must obey the total readiness deadline"
    );
}

#[test]
fn linux_tcp_fixture_uses_the_documented_inode_field() {
    let fixture = "  sl  local_address rem_address   st tx_queue:rx_queue tr:tm->when retrnsmt   uid  timeout inode\n\
       0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0000000000000000 100 0 0 10 0";

    assert_eq!(
        parse_linux_listener_inodes(fixture, 3000).expect("parse Linux listener fixture"),
        ["socket:[424242]"]
    );
}

#[test]
fn direct_pipe_logs_are_independent_from_loopback_readiness() {
    let mut state = BackendStartupState::spawned(42, 3000);

    assert_eq!(
        state.observe(BackendStartupEvent::Stdout("ordinary output".into())),
        [BackendStartupAction::LogStdout("ordinary output".into())]
    );
    assert_eq!(
        state.observe(BackendStartupEvent::Stderr("ordinary error".into())),
        [BackendStartupAction::LogStderr("ordinary error".into())]
    );
    assert!(!state.is_ready(), "log text must not attest readiness");

    assert_eq!(
        state.observe(BackendStartupEvent::LoopbackConnected),
        [BackendStartupAction::PublishReady {
            pid: 42,
            port: 3000,
        }]
    );
    assert!(state.is_ready());
}

#[test]
fn loopback_cannot_publish_before_an_owned_child_is_registered() {
    let mut state = BackendStartupState::awaiting_spawn(3000);

    assert!(state
        .observe(BackendStartupEvent::LoopbackConnected)
        .is_empty());
    assert!(!state.is_ready(), "an external listener has no owned child");
    assert_eq!(
        state.observe(BackendStartupEvent::ChildSpawned(42)),
        [BackendStartupAction::PublishReady {
            pid: 42,
            port: 3000,
        }]
    );
}

#[test]
fn startup_timeout_terminates_the_owned_tree_and_clears_state() {
    let mut state = BackendStartupState::spawned(42, 3000);

    assert_eq!(
        state.observe(BackendStartupEvent::TimedOut),
        [
            BackendStartupAction::TerminateProcessTree(42),
            BackendStartupAction::ReapOwnedChild(42),
            BackendStartupAction::ClearState,
        ]
    );
    assert_eq!(state.pid(), None);
    assert_eq!(state.port(), None);
}

#[test]
fn backend_exit_and_shutdown_clear_published_state() {
    let mut exited = BackendStartupState::spawned(42, 3000);
    exited.observe(BackendStartupEvent::LoopbackConnected);
    assert_eq!(
        exited.observe(BackendStartupEvent::Exited("status 17".into())),
        [
            BackendStartupAction::ClearState,
            BackendStartupAction::ReportUnexpectedExit("status 17".into()),
        ]
    );
    assert_eq!((exited.pid(), exited.port()), (None, None));

    let mut stopping = BackendStartupState::spawned(84, 3000);
    stopping.observe(BackendStartupEvent::LoopbackConnected);
    assert_eq!(
        stopping.observe(BackendStartupEvent::ShutdownRequested),
        [
            BackendStartupAction::TerminateProcessTree(84),
            BackendStartupAction::ReapOwnedChild(84),
            BackendStartupAction::ClearState,
        ]
    );
    assert_eq!((stopping.pid(), stopping.port()), (None, None));
}

#[test]
fn a_stop_request_between_launch_reservation_and_spawn_rejects_registration() {
    let mut ownership = BackendOwnershipState::default();
    let launch = ownership.reserve_start();

    assert_eq!(ownership.request_stop(), None);
    assert!(!ownership.register_spawn(launch, 42));
    assert_eq!(ownership.pid(), None);
    assert!(ownership.is_stopping());
}

#[test]
fn a_registered_child_is_returned_for_stop_and_cannot_be_revived() {
    let mut ownership = BackendOwnershipState::default();
    let launch = ownership.reserve_start();
    assert!(ownership.register_spawn(launch, 42));
    assert!(ownership.owns_active(42));

    assert_eq!(ownership.request_stop(), Some(42));
    assert!(!ownership.owns_active(42));
    assert!(!ownership.register_spawn(launch, 42));
    assert_eq!(ownership.pid(), None);
    assert!(ownership.is_stopping());
    assert!(ownership.has_owned_work());
    assert!(ownership.owns_process(42));

    assert!(ownership.clear_spawn(42));
    assert!(!ownership.is_stopping());
    assert!(!ownership.has_owned_work());
    assert!(!ownership.owns_process(42));
}

#[test]
fn a_stale_child_clear_cannot_release_the_current_stop_owner() {
    let mut ownership = BackendOwnershipState::default();
    let launch = ownership.reserve_start();
    assert!(ownership.register_spawn(launch, 42));
    assert_eq!(ownership.request_stop(), Some(42));

    assert!(ownership.clear_spawn(7));
    assert!(ownership.is_stopping());
    assert!(ownership.owns_process(42));

    assert!(ownership.clear_spawn(42));
    assert!(!ownership.is_stopping());
    assert!(!ownership.has_owned_work());
}

#[test]
fn tree_termination_failure_still_triggers_the_exact_child_stop_fallback() {
    let (fallback_tx, mut fallback_rx) = tokio::sync::mpsc::unbounded_channel();

    let error = finish_backend_stop(
        Err("tree termination failed".to_string()),
        Some(fallback_tx),
    )
    .expect_err("the tree failure remains diagnosable");

    assert!(error.contains("tree termination failed"));
    fallback_rx
        .try_recv()
        .expect("the exact-child fallback is always requested");
}

#[test]
fn packaged_runtime_paths_derive_from_one_resource_root() {
    let root = PathBuf::from("package-root");
    let config = PathBuf::from("user-config");
    let paths = RuntimePaths::resolve(RuntimePathMode::Packaged(root.clone()), config.clone())
        .expect("packaged runtime paths");

    assert_eq!(paths.resource_root(), root);
    assert_eq!(
        paths.backend_script(),
        PathBuf::from("package-root/resources/backend/main.js")
    );
    assert_eq!(
        paths.node_executable(),
        PathBuf::from(if cfg!(windows) {
            "package-root/resources/backend/runtime/node.exe"
        } else {
            "package-root/resources/backend/runtime/node"
        })
    );
    assert_eq!(
        paths.frontend_directory(),
        PathBuf::from("package-root/lib/frontend")
    );
    assert_eq!(
        paths.plugin_directory(),
        PathBuf::from("package-root/resources/plugins")
    );
    assert_eq!(paths.config_directory(), config);
}

#[test]
fn tauri_uses_an_isolated_config_directory_unless_explicitly_overridden() {
    let home = PathBuf::from("home");

    assert_eq!(
        resolve_tauri_config_directory(None, Some(home.clone())),
        home.join(".ride-tauri")
    );
    assert_eq!(
        resolve_tauri_config_directory(Some(PathBuf::from("explicit-config")), Some(home)),
        PathBuf::from("explicit-config")
    );
}

#[test]
fn release_windows_binary_uses_the_gui_subsystem() {
    let main_source = include_str!("../src/main.rs");
    let compact_source = main_source
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();

    assert!(compact_source.contains(
        "#![cfg_attr(all(not(debug_assertions),target_os=\"windows\"),windows_subsystem=\"windows\")]"
    ));
}

#[test]
fn ancestor_scanning_requires_explicit_development_mode() {
    let development_root = PathBuf::from("checkout");
    let paths = RuntimePaths::resolve(
        RuntimePathMode::Development(development_root.clone()),
        PathBuf::from("config"),
    )
    .expect("explicit development paths");

    assert_eq!(
        paths.resource_root(),
        development_root.join("app/applications/tauri/resources")
    );
    assert_eq!(
        paths.backend_script(),
        development_root.join("app/applications/browser/lib/backend/main.js")
    );
    assert_eq!(
        paths.frontend_directory(),
        development_root.join("app/applications/browser/lib/frontend")
    );
    assert_eq!(
        paths.plugin_directory(),
        development_root.join("app/applications/tauri/resources/plugins")
    );
    assert!(matches!(paths.mode(), RuntimePathMode::Development(_)));
}

#[test]
fn runtime_paths_are_computed_once() {
    let cache = RuntimePathsCache::default();
    let computations = AtomicUsize::new(0);
    let resolve = || {
        computations.fetch_add(1, Ordering::SeqCst);
        RuntimePaths::resolve(
            RuntimePathMode::Packaged(PathBuf::from("package-root")),
            PathBuf::from("config"),
        )
    };

    let first = cache
        .get_or_try_init(resolve)
        .expect("first path resolution");
    let second = cache
        .get_or_try_init(resolve)
        .expect("cached path resolution");

    assert!(std::ptr::eq(first, second));
    assert_eq!(computations.load(Ordering::SeqCst), 1);
}

#[test]
fn production_uses_one_app_state_path_cache_and_the_shared_tauri_runtime() {
    let lib_source = include_str!("../src/lib.rs");
    let sidecar_source = include_str!("../src/sidecar.rs");

    assert!(
        lib_source.contains("runtime_paths: startup::RuntimePathsCache"),
        "AppState must own the one runtime-path cache"
    );
    assert!(
        lib_source.contains("backend_stop_fallback"),
        "AppState must retain an exact-child stop fallback after readiness"
    );
    assert!(
        lib_source.contains("tauri::async_runtime::spawn(async move"),
        "backend startup must use Tauri's shared async runtime"
    );
    assert!(
        !sidecar_source.contains("tokio::runtime::Runtime::new()"),
        "sidecar must not create a second Tokio runtime"
    );
    assert!(
        sidecar_source.contains("terminate_and_reap_backend"),
        "direct cleanup must reap its owned child after tree termination"
    );
    assert!(
        sidecar_source.contains("terminate_process_tree_async(pid).await"),
        "PTY timeout cleanup must leave blocking process-tree termination off async workers"
    );
    let direct_start = sidecar_source
        .split("async fn start_backend_direct_process")
        .nth(1)
        .and_then(|source| source.split("pub async fn start_backend_process").next())
        .expect("direct backend startup source");
    let startup_wait = direct_start
        .split("let app_handle_exit")
        .next()
        .expect("direct startup wait source");
    assert!(
        startup_wait.contains("stop = stop_fallback_rx.recv()"),
        "an unready direct child must consume the exact-child stop fallback"
    );
    assert!(direct_start.contains("wait_for_owned_loopback"));
    assert!(direct_start.contains("child.try_wait()"));
    assert!(direct_start.contains("kill_on_drop(true)"));
    assert!(
        direct_start
            .matches("kill_and_reap_backend_child(&mut child)")
            .count()
            >= 2,
        "readiness cancellation and publication races must kill before reaping"
    );
    assert!(
        !direct_start.contains("backend_stdout_confirms_port"),
        "direct readiness must not depend on backend log formatting"
    );
    assert!(direct_start.contains("stop_fallback_rx.recv()"));
    assert!(sidecar_source.contains("stop_fallback_rx.blocking_recv()"));
}

#[test]
fn backend_start_is_scheduled_before_the_main_webview_is_built() {
    let lib_source = include_str!("../src/lib.rs");
    let setup_source = lib_source
        .split(".setup(move |app|")
        .nth(1)
        .and_then(|source| source.split(".invoke_handler").next())
        .expect("Tauri setup source");
    let backend_start = setup_source
        .find("sidecar::start_backend")
        .expect("backend start task");
    let webview_build = setup_source
        .find("WebviewWindowBuilder::from_config")
        .expect("configured main webview build");

    assert!(backend_start < webview_build);
}

#[test]
fn main_webview_bridges_theia_popups_to_tauri_windows() {
    let lib_source = include_str!("../src/lib.rs");
    let setup_source = lib_source
        .split(".setup(move |app|")
        .nth(1)
        .and_then(|source| source.split(".invoke_handler").next())
        .expect("Tauri setup source");

    assert!(setup_source.contains(".on_new_window"));
    assert!(setup_source.contains("is_trusted_secondary_window_url"));
    assert!(setup_source.contains("NewWindowResponse::Create"));
    assert!(setup_source.contains("NewWindowResponse::Deny"));
}

#[test]
fn closing_the_main_window_closes_tauri_secondary_windows() {
    let lib_source = include_str!("../src/lib.rs");

    assert!(lib_source.contains("RunEvent::WindowEvent"));
    assert!(lib_source.contains("WindowEvent::CloseRequested"));
    assert!(lib_source.contains("WindowEvent::Destroyed"));
    assert!(lib_source.contains("close_secondary_windows"));
    assert!(lib_source.contains("app_handle.exit(0)"));

    let close_source = lib_source
        .split("if label == \"main\" => {")
        .nth(1)
        .and_then(|source| source.split("#[cfg(target_os = \"macos\")]").next())
        .expect("main-window close handler");
    let backend_stop = close_source
        .find("shutdown_application")
        .expect("ordered application shutdown in close handler");
    let app_exit = close_source.find("app_handle.exit(0)").expect("app exit");
    assert!(backend_stop < app_exit);

    let shutdown_source = lib_source
        .split("fn shutdown_application")
        .nth(1)
        .and_then(|source| source.split("fn restore_main_window").next())
        .expect("ordered shutdown helper");
    assert!(
        shutdown_source
            .find("gateway.shutdown")
            .expect("gateway stop")
            < shutdown_source
                .find("sidecar::stop_backend")
                .expect("backend process-tree cleanup")
    );
}
