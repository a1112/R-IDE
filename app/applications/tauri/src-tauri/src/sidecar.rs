/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use crate::startup::{
    finish_backend_stop, resolve_tauri_config_directory, wait_for_owned_loopback,
    BackendLaunchPlan, BackendReadinessPolicy, BackendSpawnStrategy, BackendStartToken,
    BackendStartupAction, BackendStartupEvent, BackendStartupState, BackendTransport,
    RuntimePathMode, RuntimePaths,
};
use crate::startup_metrics::StartupMilestone;
use dirs::home_dir;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;

const BACKEND_STARTUP_TIMEOUT: u64 = 240; // seconds
const BACKEND_PORT: u16 = 3000;
const BACKEND_PROBE_INTERVAL: Duration = Duration::from_millis(50);
const BACKEND_PROBE_TIMEOUT: Duration = Duration::from_millis(250);

fn resolve_runtime_paths(app_handle: &AppHandle) -> Result<RuntimePaths, String> {
    let state = app_handle.state::<crate::AppState>();
    state
        .runtime_paths
        .get_or_try_init(|| {
            let config_directory = resolve_tauri_config_directory(
                std::env::var_os("RIDE_CONFIG_DIR").map(PathBuf::from),
                home_dir(),
            );
            let mode =
                if let Some(root) = std::env::var_os("RIDE_DEVELOPMENT_ROOT") {
                    RuntimePathMode::Development(PathBuf::from(root))
                } else {
                    RuntimePathMode::Packaged(app_handle.path().resource_dir().map_err(
                        |error| format!("Failed to resolve resource directory: {error}"),
                    )?)
                };
            RuntimePaths::resolve(mode, config_directory)
        })
        .cloned()
}

