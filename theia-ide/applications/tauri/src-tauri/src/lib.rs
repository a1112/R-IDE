/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Tauri 应用库模块

pub mod sidecar;
pub mod commands;

use std::sync::Mutex;
use tauri::Manager;

// 全局状态：存储 Node.js 后端的端口号
pub struct AppState {
    pub backend_port: Mutex<Option<u16>>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
