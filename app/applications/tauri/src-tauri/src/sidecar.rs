/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use dirs::home_dir;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const BACKEND_STARTUP_TIMEOUT: u64 = 240; // seconds

fn current_exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn resource_dir_candidates() -> Vec<PathBuf> {
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = current_exe_dir();
    let mut candidates = Vec::new();

    for base in [&current_dir, &exe_dir] {
        for ancestor in base.ancestors().take(10) {
            candidates.push(
                ancestor
                    .join("applications")
                    .join("tauri")
                    .join("resources"),
            );
        }
    }

    candidates.extend([
        exe_dir.join("resources"),
        current_dir.join("resources"),
        current_dir
            .join("applications")
            .join("tauri")
            .join("resources"),
    ]);

    if let Some(contents_dir) = exe_dir.parent() {
        candidates.push(contents_dir.join("Resources").join("resources"));
    }

    candidates
}

/// 查找 Node.js 可执行文件
fn find_node_executable() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("RIDE_NODE_PATH") {
        let node_path = PathBuf::from(path);
        if node_path.exists() {
            return Some(node_path);
        }
    }

    for resources_dir in resource_dir_candidates() {
        let bundled_node = resources_dir
            .join("backend")
            .join("runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        if bundled_node.exists() {
            return Some(bundled_node);
        }
    }

    let probe_command = if cfg!(windows) { "where" } else { "which" };
    let probe_args: &[&str] = &["node"];

    if let Ok(output) = StdCommand::new(probe_command).args(probe_args).output() {
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
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
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

    let mut possible_locations: Vec<PathBuf> = resource_dir_candidates()
        .into_iter()
        .flat_map(|resources_dir| {
            [
                resources_dir.join("backend").join("main.js"),
                resources_dir
                    .join("backend")
                    .join("backend")
                    .join("main.js"),
            ]
        })
        .collect();

    possible_locations.extend([
        // 开发环境：从 Tauri 应用目录运行
        current_dir.join("../browser/lib/backend/main.js"),
        // 开发环境：从 src-tauri 目录运行
        current_dir.join("../../browser/lib/backend/main.js"),
        // 开发环境：browser 应用的构建目录
        current_dir
            .join("applications")
            .join("browser")
            .join("lib")
            .join("backend")
            .join("main.js"),
        // 相对于当前目录
        current_dir.join("lib").join("backend").join("main.js"),
    ]);

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
        log::info!(
            "Using Node.js to run backend: {:?} {:?}",
            node_exe,
            script_path
        );
        return BackendConfig {
            node_exe,
            script_path,
            use_node: true,
        };
    }

    // 回退到 pkg 编译的二进制
    let exe_dir = current_exe_dir();
    let mut sidecar_path = exe_dir.join("theia-backend");

    if cfg!(windows) && sidecar_path.extension().is_none_or(|e| e != "exe") {
        sidecar_path.set_extension("exe");
    }

    log::info!("Using pkg compiled backend: {:?}", sidecar_path);

    BackendConfig {
        node_exe: sidecar_path.clone(),
        script_path: sidecar_path,
        use_node: false,
    }
}

/// 获取插件目录路径
fn get_plugins_dir() -> PathBuf {
    // 优先使用环境变量
    if let Ok(path) = std::env::var("RIDE_PLUGINS_DIR") {
        return PathBuf::from(path);
    }

    // 尝试几个可能的位置
    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = current_exe_dir();
    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));

    let mut possible_locations: Vec<PathBuf> = resource_dir_candidates()
        .into_iter()
        .map(|resources_dir| resources_dir.join("plugins"))
        .collect();

    possible_locations.extend([
        // 当前工作目录
        current_dir
            .join("applications")
            .join("tauri")
            .join("resources")
            .join("plugins"),
        // 开发环境：从 Tauri 应用目录运行
        current_dir.join("../../plugins"),
        // 开发环境：从 src-tauri 目录运行
        current_dir.join("../../../plugins"),
        // 项目根目录的 plugins
        current_dir.join("plugins"),
        // 用户配置目录
        home.join(".ride").join("plugins"),
    ]);

    for base in [&current_dir, &exe_dir] {
        possible_locations.extend(
            base.ancestors()
                .take(8)
                .map(|ancestor| ancestor.join("plugins")),
        );
    }

    for location in possible_locations {
        if is_plugin_dir_ready(&location) {
            log::info!("Using plugins directory: {:?}", location);
            return location;
        }
    }

    // 默认：使用用户配置目录
    let default_plugins = home_dir().unwrap_or_default().join(".ride").join("plugins");

    log::info!("Creating default plugins directory: {:?}", default_plugins);
    fs::create_dir_all(&default_plugins).unwrap_or_else(|e| {
        log::warn!("Failed to create plugins directory: {}", e);
    });

    default_plugins
}