fn current_exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 查找 Node.js 可执行文件
fn find_node_executable(paths: &RuntimePaths) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("RIDE_NODE_PATH") {
        let node_path = PathBuf::from(path);
        if node_path.exists() {
            return Some(node_path);
        }
    }

    let bundled_node = paths.node_executable();
    if bundled_node.exists() {
        return Some(bundled_node);
    }
    if !matches!(paths.mode(), RuntimePathMode::Development(_)) {
        return None;
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
fn get_backend_script(paths: &RuntimePaths) -> PathBuf {
    // 优先使用环境变量指定的路径（用于开发）
    if let Ok(path) = std::env::var("RIDE_BACKEND_PATH") {
        return PathBuf::from(path);
    }

    paths.backend_script()
}

/// 后端运行配置
struct BackendConfig {
    node_exe: PathBuf,
    script_path: PathBuf,
    use_node: bool,
}

/// 查找并返回后端运行配置
fn get_backend_config(paths: &RuntimePaths) -> BackendConfig {
    // 首先尝试找到 Node.js
    if let Some(node_exe) = find_node_executable(paths) {
        let script_path = get_backend_script(paths);
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

fn canonical_ready_plugin_directories(
    candidates: impl IntoIterator<Item = PathBuf>,
) -> Vec<PathBuf> {
    for candidate in candidates {
        if !is_plugin_dir_ready(&candidate) {
            continue;
        }
        let Ok(canonical) = fs::canonicalize(&candidate) else {
            continue;
        };
        // Preserve the historical trusted-candidate priority. Installing every
        // ready ancestor/user directory as a System plugin would expand the
        // code-loading trust boundary beyond the bundled directory.
        return vec![canonical];
    }
    Vec::new()
}

/// Resolve plugin directories on frontend demand, after the core editor is visible.
pub fn plugin_directories(app_handle: &AppHandle) -> Result<Vec<String>, String> {
    let paths = resolve_runtime_paths(app_handle)?;
    let candidate = std::env::var_os("RIDE_PLUGINS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| paths.plugin_directory());
    canonical_ready_plugin_directories([candidate])
        .into_iter()
        .map(|directory| {
            directory
                .into_os_string()
                .into_string()
                .map_err(|_| "Plugin directory is not valid Unicode".to_string())
        })
        .collect()
}

/// 获取配置目录路径
fn get_config_dir(paths: &RuntimePaths) -> PathBuf {
    let config_dir = paths.config_directory();

    fs::create_dir_all(&config_dir).unwrap_or_else(|e| {
        log::warn!("Failed to create config directory: {}", e);
    });

    config_dir
}

fn is_frontend_dir_ready(location: &Path) -> bool {
    location.join("index.html").is_file()
}

fn get_frontend_dir(paths: &RuntimePaths) -> Option<PathBuf> {
    if let Ok(path) = std::env::var("RIDE_FRONTEND_DIR") {
        let frontend_dir = PathBuf::from(path);
        if is_frontend_dir_ready(&frontend_dir) {
            return Some(frontend_dir);
        }
    }

    let frontend = paths.frontend_directory();
    if is_frontend_dir_ready(&frontend) {
        log::info!("Using frontend directory: {:?}", frontend);
        return Some(frontend);
    }

    log::warn!(
        "Copied frontend directory was not found; backend static root will use its default path"
    );
    None
}

fn announce_backend_port(app_handle: &AppHandle, port: u16) {
    let _ = app_handle.emit("backend-ready", port);
    navigate_main_window_to_backend(app_handle, port);
}

pub fn publish_backend_listening_in_order(
    port: u16,
    record: impl FnOnce(StartupMilestone),
    publish: impl FnOnce(u16),
) {
    record(StartupMilestone::BackendListening);
    publish(port);
}

fn publish_backend_listening(app_handle: &AppHandle, pid: u32, port: u16) -> bool {
    let Some(state) = app_handle.try_state::<crate::AppState>() else {
        return false;
    };
    let ownership = state.backend_ownership.lock().unwrap();
    if !ownership.owns_active(pid) {
        return false;
    }
    let mut published_port = state.backend_port.lock().unwrap();
    record_backend_listening_before_window(app_handle);
    *published_port = Some(port);
    drop(published_port);
    drop(ownership);
    announce_backend_port(app_handle, port);
    true
}

fn register_backend_pid(
    app_handle: &AppHandle,
    start: BackendStartToken,
    pid: u32,
    stop_fallback: tokio::sync::mpsc::UnboundedSender<()>,
) -> bool {
    app_handle
        .try_state::<crate::AppState>()
        .map(|state| {
            let mut ownership = state.backend_ownership.lock().unwrap();
            if !ownership.register_spawn(start, pid) {
                return false;
            }
            *state.backend_stop_fallback.lock().unwrap() = Some((pid, stop_fallback));
            true
        })
        .unwrap_or(false)
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
        *state.backend_port.lock().unwrap() = None;
    }
}

fn is_backend_stopping(app_handle: &AppHandle) -> bool {
    app_handle
        .try_state::<crate::AppState>()
        .map(|state| state.backend_ownership.lock().unwrap().is_stopping())
        .unwrap_or(false)
}

fn owns_active_backend(app_handle: &AppHandle, pid: u32) -> bool {
    app_handle
        .try_state::<crate::AppState>()
        .map(|state| state.backend_ownership.lock().unwrap().owns_active(pid))
        .unwrap_or(false)
}

fn clear_backend_process(app_handle: &AppHandle, pid: u32) -> bool {
    let Some(state) = app_handle.try_state::<crate::AppState>() else {
        return false;
    };
    let mut ownership = state.backend_ownership.lock().unwrap();
    let stopping = ownership.clear_spawn(pid);
    let mut stop_fallback = state.backend_stop_fallback.lock().unwrap();
    if stop_fallback.as_ref().map(|(owner, _)| *owner) == Some(pid) {
        stop_fallback.take();
    }
    *state.backend_port.lock().unwrap() = None;
    stopping
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
    backend_child_path_from(std::env::var("PATH").unwrap_or_default())
}

fn backend_child_path_from(paths: String) -> String {
    #[cfg(windows)]
    {
        paths
    }
    #[cfg(not(windows))]
    {
        let mut paths = paths;
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
}

fn node_runtime_path(path: &Path) -> PathBuf {
    // Tauri canonicalizes packaged resource paths with Windows' verbatim
    // prefix. Node 24 treats a `\\?\C:\...` entry script as `C:` and exits
    // before loading JavaScript, so keep verbatim paths inside Rust and
    // simplify only values that cross into the Node process.
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};

        let mut components = path.components();
        if let Some(Component::Prefix(prefix)) = components.next() {
            if let Prefix::VerbatimUNC(server, share) = prefix.kind() {
                let mut simplified = PathBuf::from(r"\\");
                simplified.push(server);
                simplified.push(share);
                for component in components {
                    if !matches!(component, Component::RootDir) {
                        simplified.push(component.as_os_str());
                    }
                }
                return simplified;
            }
        }
    }

    dunce::simplified(path).to_path_buf()
}

fn ensure_backend_port_available(port: u16) -> Result<(), String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", port))
        .map_err(|error| format!("Backend port {port} is already in use on 127.0.0.1: {error}"))?;
    drop(listener);
    Ok(())
}

async fn backend_port_is_listening(port: u16) -> bool {
    matches!(
        tokio::time::timeout(
            BACKEND_PROBE_TIMEOUT,
            TcpStream::connect(("127.0.0.1", port)),
        )
        .await,
        Ok(Ok(_))
    )
}

fn backend_stdout_confirms_port(line: &str, port: u16) -> bool {
    line.contains(&format!("Theia app listening on http://127.0.0.1:{port}"))
}

#[cfg(windows)]
fn initialize_windows_backend_pty_input(writer: &mut dyn std::io::Write) -> Result<(), String> {
    // portable-pty creates ConPTY with PSEUDOCONSOLE_INHERIT_CURSOR. Windows
    // waits for this standard cursor-position response before starting the
    // attached process; without it the backend remains alive but never runs.
    writer
        .write_all(b"\x1b[1;1R")
        .and_then(|()| writer.flush())
        .map_err(|error| format!("Failed to initialize backend PTY input: {error}"))
}

fn wait_with_backend_pty_lifetime<G, T>(guard: G, wait: impl FnOnce() -> T) -> T {
    let result = wait();
    drop(guard);
    result
}

#[cfg(test)]
fn return_post_spawn_setup_or_cleanup<T>(
    result: Result<T, String>,
    cleanup: impl FnOnce(),
) -> Result<T, String> {
    if result.is_err() {
        cleanup();
    }
    result
}

fn reap_portable_child_bounded(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
) -> Result<(), String> {
    const REAP_TIMEOUT: Duration = Duration::from_secs(5);
    const POLL_INTERVAL: Duration = Duration::from_millis(25);
    for force_kill in [false, true] {
        if force_kill {
            child
                .kill()
                .map_err(|error| format!("Failed to force-kill PTY backend: {error}"))?;
        }
        let deadline = std::time::Instant::now() + REAP_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => return Ok(()),
                Ok(None) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(POLL_INTERVAL)
                }
                Ok(None) => break,
                Err(error) => return Err(format!("Failed to reap PTY backend: {error}")),
            }
        }
    }
    Err("PTY backend did not exit after force-kill".to_string())
}

async fn kill_portable_child_async(
    mut killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || killer.kill())
        .await
        .map_err(|error| format!("PTY backend kill task failed: {error}"))?
        .map_err(|error| format!("Failed to kill PTY backend: {error}"))
}

async fn cleanup_failed_pty_backend_start(
    app_handle: &AppHandle,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    child_pid: Option<u32>,
) -> Result<(), String> {
    let termination = match child_pid {
        Some(pid) => terminate_process_tree_async(pid).await,
        None => child
            .kill()
            .map_err(|error| format!("Failed to kill unidentified PTY backend: {error}")),
    };
    if termination.is_err() {
        let _ = child.kill();
    }
    let wait = tauri::async_runtime::spawn_blocking(move || reap_portable_child_bounded(child))
        .await
        .map_err(|error| format!("PTY backend reap task failed: {error}"))?;
    if let Some(pid) = child_pid {
        clear_backend_process(app_handle, pid);
    } else {
        clear_backend_state(app_handle);
    }
    match (termination, wait) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(termination), Ok(())) => Err(termination),
        (Ok(()), Err(wait)) => Err(wait),
        (Err(termination), Err(wait)) => Err(format!("{termination}; {wait}")),
    }
}

