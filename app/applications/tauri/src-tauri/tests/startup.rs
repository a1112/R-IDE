/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use ride_tauri::startup::{
    attest_pty_cleanup_session, backend_process_session_column_name, finish_backend_stop,
    parse_backend_process_group_members, parse_backend_process_scope_members,
    parse_linux_listener_inodes, resolve_tauri_config_directory,
    validate_pty_cleanup_process_group, wait_for_loopback, wait_for_owned_loopback,
    BackendLaunchPlan, BackendOwnershipState, BackendReadinessPolicy, BackendSpawnPlan,
    BackendSpawnStrategy, BackendStartupAction, BackendStartupEvent, BackendStartupState,
    BackendTransport, RuntimePathMode, RuntimePaths, RuntimePathsCache,
};
use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

#[test]
fn process_group_enumeration_is_strict_and_never_drops_malformed_rows() {
    assert_eq!(
        parse_backend_process_group_members("4100 4100\n4101 4100\n4200 4200\n", 4100).unwrap(),
        vec![4100, 4101]
    );
    for malformed in [
        "4100 4100\nsecret 4100\n",
        "4100 4100 extra\n",
        "0 4100\n",
        "4100 0\n",
    ] {
        let error = parse_backend_process_group_members(malformed, 4100).unwrap_err();
        assert_eq!(error, "Malformed backend process-group enumeration row");
        assert!(!error.contains(malformed));
    }
}

#[test]
fn session_enumeration_discovers_groups_after_their_leader_exits() {
    assert_eq!(
        parse_backend_process_scope_members(
            "2 0 0\n4100 4100 4100\n4102 4101 4100\n4200 4200 4200\n",
            &[4100],
            Some(4100),
        )
        .unwrap(),
        (vec![4100, 4102], vec![4100, 4101])
    );

    for malformed in [
        "4100 4100\n",
        "4100 4100 4100 extra\n",
        "4100 4100 nope\n",
        "4100 0 4100\n",
    ] {
        let error =
            parse_backend_process_scope_members(malformed, &[4100], Some(4100)).unwrap_err();
        assert_eq!(error, "Malformed backend process-scope enumeration row");
        assert!(!error.contains(malformed));
    }
}

#[test]
fn process_scope_uses_each_platforms_supported_session_column() {
    assert_eq!(backend_process_session_column_name(false), "sid=");
    assert_eq!(backend_process_session_column_name(true), "sess=");
}

#[test]
fn pty_cleanup_group_must_be_positive_and_separate_from_the_app_group() {
    assert_eq!(
        validate_pty_cleanup_process_group(4_100, Some(4_101), 4_000).unwrap(),
        4_101
    );
    assert!(validate_pty_cleanup_process_group(4_100, None, 4_000).is_err());
    assert!(validate_pty_cleanup_process_group(4_100, Some(0), 4_000).is_err());
    assert!(validate_pty_cleanup_process_group(4_100, Some(4_000), 4_000).is_err());
}

#[test]
fn pty_cleanup_attests_the_isolated_root_session() {
    assert_eq!(
        attest_pty_cleanup_session(4_100, 4_100, 4_100, 4_000).unwrap(),
        4_100
    );
    assert!(attest_pty_cleanup_session(4_100, 4_101, 4_100, 4_000).is_err());
    assert!(attest_pty_cleanup_session(4_100, 4_100, 4_101, 4_000).is_err());
    assert!(attest_pty_cleanup_session(4_100, 4_000, 4_100, 4_000).is_err());
}

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
fn windows_pty_falls_back_to_direct_without_a_watcher() {
    let plan = BackendSpawnPlan::for_backend_on_platform(BackendTransport::Pty, true, true)
        .expect("Windows PTY must have a safe direct fallback");

    assert_eq!(plan.strategy(), BackendSpawnStrategy::DirectPipes);
    assert!(!plan.watcher_process());
    let warning = plan.warning().expect("fallback must be diagnosed");
    assert!(warning.contains("PTY"), "{warning}");
    assert!(warning.contains("direct"), "{warning}");
    assert!(warning.len() <= 256, "warning must remain bounded");
}

#[test]
fn unix_pty_preserves_the_watcher_when_tree_ownership_is_available() {
    let plan = BackendSpawnPlan::for_backend_on_platform(BackendTransport::Pty, true, false)
        .expect("Unix PTY process groups can own watcher descendants");

    assert_eq!(plan.strategy(), BackendSpawnStrategy::Pty);
    assert!(plan.watcher_process());
    assert_eq!(plan.warning(), None);

    let startup_source = include_str!("../src/startup.rs");
    let sidecar_source = include_str!("../src/sidecar.rs");
    assert!(startup_source.contains("claim_spawned_pty_backend_session_scope"));
    assert!(!sidecar_source.contains("retain_unclaimed_pty_cleanup"));
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
            BackendStartupAction::TerminateProcessTree(42),
            BackendStartupAction::ReapOwnedChild(42),
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
    assert!(ownership.has_owned_work());

    assert!(ownership.complete_start(launch));
    assert!(!ownership.is_stopping());
    assert!(!ownership.has_owned_work());
}

