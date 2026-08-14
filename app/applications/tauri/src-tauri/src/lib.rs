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
pub mod sidecar;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

const MAX_PENDING_LAUNCH_INTENTS: usize = 64;

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
    pub backend_pid: Mutex<Option<u32>>,
    pub backend_stopping: Mutex<bool>,
    pub downloads: download::DownloadManager,
    pub launch_intent_router: launch_intent::LaunchIntentRouter,
}

impl AppState {
    fn new(initial_launch_intent: Option<launch_intent::LaunchIntent>) -> Self {
        Self {
            backend_port: Mutex::new(None),
            backend_pid: Mutex::new(None),
            backend_stopping: Mutex::new(false),
            downloads: download::DownloadManager::new(),
            launch_intent_router: launch_intent::LaunchIntentRouter::new(
                MAX_PENDING_LAUNCH_INTENTS,
                initial_launch_intent,
            ),
        }
    }
}

/// Registers the activation plugin first, then injects its state before the
/// returned builder can initialize plugins.
fn configure_activation_builder<B, P, RegisterPlugin, ManageState>(
    builder: B,
    activation_plugin: P,
    initial_launch_intent: Option<launch_intent::LaunchIntent>,
    register_plugin: RegisterPlugin,
    manage_state: ManageState,
) -> B
where
    RegisterPlugin: FnOnce(B, P) -> B,
    ManageState: FnOnce(B, AppState) -> B,
{
    let builder = register_plugin(builder, activation_plugin);
    manage_state(builder, AppState::new(initial_launch_intent))
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
            if let Err(e) = sidecar::stop_backend(&app_handle) {
                log::warn!("Failed to stop backend after shutdown signal: {}", e);
            }
            app_handle.exit(0);
        }
    });
}

#[cfg(not(unix))]
fn install_shutdown_signal_handlers(_app_handle: tauri::AppHandle) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        |builder, plugin| builder.plugin(plugin),
        |builder, state| builder.manage(state),
    );

    let app = builder
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                native_chrome::configure_native_window(&window);
            }
            native_chrome::install_menu_event_bridge(app.handle());

            // 初始化插件目录
            if let Err(e) = sidecar::initialize_plugins() {
                eprintln!("Failed to initialize plugins: {}", e);
            }

            // 初始化 sidecar 进程
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = sidecar::start_backend(&app_handle) {
                    eprintln!("Failed to start backend: {}", e);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_backend_port,
            commands::download_start,
            commands::download_cancel,
            commands::download_list,
            commands::download_plugin,
            commands::download_configured_plugins,
            native_chrome::ride_show_main_menu,
            native_chrome::ride_start_window_drag,
            native_chrome::ride_window_control,
            native_chrome::ride_frontend_ready,
            commands::open_directory,
            commands::save_file,
            commands::show_in_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    install_shutdown_signal_handlers(app.handle().clone());

    app.run(|app_handle, event| match event {
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
            if let Err(e) = sidecar::stop_backend(app_handle) {
                log::warn!("Failed to stop backend during shutdown: {}", e);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

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
}