fn handle_backend_process_exit(
    exit: String,
    stopping: bool,
    clear: impl FnOnce(),
    report_unexpected: impl FnOnce(String),
) {
    clear();
    if !stopping {
        report_unexpected(format!("Backend exited unexpectedly: {exit}"));
    }
}

#[derive(Debug)]
enum BackendReadinessFailure {
    ChildExited(String),
    TimedOut(String),
}

impl BackendReadinessFailure {
    fn message(self) -> String {
        match self {
            Self::ChildExited(exit) => {
                format!("Backend process exited before ready: {exit}")
            }
            Self::TimedOut(message) => message,
        }
    }
}

#[cfg(test)]
fn finish_backend_readiness(
    result: Result<u16, BackendReadinessFailure>,
    terminate: impl FnOnce(),
    clear: impl FnOnce(),
) -> Result<u16, String> {
    match result {
        Ok(port) => Ok(port),
        Err(BackendReadinessFailure::ChildExited(exit)) => {
            clear();
            Err(BackendReadinessFailure::ChildExited(exit).message())
        }
        Err(failure @ BackendReadinessFailure::TimedOut(_)) => {
            terminate();
            clear();
            Err(failure.message())
        }
    }
}

async fn wait_for_node_backend_readiness(
    line_rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
    exit_rx: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
    port: u16,
    timeout: Duration,
) -> Result<u16, BackendReadinessFailure> {
    let startup_timeout = tokio::time::sleep(timeout);
    tokio::pin!(startup_timeout);
    let mut probe_interval = tokio::time::interval(BACKEND_PROBE_INTERVAL);
    probe_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut line_reader_open = true;
    let mut child_wait_open = true;
    let mut child_reported_port = false;

    loop {
        tokio::select! {
            biased;
            exit = exit_rx.recv(), if child_wait_open => {
                match exit {
                    Some(exit) => {
                        return Err(BackendReadinessFailure::ChildExited(exit));
                    }
                    None => child_wait_open = false,
                }
            }
            _ = &mut startup_timeout => {
                return Err(BackendReadinessFailure::TimedOut(format!(
                    "Backend startup timeout: port {port} did not accept connections within {}s",
                    timeout.as_secs()
                )));
            }
            _ = probe_interval.tick(), if child_reported_port => {
                if backend_port_is_listening(port).await {
                    return Ok(port);
                }
            }
            line = line_rx.recv(), if line_reader_open => {
                match line {
                    Some(line) => {
                        log::info!("Backend stdout: {}", line);
                        child_reported_port |= backend_stdout_confirms_port(&line, port);
                    }
                    None => line_reader_open = false,
                }
            }
        }
    }
}