fn is_plugin_dir_ready(location: &Path) -> bool {
    if !location.is_dir() {
        return false;
    }

    location.read_dir().is_ok_and(|entries| {
        entries.flatten().any(|entry| {
            entry.file_type().is_ok_and(|ty| ty.is_dir())
                && !entry.file_name().to_string_lossy().starts_with('.')
        })
    })
}

/// Initialize the user plugin directory while keeping bundled plugins in place.
pub fn initialize_plugins() -> Result<(), String> {
    let user_plugins = home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ride")
        .join("plugins");
    fs::create_dir_all(&user_plugins)
        .map_err(|e| format!("Failed to create plugins directory: {}", e))?;
    log::info!("User plugins directory: {:?}", user_plugins);

    for bundled_plugins in resource_dir_candidates()
        .into_iter()
        .map(|resources_dir| resources_dir.join("plugins"))
    {
        if is_plugin_dir_ready(&bundled_plugins) {
            log::info!("Using bundled plugins in place: {:?}", bundled_plugins);
            break;
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

fn is_frontend_dir_ready(location: &Path) -> bool {
    location.join("index.html").is_file()
}

fn get_frontend_dir() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("RIDE_FRONTEND_DIR") {
        let frontend_dir = PathBuf::from(path);
        if is_frontend_dir_ready(&frontend_dir) {
            return Some(frontend_dir);
        }
    }

    let current_dir = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let exe_dir = current_exe_dir();
    let mut candidates = Vec::new();

    for resources_dir in resource_dir_candidates() {
        if let Some(resource_parent) = resources_dir.parent() {
            candidates.push(resource_parent.join("browser-frontend"));
            candidates.push(resource_parent.join("lib").join("frontend"));
        }
    }

    for base in [&current_dir, &exe_dir] {
        for ancestor in base.ancestors().take(10) {
            candidates.push(
                ancestor
                    .join("applications")
                    .join("tauri")
                    .join("browser-frontend"),
            );
            candidates.push(
                ancestor
                    .join("applications")
                    .join("browser")
                    .join("lib")
                    .join("frontend"),
            );
        }
    }

    candidates.extend([
        current_dir.join("../browser/lib/frontend"),
        current_dir.join("../../browser/lib/frontend"),
        current_dir
            .join("applications")
            .join("tauri")
            .join("browser-frontend"),
        current_dir
            .join("applications")
            .join("browser")
            .join("lib")
            .join("frontend"),
        current_dir.join("browser-frontend"),
        current_dir.join("lib").join("frontend"),
    ]);

    for location in candidates {
        if is_frontend_dir_ready(&location) {
            log::info!("Using frontend directory: {:?}", location);
            return Some(location);
        }
    }

    log::warn!(
        "Copied frontend directory was not found; backend static root will use its default path"
    );
    None
}

fn set_backend_port(app_handle: &AppHandle, port: u16) {
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        *state.backend_port.lock().unwrap() = Some(port);
    }
    let _ = app_handle.emit("backend-ready", port);
    navigate_main_window_to_backend(app_handle, port);
}

fn set_backend_pid(app_handle: &AppHandle, pid: Option<u32>) {
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        *state.backend_pid.lock().unwrap() = pid;
        if pid.is_some() {
            *state.backend_stopping.lock().unwrap() = false;
        }
    }
}

fn navigate_main_window_to_backend(app_handle: &AppHandle, port: u16) {
    let Some(window) = app_handle.get_webview_window("main") else {
        log::warn!("Main window is not available for backend navigation");
        return;
    };

    let mut url = match Url::parse(&format!("http://127.0.0.1:{}/", port)) {
        Ok(url) => url,
        Err(e) => {
            log::warn!("Failed to build backend frontend URL: {}", e);
            return;
        }
    };
    if let Some(locale) = system_locale() {
        url.query_pairs_mut().append_pair("ride_locale", &locale);
    }

    let target = url.clone();
    if let Err(e) = app_handle.run_on_main_thread(move || {
        if let Err(e) = window.navigate(target.clone()) {
            log::warn!("Failed to navigate main window to {}: {}", target, e);
        } else {
            log::info!("Navigated main window to {}", target);
        }
    }) {
        log::warn!("Failed to schedule backend navigation to {}: {}", url, e);
    }
}