#[test]
fn a_registered_child_is_returned_for_stop_and_cannot_be_revived() {
    let mut ownership = BackendOwnershipState::default();
    let launch = ownership.reserve_start();
    assert!(ownership.register_spawn(launch, 42));
    assert!(ownership.owns_active(42));

    assert_eq!(ownership.request_stop(), Some(42));
    assert_eq!(ownership.request_stop(), None);
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
fn repeated_stop_preserves_the_exact_child_awaiting_reap() {
    let mut ownership = BackendOwnershipState::default();
    let launch = ownership.reserve_start();
    assert!(ownership.register_spawn(launch, 42));

    assert_eq!(ownership.request_stop(), Some(42));
    assert_eq!(ownership.request_stop(), None);
    assert!(ownership.owns_process(42));
    assert!(ownership.has_owned_work());

    assert!(ownership.clear_spawn(42));
    assert!(!ownership.has_owned_work());
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
fn an_exited_root_retains_generation_tree_ownership_until_confirmed_cleanup() {
    let mut ownership = BackendOwnershipState::default();
    let launch = ownership.reserve_start();
    assert!(ownership.register_spawn(launch, 42));

    assert!(!ownership.mark_root_exited(42));

    assert_eq!(ownership.pid(), None);
    assert!(ownership.has_owned_work());
    assert!(ownership.owns_process(42));
    assert_eq!(ownership.request_stop(), Some(42));
    assert!(ownership.has_owned_work());

    assert!(ownership.clear_spawn(42));
    assert!(!ownership.has_owned_work());
}

#[test]
fn a_stale_root_exit_cannot_change_the_current_generation() {
    let mut ownership = BackendOwnershipState::default();
    let launch = ownership.reserve_start();
    assert!(ownership.register_spawn(launch, 42));

    assert!(!ownership.mark_root_exited(7));

    assert_eq!(ownership.pid(), Some(42));
    assert!(ownership.owns_active(42));
    assert!(!ownership.owns_process(7));
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
        sidecar_source.contains("cleanup_owned_direct_backend"),
        "direct cleanup must confirm its owned tree before releasing the reaped child"
    );
    assert!(
        sidecar_source.contains("terminate_owned_tree_async"),
        "startup cleanup must leave owned-tree termination off async workers"
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
    assert!(direct_start.contains("observe_backend_root_exit"));
    assert!(
        !direct_start.contains("child.try_wait()"),
        "Unix liveness checks must not reap the root before process-group cleanup"
    );
    assert!(direct_start.contains("kill_on_drop(true)"));
    assert!(
        direct_start
            .matches("cleanup_or_retain_owned_direct_backend(")
            .count()
            >= 6,
        "startup failures and publication races must retain the owned-tree cleanup transaction"
    );
    assert!(
        direct_start
            .matches("retain_owned_direct_backend_cleanup(")
            .count()
            >= 2,
        "post-spawn setup failures must transfer child ownership to a cleanup retry task"
    );
    assert!(
        !direct_start.contains("backend_stdout_confirms_port"),
        "direct readiness must not depend on backend log formatting"
    );
    assert!(direct_start.contains("stop_fallback_rx.recv()"));
    assert!(sidecar_source.contains("stop_rx.blocking_recv()"));
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
    let prevent_close = close_source
        .find("api.prevent_close()")
        .expect("main-window destruction is deferred during cleanup");
    let scheduled_shutdown = close_source
        .find("request_application_shutdown(app_handle.clone())")
        .expect("application shutdown is scheduled off the window callback");
    assert!(prevent_close < scheduled_shutdown);
    assert!(!close_source.contains("block_on"));

    let exit_request_source = lib_source
        .split("tauri::RunEvent::ExitRequested")
        .nth(1)
        .and_then(|source| source.split("tauri::RunEvent::Exit").next())
        .expect("exit-request handler");
    assert!(exit_request_source.contains("api.prevent_exit()"));

    let retained_cleanup = lib_source
        .split("fn retain_failed_application_cleanup")
        .nth(1)
        .and_then(|source| source.split("fn restore_main_window").next())
        .expect("retained application cleanup helper");
    assert!(retained_cleanup.contains("std::thread::spawn"));
    assert!(retained_cleanup.contains("stop_backend_bounded"));
    assert!(retained_cleanup.contains("force_release_backend_for_exit"));

    let shutdown_source = lib_source
        .split("async fn shutdown_application")
        .nth(1)
        .and_then(|source| source.split("fn restore_main_window").next())
        .expect("ordered shutdown helper");
    assert!(shutdown_source.contains("application_shutdown"));
    assert!(shutdown_source.contains(".run("));
    assert!(
        shutdown_source
            .find("gateway.shutdown")
            .expect("gateway stop")
            < shutdown_source
                .rfind("sidecar::stop_backend_bounded")
                .expect("ordered backend process-tree cleanup")
    );

    let request_source = lib_source
        .split("fn request_application_shutdown")
        .nth(1)
        .and_then(|source| source.split("fn retain_failed_application_cleanup").next())
        .expect("non-blocking shutdown request helper");
    assert!(request_source.contains("tauri::async_runtime::spawn"));
    assert!(request_source.contains("shutdown_application(&app_handle).await"));
    assert!(request_source.contains("app_handle.exit(0)"));
}