async fn start_node_backend_process(
    app_handle: &AppHandle,
    config: &BackendConfig,
    config_dir: PathBuf,
    frontend_dir: Option<PathBuf>,
    launch_plan: &BackendLaunchPlan,
    backend_start: BackendStartToken,
) -> Result<(), String> {
    ensure_backend_port_available(BACKEND_PORT)?;
    let script_path = node_runtime_path(&config.script_path);
    let config_dir = node_runtime_path(&config_dir);
    let frontend_dir = frontend_dir.map(|path| node_runtime_path(&path));
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
    command.arg(&script_path);
    command.arg("--log-level=info");
    command.arg(format!("--port={BACKEND_PORT}"));
    command.arg("--hostname=127.0.0.1");
    if let Some(backend_dir) = script_path.parent() {
        command.cwd(backend_dir);
    }
    if !backend_use_watcher_process() {
        command.arg("--no-cluster");
    }
    command.args(launch_plan.arguments());
    if let Some(node_options) = backend_node_options() {
        command.env("NODE_OPTIONS", node_options);
    }
    command.env("PATH", backend_child_path());
    if let Some(frontend_dir) = frontend_dir {
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
    record_backend_spawned_before_window(app_handle);

    let child_pid = child.process_id();
    if let Some(pid) = child_pid {
        log::info!("Backend process started with pid {}", pid);
        let (stop_fallback_tx, mut stop_fallback_rx) = tokio::sync::mpsc::unbounded_channel();
        let mut stop_killer = child.clone_killer();
        if !register_backend_pid(app_handle, backend_start, pid, stop_fallback_tx) {
            let cleanup = terminate_process_tree_async(pid).await;
            if cleanup.is_err() {
                let _ = child.kill();
            }
            let wait =
                tauri::async_runtime::spawn_blocking(move || reap_portable_child_bounded(child))
                    .await
                    .map_err(|error| format!("Cancelled PTY backend reap task failed: {error}"))?;
            clear_backend_state(app_handle);
            return match (cleanup, wait) {
                (Ok(()), Ok(_)) => {
                    Err("Backend start was cancelled before PTY spawn completed".to_string())
                }
                (cleanup, wait) => Err(format!(
                    "Backend start was cancelled before PTY spawn completed; cleanup failed: {}; reap failed: {}",
                    cleanup.err().unwrap_or_else(|| "none".to_string()),
                    wait.err().unwrap_or_else(|| "none".to_string())
                )),
            };
        }
        std::thread::spawn(move || {
            if stop_fallback_rx.blocking_recv().is_some() {
                let _ = stop_killer.kill();
            }
        });
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
    } else {
        let wait = tauri::async_runtime::spawn_blocking(move || {
            let _ = child.kill();
            reap_portable_child_bounded(child)
        })
        .await
        .map_err(|error| format!("Unidentified PTY backend cleanup task failed: {error}"))?;
        clear_backend_state(app_handle);
        return match wait {
            Ok(()) => Err("PTY backend process did not report a process id".to_string()),
            Err(cleanup) => Err(format!(
                "PTY backend process did not report a process id; cleanup failed: {cleanup}"
            )),
        };
    }

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let error = format!("Failed to clone backend PTY reader: {error}");
            let cleanup = cleanup_failed_pty_backend_start(app_handle, child, child_pid).await;
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
            });
        }
    };
    #[cfg(windows)]
    let backend_pty_writer = {
        let mut writer = match pair.master.take_writer() {
            Ok(writer) => writer,
            Err(error) => {
                let error = format!("Failed to open backend PTY input: {error}");
                let cleanup = cleanup_failed_pty_backend_start(app_handle, child, child_pid).await;
                return Err(match cleanup {
                    Ok(()) => error,
                    Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
                });
            }
        };
        if let Err(error) = initialize_windows_backend_pty_input(writer.as_mut()) {
            let cleanup = cleanup_failed_pty_backend_start(app_handle, child, child_pid).await;
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
            });
        }
        writer
    };
    let backend_pty_master = pair.master;
    let pty_killer = child.clone_killer();
    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            let _ = line_tx.send(line);
        }
    });

    let (exit_tx, mut exit_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        #[cfg(windows)]
        let backend_pty_lifetime = (backend_pty_master, backend_pty_writer);
        #[cfg(not(windows))]
        let backend_pty_lifetime = backend_pty_master;
        let exit = wait_with_backend_pty_lifetime(backend_pty_lifetime, || match child.wait() {
            Ok(status) => format!("{status:?}"),
            Err(error) => format!("wait failed: {error}"),
        });
        let _ = exit_tx.send(exit);
    });

    let ready_port = match wait_for_node_backend_readiness(
        &mut line_rx,
        &mut exit_rx,
        BACKEND_PORT,
        Duration::from_secs(BACKEND_STARTUP_TIMEOUT),
    )
    .await
    {
        Ok(port) => port,
        Err(BackendReadinessFailure::ChildExited(exit)) => {
            if let Some(pid) = child_pid {
                clear_backend_process(app_handle, pid);
            } else {
                clear_backend_state(app_handle);
            }
            return Err(BackendReadinessFailure::ChildExited(exit).message());
        }
        Err(failure @ BackendReadinessFailure::TimedOut(_)) => {
            let termination = match child_pid {
                Some(pid) => terminate_process_tree_async(pid).await,
                None => Err("PTY backend did not report a process id".to_string()),
            };
            let fallback = if termination.is_err() {
                kill_portable_child_async(pty_killer).await
            } else {
                Ok(())
            };
            let reaped = tokio::time::timeout(Duration::from_secs(5), exit_rx.recv()).await;
            if let Some(pid) = child_pid {
                clear_backend_process(app_handle, pid);
            } else {
                clear_backend_state(app_handle);
            }
            let cleanup = match (&termination, &fallback, &reaped) {
                (Ok(()), Ok(()), Ok(Some(_))) => None,
                _ => Some(format!(
                    "termination: {}; fallback: {}; reap: {}",
                    termination.err().unwrap_or_else(|| "ok".to_string()),
                    fallback.err().unwrap_or_else(|| "ok".to_string()),
                    match reaped {
                        Ok(Some(_)) => "ok".to_string(),
                        Ok(None) => "wait channel closed".to_string(),
                        Err(_) => "timed out".to_string(),
                    }
                )),
            };
            return Err(match cleanup {
                Some(cleanup) => format!("{}; PTY cleanup failed: {cleanup}", failure.message()),
                None => failure.message(),
            });
        }
    };
    if let Some(pid) = child_pid {
        if !owns_active_backend(app_handle, pid) {
            let fallback = kill_portable_child_async(pty_killer).await;
            let reaped = tokio::time::timeout(Duration::from_secs(5), exit_rx.recv()).await;
            clear_backend_process(app_handle, pid);
            return Err(match (fallback, reaped) {
                (_, Ok(Some(_))) => "Backend start was cancelled before PTY readiness".to_string(),
                (fallback, reaped) => format!(
                    "Backend start was cancelled before PTY readiness; kill: {}; reap: {}",
                    fallback.err().unwrap_or_else(|| "ok".to_string()),
                    match reaped {
                        Ok(None) => "wait channel closed",
                        Err(_) => "timed out",
                        Ok(Some(_)) => "ok",
                    }
                ),
            });
        }
    }
    log::info!("Backend ready on port {}", ready_port);
    let pid = child_pid.expect("PTY backend readiness requires an owned process id");
    if !publish_backend_listening(app_handle, pid, ready_port) {
        let fallback = kill_portable_child_async(pty_killer).await;
        let reaped = tokio::time::timeout(Duration::from_secs(5), exit_rx.recv()).await;
        clear_backend_process(app_handle, pid);
        return Err(match (fallback, reaped) {
            (_, Ok(Some(_))) => "Backend start was cancelled before PTY publication".to_string(),
            (fallback, reaped) => format!(
                "Backend start was cancelled before PTY publication; kill: {}; reap: {}",
                fallback.err().unwrap_or_else(|| "ok".to_string()),
                match reaped {
                    Ok(None) => "wait channel closed",
                    Err(_) => "timed out",
                    Ok(Some(_)) => "ok",
                }
            ),
        });
    }

    let app_handle_logs = app_handle.clone();
    std::thread::spawn(move || {
        while let Some(line) = line_rx.blocking_recv() {
            log::info!("Backend stdout: {}", line);
            let _ = app_handle_logs.emit("backend-log", line);
        }
    });

    let app_handle_exit = app_handle.clone();
    std::thread::spawn(move || {
        if let Some(exit) = exit_rx.blocking_recv() {
            let stopping = child_pid
                .map(|pid| clear_backend_process(&app_handle_exit, pid))
                .unwrap_or_else(|| is_backend_stopping(&app_handle_exit));
            let clear_handle = app_handle_exit.clone();
            let report_handle = app_handle_exit.clone();
            handle_backend_process_exit(
                exit,
                stopping,
                move || clear_backend_state(&clear_handle),
                move |message| {
                    log::error!("{message}");
                    let _ = report_handle.emit("backend-error", message);
                },
            );
        }
    });

    Ok(())
}

async fn terminate_process_tree_async(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || terminate_process_tree(pid))
        .await
        .map_err(|error| format!("Backend termination task failed: {error}"))?
}

async fn reap_backend_child(child: &mut tokio::process::Child) -> Result<(), String> {
    const REAP_TIMEOUT: Duration = Duration::from_secs(5);
    match tokio::time::timeout(REAP_TIMEOUT, child.wait()).await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) => Err(format!("Failed to reap backend child: {error}")),
        Err(_) => {
            child
                .start_kill()
                .map_err(|error| format!("Failed to force-kill backend child: {error}"))?;
            match tokio::time::timeout(REAP_TIMEOUT, child.wait()).await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err(format!("Failed to reap force-killed backend: {error}")),
                Err(_) => Err("Backend child did not exit after force-kill".to_string()),
            }
        }
    }
}

