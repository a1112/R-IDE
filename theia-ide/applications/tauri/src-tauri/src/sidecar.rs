/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use std::path::{Path, PathBuf};
use std::time::Duration;
use std::fs;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use dirs::home_dir;

const BACKEND_STARTUP_TIMEOUT: u64 = 120; // seconds

/// 查找 Node.js 可执行文件
fn find_node_executable() -> Option<PathBuf> {
    // 检查环境变量 PATH 中的 node
    if let Ok(output) = std::process::Command::new("where").arg("node").output() {
        if output.status.success() {
            if let Some(path) = String::from_utf8_lossy(&output.stdout).lines().next() {
                return Some(PathBuf::from(path.trim()));
            }
        }
    }

    // 常见安装路径
    let common_paths = vec![
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        r"C:\Users\[USER]\AppData\Roaming\npm\node.cmd",
    ];

    for path in common_paths {
        let expanded = path.replace("[USER]", &std::env::var("USERNAME").unwrap_or_default());
        let path_buf = PathBuf::from(expanded);
        if path_buf.exists() {
            return Some(path_buf);
        }
    }

    None
}

/// 查找并返回 Node.js 后端主文件路径
fn get_backend_script() -> PathBuf {
    // 优先使用环境变量指定的路径（用于开发）
    if let Ok(path) = std::env::var("RIDE_BACKEND_PATH") {
        return PathBuf::from(path);
    }

    // 尝试几个可能的位置
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = exe_path.parent().unwrap_or(&Path::new("."));

    let possible_locations = vec![
        // Tauri 资源目录（打包时复制）- 标准路径
        exe_dir.join("resources").join("backend").join("main.js"),
        // Tauri 资源目录 - 嵌套路径（resources 映射可能导致嵌套）
        exe_dir.join("resources").join("backend").join("backend").join("main.js"),
        // 开发环境：browser 应用的构建目录
        current_dir.join("applications").join("browser").join("lib").join("backend").join("main.js"),
        // 相对于当前目录
        current_dir.join("lib").join("backend").join("main.js"),
    ];

    for location in &possible_locations {
        if location.exists() {
            log::info!("Found backend script at: {:?}", location);
            return location.clone();
        }
    }

    // 默认：返回第一个路径，即使不存在（会在启动时报错）
    possible_locations[0].clone()
}

/// 后端运行配置
struct BackendConfig {
    node_exe: PathBuf,
    script_path: PathBuf,
    use_node: bool,
}

/// 查找并返回后端运行配置
fn get_backend_config() -> BackendConfig {
    // 首先尝试找到 Node.js
    if let Some(node_exe) = find_node_executable() {
        let script_path = get_backend_script();
        log::info!("Using Node.js to run backend: {:?} {:?}", node_exe, script_path);
        return BackendConfig {
            node_exe,
            script_path,
            use_node: true,
        };
    }

    // 回退到 pkg 编译的二进制
    let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = exe_path.parent().unwrap_or(&Path::new("."));
    let mut sidecar_path = exe_dir.join("theia-backend");

    if cfg!(windows) && !sidecar_path.extension().is_some_and(|e| e == "exe") {
        sidecar_path.set_extension("exe");
    }

    log::info!("Using pkg compiled backend: {:?}", sidecar_path);

    BackendConfig {
        node_exe: sidecar_path.clone(),
        script_path: sidecar_path,
        use_node: false,
    }
}

/// 查找并返回 Node.js 后端二进制文件路径（已弃用，保留用于兼容）
fn get_backend_binary() -> PathBuf {
    get_backend_config().script_path
}

/// 获取插件目录路径
fn get_plugins_dir() -> PathBuf {
    // 优先使用环境变量
    if let Ok(path) = std::env::var("RIDE_PLUGINS_DIR") {
        return PathBuf::from(path);
    }

    // 尝试几个可能的位置
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));

    let possible_locations = vec![
        // Tauri 资源目录（优先使用打包的插件）
        exe_dir.join("resources").join("plugins"),
        // 当前工作目录
        current_dir.join("applications").join("tauri").join("resources").join("plugins"),
        // 项目根目录的 plugins
        current_dir.join("plugins"),
        // 用户配置目录
        home.join(".ride").join("plugins"),
    ];

    for location in possible_locations {
        if location.exists() {
            log::info!("Using plugins directory: {:?}", location);
            return location;
        }
    }

    // 默认：使用用户配置目录
    let default_plugins = home_dir()
        .unwrap_or_default()
        .join(".ride")
        .join("plugins");

    log::info!("Creating default plugins directory: {:?}", default_plugins);
    fs::create_dir_all(&default_plugins).unwrap_or_else(|e| {
        log::warn!("Failed to create plugins directory: {}", e);
    });

    default_plugins
}

/// 初始化插件目录（从打包的资源复制到用户目录）
pub fn initialize_plugins() -> Result<(), String> {
    let exe_path = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = exe_path.parent().unwrap_or(&Path::new("."));
    let bundled_plugins = exe_dir.join("resources").join("plugins");

    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
    let user_plugins = home.join(".ride").join("plugins");

    // 如果打包的插件存在且用户插件为空或不存在，则复制
    if bundled_plugins.exists() {
        if !user_plugins.exists() || user_plugins.read_dir().map_or(true, |mut it| it.next().is_none()) {
            log::info!("Copying bundled plugins to user directory: {:?} -> {:?}", bundled_plugins, user_plugins);

            fs::create_dir_all(&user_plugins).map_err(|e| format!("Failed to create plugins directory: {}", e))?;

            // 复制插件目录
            copy_dir_recursive(&bundled_plugins, &user_plugins).map_err(|e| format!("Failed to copy plugins: {}", e))?;

            log::info!("Plugins initialized successfully");
        }
    }

    Ok(())
}

