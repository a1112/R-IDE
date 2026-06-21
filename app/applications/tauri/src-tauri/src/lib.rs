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
pub mod sidecar;

use std::sync::Mutex;
use tauri::Manager;

// 全局状态：存储 Node.js 后端的端口号
pub struct AppState {
    pub backend_port: Mutex<Option<u16>>,
    pub backend_pid: Mutex<Option<u32>>,
    pub backend_stopping: Mutex<bool>,
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
    let _ = env_logger::try_init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 单实例：聚焦已存在的窗口
            let window = app.get_webview_window("main").unwrap();
            let _ = window.set_ignore_cursor_events(false);
            let _ = window.set_focus();
            let _ = window.unminimize();
        }))
        .setup(|app| {
            // 初始化全局状态
            app.manage(AppState {
                backend_port: Mutex::new(None),
                backend_pid: Mutex::new(None),
                backend_stopping: Mutex::new(false),
            });

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
            commands::open_directory,
            commands::save_file,
            commands::show_in_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    install_shutdown_signal_handlers(app.handle().clone());

    app.run(|app_handle, event| match event {
        tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit => {
            if let Err(e) = sidecar::stop_backend(app_handle) {
                log::warn!("Failed to stop backend during shutdown: {}", e);
            }
        }
        _ => {}
    });
}