async fn kill_and_reap_backend_child(child: &mut tokio::process::Child) -> Result<(), String> {
    let kill = child
        .start_kill()
        .map_err(|error| format!("Failed to kill owned backend child: {error}"));
    let reaped = reap_backend_child(child).await;
    match (kill, reaped) {
        (_, Ok(())) => Ok(()),
        (Ok(()), Err(reaped)) => Err(reaped),
        (Err(kill), Err(reaped)) => Err(format!("{kill}; {reaped}")),
    }
}

async fn terminate_and_reap_backend(
    child: &mut tokio::process::Child,
    pid: Option<u32>,
) -> Result<(), String> {
    let termination = match pid {
        Some(pid) => terminate_process_tree_async(pid).await,
        None => child
            .start_kill()
            .map_err(|error| format!("Failed to kill backend without a process id: {error}")),
    };
    if termination.is_err() {
        let _ = child.start_kill();
    }
    let reaped = reap_backend_child(child).await;
    match (termination, reaped) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(termination), Ok(())) => Err(termination),
        (Ok(()), Err(reaped)) => Err(reaped),
        (Err(termination), Err(reaped)) => Err(format!("{termination}; {reaped}")),
    }
}

async fn apply_backend_cleanup_actions(
    app_handle: &AppHandle,
    child: &mut tokio::process::Child,
    actions: impl IntoIterator<Item = BackendStartupAction>,
) -> Result<(), String> {
    let mut termination_error = None;
    let mut owned_pid = None;
    for action in actions {
        match action {
            BackendStartupAction::TerminateProcessTree(pid) => {
                owned_pid = Some(pid);
                if let Err(error) = terminate_process_tree_async(pid).await {
                    let _ = child.start_kill();
                    termination_error = Some(error);
                }
            }
            BackendStartupAction::ReapOwnedChild(_) => {
                if let Err(error) = reap_backend_child(child).await {
                    termination_error = Some(match termination_error {
                        Some(first) => format!("{first}; {error}"),
                        None => error,
                    });
                }
            }
            BackendStartupAction::ClearState => {
                if let Some(pid) = owned_pid {
                    clear_backend_process(app_handle, pid);
                } else {
                    clear_backend_state(app_handle);
                }
            }
            other => apply_backend_startup_actions(app_handle, [other]).await?,
        }
    }
    match termination_error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

async fn apply_backend_startup_actions(
    app_handle: &AppHandle,
    actions: impl IntoIterator<Item = BackendStartupAction>,
) -> Result<(), String> {
    for action in actions {
        match action {
            BackendStartupAction::PublishReady { pid, port } => {
                if !publish_backend_listening(app_handle, pid, port) {
                    return Err("Backend start was cancelled before readiness publication".into());
                }
            }
            BackendStartupAction::TerminateProcessTree(pid) => {
                terminate_process_tree_async(pid).await?
            }
            BackendStartupAction::ReapOwnedChild(pid) => {
                return Err(format!(
                    "Owned backend child {pid} requires the cleanup executor"
                ));
            }
            BackendStartupAction::ClearState => clear_backend_state(app_handle),
            BackendStartupAction::LogStdout(line) => {
                log::info!("Backend stdout: {line}");
                let _ = app_handle.emit("backend-log", line);
            }
            BackendStartupAction::LogStderr(line) => {
                log::warn!("Backend stderr: {line}");
                let _ = app_handle.emit("backend-error", line);
            }
            BackendStartupAction::ReportUnexpectedExit(exit) => {
                let message = format!("Backend exited unexpectedly: {exit}");
                log::error!("{message}");
                let _ = app_handle.emit("backend-error", message);
            }
        }
    }
    Ok(())
}

fn spawn_backend_pipe_log<R>(app_handle: AppHandle, reader: R, stderr: bool)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let action = if stderr {
                BackendStartupAction::LogStderr(line)
            } else {
                BackendStartupAction::LogStdout(line)
            };
            let _ = apply_backend_startup_actions(&app_handle, [action]).await;
        }
    });
}

