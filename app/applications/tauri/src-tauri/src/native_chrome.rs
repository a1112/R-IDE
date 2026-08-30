/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewWindow};

use crate::startup_metrics::StartupMilestone;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct MenuPopupRequest {
    pub x: f64,
    pub y: f64,
    pub language: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
struct NativeMenuCommandPayload {
    command: String,
}

#[tauri::command]
pub fn ride_start_window_drag(window: WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ride_window_control(window: WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "close" => window.close(),
        "minimize" => window.minimize(),
        "toggleMaximize" => {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        other => return Err(format!("Unsupported window action: {other}")),
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn ride_frontend_ready(
    app: AppHandle,
    window: WebviewWindow,
    locale: Option<String>,
) -> Result<(), String> {
    log::info!(
        "Frontend ready (locale={})",
        locale.as_deref().unwrap_or("unknown")
    );

    let state = app.state::<AppState>();
    let report = state.launch_intent_router.frontend_ready_after_show(
        || window.set_focus(),
        |error| log::warn!("Failed to focus main window after frontend ready: {error}"),
        |intent| app.emit_to("main", "ride-open-request", intent),
    );
    for failure in report.failures {
        log::warn!(
            "Failed to emit frontend-ready launch intent {}: {}",
            failure.intent.id,
            failure.error
        );
    }
    Ok(())
}

#[tauri::command]
pub fn ride_record_startup_milestone(
    app: AppHandle,
    milestone: StartupMilestone,
) -> Result<(), String> {
    if !milestone.is_frontend_reportable() {
        return Err(format!(
            "Startup milestone {milestone:?} cannot be reported by the frontend"
        ));
    }

    app.state::<AppState>()
        .startup_metrics
        .record_or_warn(milestone);
    Ok(())
}

#[tauri::command]
pub fn ride_show_main_menu(
    app: AppHandle,
    window: WebviewWindow,
    request: MenuPopupRequest,
) -> Result<(), String> {
    let english = request
        .language
        .as_deref()
        .map(|language| language.to_ascii_lowercase().starts_with("en"))
        .unwrap_or(false);
    let t = |zh: &'static str, en: &'static str| -> &'static str {
        if english {
            en
        } else {
            zh
        }
    };

    let zh_label = if english {
        "Chinese (Simplified)"
    } else {
        "✓ 简体中文"
    };
    let en_label = if english { "✓ English" } else { "English" };

    let file_menu = SubmenuBuilder::new(&app, t("文件", "File"))
        .text(
            "workbench.action.files.newUntitledFile",
            t("新建文件", "New File"),
        )
        .text("workspace:openFile", t("打开文件...", "Open File..."))
        .text("workspace:openFolder", t("打开文件夹...", "Open Folder..."))
        .text("workspace:openRecent", t("打开最近", "Open Recent"))
        .separator()
        .text("core.save", t("保存", "Save"))
        .text("core.saveAll", t("全部保存", "Save All"))
        .build()
        .map_err(|error| error.to_string())?;

    let edit_menu = SubmenuBuilder::new(&app, t("编辑", "Edit"))
        .text("core.undo", t("撤销", "Undo"))
        .text("core.redo", t("重做", "Redo"))
        .separator()
        .text("core.cut", t("剪切", "Cut"))
        .text("core.copy", t("复制", "Copy"))
        .text("core.paste", t("粘贴", "Paste"))
        .text("core.find", t("查找", "Find"))
        .build()
        .map_err(|error| error.to_string())?;

    let view_menu = SubmenuBuilder::new(&app, t("视图", "View"))
        .text(
            "workbench.action.showCommands",
            t("命令面板...", "Command Palette..."),
        )
        .text(
            "workbench.action.quickOpen",
            t("快速打开...", "Quick Open..."),
        )
        .separator()
        .text("fileNavigator:toggle", t("资源管理器", "Explorer"))
        .text(
            "core.toggle.left.panel",
            t("切换左侧栏", "Toggle Left Sidebar"),
        )
        .text(
            "core.toggle.bottom.panel",
            t("切换底部面板", "Toggle Bottom Panel"),
        )
        .text(
            "core.toggle.right.panel",
            t("切换右侧栏", "Toggle Right Sidebar"),
        )
        .build()
        .map_err(|error| error.to_string())?;

    let run_menu = SubmenuBuilder::new(&app, t("运行", "Run"))
        .text("workbench.action.debug.run", t("运行", "Run"))
        .text(
            "workbench.action.debug.start",
            t("开始调试", "Start Debugging"),
        )
        .separator()
        .text("terminal:new", t("新建终端", "New Terminal"))
        .text(
            "terminal:new:active:workspace",
            t("在工作区中新建终端", "New Terminal in Workspace"),
        )
        .build()
        .map_err(|error| error.to_string())?;

    let window_menu = SubmenuBuilder::new(&app, t("窗口", "Window"))
        .text("ride.window.minimize", t("最小化", "Minimize"))
        .text(
            "ride.window.toggleMaximize",
            t("最大化/还原", "Maximize/Restore"),
        )
        .separator()
        .text(
            "workbench.action.closeActiveEditor",
            t("关闭编辑器", "Close Editor"),
        )
        .text(
            "workbench.action.closeAllEditors",
            t("关闭所有编辑器", "Close All Editors"),
        )
        .build()
        .map_err(|error| error.to_string())?;

    let language_menu = SubmenuBuilder::new(&app, t("语言", "Language"))
        .text("ride.language.zh-cn", zh_label)
        .text("ride.language.en", en_label)
        .separator()
        .text(
            "workbench.action.configureLanguage",
            t("更多显示语言...", "Configure Display Language..."),
        )
        .build()
        .map_err(|error| error.to_string())?;

    let help_menu = SubmenuBuilder::new(&app, t("帮助", "Help"))
        .text("workbench.action.openGlobalSettings", t("设置", "Settings"))
        .text("theia-ide:documentation", t("文档", "Documentation"))
        .text("theia-ide:report-issue", t("报告问题", "Report Issue"))
        .build()
        .map_err(|error| error.to_string())?;

    let menu = MenuBuilder::new(&app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&run_menu)
        .item(&window_menu)
        .item(&language_menu)
        .item(&help_menu)
        .separator()
        .text(
            "workbench.action.showCommands",
            t("命令面板...", "Command Palette..."),
        )
        .build()
        .map_err(|error| error.to_string())?;

    window
        .popup_menu_at(&menu, LogicalPosition::new(request.x, request.y))
        .map_err(|error| error.to_string())
}

pub fn install_menu_event_bridge(app: &AppHandle) {
    app.on_menu_event(|app_handle, event| {
        let command = event.id().as_ref().to_string();
        if command.starts_with("__") {
            return;
        }

        let payload = NativeMenuCommandPayload { command };
        if let Err(error) = app_handle.emit_to("main", "ride-native-menu-command", payload) {
            log::warn!("Failed to emit native menu command: {}", error);
        }
    });
}

pub fn configure_native_window(window: &WebviewWindow) {
    if let Err(error) = window.set_decorations(false) {
        log::warn!("Failed to disable native window decorations: {error}");
    }

    #[cfg(target_os = "macos")]
    configure_macos_window(window);

    #[cfg(all(not(mobile), target_os = "macos"))]
    apply_macos_vibrancy(window);
}

#[cfg(target_os = "macos")]
fn configure_macos_window(window: &WebviewWindow) {
    use objc2::{class, msg_send, runtime::AnyObject};

    const WINDOW_CORNER_RADIUS: f64 = 10.0;

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };

    unsafe {
        let ns_window = ns_window_ptr.cast::<AnyObject>();
        let clear_color: *mut AnyObject = msg_send![class!(NSColor), clearColor];

        let _: () = msg_send![ns_window, setOpaque: false];
        let _: () = msg_send![ns_window, setBackgroundColor: clear_color];
        let _: () = msg_send![ns_window, setHasShadow: true];
        let _: () = msg_send![ns_window, setMovableByWindowBackground: false];

        let content_view: *mut AnyObject = msg_send![ns_window, contentView];
        if !content_view.is_null() {
            let _: () = msg_send![content_view, setWantsLayer: true];

            let layer: *mut AnyObject = msg_send![content_view, layer];
            if !layer.is_null() {
                let _: () = msg_send![layer, setCornerRadius: WINDOW_CORNER_RADIUS];
                let _: () = msg_send![layer, setMasksToBounds: true];
                let _: () = msg_send![layer, setAllowsEdgeAntialiasing: true];
                let _: () = msg_send![layer, setNeedsDisplay];
            }
        }

        let _: () = msg_send![ns_window, invalidateShadow];
    }
}

#[cfg(all(not(mobile), target_os = "macos"))]
fn apply_macos_vibrancy(window: &WebviewWindow) {
    use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial, NSVisualEffectState};

    if let Err(error) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::Active),
        Some(18.0),
    ) {
        log::warn!("Failed to apply macOS vibrancy: {}", error);
    }
}