fn system_locale() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = StdCommand::new("defaults")
            .args(["read", "-g", "AppleLanguages"])
            .output()
        {
            let output = String::from_utf8_lossy(&output.stdout);
            if let Some(locale) = output
                .lines()
                .find_map(|line| line.split('"').nth(1))
                .map(str::trim)
                .filter(|locale| !locale.is_empty())
            {
                return Some(locale.to_string());
            }
        }
    }

    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .map(|locale| {
            locale
                .split('.')
                .next()
                .unwrap_or(&locale)
                .replace('_', "-")
        })
        .find(|locale| !locale.is_empty() && locale != "C" && locale != "POSIX")
}

fn clear_backend_state(app_handle: &AppHandle) {
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        *state.backend_pid.lock().unwrap() = None;
        *state.backend_port.lock().unwrap() = None;
        *state.backend_stopping.lock().unwrap() = false;
    }
}

fn is_backend_stopping(app_handle: &AppHandle) -> bool {
    app_handle
        .try_state::<crate::AppState>()
        .map(|state| *state.backend_stopping.lock().unwrap())
        .unwrap_or(false)
}

fn backend_node_options() -> Option<String> {
    let existing = std::env::var("NODE_OPTIONS").unwrap_or_default();
    if existing.contains("--max-old-space-size") {
        return if existing.trim().is_empty() {
            None
        } else {
            Some(existing)
        };
    }

    let heap_limit_mb = std::env::var("RIDE_NODE_MAX_OLD_SPACE_MB")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value >= 256)
        .unwrap_or(768);
    let mut options = format!("--max-old-space-size={}", heap_limit_mb);
    if !existing.trim().is_empty() {
        options.push(' ');
        options.push_str(existing.trim());
    }

    Some(options)
}

fn backend_use_watcher_process() -> bool {
    std::env::var("RIDE_BACKEND_WATCHER_PROCESS")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn backend_child_path() -> String {
    let mut paths = std::env::var("PATH").unwrap_or_default();
    for required in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        if !paths.split(':').any(|entry| entry == required) {
            if !paths.is_empty() {
                paths.push(':');
            }
            paths.push_str(required);
        }
    }
    paths
}

async fn start_node_backend_process(
    app_handle: &AppHandle,
    config: &BackendConfig,
    plugins_dir: PathBuf,
    config_dir: PathBuf,
) -> Result<(), String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to create backend PTY: {}", e))?;

    let mut command = CommandBuilder::new(&config.node_exe);
    command.arg(&config.script_path);
    command.arg("--log-level=info");
    command.arg("--port=3000");
    command.arg("--hostname=127.0.0.1");
    if is_plugin_dir_ready(&plugins_dir) {
        command.arg(format!("--plugins=local-dir:{}", plugins_dir.display()));
    }
    if let Some(backend_dir) = config.script_path.parent() {
        command.cwd(backend_dir);
    }
    if !backend_use_watcher_process() {
        command.arg("--no-cluster");
    }
    if let Some(node_options) = backend_node_options() {
        command.env("NODE_OPTIONS", node_options);
    }
    command.env("PATH", backend_child_path());
    if let Some(frontend_dir) = get_frontend_dir() {
        command.env(
            "RIDE_FRONTEND_DIR",
            frontend_dir.to_string_lossy().to_string(),
        );
    }
    if let Ok(user) = std::env::var("USER") {
        command.env("LOGNAME", std::env::var("LOGNAME").unwrap_or(user));
    }
    command.env(
        "TERM",
        std::env::var("TERM").unwrap_or_else(|_| "dumb".to_string()),
    );
    command.env("NODE_ENV", "production");
    command.env("THEIA_CONFIG_DIR", config_dir.to_string_lossy().to_string());

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|e| format!("Failed to spawn backend in PTY: {}", e))?;
    drop(pair.slave);

    let child_pid = child.process_id();
    if let Some(pid) = child_pid {
        log::info!("Backend process started with pid {}", pid);
        set_backend_pid(app_handle, Some(pid));
        #[cfg(unix)]
        {
            send_signal(pid, "-CONT");
            std::thread::spawn(move || {
                for delay in [250_u64, 1000] {
                    std::thread::sleep(Duration::from_millis(delay));
                    send_signal(pid, "-CONT");
                }
            });
        }
    }

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone backend PTY reader: {}", e))?;
    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            let _ = line_tx.send(line);
        }
    });

    std::thread::spawn(move || {
        let _ = child.wait();
    });

    let startup_timeout = tokio::time::sleep(Duration::from_secs(BACKEND_STARTUP_TIMEOUT));
    tokio::pin!(startup_timeout);
    let mut backend_ready = false;

    loop {
        tokio::select! {
            line = line_rx.recv() => {
                let Some(line) = line else {
                    break;
                };
                log::info!("Backend stdout: {}", line);
                if !backend_ready && (line.contains("port") || line.contains("listening") || line.contains("localhost")) {
                    if let Some(port) =
                        extract_port_from_line(&line).and_then(|value| value.parse::<u16>().ok())
                    {
                        log::info!("Backend ready on port {}", port);
                        set_backend_port(app_handle, port);
                        backend_ready = true;
                        break;
                    }
                }
            }
            _ = &mut startup_timeout => {
                if let Some(pid) = child_pid {
                    let _ = terminate_process_tree(pid);
                }
                clear_backend_state(app_handle);
                return Err("Backend startup timeout".to_string());
            }
        }
    }

    if !backend_ready {
        return Err("Backend process exited before ready".to_string());
    }

    let app_handle_logs = app_handle.clone();
    tokio::spawn(async move {
        while let Some(line) = line_rx.recv().await {
            log::info!("Backend stdout: {}", line);
            let _ = app_handle_logs.emit("backend-log", line);
        }
    });

    Ok(())
}