async fn start_backend_direct_process(
    app_handle: &AppHandle,
    config: &BackendConfig,
    config_dir: PathBuf,
    frontend_dir: Option<PathBuf>,
    launch_plan: &BackendLaunchPlan,
    backend_start: BackendStartToken,
) -> Result<(), String> {
    ensure_backend_port_available(BACKEND_PORT)?;
    let script_path = node_runtime_path(&config.script_path);
    let config_dir = node_runtime_path(&config_dir);
    let frontend_dir = frontend_dir.map(|path| node_runtime_path(&path));
    let mut command = Command::new(&config.node_exe);
    if config.use_node {
        command.arg(&script_path);
    }
    command
        .arg("--log-level=info")
        .arg(format!("--port={BACKEND_PORT}"))
        .arg("--hostname=127.0.0.1");
    if config.use_node {
        if let Some(backend_dir) = script_path.parent() {
            command.current_dir(backend_dir);
        }
        if !backend_use_watcher_process() {
            command.arg("--no-cluster");
        }
        if let Some(node_options) = backend_node_options() {
            command.env("NODE_OPTIONS", node_options);
        }
        command.env("PATH", backend_child_path());
    }
    command.args(launch_plan.arguments());
    command.env("NODE_ENV", "production");
    command.env("THEIA_CONFIG_DIR", config_dir);
    if let Some(frontend_dir) = frontend_dir {
        command.env("RIDE_FRONTEND_DIR", frontend_dir);
    }
    if let Ok(user) = std::env::var("USER") {
        command.env("LOGNAME", std::env::var("LOGNAME").unwrap_or(user));
    }
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to spawn backend with direct pipes: {error}"))?;
    record_backend_spawned_before_window(app_handle);
    let Some(pid) = child.id() else {
        let cleanup = terminate_and_reap_backend(&mut child, None).await;
        clear_backend_state(app_handle);
        return match cleanup {
            Ok(()) => Err("Backend process did not report a process id".to_string()),
            Err(cleanup) => Err(format!(
                "Backend process did not report a process id; cleanup failed: {cleanup}"
            )),
        };
    };
    let (stop_fallback_tx, mut stop_fallback_rx) = tokio::sync::mpsc::unbounded_channel();
    if !register_backend_pid(app_handle, backend_start, pid, stop_fallback_tx) {
        let cleanup = terminate_and_reap_backend(&mut child, Some(pid)).await;
        clear_backend_state(app_handle);
        return match cleanup {
            Ok(()) => Err("Backend start was cancelled before spawn completed".to_string()),
            Err(cleanup) => Err(format!(
                "Backend start was cancelled before spawn completed; cleanup failed: {cleanup}"
            )),
        };
    }
    log::info!("Backend direct-pipe process started with pid {pid}");
    let mut startup_state = BackendStartupState::spawned(pid, BACKEND_PORT);

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let cleanup = apply_backend_cleanup_actions(
                app_handle,
                &mut child,
                startup_state.observe(BackendStartupEvent::TimedOut),
            )
            .await;
            return match cleanup {
                Ok(()) => Err("Failed to capture backend stdout".to_string()),
                Err(cleanup) => Err(format!(
                    "Failed to capture backend stdout; cleanup failed: {cleanup}"
                )),
            };
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let cleanup = apply_backend_cleanup_actions(
                app_handle,
                &mut child,
                startup_state.observe(BackendStartupEvent::TimedOut),
            )
            .await;
            return match cleanup {
                Ok(()) => Err("Failed to capture backend stderr".to_string()),
                Err(cleanup) => Err(format!(
                    "Failed to capture backend stderr; cleanup failed: {cleanup}"
                )),
            };
        }
    };
    spawn_backend_pipe_log(app_handle.clone(), stdout, false);
    spawn_backend_pipe_log(app_handle.clone(), stderr, true);

    let readiness_policy = BackendReadinessPolicy::new(
        Duration::from_secs(BACKEND_STARTUP_TIMEOUT),
        BACKEND_PROBE_INTERVAL,
        BACKEND_PROBE_TIMEOUT,
    )?;
    tokio::select! {
        biased;
        stop = stop_fallback_rx.recv() => {
            let kill = if stop.is_some() {
                child
                    .start_kill()
                    .map_err(|error| format!("Failed to stop unready backend child: {error}"))
            } else {
                Ok(())
            };
            let reaped = reap_backend_child(&mut child).await;
            clear_backend_process(app_handle, pid);
            Err(match (kill, reaped) {
                (Ok(()), Ok(())) => "Backend start was cancelled before readiness".to_string(),
                (kill, reaped) => format!(
                    "Backend start was cancelled before readiness; kill: {}; reap: {}",
                    kill.err().unwrap_or_else(|| "ok".to_string()),
                    reaped.err().unwrap_or_else(|| "ok".to_string())
                ),
            })
        }
        status = child.wait() => {
            match status {
                Ok(status) => {
                    clear_backend_process(app_handle, pid);
                    Err(format!("Backend process exited before ready: {status}"))
                }
                Err(error) => {
                    let cleanup = terminate_and_reap_backend(&mut child, Some(pid)).await;
                    clear_backend_process(app_handle, pid);
                    Err(match cleanup {
                        Ok(()) => format!("Failed to wait for backend: {error}"),
                        Err(cleanup) => format!(
                            "Failed to wait for backend: {error}; cleanup failed: {cleanup}"
                        ),
                    })
                }
            }
        }
        ready = wait_for_owned_loopback(BACKEND_PORT, pid, readiness_policy) => {
            if let Err(error) = ready {
                let cleanup = apply_backend_cleanup_actions(
                    app_handle,
                    &mut child,
                    startup_state.observe(BackendStartupEvent::TimedOut),
                ).await;
                if let Err(cleanup) = cleanup {
                    clear_backend_state(app_handle);
                    return Err(format!("{error}; process-tree cleanup failed: {cleanup}"));
                }
                return Err(error);
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    clear_backend_process(app_handle, pid);
                    return Err(format!("Backend process exited before ready: {status}"));
                }
                Ok(None) => {}
                Err(error) => {
                    let cleanup = terminate_and_reap_backend(&mut child, Some(pid)).await;
                    clear_backend_process(app_handle, pid);
                    return Err(match cleanup {
                        Ok(()) => format!("Failed to confirm backend liveness: {error}"),
                        Err(cleanup) => format!(
                            "Failed to confirm backend liveness: {error}; cleanup failed: {cleanup}"
                        ),
                    });
                }
            }
            if !owns_active_backend(app_handle, pid) {
                let cleanup = kill_and_reap_backend_child(&mut child).await;
                clear_backend_process(app_handle, pid);
                return Err(match cleanup {
                    Ok(()) => "Backend start was cancelled before readiness".to_string(),
                    Err(cleanup) => format!(
                        "Backend start was cancelled before readiness; cleanup failed: {cleanup}"
                    ),
                });
            }
            if let Err(error) = apply_backend_startup_actions(
                app_handle,
                startup_state.observe(BackendStartupEvent::LoopbackConnected),
            ).await {
                let cleanup = kill_and_reap_backend_child(&mut child).await;
                clear_backend_process(app_handle, pid);
                return Err(match cleanup {
                    Ok(()) => error,
                    Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
                });
            }
            let app_handle_exit = app_handle.clone();
            tauri::async_runtime::spawn(async move {
                let exit = tokio::select! {
                    biased;
                    stop = stop_fallback_rx.recv() => {
                        if stop.is_some() {
                            let _ = child.start_kill();
                        }
                        match child.wait().await {
                            Ok(status) => status.to_string(),
                            Err(error) => format!("wait failed after stop: {error}"),
                        }
                    }
                    status = child.wait() => match status {
                        Ok(status) => status.to_string(),
                        Err(error) => format!("wait failed: {error}"),
                    }
                };
                let stopping = clear_backend_process(&app_handle_exit, pid);
                let clear_handle = app_handle_exit.clone();
                let report_handle = app_handle_exit.clone();
                handle_backend_process_exit(
                    exit,
                    stopping,
                    move || clear_backend_state(&clear_handle),
                    move |message| {
                        log::error!("{message}");
                        let _ = report_handle.emit("backend-error", message);
                    },
                );
            });
            Ok(())
        }
    }
}