/// 递归复制目录
fn copy_dir_recursive(source: &PathBuf, destination: &PathBuf) -> std::io::Result<()> {
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let src = entry.path();
        let dst = destination.join(entry.file_name());

        if ty.is_dir() {
            fs::create_dir_all(&dst)?;
            copy_dir_recursive(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// 获取配置目录路径
fn get_config_dir() -> PathBuf {
    if let Ok(path) = std::env::var("RIDE_CONFIG_DIR") {
        return PathBuf::from(path);
    }

    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
    let config_dir = home.join(".ride");

    fs::create_dir_all(&config_dir).unwrap_or_else(|e| {
        log::warn!("Failed to create config directory: {}", e);
    });

    config_dir
}

/// 启动 Node.js 后端进程
pub async fn start_backend_process(app_handle: &AppHandle) -> Result<u16, String> {
    let config = get_backend_config();

    if config.use_node {
        if !config.node_exe.exists() {
            return Err(format!("Node.js not found at: {:?}", config.node_exe));
        }
        if !config.script_path.exists() {
            return Err(format!("Backend script not found at: {:?}", config.script_path));
        }
    } else {
        if !config.script_path.exists() {
            return Err(format!("Backend binary not found at: {:?}", config.script_path));
        }
    }

    log::info!("Starting backend with config: use_node={}, node_exe={:?}, script={:?}",
               config.use_node, config.node_exe, config.script_path);

    let plugins_dir = get_plugins_dir();
    let config_dir = get_config_dir();

    // 设置命令
    let mut cmd = if config.use_node {
        let mut c = Command::new(&config.node_exe);
        c.arg(&config.script_path).arg("--log-level=info");
        c
    } else {
        Command::new(&config.script_path)
    };

    // 设置环境变量
    if cfg!(windows) {
        cmd.env("NODE_ENV", "production");
    }

    // 设置插件路径
    cmd.env("THEIA_PLUGINS_DIR", plugins_dir.to_string_lossy().to_string())
       .env("THEIA_CONFIG_DIR", config_dir.to_string_lossy().to_string());

    // Theia 后端会尝试查找并启动在可用端口上
    // 我们需要捕获它的输出来获取实际使用的端口

    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn backend: {}", e))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let app_handle_stdout = app_handle.clone();
    let app_handle_stderr = app_handle.clone();

    // 在后台读取输出
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::info!("Backend stdout: {}", line);

            // 解析端口号
            // Theia 通常会输出类似 "Server started on port XXXX" 的信息
            if line.contains("port") || line.contains("listening") {
                if let Some(port_str) = extract_port_from_line(&line) {
                    if let Ok(port) = port_str.parse::<u16>() {
                        let _ = app_handle_stdout.emit("backend-ready", port);
                    }
                }
            }

            let _ = app_handle_stdout.emit("backend-log", line);
        }
    });

    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::warn!("Backend stderr: {}", line);
            let _ = app_handle_stderr.emit("backend-error", line);
        }
    });

    // 等待进程启动并获取端口
    // 注意：这是一个简化的实现，实际可能需要更复杂的健康检查

    // 暂时返回默认端口，实际应该从输出中解析
    // TODO: 实现端口监听和解析逻辑
    Ok(3000)
}

/// 从日志行中提取端口号
fn extract_port_from_line(line: &str) -> Option<String> {
    // 匹配常见的端口输出格式
    // "Server started on port 3000"
    // "Listening on *:3000"
    // "http://localhost:3000"
    let patterns = vec![
        r"port (\d{4,5})",
        r":(\d{4,5})",
        r"(\d{4,5})",
    ];

    for pattern in patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(line) {
                if let Some(port) = caps.get(1) {
                    return Some(port.as_str().to_string());
                }
            }
        }
    }

    None
}

/// 启动后端的主函数（在独立线程中运行）
pub fn start_backend(app_handle: &AppHandle) -> Result<(), String> {
    let rt = tokio::runtime::Runtime::new()
        .map_err(|e| format!("Failed to create async runtime: {}", e))?;

    let app_handle = app_handle.clone();

    rt.block_on(async {
        match start_backend_process(&app_handle).await {
            Ok(port) => {
                log::info!("Backend started successfully on port {}", port);

                // 存储端口号到全局状态
                if let Some(state) = app_handle.try_state::<crate::AppState>() {
                    *state.backend_port.lock().unwrap() = Some(port);
                }

                Ok(())
            }
            Err(e) => {
                log::error!("Failed to start backend: {}", e);
                let _ = app_handle.emit("backend-error", format!("Failed to start: {}", e));
                Err(e)
            }
        }
    })
}

/// 停止后端进程
pub fn stop_backend(app_handle: &AppHandle) -> Result<(), String> {
    // TODO: 实现优雅关闭逻辑
    log::info!("Stopping backend...");
    Ok(())
}