/// 启动 Node.js 后端进程并保持进程生命周期
pub async fn start_backend_process(app_handle: &AppHandle) -> Result<(), String> {
    let config = get_backend_config();

    if config.use_node {
        if !config.node_exe.exists() {
            return Err(format!("Node.js not found at: {:?}", config.node_exe));
        }
        if !config.script_path.exists() {
            return Err(format!(
                "Backend script not found at: {:?}",
                config.script_path
            ));
        }
    } else {
        if !config.script_path.exists() {
            return Err(format!(
                "Backend binary not found at: {:?}",
                config.script_path
            ));
        }
    }

    log::info!(
        "Starting backend with config: use_node={}, node_exe={:?}, script={:?}",
        config.use_node,
        config.node_exe,
        config.script_path
    );

    let plugins_dir = get_plugins_dir();
    let config_dir = get_config_dir();

    if config.use_node {
        return start_node_backend_process(app_handle, &config, plugins_dir, config_dir).await;
    }

    // 设置命令
    let mut cmd = Command::new(&config.script_path);
    cmd.arg("--port=3000").arg("--hostname=127.0.0.1");
    if is_plugin_dir_ready(&plugins_dir) {
        cmd.arg(format!("--plugins=local-dir:{}", plugins_dir.display()));
    }

    cmd.env("NODE_ENV", "production");
    if let Some(frontend_dir) = get_frontend_dir() {
        cmd.env(
            "RIDE_FRONTEND_DIR",
            frontend_dir.to_string_lossy().to_string(),
        );
    }

    cmd.env("THEIA_CONFIG_DIR", config_dir.to_string_lossy().to_string());

    // Theia 后端会尝试查找并启动在可用端口上
    // 我们需要捕获它的输出来获取实际使用的端口

    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn backend: {}", e))?;

    if let Some(pid) = child.id() {
        log::info!("Backend process started with pid {}", pid);
        set_backend_pid(app_handle, Some(pid));
    }

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let app_handle_stderr = app_handle.clone();

    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            log::warn!("Backend stderr: {}", line);
            let _ = app_handle_stderr.emit("backend-error", line);
        }
    });

    let mut stdout_reader = BufReader::new(stdout).lines();
    let startup_timeout = tokio::time::sleep(Duration::from_secs(BACKEND_STARTUP_TIMEOUT));
    tokio::pin!(startup_timeout);
    let mut backend_ready = false;

    loop {
        tokio::select! {
            line = stdout_reader.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        log::info!("Backend stdout: {}", line);
                        if !backend_ready && (line.contains("port") || line.contains("listening") || line.contains("localhost")) {
                            if let Some(port_str) = extract_port_from_line(&line) {
                                if let Ok(port) = port_str.parse::<u16>() {
                                    backend_ready = true;
                                    set_backend_port(app_handle, port);
                                }
                            }
                        }
                        let _ = app_handle.emit("backend-log", line);
                    }
                    Ok(None) => {
                        let status = child.wait().await.map_err(|e| format!("Failed to wait for backend: {}", e))?;
                        if is_backend_stopping(app_handle) {
                            clear_backend_state(app_handle);
                            return Ok(());
                        }
                        clear_backend_state(app_handle);
                        return Err(format!("Backend exited unexpectedly: {}", status));
                    }
                    Err(e) => {
                        clear_backend_state(app_handle);
                        return Err(format!("Failed to read backend output: {}", e));
                    }
                }
            }
            status = child.wait() => {
                let status = status.map_err(|e| format!("Failed to wait for backend: {}", e))?;
                if is_backend_stopping(app_handle) {
                    clear_backend_state(app_handle);
                    return Ok(());
                }
                clear_backend_state(app_handle);
                if status.success() {
                    return Ok(());
                }
                return Err(format!("Backend exited with status: {}", status));
            }
            _ = &mut startup_timeout, if !backend_ready => {
                let fallback_port = 3000;
                log::warn!("Backend did not report a port within {}s; using fallback port {}", BACKEND_STARTUP_TIMEOUT, fallback_port);
                backend_ready = true;
                set_backend_port(app_handle, fallback_port);
            }
        }
    }
}