/// 启动 Node.js 后端进程并保持进程生命周期
pub async fn start_backend_process(
    app_handle: &AppHandle,
    launch_plan: &BackendLaunchPlan,
    backend_start: BackendStartToken,
) -> Result<(), String> {
    let paths = resolve_runtime_paths(app_handle)?;
    let config = get_backend_config(&paths);

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

    let config_dir = get_config_dir(&paths);
    let frontend_dir = get_frontend_dir(&paths);

    if config.use_node {
        let spawn_strategy = BackendSpawnStrategy::for_backend(
            BackendTransport::from_env()?,
            backend_use_watcher_process(),
        )?;
        return match spawn_strategy {
            BackendSpawnStrategy::DirectPipes => {
                start_backend_direct_process(
                    app_handle,
                    &config,
                    config_dir,
                    frontend_dir,
                    launch_plan,
                    backend_start,
                )
                .await
            }
            BackendSpawnStrategy::Pty => {
                start_node_backend_process(
                    app_handle,
                    &config,
                    config_dir,
                    frontend_dir,
                    launch_plan,
                    backend_start,
                )
                .await
            }
        };
    }

    start_backend_direct_process(
        app_handle,
        &config,
        config_dir,
        frontend_dir,
        launch_plan,
        backend_start,
    )
    .await
}

fn record_backend_spawned_before_window(app_handle: &AppHandle) {
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        if let Err(error) = state.startup_metrics.record_backend_spawned_before_window() {
            log::warn!("Failed to record overlapped backend spawn: {error}");
        }
    }
}

fn record_backend_listening_before_window(app_handle: &AppHandle) {
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        if let Err(error) = state
            .startup_metrics
            .record_backend_listening_before_window()
        {
            log::warn!("Failed to record overlapped backend readiness: {error}");
        }
    }
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

/// Start the backend on Tauri's shared asynchronous runtime.
pub async fn start_backend(
    app_handle: &AppHandle,
    workspace: Option<PathBuf>,
    backend_start: BackendStartToken,
) -> Result<(), String> {
    let launch_plan = BackendLaunchPlan::new(workspace);
    match start_backend_process(app_handle, &launch_plan, backend_start).await {
        Ok(()) => Ok(()),
        Err(error) => {
            log::error!("Failed to start backend: {error}");
            let _ = app_handle.emit("backend-error", format!("Failed to start: {error}"));
            Err(error)
        }
    }
}

