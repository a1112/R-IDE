/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use crate::download::{
    ConfiguredPluginsRequest, DownloadCancelRequest, DownloadStartRequest, DownloadTask,
    PluginDownloadRequest, PluginDownloadResult,
};
use crate::AppState;
use tauri::{AppHandle, State};

/// 获取后端服务的端口号
#[tauri::command]
pub fn get_backend_port(state: State<AppState>) -> Result<Option<u16>, String> {
    Ok(*state.backend_port.lock().unwrap())
}

/// Start a native Rust-backed download task.
#[tauri::command]
pub fn download_start(
    app: AppHandle,
    state: State<AppState>,
    request: DownloadStartRequest,
) -> Result<DownloadTask, String> {
    state.downloads.start_download(app, request)
}

/// Cancel a queued or running native download task.
#[tauri::command]
pub fn download_cancel(
    state: State<AppState>,
    request: DownloadCancelRequest,
) -> Result<bool, String> {
    Ok(state.downloads.cancel(&request.id))
}

/// List native download tasks known to this process.
#[tauri::command]
pub fn download_list(state: State<AppState>) -> Result<Vec<DownloadTask>, String> {
    Ok(state.downloads.list())
}

/// Download and install a single VS Code plugin archive into ~/.ride/plugins.
#[tauri::command]
pub async fn download_plugin(
    app: AppHandle,
    state: State<'_, AppState>,
    request: PluginDownloadRequest,
) -> Result<PluginDownloadResult, String> {
    state.downloads.download_plugin(app, request).await
}

/// Download and install plugins from the bundled package.json theiaPlugins map.
#[tauri::command]
pub async fn download_configured_plugins(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ConfiguredPluginsRequest,
) -> Result<Vec<PluginDownloadResult>, String> {
    state
        .downloads
        .download_configured_plugins(app, request)
        .await
}

/// 打开目录选择器
#[tauri::command]
pub fn open_directory() -> Result<Option<String>, String> {
    // TODO: 实现目录选择逻辑
    Ok(None)
}

/// 保存文件对话框
#[tauri::command]
pub fn save_file() -> Result<Option<String>, String> {
    // TODO: 实现保存文件逻辑
    Ok(None)
}

/// 在文件管理器中显示文件
#[tauri::command]
pub fn show_in_folder(path: String) -> Result<(), String> {
    use std::path::Path;

    if !Path::new(&path).exists() {
        return Err("Path does not exist".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }

    #[cfg(target_os = "macos")]
    {
        use std::process::Command;
        Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to show in folder: {}", e))?;
    }

    Ok(())
}
