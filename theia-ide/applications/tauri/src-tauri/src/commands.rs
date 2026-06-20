/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use tauri::{AppHandle, State, Emitter};
use crate::AppState;

/// 获取后端服务的端口号
#[tauri::command]
pub fn get_backend_port(state: State<AppState>) -> Result<Option<u16>, String> {
    Ok(*state.backend_port.lock().unwrap())
}

/// 打开目录选择器
#[tauri::command]
pub fn open_directory() -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // TODO: 实现目录选择逻辑
    Ok(None)
}

/// 保存文件对话框
#[tauri::command]
pub fn save_file() -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
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