/// 停止后端进程
pub fn stop_backend(app_handle: &AppHandle) -> Result<(), String> {
    let (pid, stop_fallback) = app_handle
        .try_state::<crate::AppState>()
        .map(|state| {
            let mut ownership = state.backend_ownership.lock().unwrap();
            let pid = ownership.request_stop();
            let mut fallback = state.backend_stop_fallback.lock().unwrap();
            let stop_fallback = if fallback.as_ref().map(|(owner, _)| *owner) == pid {
                fallback.take().map(|(_, sender)| sender)
            } else {
                None
            };
            *state.backend_port.lock().unwrap() = None;
            (pid, stop_fallback)
        })
        .unwrap_or((None, None));

    let termination = if let Some(pid) = pid {
        log::info!("Stopping backend process tree rooted at pid {}", pid);
        terminate_process_tree(pid)
    } else {
        log::debug!("No backend process is registered; nothing to stop");
        Ok(())
    };
    finish_backend_stop(termination, stop_fallback)
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_ready_plugin_directories, ensure_backend_port_available,
        wait_for_node_backend_readiness,
    };
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::time::Duration;
    use tokio::sync::mpsc;

    struct PluginFixture(PathBuf);

    impl Drop for PluginFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn plugin_directory_discovery_selects_only_the_first_canonical_ready_directory() {
        let root =
            std::env::temp_dir().join(format!("ride-plugin-directories-{}", uuid::Uuid::new_v4()));
        let fixture = PluginFixture(root.clone());
        let ready = root.join("ready");
        let later = root.join("later");
        let empty = root.join("empty");
        std::fs::create_dir_all(ready.join("extension-a")).expect("create ready plugin dir");
        std::fs::create_dir_all(later.join("extension-b")).expect("create later plugin dir");
        std::fs::create_dir_all(&empty).expect("create empty plugin dir");

        let discovered = canonical_ready_plugin_directories([
            root.join("missing"),
            empty,
            ready.clone(),
            ready.join("."),
            later,
        ]);

        assert_eq!(
            discovered,
            vec![std::fs::canonicalize(ready).expect("canonical ready plugin dir")]
        );
        drop(fixture);
    }

    #[test]
    fn backend_port_preflight_rejects_an_existing_listener() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback listener");
        let port = listener.local_addr().expect("listener address").port();

        let error = ensure_backend_port_available(port)
            .expect_err("an occupied backend port must fail before spawn");

        assert!(error.contains(&port.to_string()), "{error}");
        assert!(error.contains("already in use"), "{error}");
    }

    #[tokio::test]
    async fn backend_readiness_requires_child_port_evidence_before_tcp() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind external listener");
        let port = listener.local_addr().expect("listener address").port();
        let (_line_tx, mut line_rx) = mpsc::unbounded_channel();
        let (exit_tx, mut exit_rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(25)).await;
            let _ = exit_tx.send("child exited".to_string());
        });

        let error = wait_for_node_backend_readiness(
            &mut line_rx,
            &mut exit_rx,
            port,
            Duration::from_secs(1),
        )
        .await
        .expect_err("an unrelated listener cannot attest child readiness");

        assert!(
            matches!(
                error,
                super::BackendReadinessFailure::ChildExited(ref exit)
                    if exit.contains("child exited")
            ),
            "{error:?}"
        );
    }

    #[tokio::test]
    async fn backend_readiness_requires_child_evidence_and_a_real_loopback_connection() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind loopback listener");
        let port = listener.local_addr().expect("listener address").port();
        let (line_tx, mut line_rx) = mpsc::unbounded_channel();
        let (_exit_tx, mut exit_rx) = mpsc::unbounded_channel();
        line_tx
            .send(format!("Theia app listening on http://127.0.0.1:{port}."))
            .expect("send child readiness evidence");

        let ready_port = wait_for_node_backend_readiness(
            &mut line_rx,
            &mut exit_rx,
            port,
            Duration::from_secs(1),
        )
        .await
        .expect("the listening socket is authoritative readiness");

        assert_eq!(ready_port, port);
    }

    #[tokio::test]
    async fn backend_readiness_reports_child_exit_without_waiting_for_timeout() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve unused port");
        let port = listener.local_addr().expect("listener address").port();
        drop(listener);
        let (_line_tx, mut line_rx) = mpsc::unbounded_channel();
        let (exit_tx, mut exit_rx) = mpsc::unbounded_channel();
        exit_tx
            .send("exit status: 17".to_string())
            .expect("send child exit");

        let started = std::time::Instant::now();
        let error = wait_for_node_backend_readiness(
            &mut line_rx,
            &mut exit_rx,
            port,
            Duration::from_secs(30),
        )
        .await
        .expect_err("an exited child cannot become ready");

        assert!(
            matches!(
                error,
                super::BackendReadinessFailure::ChildExited(ref exit)
                    if exit.contains("exit status: 17")
            ),
            "{error:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn backend_timeout_is_not_starved_by_continuous_stdout() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve unused port");
        let port = listener.local_addr().expect("listener address").port();
        drop(listener);
        let (line_tx, mut line_rx) = mpsc::unbounded_channel();
        let (_exit_tx, mut exit_rx) = mpsc::unbounded_channel();
        for _ in 0..1_000 {
            line_tx.send("still starting".to_string()).unwrap();
        }
        let stop = Arc::new(AtomicBool::new(false));
        let producer_stop = stop.clone();
        let producer = std::thread::spawn(move || {
            while !producer_stop.load(Ordering::SeqCst) {
                if line_tx.send("still starting".to_string()).is_err() {
                    break;
                }
                std::thread::yield_now();
            }
        });
        let mut wait = tokio::spawn(async move {
            wait_for_node_backend_readiness(
                &mut line_rx,
                &mut exit_rx,
                port,
                Duration::from_millis(20),
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(100)).await;
        let finished = wait.is_finished();
        stop.store(true, Ordering::SeqCst);
        wait.abort();
        let _ = (&mut wait).await;
        producer.join().expect("stdout producer stops");

        assert!(
            finished,
            "continuous stdout must not starve startup timeout"
        );
    }

    #[test]
    fn backend_stdout_evidence_requires_the_expected_listening_port() {
        assert!(super::backend_stdout_confirms_port(
            "Theia app listening on http://127.0.0.1:3000.",
            3000
        ));
        assert!(!super::backend_stdout_confirms_port(
            "unrelated value 3000",
            3000
        ));
        assert!(!super::backend_stdout_confirms_port(
            "Theia app listening on http://127.0.0.1:3999.",
            3000
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_backend_child_path_preserves_the_windows_path_list() {
        let path = r"C:\Program Files\Git\cmd;D:\Tools\bin";

        assert_eq!(super::backend_child_path_from(path.to_string()), path);
    }

    #[cfg(windows)]
    #[test]
    fn windows_node_runtime_path_removes_verbatim_prefixes() {
        assert_eq!(
            super::node_runtime_path(&PathBuf::from(
                r"\\?\C:\Program Files\R-IDE\resources\backend\main.js",
            )),
            PathBuf::from(r"C:\Program Files\R-IDE\resources\backend\main.js")
        );
        assert_eq!(
            super::node_runtime_path(&PathBuf::from(
                r"\\?\UNC\server\share\R-IDE\resources\backend\main.js",
            )),
            PathBuf::from(r"\\server\share\R-IDE\resources\backend\main.js")
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_conpty_receives_the_cursor_position_response_needed_to_start() {
        let mut input = Vec::new();

        super::initialize_windows_backend_pty_input(&mut input).expect("initialize ConPTY input");

        assert_eq!(input, b"\x1b[1;1R");
    }

    #[test]
    fn backend_pty_lifetime_is_held_until_child_wait_finishes() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        struct DropProbe(Arc<AtomicBool>);
        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let dropped = Arc::new(AtomicBool::new(false));
        let guard = DropProbe(dropped.clone());
        let result = super::wait_with_backend_pty_lifetime(guard, || {
            assert!(!dropped.load(Ordering::SeqCst));
            "child exited"
        });

        assert_eq!(result, "child exited");
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[test]
    fn post_spawn_setup_error_runs_cleanup_before_returning() {
        let mut cleaned = false;
        let result: Result<(), String> =
            super::return_post_spawn_setup_or_cleanup(Err("PTY setup failed".to_string()), || {
                cleaned = true
            });

        assert_eq!(result, Err("PTY setup failed".to_string()));
        assert!(cleaned);
    }

    #[test]
    fn child_exit_failure_clears_state_without_killing_a_reused_pid() {
        let events = std::cell::RefCell::new(Vec::new());
        let error = super::finish_backend_readiness(
            Err(super::BackendReadinessFailure::ChildExited(
                "exit status: 17".to_string(),
            )),
            || events.borrow_mut().push("kill"),
            || events.borrow_mut().push("clear"),
        )
        .expect_err("child exit is a startup failure");

        assert!(error.contains("exit status: 17"), "{error}");
        assert_eq!(*events.borrow(), ["clear"]);
    }

    #[test]
    fn backend_exit_clears_state_and_only_reports_when_unexpected() {
        let unexpected_events = std::cell::RefCell::new(Vec::new());
        super::handle_backend_process_exit(
            "exit status: 17".to_string(),
            false,
            || unexpected_events.borrow_mut().push("clear".to_string()),
            |message| {
                unexpected_events
                    .borrow_mut()
                    .push(format!("error:{message}"))
            },
        );
        assert_eq!(
            *unexpected_events.borrow(),
            [
                "clear",
                "error:Backend exited unexpectedly: exit status: 17"
            ]
        );

        let stopping_events = std::cell::RefCell::new(Vec::new());
        super::handle_backend_process_exit(
            "terminated".to_string(),
            true,
            || stopping_events.borrow_mut().push("clear".to_string()),
            |message| {
                stopping_events
                    .borrow_mut()
                    .push(format!("error:{message}"))
            },
        );
        assert_eq!(*stopping_events.borrow(), ["clear"]);
    }
}