/// 从日志行中提取端口号
fn extract_port_from_line(line: &str) -> Option<String> {
    // 匹配常见的端口输出格式
    // "Server started on port 3000"
    // "Listening on *:3000"
    // "http://localhost:3000"
    let patterns = vec![r"port (\d{4,5})", r":(\d{4,5})", r"(\d{4,5})"];

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

#[cfg(unix)]
fn child_pids(pid: u32) -> Vec<u32> {
    let output = StdCommand::new("pgrep")
        .args(["-P", &pid.to_string()])
        .output();

    output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(unix)]
fn collect_descendant_pids(pid: u32) -> Vec<u32> {
    let mut descendants = Vec::new();
    for child in child_pids(pid) {
        descendants.extend(collect_descendant_pids(child));
        descendants.push(child);
    }
    descendants
}

#[cfg(unix)]
fn is_process_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(unix)]
fn send_signal(pid: u32, signal: &str) {
    let Some(signal) = signal_number(signal) else {
        return;
    };
    unsafe {
        let _ = libc::kill(pid as libc::pid_t, signal);
    }
}

#[cfg(unix)]
fn signal_number(signal: &str) -> Option<i32> {
    match signal.trim_start_matches('-') {
        "0" => Some(0),
        "CONT" => Some(libc::SIGCONT),
        "TERM" => Some(libc::SIGTERM),
        "KILL" => Some(libc::SIGKILL),
        _ => None,
    }
}

#[cfg(unix)]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let mut pids = collect_descendant_pids(pid);
    pids.push(pid);

    for target in &pids {
        send_signal(*target, "-TERM");
    }

    std::thread::sleep(Duration::from_millis(500));

    for target in pids.iter().copied().filter(|pid| is_process_alive(*pid)) {
        send_signal(target, "-KILL");
    }

    Ok(())
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32) -> Result<(), String> {
    let status = StdCommand::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|e| format!("Failed to run taskkill: {}", e))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("taskkill exited with status: {}", status))
    }
}

/// 启动后端的主函数（在独立线程中运行）
pub fn start_backend(app_handle: &AppHandle) -> Result<(), String> {
    let rt = tokio::runtime::Runtime::new()
        .map_err(|e| format!("Failed to create async runtime: {}", e))?;

    let app_handle = app_handle.clone();

    rt.block_on(async {
        match start_backend_process(&app_handle).await {
            Ok(()) => Ok(()),
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
    let pid = app_handle.try_state::<crate::AppState>().and_then(|state| {
        *state.backend_port.lock().unwrap() = None;
        *state.backend_stopping.lock().unwrap() = true;
        state.backend_pid.lock().unwrap().take()
    });

    if let Some(pid) = pid {
        log::info!("Stopping backend process tree rooted at pid {}", pid);
        terminate_process_tree(pid)?;
    } else {
        log::debug!("No backend process is registered; nothing to stop");
    }

    Ok(())
}
