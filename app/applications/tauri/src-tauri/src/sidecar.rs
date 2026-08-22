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
    BackendLaunchPlan, BackendProcessTree, BackendReadinessPolicy, BackendSpawnPlan,
    BackendSpawnStrategy, BackendStartToken, BackendStartupAction, BackendStartupEvent,
    BackendStartupState, BackendTransport, PreparedBackendProcessTree, RuntimePathMode,
    RuntimePaths, StartupWindowCreatedGate,
};
use crate::startup_gateway::{BackendGeneration, GatewayState};
use crate::startup_metrics::StartupMilestone;
use dirs::home_dir;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::fs;
use std::future::Future;
use std::io::BufRead;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command as StdCommand, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Url};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;

const BACKEND_STARTUP_TIMEOUT: u64 = 240; // seconds
pub(crate) const BACKEND_PORT: u16 = 3000;
pub const BACKEND_CLEANUP_BOUND: Duration = Duration::from_secs(5);
const BACKEND_PROBE_INTERVAL: Duration = Duration::from_millis(50);
const BACKEND_PROBE_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Clone, Debug)]
pub(crate) struct BackendRootCrashEvidence {
    root_pid: u32,
    descendant_pids: Vec<u32>,
    tree: BackendProcessTree,
}

impl BackendRootCrashEvidence {
    fn capture(tree: BackendProcessTree, bound: Duration) -> Result<Self, String> {
        let root_pid = tree.root_pid();
        let descendant_pids = tree
            .process_ids_bounded(bound)?
            .into_iter()
            .filter(|pid| *pid != root_pid)
            .collect();
        Ok(Self {
            root_pid,
            descendant_pids,
            tree,
        })
    }

    #[allow(dead_code)]
    pub(crate) fn root_pid(&self) -> u32 {
        self.root_pid
    }

    #[allow(dead_code)]
    pub(crate) fn descendant_pids(&self) -> &[u32] {
        &self.descendant_pids
    }

    #[allow(dead_code)]
    pub(crate) fn active_process_ids(&self, bound: Duration) -> Result<Vec<u32>, String> {
        self.tree.process_ids_bounded(bound)
    }

    #[allow(dead_code)]
    pub(crate) fn active_process_count(&self) -> Result<u32, String> {
        self.tree.active_process_count()
    }
}

pub async fn race_backend_publication_with_exit<E, P, T>(
    child_exit: E,
    publication: P,
) -> Result<T, E::Output>
where
    E: Future,
    P: Future<Output = T>,
{
    tokio::select! {
        biased;
        exit = child_exit => Err(exit),
        published = publication => Ok(published),
    }
}

#[derive(Clone)]
pub enum BackendReadinessPublisher {
    Legacy {
        navigation_dispatched: Arc<AtomicBool>,
    },
    Gateway {
        state: GatewayState,
        generation: BackendGeneration,
        public_authority: String,
        window_created: StartupWindowCreatedGate,
    },
}

impl BackendReadinessPublisher {
    pub fn legacy() -> Self {
        Self::Legacy {
            navigation_dispatched: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn gateway(
        state: GatewayState,
        generation: BackendGeneration,
        public_authority: String,
        window_created: StartupWindowCreatedGate,
    ) -> Self {
        Self::Gateway {
            state,
            generation,
            public_authority,
            window_created,
        }
    }

    pub fn theia_hosts(&self) -> Option<String> {
        match self {
            Self::Legacy { .. } => None,
            Self::Gateway {
                public_authority, ..
            } => Some(public_authority.clone()),
        }
    }

    pub async fn backend_ready(&self, backend_addr: SocketAddr) -> Result<(), String> {
        self.backend_ready_after_window(backend_addr, || true)
            .await
            .map(|_| ())
    }

    pub async fn backend_ready_after_window<F>(
        &self,
        backend_addr: SocketAddr,
        before_publish: F,
    ) -> Result<bool, String>
    where
        F: FnOnce() -> bool + Send,
    {
        match self {
            Self::Legacy { .. } => Ok(before_publish()),
            Self::Gateway {
                state,
                generation,
                window_created,
                ..
            } => {
                window_created.wait().await;
                state
                    .backend_ready_if_current(*generation, backend_addr, before_publish)
                    .await
                    .map_err(|error| error.to_string())
            }
        }
    }

    pub fn dispatch_readiness_navigation(
        &self,
        port: u16,
        locale: Option<&str>,
        navigate: impl FnOnce(Url),
    ) -> Result<bool, String> {
        let navigation_dispatched = match self {
            Self::Gateway { .. } => return Ok(false),
            Self::Legacy {
                navigation_dispatched,
            } => navigation_dispatched,
        };
        if navigation_dispatched
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Ok(false);
        }

        let mut url = Url::parse(&format!("http://127.0.0.1:{port}/"))
            .map_err(|error| format!("Failed to build backend frontend URL: {error}"))?;
        if let Some(locale) = locale {
            url.query_pairs_mut().append_pair("ride_locale", locale);
        }
        navigate(url);
        Ok(true)
    }

    pub async fn backend_failed(&self) {
        if let Self::Gateway {
            state, generation, ..
        } = self
        {
            if let Err(error) = state.fail_backend(*generation, "backend unavailable").await {
                log::debug!("Gateway ignored backend failure publication: {error}");
            }
        }
    }
}

trait BackendChildEnvironment {
    fn remove_environment(&mut self, name: &str);
}

impl BackendChildEnvironment for CommandBuilder {
    fn remove_environment(&mut self, name: &str) {
        self.env_remove(name);
    }
}

impl BackendChildEnvironment for Command {
    fn remove_environment(&mut self, name: &str) {
        self.env_remove(name);
    }
}

fn remove_smoke_environment(command: &mut impl BackendChildEnvironment) {
    for name in crate::smoke::SMOKE_ENV_NAMES {
        command.remove_environment(name);
    }
}

pub(crate) fn resolve_runtime_paths(app_handle: &AppHandle) -> Result<RuntimePaths, String> {
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

struct BackendProcessStart<'a> {
    config_dir: PathBuf,
    frontend_dir: Option<PathBuf>,
    launch_plan: &'a BackendLaunchPlan,
    backend_start: BackendStartToken,
    publisher: BackendReadinessPublisher,
    watcher_process: bool,
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

fn announce_backend_port(app_handle: &AppHandle, port: u16, publisher: &BackendReadinessPublisher) {
    let locale = system_locale();
    if let Err(error) = publisher.dispatch_readiness_navigation(port, locale.as_deref(), |url| {
        let _ = app_handle.emit("backend-ready", port);
        navigate_main_window_to_backend(app_handle, url);
    }) {
        log::warn!("Failed to prepare backend navigation: {error}");
    }
}

pub fn publish_backend_listening_in_order(
    port: u16,
    record: impl FnOnce(StartupMilestone),
    publish: impl FnOnce(u16),
) {
    record(StartupMilestone::BackendListening);
    publish(port);
}

async fn publish_backend_listening(
    app_handle: &AppHandle,
    pid: u32,
    port: u16,
    publisher: &BackendReadinessPublisher,
) -> Result<bool, String> {
    let published = publisher
        .backend_ready_after_window(SocketAddr::from(([127, 0, 0, 1], port)), || {
            let Some(state) = app_handle.try_state::<crate::AppState>() else {
                return false;
            };
            let ownership = state.backend_ownership.lock().unwrap();
            if !ownership.owns_active(pid) {
                return false;
            }
            let mut published_port = state.backend_port.lock().unwrap();
            record_backend_listening(app_handle);
            *published_port = Some(port);
            set_backend_ready_pid_if_accepted(&state.backend_ready_pid, pid, true);
            true
        })
        .await?;
    if published {
        announce_backend_port(app_handle, port, publisher);
    }
    Ok(published)
}

fn prepare_direct_backend_tree(
    command: &mut Command,
) -> Result<PreparedBackendProcessTree, String> {
    PreparedBackendProcessTree::for_direct(command)
}

#[cfg(windows)]
fn claim_direct_backend_tree(
    prepared: PreparedBackendProcessTree,
    child: &tokio::process::Child,
    pid: u32,
) -> Result<crate::startup::BackendProcessTree, String> {
    let root_process = child
        .raw_handle()
        .ok_or_else(|| "Direct backend did not expose a Windows process handle".to_string())?;
    prepared.claim_direct(pid, root_process.cast())
}

#[cfg(unix)]
fn claim_direct_backend_tree(
    prepared: PreparedBackendProcessTree,
    _child: &tokio::process::Child,
    pid: u32,
) -> Result<crate::startup::BackendProcessTree, String> {
    prepared.claim_direct(pid)
}

#[cfg(windows)]
fn ensure_backend_pty_tree_ownership_supported() -> Result<(), String> {
    Err(
        "RIDE_BACKEND_TRANSPORT=pty is unavailable on Windows because portable-pty cannot atomically assign the backend to its generation Job Object; use direct transport"
            .to_string(),
    )
}

#[cfg(unix)]
fn ensure_backend_pty_tree_ownership_supported() -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
fn backend_pty_tree_ownership_supported() -> bool {
    ensure_backend_pty_tree_ownership_supported().is_ok()
}

#[cfg(unix)]
fn claim_pty_backend_tree(pid: u32) -> Result<crate::startup::BackendProcessTree, String> {
    crate::startup::claim_pty_backend_process_tree(pid)
}

#[cfg(windows)]
fn claim_pty_backend_tree(_pid: u32) -> Result<crate::startup::BackendProcessTree, String> {
    ensure_backend_pty_tree_ownership_supported()?;
    unreachable!("unsupported Windows PTY ownership returned success")
}

fn register_backend_tree(
    app_handle: &AppHandle,
    start: BackendStartToken,
    tree: crate::startup::BackendProcessTree,
    stop_fallback: tokio::sync::mpsc::UnboundedSender<()>,
) -> bool {
    let pid = tree.root_pid();
    app_handle
        .try_state::<crate::AppState>()
        .map(|state| {
            let mut ownership = state.backend_ownership.lock().unwrap();
            let registered = ownership.register_tree(start, tree.clone());
            let retained =
                registered || ownership.retain_tree_for_cancelled_start(start, tree.clone());
            if !retained {
                return false;
            }
            *state.backend_stop_fallback.lock().unwrap() = Some((pid, stop_fallback));
            registered
        })
        .unwrap_or(false)
}

fn navigate_main_window_to_backend(app_handle: &AppHandle, url: Url) {
    let Some(window) = app_handle.get_webview_window("main") else {
        log::warn!("Main window is not available for backend navigation");
        return;
    };

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
    let (owns_process, stopping) = {
        let mut ownership = state.backend_ownership.lock().unwrap();
        let owns_process = ownership.pid() == Some(pid);
        let stopping = ownership.clear_spawn(pid);
        (owns_process, stopping)
    };
    if owns_process {
        let mut stop_fallback = state.backend_stop_fallback.lock().unwrap();
        if stop_fallback.as_ref().map(|(owner, _)| *owner) == Some(pid) {
            stop_fallback.take();
        }
        *state.backend_port.lock().unwrap() = None;
    }
    state.backend_cleanup_notify.notify_waiters();
    stopping
}

fn clear_backend_tree(app_handle: &AppHandle, tree: &BackendProcessTree) -> bool {
    let Some(state) = app_handle.try_state::<crate::AppState>() else {
        return false;
    };
    let (owned, stopping) = {
        let mut ownership = state.backend_ownership.lock().unwrap();
        let owned = ownership
            .tree()
            .as_ref()
            .is_some_and(|current| current.same_owner(tree));
        let stopping = owned && ownership.clear_tree(tree);
        (owned, stopping)
    };
    if owned {
        let mut stop_fallback = state.backend_stop_fallback.lock().unwrap();
        if stop_fallback.as_ref().map(|(owner, _)| *owner) == Some(tree.root_pid()) {
            stop_fallback.take();
        }
        *state.backend_port.lock().unwrap() = None;
        state.backend_cleanup_notify.notify_waiters();
    }
    stopping
}

#[cfg(windows)]
fn mark_backend_root_exited(app_handle: &AppHandle, pid: u32) -> bool {
    let Some(state) = app_handle.try_state::<crate::AppState>() else {
        return false;
    };
    let stopping = state
        .backend_ownership
        .lock()
        .unwrap()
        .mark_root_exited(pid);
    *state.backend_port.lock().unwrap() = None;
    state.backend_cleanup_notify.notify_waiters();
    stopping
}

fn mark_backend_tree_root_exited(
    app_handle: &AppHandle,
    tree: &BackendProcessTree,
) -> Option<bool> {
    let state = app_handle.try_state::<crate::AppState>()?;
    let stopping = state
        .backend_ownership
        .lock()
        .unwrap()
        .mark_tree_root_exited(tree)?;
    *state.backend_port.lock().unwrap() = None;
    state.backend_cleanup_notify.notify_waiters();
    Some(stopping)
}

#[cfg(unix)]
fn observe_unix_backend_root_exit_without_reaping(pid: u32) -> Result<String, String> {
    let pid = i32::try_from(pid)
        .map_err(|_| format!("Backend pid {pid} does not fit a Unix process id"))?;
    let mut information = std::mem::MaybeUninit::<libc::siginfo_t>::zeroed();
    if unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            information.as_mut_ptr(),
            libc::WEXITED | libc::WNOWAIT,
        )
    } != 0
    {
        return Err(format!(
            "Failed to observe backend root exit without reaping: {}",
            std::io::Error::last_os_error()
        ));
    }
    let information = unsafe { information.assume_init() };
    Ok(format!("waitid status {}", unsafe {
        information.si_status()
    }))
}

#[cfg(unix)]
async fn observe_backend_root_exit(
    _child: &mut tokio::process::Child,
    pid: u32,
) -> Result<(String, bool), String> {
    tauri::async_runtime::spawn_blocking(move || {
        observe_unix_backend_root_exit_without_reaping(pid).map(|exit| (exit, false))
    })
    .await
    .map_err(|error| format!("Backend root observation task failed: {error}"))?
}

#[cfg(windows)]
async fn observe_backend_root_exit(
    child: &mut tokio::process::Child,
    _pid: u32,
) -> Result<(String, bool), String> {
    child
        .wait()
        .await
        .map(|status| (status.to_string(), true))
        .map_err(|error| format!("Failed to wait for backend: {error}"))
}

fn complete_backend_start(app_handle: &AppHandle, start: BackendStartToken) {
    let Some(state) = app_handle.try_state::<crate::AppState>() else {
        return;
    };
    if state
        .backend_ownership
        .lock()
        .unwrap()
        .complete_start(start)
    {
        state.backend_cleanup_notify.notify_waiters();
    }
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

#[cfg(any(windows, test))]
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
    reap_portable_child_bounded_ref(child.as_mut())
}

fn reap_portable_child_bounded_ref(
    child: &mut (dyn portable_pty::Child + Send + Sync),
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

#[cfg(windows)]
async fn kill_portable_child_async(
    mut killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || killer.kill())
        .await
        .map_err(|error| format!("PTY backend kill task failed: {error}"))?
        .map_err(|error| format!("Failed to kill PTY backend: {error}"))
}

#[cfg(windows)]
type SharedPtyExitReceiver = Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<String>>>;

#[cfg(windows)]
async fn run_pty_cleanup_action_bounded(
    action: impl Future<Output = Result<(), String>>,
    timeout_error: &'static str,
) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(5), action)
        .await
        .unwrap_or_else(|_| Err(timeout_error.to_string()))
}

#[cfg(windows)]
async fn wait_for_pty_exit_bounded(exit_rx: SharedPtyExitReceiver) -> Result<(), String> {
    let mut exit_rx = exit_rx.lock().await;
    match tokio::time::timeout(Duration::from_secs(5), exit_rx.recv()).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err("PTY backend exit channel closed before reap".to_string()),
        Err(_) => Err("PTY backend reap timed out".to_string()),
    }
}

#[cfg(any(windows, test))]
async fn clear_retained_pty_ownership_after_exit<Exit, Clear>(exit: Exit, clear: Clear) -> bool
where
    Exit: Future<Output = Option<String>>,
    Clear: FnOnce(),
{
    if exit.await.is_some() {
        clear();
        true
    } else {
        false
    }
}

#[cfg(any(windows, test))]
fn pty_cleanup_status(result: &Result<(), String>) -> String {
    const MAX_CHARS: usize = 192;
    result
        .as_ref()
        .map(|()| "ok".to_string())
        .unwrap_or_else(|error| error.chars().take(MAX_CHARS).collect())
}

fn finish_owned_tree_cleanup(
    tree_termination: Result<(), String>,
    root_reap: Result<(), String>,
    release: impl FnOnce(),
) -> Result<(), String> {
    match (tree_termination, root_reap) {
        (Ok(()), Ok(())) => {
            release();
            Ok(())
        }
        (Err(tree), Ok(())) => Err(tree),
        (Ok(()), Err(reap)) => Err(reap),
        (Err(tree), Err(reap)) => Err(format!("{tree}; {reap}")),
    }
}

async fn finish_owned_tree_cleanup_async<Termination, Reap, ReapFuture, Release>(
    tree_termination: Termination,
    root_reap: Reap,
    release: Release,
) -> Result<(), String>
where
    Termination: Future<Output = Result<(), String>>,
    Reap: FnOnce() -> ReapFuture,
    ReapFuture: Future<Output = Result<(), String>>,
    Release: FnOnce(),
{
    tree_termination.await?;
    finish_owned_tree_cleanup(Ok(()), root_reap().await, release)
}

#[cfg(any(windows, test))]
async fn finish_pty_readiness_publication<
    Kill,
    KillFuture,
    FirstReap,
    FirstReapFuture,
    TreeFallback,
    TreeFallbackFuture,
    SecondReap,
    SecondReapFuture,
    Clear,
    Retain,
    RetainFuture,
>(
    publication: Result<bool, String>,
    kill: Kill,
    first_reap: FirstReap,
    tree_fallback: TreeFallback,
    second_reap: SecondReap,
    clear: Clear,
    retain: Retain,
) -> Result<(), String>
where
    Kill: FnOnce() -> KillFuture,
    KillFuture: Future<Output = Result<(), String>>,
    FirstReap: FnOnce() -> FirstReapFuture,
    FirstReapFuture: Future<Output = Result<(), String>>,
    TreeFallback: FnOnce() -> TreeFallbackFuture,
    TreeFallbackFuture: Future<Output = Result<(), String>>,
    SecondReap: FnOnce() -> SecondReapFuture,
    SecondReapFuture: Future<Output = Result<(), String>>,
    Clear: FnOnce(),
    Retain: FnOnce() -> RetainFuture,
    RetainFuture: Future<Output = ()>,
{
    let publication_error = match publication {
        Ok(true) => return Ok(()),
        Ok(false) => "Backend start was cancelled before PTY publication".to_string(),
        Err(error) => error,
    };
    let kill = kill().await;
    let first_reap = first_reap().await;
    if first_reap.is_ok() {
        clear();
        return Err(format!(
            "{publication_error}; ownership cleared after confirmed exit; kill: {}; first reap: ok; tree fallback: skipped; second reap: skipped",
            pty_cleanup_status(&kill)
        ));
    }

    let tree_fallback = tree_fallback().await;
    let second_reap = second_reap().await;
    let ownership = if second_reap.is_ok() {
        clear();
        "ownership cleared after confirmed exit"
    } else {
        retain().await;
        "ownership retained pending confirmed exit"
    };
    Err(format!(
        "{publication_error}; {ownership}; kill: {}; first reap: {}; tree fallback: {}; second reap: {}",
        pty_cleanup_status(&kill),
        pty_cleanup_status(&first_reap),
        pty_cleanup_status(&tree_fallback),
        pty_cleanup_status(&second_reap)
    ))
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

#[cfg(unix)]
async fn cleanup_owned_pty_before_watcher(
    app_handle: &AppHandle,
    tree: &BackendProcessTree,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    stop_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
) -> Result<(), String> {
    let termination = terminate_owned_tree_async(tree, BACKEND_CLEANUP_BOUND).await;
    if let Err(error) = termination {
        retain_owned_pty_cleanup(
            app_handle.clone(),
            tree.clone(),
            child,
            stop_rx,
            error.clone(),
        );
        return Err(error);
    }
    let (child, reap) = tauri::async_runtime::spawn_blocking(move || {
        let reap = reap_portable_child_bounded_ref(child.as_mut());
        (child, reap)
    })
    .await
    .map_err(|error| format!("PTY backend reap task failed: {error}"))?;
    if let Err(error) = reap {
        retain_owned_pty_cleanup(
            app_handle.clone(),
            tree.clone(),
            child,
            stop_rx,
            error.clone(),
        );
        return Err(error);
    }
    finish_owned_tree_cleanup(Ok(()), Ok(()), || {
        clear_backend_tree(app_handle, tree);
    })
}

#[cfg(unix)]
fn retain_owned_pty_cleanup(
    app_handle: AppHandle,
    tree: BackendProcessTree,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    mut stop_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
    initial_error: String,
) {
    std::thread::spawn(move || {
        let mut cleanup_error = initial_error;
        loop {
            log::error!(
                "Retaining PTY backend process-tree ownership after cleanup failure: {cleanup_error}"
            );
            std::thread::sleep(Duration::from_millis(100));
            while stop_rx.try_recv().is_ok() {}
            match tree.terminate_and_confirm(BACKEND_CLEANUP_BOUND) {
                Ok(()) => match reap_portable_child_bounded_ref(child.as_mut()) {
                    Ok(()) => {
                        clear_backend_tree(&app_handle, &tree);
                        return;
                    }
                    Err(error) => cleanup_error = error,
                },
                Err(error) => cleanup_error = error,
            }
        }
    });
}

#[cfg(unix)]
type SharedPtyCleanupReceiver =
    Arc<tokio::sync::Mutex<tokio::sync::mpsc::UnboundedReceiver<Result<(), String>>>>;

#[cfg(unix)]
async fn request_owned_pty_cleanup(
    tree: &BackendProcessTree,
    stop: &tokio::sync::mpsc::UnboundedSender<()>,
    cleanup: &SharedPtyCleanupReceiver,
) -> Result<(), String> {
    let termination = terminate_owned_tree_async(tree, BACKEND_CLEANUP_BOUND).await;
    let signal = stop
        .send(())
        .map_err(|_| "PTY backend cleanup watcher was unavailable".to_string());
    let watcher = if signal.is_ok() {
        let mut cleanup = cleanup.lock().await;
        match tokio::time::timeout(BACKEND_CLEANUP_BOUND, cleanup.recv()).await {
            Ok(Some(result)) => result,
            Ok(None) => Err("PTY backend cleanup watcher closed without evidence".to_string()),
            Err(_) => Err(format!(
                "PTY backend watcher cleanup exceeded {}ms",
                BACKEND_CLEANUP_BOUND.as_millis()
            )),
        }
    } else {
        signal
    };
    match (termination, watcher) {
        (_, Ok(())) => Ok(()),
        (Ok(()), Err(watcher)) => Err(watcher),
        (Err(termination), Err(watcher)) => Err(format!("{termination}; {watcher}")),
    }
}

#[cfg(unix)]
async fn start_node_backend_process(
    app_handle: &AppHandle,
    config: &BackendConfig,
    start: BackendProcessStart<'_>,
) -> Result<(), String> {
    let BackendProcessStart {
        config_dir,
        frontend_dir,
        launch_plan,
        backend_start,
        publisher,
        watcher_process,
    } = start;
    ensure_backend_pty_tree_ownership_supported()?;
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
        .map_err(|error| format!("Failed to create backend PTY: {error}"))?;

    let mut command = CommandBuilder::new(&config.node_exe);
    remove_smoke_environment(&mut command);
    command.arg(&script_path);
    command.arg("--log-level=info");
    command.arg(format!("--port={BACKEND_PORT}"));
    command.arg("--hostname=127.0.0.1");
    if let Some(backend_dir) = script_path.parent() {
        command.cwd(backend_dir);
    }
    if !watcher_process {
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
    if let Some(public_authority) = publisher.theia_hosts() {
        command.env("THEIA_HOSTS", public_authority);
    }

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Failed to spawn backend in PTY: {error}"))?;
    drop(pair.slave);
    record_backend_spawned_before_window(app_handle);
    let Some(pid) = child.process_id() else {
        let cleanup = tauri::async_runtime::spawn_blocking(move || {
            let _ = child.kill();
            reap_portable_child_bounded(child)
        })
        .await
        .map_err(|error| format!("Unidentified PTY backend cleanup task failed: {error}"))?;
        clear_backend_state(app_handle);
        return Err(match cleanup {
            Ok(()) => "PTY backend process did not report a process id".to_string(),
            Err(cleanup) => format!(
                "PTY backend process did not report a process id; cleanup failed: {cleanup}"
            ),
        });
    };
    log::info!("Backend PTY process started with pid {pid}");
    let tree = match claim_pty_backend_tree(pid) {
        Ok(tree) => tree,
        Err(error) => {
            let cleanup = cleanup_failed_pty_backend_start(app_handle, child, Some(pid)).await;
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
            });
        }
    };
    let (stop_tx, mut stop_rx) = tokio::sync::mpsc::unbounded_channel();
    if !register_backend_tree(app_handle, backend_start, tree.clone(), stop_tx.clone()) {
        let cleanup = cleanup_owned_pty_before_watcher(app_handle, &tree, child, stop_rx).await;
        return Err(match cleanup {
            Ok(()) => "Backend start was cancelled before PTY spawn completed".to_string(),
            Err(cleanup) => format!(
                "Backend start was cancelled before PTY spawn completed; cleanup failed: {cleanup}"
            ),
        });
    }

    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let error = format!("Failed to clone backend PTY reader: {error}");
            let cleanup = cleanup_owned_pty_before_watcher(app_handle, &tree, child, stop_rx).await;
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
            });
        }
    };
    let pty_lifetime = pair.master;
    send_signal(pid, "-CONT");
    std::thread::spawn(move || {
        for delay in [250_u64, 1000] {
            std::thread::sleep(Duration::from_millis(delay));
            send_signal(pid, "-CONT");
        }
    });

    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        let reader = std::io::BufReader::new(reader);
        for line in reader.lines().map_while(Result::ok) {
            let _ = line_tx.send(line);
        }
    });
    let (exit_tx, mut exit_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (cleanup_tx, cleanup_rx) = tokio::sync::mpsc::unbounded_channel();
    let cleanup_rx = Arc::new(tokio::sync::Mutex::new(cleanup_rx));
    let watcher_app = app_handle.clone();
    let watcher_tree = tree.clone();
    std::thread::spawn(move || {
        let _pty_lifetime = pty_lifetime;
        let exit =
            observe_unix_backend_root_exit_without_reaping(pid).unwrap_or_else(|error| error);
        if mark_backend_tree_root_exited(&watcher_app, &watcher_tree).is_none() {
            log::warn!("Observed a stale PTY backend root exit for pid {pid}");
        }
        let _ = exit_tx.send(exit);
        if stop_rx.blocking_recv().is_none() {
            let _ = cleanup_tx.send(Err(
                "PTY cleanup channel closed while process-group ownership was retained".to_string(),
            ));
        }
        loop {
            let result = match watcher_tree.terminate_and_confirm(BACKEND_CLEANUP_BOUND) {
                Ok(()) => child
                    .wait()
                    .map(|_| ())
                    .map_err(|error| format!("Failed to reap retained PTY backend root: {error}")),
                Err(error) => Err(error),
            };
            match result {
                Ok(()) => {
                    clear_backend_tree(&watcher_app, &watcher_tree);
                    let _ = cleanup_tx.send(Ok(()));
                    return;
                }
                Err(error) => {
                    let _ = cleanup_tx.send(Err(error.clone()));
                    log::error!(
                        "Retaining PTY backend ownership for another cleanup attempt: {error}"
                    );
                    std::thread::sleep(Duration::from_millis(100));
                    while stop_rx.try_recv().is_ok() {}
                }
            }
        }
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
        Err(failure) => {
            let reason = failure.message();
            let cleanup = request_owned_pty_cleanup(&tree, &stop_tx, &cleanup_rx).await;
            return Err(match cleanup {
                Ok(()) => reason,
                Err(cleanup) => format!("{reason}; PTY cleanup failed: {cleanup}"),
            });
        }
    };
    if !owns_active_backend(app_handle, pid) {
        let cleanup = request_owned_pty_cleanup(&tree, &stop_tx, &cleanup_rx).await;
        return Err(match cleanup {
            Ok(()) => "Backend start was cancelled before PTY readiness".to_string(),
            Err(cleanup) => format!(
                "Backend start was cancelled before PTY readiness; cleanup failed: {cleanup}"
            ),
        });
    }
    log::info!("Backend ready on port {ready_port}");
    match race_backend_publication_with_exit(
        exit_rx.recv(),
        publish_backend_listening(app_handle, pid, ready_port, &publisher),
    )
    .await
    {
        Ok(Ok(true)) => {}
        Ok(publication) => {
            let reason = match publication {
                Ok(false) => "Backend start was cancelled before PTY publication".to_string(),
                Err(error) => error,
                Ok(true) => unreachable!(),
            };
            let cleanup = request_owned_pty_cleanup(&tree, &stop_tx, &cleanup_rx).await;
            return Err(match cleanup {
                Ok(()) => reason,
                Err(cleanup) => format!("{reason}; cleanup failed: {cleanup}"),
            });
        }
        Err(exit) => {
            let reason = exit
                .map(|exit| {
                    format!("Backend process exited before PTY readiness publication: {exit}")
                })
                .unwrap_or_else(|| {
                    "Backend PTY exit channel closed before readiness publication".to_string()
                });
            let cleanup = request_owned_pty_cleanup(&tree, &stop_tx, &cleanup_rx).await;
            return Err(match cleanup {
                Ok(()) => reason,
                Err(cleanup) => format!("{reason}; cleanup failed: {cleanup}"),
            });
        }
    }

    let app_handle_logs = app_handle.clone();
    std::thread::spawn(move || {
        while let Some(line) = line_rx.blocking_recv() {
            log::info!("Backend stdout: {line}");
            let _ = app_handle_logs.emit("backend-log", line);
        }
    });
    let app_handle_exit = app_handle.clone();
    let exit_publisher = publisher.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(exit) = exit_rx.recv().await {
            clear_backend_state(&app_handle_exit);
            if !is_backend_stopping(&app_handle_exit) {
                let message = format!("Backend exited unexpectedly: {exit}");
                log::error!("{message}");
                let _ = app_handle_exit.emit("backend-error", message);
                exit_publisher.backend_failed().await;
            }
        }
    });
    Ok(())
}

#[cfg(windows)]
async fn start_node_backend_process(
    app_handle: &AppHandle,
    config: &BackendConfig,
    start: BackendProcessStart<'_>,
) -> Result<(), String> {
    let BackendProcessStart {
        config_dir,
        frontend_dir,
        launch_plan,
        backend_start,
        publisher,
        watcher_process,
    } = start;
    ensure_backend_pty_tree_ownership_supported()?;
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
    remove_smoke_environment(&mut command);
    command.arg(&script_path);
    command.arg("--log-level=info");
    command.arg(format!("--port={BACKEND_PORT}"));
    command.arg("--hostname=127.0.0.1");
    if let Some(backend_dir) = script_path.parent() {
        command.cwd(backend_dir);
    }
    if !watcher_process {
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
    if let Some(public_authority) = publisher.theia_hosts() {
        command.env("THEIA_HOSTS", public_authority);
    }

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
        let backend_tree = match claim_pty_backend_tree(pid) {
            Ok(tree) => tree,
            Err(error) => {
                let _ = child.kill();
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    reap_portable_child_bounded(child)
                })
                .await;
                return Err(error);
            }
        };
        if !register_backend_tree(app_handle, backend_start, backend_tree, stop_fallback_tx) {
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
    let publication = match race_backend_publication_with_exit(
        exit_rx.recv(),
        publish_backend_listening(app_handle, pid, ready_port, &publisher),
    )
    .await
    {
        Ok(published) => published,
        Err(exit) => {
            clear_backend_process(app_handle, pid);
            return Err(match exit {
                Some(exit) => {
                    format!("Backend process exited before PTY readiness publication: {exit}")
                }
                None => "Backend PTY exit channel closed before readiness publication".to_string(),
            });
        }
    };
    match publication {
        Ok(true) => {}
        publication => {
            let exit_rx = Arc::new(tokio::sync::Mutex::new(exit_rx));
            let first_reap_exit = exit_rx.clone();
            let second_reap_exit = exit_rx.clone();
            let retained_exit = exit_rx.clone();
            let retained_app = app_handle.clone();
            return finish_pty_readiness_publication(
                publication,
                || {
                    run_pty_cleanup_action_bounded(
                        kill_portable_child_async(pty_killer),
                        "PTY exact-child kill timed out",
                    )
                },
                move || wait_for_pty_exit_bounded(first_reap_exit),
                || {
                    run_pty_cleanup_action_bounded(
                        terminate_process_tree_async(pid),
                        "PTY process-tree termination timed out",
                    )
                },
                move || wait_for_pty_exit_bounded(second_reap_exit),
                || {
                    clear_backend_process(app_handle, pid);
                },
                move || async move {
                    tauri::async_runtime::spawn(async move {
                        clear_retained_pty_ownership_after_exit(
                            async move {
                                let mut retained_exit = retained_exit.lock().await;
                                retained_exit.recv().await
                            },
                            move || {
                                clear_backend_process(&retained_app, pid);
                            },
                        )
                        .await;
                    });
                },
            )
            .await;
        }
    }

    let app_handle_logs = app_handle.clone();
    std::thread::spawn(move || {
        while let Some(line) = line_rx.blocking_recv() {
            log::info!("Backend stdout: {}", line);
            let _ = app_handle_logs.emit("backend-log", line);
        }
    });

    let app_handle_exit = app_handle.clone();
    let exit_publisher = publisher.clone();
    std::thread::spawn(move || {
        if let Some(exit) = exit_rx.blocking_recv() {
            let stopping = child_pid
                .map(|pid| {
                    let stopping = mark_backend_root_exited(&app_handle_exit, pid);
                    if stopping {
                        clear_backend_process(&app_handle_exit, pid);
                    }
                    stopping
                })
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
                    let publisher = exit_publisher.clone();
                    tauri::async_runtime::spawn(async move {
                        publisher.backend_failed().await;
                    });
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

async fn terminate_owned_tree_async(
    tree: &BackendProcessTree,
    bound: Duration,
) -> Result<(), String> {
    let tree = tree.clone();
    tauri::async_runtime::spawn_blocking(move || tree.terminate_and_confirm(bound))
        .await
        .map_err(|error| format!("Owned backend tree termination task failed: {error}"))?
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

async fn cleanup_owned_direct_backend(
    app_handle: &AppHandle,
    tree: &BackendProcessTree,
    child: &mut tokio::process::Child,
    root_already_reaped: bool,
) -> Result<(), String> {
    finish_owned_tree_cleanup_async(
        terminate_owned_tree_async(tree, BACKEND_CLEANUP_BOUND),
        || async {
            if root_already_reaped {
                Ok(())
            } else {
                reap_backend_child(child).await
            }
        },
        || {
            clear_backend_tree(app_handle, tree);
        },
    )
    .await
}

fn retain_owned_direct_backend_cleanup(
    app_handle: AppHandle,
    tree: BackendProcessTree,
    mut child: tokio::process::Child,
    mut stop_fallback_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
    root_already_reaped: bool,
    initial_error: String,
) {
    tauri::async_runtime::spawn(async move {
        let mut cleanup_error = initial_error;
        let mut stop_channel_open = true;
        loop {
            log::error!(
                "Retaining backend process-tree ownership after cleanup failure: {cleanup_error}"
            );
            if stop_channel_open {
                tokio::select! {
                    signal = stop_fallback_rx.recv() => {
                        stop_channel_open = signal.is_some();
                    }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                }
            } else {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            match cleanup_owned_direct_backend(&app_handle, &tree, &mut child, root_already_reaped)
                .await
            {
                Ok(()) => return,
                Err(error) => cleanup_error = error,
            }
        }
    });
}

async fn cleanup_or_retain_owned_direct_backend(
    app_handle: &AppHandle,
    tree: BackendProcessTree,
    mut child: tokio::process::Child,
    stop_fallback_rx: tokio::sync::mpsc::UnboundedReceiver<()>,
    root_already_reaped: bool,
) -> Result<(), String> {
    let cleanup =
        cleanup_owned_direct_backend(app_handle, &tree, &mut child, root_already_reaped).await;
    if let Err(error) = cleanup.as_ref() {
        retain_owned_direct_backend_cleanup(
            app_handle.clone(),
            tree,
            child,
            stop_fallback_rx,
            root_already_reaped,
            error.clone(),
        );
    }
    cleanup
}

async fn apply_backend_cleanup_actions(
    app_handle: &AppHandle,
    tree: &BackendProcessTree,
    child: &mut tokio::process::Child,
    actions: impl IntoIterator<Item = BackendStartupAction>,
    publisher: &BackendReadinessPublisher,
) -> Result<(), String> {
    let mut cleanup_requested = false;
    for action in actions {
        match action {
            BackendStartupAction::TerminateProcessTree(pid)
            | BackendStartupAction::ReapOwnedChild(pid) => {
                if pid != tree.root_pid() {
                    return Err(format!(
                        "Cleanup action targeted pid {pid}, but the owned tree root is {}",
                        tree.root_pid()
                    ));
                }
                cleanup_requested = true;
            }
            BackendStartupAction::ClearState => cleanup_requested = true,
            other => apply_backend_startup_actions(app_handle, [other], publisher).await?,
        }
    }
    if cleanup_requested {
        cleanup_owned_direct_backend(app_handle, tree, child, false).await
    } else {
        Ok(())
    }
}

async fn apply_backend_startup_actions(
    app_handle: &AppHandle,
    actions: impl IntoIterator<Item = BackendStartupAction>,
    publisher: &BackendReadinessPublisher,
) -> Result<(), String> {
    for action in actions {
        match action {
            BackendStartupAction::PublishReady { pid, port } => {
                if !publish_backend_listening(app_handle, pid, port, publisher).await? {
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

fn spawn_backend_pipe_log<R>(
    app_handle: AppHandle,
    reader: R,
    stderr: bool,
    publisher: BackendReadinessPublisher,
) where
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
            let _ = apply_backend_startup_actions(&app_handle, [action], &publisher).await;
        }
    });
}

async fn start_backend_direct_process(
    app_handle: &AppHandle,
    config: &BackendConfig,
    start: BackendProcessStart<'_>,
) -> Result<(), String> {
    let BackendProcessStart {
        config_dir,
        frontend_dir,
        launch_plan,
        backend_start,
        publisher,
        watcher_process,
    } = start;
    ensure_backend_port_available(BACKEND_PORT)?;
    let script_path = node_runtime_path(&config.script_path);
    let config_dir = node_runtime_path(&config_dir);
    let frontend_dir = frontend_dir.map(|path| node_runtime_path(&path));
    let mut command = Command::new(&config.node_exe);
    remove_smoke_environment(&mut command);
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
        if !watcher_process {
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
    if let Some(public_authority) = publisher.theia_hosts() {
        command.env("THEIA_HOSTS", public_authority);
    }
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

    let prepared_tree = prepare_direct_backend_tree(&mut command)?;

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
    let backend_tree = match claim_direct_backend_tree(prepared_tree, &child, pid) {
        Ok(tree) => tree,
        Err(error) => {
            let cleanup = kill_and_reap_backend_child(&mut child).await;
            return Err(match cleanup {
                Ok(()) => error,
                Err(cleanup) => format!("{error}; suspended backend cleanup failed: {cleanup}"),
            });
        }
    };
    let lifecycle_tree = backend_tree.clone();
    let (stop_fallback_tx, mut stop_fallback_rx) = tokio::sync::mpsc::unbounded_channel();
    if !register_backend_tree(
        app_handle,
        backend_start,
        backend_tree.clone(),
        stop_fallback_tx,
    ) {
        let cleanup = cleanup_or_retain_owned_direct_backend(
            app_handle,
            backend_tree.clone(),
            child,
            stop_fallback_rx,
            false,
        )
        .await;
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
                &backend_tree,
                &mut child,
                startup_state.observe(BackendStartupEvent::TimedOut),
                &publisher,
            )
            .await;
            if let Err(error) = cleanup.as_ref() {
                retain_owned_direct_backend_cleanup(
                    app_handle.clone(),
                    backend_tree.clone(),
                    child,
                    stop_fallback_rx,
                    false,
                    error.clone(),
                );
            }
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
                &backend_tree,
                &mut child,
                startup_state.observe(BackendStartupEvent::TimedOut),
                &publisher,
            )
            .await;
            if let Err(error) = cleanup.as_ref() {
                retain_owned_direct_backend_cleanup(
                    app_handle.clone(),
                    backend_tree.clone(),
                    child,
                    stop_fallback_rx,
                    false,
                    error.clone(),
                );
            }
            return match cleanup {
                Ok(()) => Err("Failed to capture backend stderr".to_string()),
                Err(cleanup) => Err(format!(
                    "Failed to capture backend stderr; cleanup failed: {cleanup}"
                )),
            };
        }
    };
    spawn_backend_pipe_log(app_handle.clone(), stdout, false, publisher.clone());
    spawn_backend_pipe_log(app_handle.clone(), stderr, true, publisher.clone());

    let readiness_policy = BackendReadinessPolicy::new(
        Duration::from_secs(BACKEND_STARTUP_TIMEOUT),
        BACKEND_PROBE_INTERVAL,
        BACKEND_PROBE_TIMEOUT,
    )?;
    tokio::select! {
        biased;
        stop = stop_fallback_rx.recv() => {
            let cleanup = cleanup_or_retain_owned_direct_backend(
                app_handle,
                backend_tree.clone(),
                child,
                stop_fallback_rx,
                false,
            ).await;
            let reason = if stop.is_some() {
                "Backend start was cancelled before readiness"
            } else {
                "Backend cleanup channel closed before readiness"
            };
            Err(match cleanup {
                Ok(()) => reason.to_string(),
                Err(cleanup) => format!("{reason}; cleanup failed: {cleanup}"),
            })
        }
        exit = observe_backend_root_exit(&mut child, pid) => {
            let (reason, root_reaped) = match exit {
                Ok((exit, root_reaped)) => (
                    format!("Backend process exited before ready: {exit}"),
                    root_reaped,
                ),
                Err(error) => (error, false),
            };
            let cleanup = cleanup_or_retain_owned_direct_backend(
                app_handle,
                backend_tree.clone(),
                child,
                stop_fallback_rx,
                root_reaped,
            ).await;
            Err(match cleanup {
                Ok(()) => reason,
                Err(cleanup) => format!("{reason}; cleanup failed: {cleanup}"),
            })
        }
        ready = wait_for_owned_loopback(BACKEND_PORT, pid, readiness_policy) => {
            if let Err(error) = ready {
                let cleanup = apply_backend_cleanup_actions(
                    app_handle,
                    &backend_tree,
                    &mut child,
                    startup_state.observe(BackendStartupEvent::TimedOut),
                    &publisher,
                ).await;
                if let Err(cleanup) = cleanup {
                    retain_owned_direct_backend_cleanup(
                        app_handle.clone(),
                        backend_tree.clone(),
                        child,
                        stop_fallback_rx,
                        false,
                        cleanup.clone(),
                    );
                    return Err(format!("{error}; process-tree cleanup failed: {cleanup}"));
                }
                return Err(error);
            }
            if !owns_active_backend(app_handle, pid) {
                let cleanup = cleanup_or_retain_owned_direct_backend(
                    app_handle,
                    backend_tree.clone(),
                    child,
                    stop_fallback_rx,
                    false,
                ).await;
                return Err(match cleanup {
                    Ok(()) => "Backend start was cancelled before readiness".to_string(),
                    Err(cleanup) => format!(
                        "Backend start was cancelled before readiness; cleanup failed: {cleanup}"
                    ),
                });
            }
            let publication = apply_backend_startup_actions(
                app_handle,
                startup_state.observe(BackendStartupEvent::LoopbackConnected),
                &publisher,
            );
            match race_backend_publication_with_exit(
                observe_backend_root_exit(&mut child, pid),
                publication,
            ).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    let cleanup = cleanup_or_retain_owned_direct_backend(
                        app_handle,
                        backend_tree.clone(),
                        child,
                        stop_fallback_rx,
                        false,
                    ).await;
                    return Err(match cleanup {
                        Ok(()) => error,
                        Err(cleanup) => format!("{error}; cleanup failed: {cleanup}"),
                    });
                }
                Err(Ok((exit, root_reaped))) => {
                    let cleanup = cleanup_or_retain_owned_direct_backend(
                        app_handle,
                        backend_tree.clone(),
                        child,
                        stop_fallback_rx,
                        root_reaped,
                    ).await;
                    let reason = format!(
                        "Backend process exited before readiness publication: {exit}"
                    );
                    return Err(match cleanup {
                        Ok(()) => reason,
                        Err(cleanup) => format!("{reason}; cleanup failed: {cleanup}"),
                    });
                }
                Err(Err(error)) => {
                    let cleanup = cleanup_or_retain_owned_direct_backend(
                        app_handle,
                        backend_tree.clone(),
                        child,
                        stop_fallback_rx,
                        false,
                    ).await;
                    return Err(match cleanup {
                        Ok(()) => format!(
                            "Failed to wait for backend during readiness publication: {error}"
                        ),
                        Err(cleanup) => format!(
                            "Failed to wait for backend during readiness publication: {error}; cleanup failed: {cleanup}"
                        ),
                    });
                }
            }
            let app_handle_exit = app_handle.clone();
            let exit_publisher = publisher.clone();
            #[cfg(unix)]
            tauri::async_runtime::spawn(async move {
                let exit = match tauri::async_runtime::spawn_blocking(move || {
                    observe_unix_backend_root_exit_without_reaping(pid)
                })
                .await
                {
                    Ok(Ok(exit)) => exit,
                    Ok(Err(error)) => error,
                    Err(error) => format!("backend root observation task failed: {error}"),
                };
                let Some(stopping) =
                    mark_backend_tree_root_exited(&app_handle_exit, &lifecycle_tree)
                else {
                    log::warn!("Ignored a stale Unix backend root exit for pid {pid}");
                    return;
                };
                let clear_handle = app_handle_exit.clone();
                let report_handle = app_handle_exit.clone();
                handle_backend_process_exit(
                    exit,
                    stopping,
                    move || clear_backend_state(&clear_handle),
                    move |message| {
                        log::error!("{message}");
                        let _ = report_handle.emit("backend-error", message);
                        let publisher = exit_publisher.clone();
                        tauri::async_runtime::spawn(async move {
                            publisher.backend_failed().await;
                        });
                    },
                );

                if stop_fallback_rx.recv().await.is_none() {
                    log::error!("Backend cleanup channel closed while Unix root identity was retained");
                }
                if let Err(error) = cleanup_or_retain_owned_direct_backend(
                    &app_handle_exit,
                    lifecycle_tree,
                    child,
                    stop_fallback_rx,
                    false,
                )
                .await
                {
                    log::error!(
                        "Backend process-group ownership retained for cleanup retry: {error}"
                    );
                }
            });
            #[cfg(windows)]
            tauri::async_runtime::spawn(async move {
                let (exit, reaped) = match child.wait().await {
                    Ok(status) => (status.to_string(), Ok(())),
                    Err(error) => (
                        format!("wait failed: {error}"),
                        Err(format!("Failed to reap backend root: {error}")),
                    ),
                };
                let Some(stopping) =
                    mark_backend_tree_root_exited(&app_handle_exit, &lifecycle_tree)
                else {
                    log::warn!("Ignored a stale Windows backend root exit for pid {pid}");
                    return;
                };
                let clear_handle = app_handle_exit.clone();
                let report_handle = app_handle_exit.clone();
                handle_backend_process_exit(
                    exit,
                    stopping,
                    move || clear_backend_state(&clear_handle),
                    move |message| {
                        log::error!("{message}");
                        let _ = report_handle.emit("backend-error", message);
                        let publisher = exit_publisher.clone();
                        tauri::async_runtime::spawn(async move {
                            publisher.backend_failed().await;
                        });
                    },
                );
                if stop_fallback_rx.recv().await.is_none() {
                    log::error!("Backend cleanup channel closed while Windows Job ownership was retained");
                }
                let root_already_reaped = reaped.is_ok();
                if let Err(error) = cleanup_or_retain_owned_direct_backend(
                    &app_handle_exit,
                    lifecycle_tree,
                    child,
                    stop_fallback_rx,
                    root_already_reaped,
                )
                .await
                {
                    log::error!(
                        "Backend Job ownership retained for watcher cleanup retry: {error}"
                    );
                }
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
    publisher: BackendReadinessPublisher,
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
    } else if !config.script_path.exists() {
        return Err(format!(
            "Backend binary not found at: {:?}",
            config.script_path
        ));
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
        let spawn_plan = BackendSpawnPlan::for_current_platform(
            BackendTransport::from_env()?,
            backend_use_watcher_process(),
        )?;
        if let Some(warning) = spawn_plan.warning() {
            log::warn!("{warning}");
        }
        let start = BackendProcessStart {
            config_dir,
            frontend_dir,
            launch_plan,
            backend_start,
            publisher,
            watcher_process: spawn_plan.watcher_process(),
        };
        return match spawn_plan.strategy() {
            BackendSpawnStrategy::DirectPipes => {
                start_backend_direct_process(app_handle, &config, start).await
            }
            BackendSpawnStrategy::Pty => {
                start_node_backend_process(app_handle, &config, start).await
            }
        };
    }

    start_backend_direct_process(
        app_handle,
        &config,
        BackendProcessStart {
            config_dir,
            frontend_dir,
            launch_plan,
            backend_start,
            publisher,
            watcher_process: false,
        },
    )
    .await
}

fn increment_backend_spawn_count(counter: &std::sync::atomic::AtomicU64) {
    let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
        Some(count.saturating_add(1))
    });
}

fn set_backend_ready_pid_if_accepted(ready_pid: &Mutex<Option<u32>>, pid: u32, accepted: bool) {
    if accepted {
        *ready_pid.lock().unwrap() = Some(pid);
    }
}

fn record_backend_spawned_before_window(app_handle: &AppHandle) {
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        increment_backend_spawn_count(&state.backend_spawn_count);
        if let Err(error) = state.startup_metrics.record_backend_spawned_before_window() {
            log::warn!("Failed to record overlapped backend spawn: {error}");
        }
    }
}

fn record_backend_listening(app_handle: &AppHandle) {
    if let Some(state) = app_handle.try_state::<crate::AppState>() {
        if let Err(error) = state
            .startup_metrics
            .record(StartupMilestone::BackendListening)
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
    publisher: BackendReadinessPublisher,
) -> Result<(), String> {
    let launch_plan = BackendLaunchPlan::new(workspace);
    let result =
        match start_backend_process(app_handle, &launch_plan, backend_start, publisher.clone())
            .await
        {
            Ok(()) => Ok(()),
            Err(error) => {
                publisher.backend_failed().await;
                log::error!("Failed to start backend: {error}");
                let _ = app_handle.emit("backend-error", format!("Failed to start: {error}"));
                Err(error)
            }
        };
    complete_backend_start(app_handle, backend_start);
    result
}

/// 停止后端进程
fn clone_backend_stop_fallback(
    fallback: &Mutex<Option<(u32, tokio::sync::mpsc::UnboundedSender<()>)>>,
    pid: Option<u32>,
) -> Option<tokio::sync::mpsc::UnboundedSender<()>> {
    fallback
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(owner, _)| Some(*owner) == pid)
        .map(|(_, sender)| sender.clone())
}

pub fn stop_backend(app_handle: &AppHandle) -> Result<(), String> {
    let (pid, tree, stop_fallback) = app_handle
        .try_state::<crate::AppState>()
        .map(|state| {
            let mut ownership = state.backend_ownership.lock().unwrap();
            let pid = ownership.owned_root_pid();
            let tree = ownership.request_tree_stop();
            let stop_fallback = clone_backend_stop_fallback(&state.backend_stop_fallback, pid);
            *state.backend_port.lock().unwrap() = None;
            (pid, tree, stop_fallback)
        })
        .unwrap_or((None, None, None));

    let termination = if let Some(tree) = tree {
        log::info!(
            "Stopping owned backend process tree rooted at pid {}",
            tree.root_pid()
        );
        tree.terminate_and_confirm(BACKEND_CLEANUP_BOUND)
    } else if let Some(pid) = pid {
        Err(format!(
            "Backend pid {pid} has no durable process-tree owner; refusing unconfirmed pid-only cleanup"
        ))
    } else {
        log::debug!("No backend process is registered; nothing to stop");
        Ok(())
    };
    finish_backend_stop(termination, stop_fallback)
}

/// Terminates only the currently owned backend root. This is intentionally
/// crate-private for the authenticated smoke protocol and never registered as
/// a Tauri command; descendants remain owned by the generation tree.
#[allow(dead_code)] // Consumed by the separately owned authenticated smoke implementation.
pub(crate) fn kill_owned_backend_root_for_smoke(
    app_handle: &AppHandle,
) -> Result<BackendRootCrashEvidence, String> {
    let state = app_handle
        .try_state::<crate::AppState>()
        .ok_or_else(|| "Application state is unavailable".to_string())?;
    let (pid, tree) = {
        let ownership = state.backend_ownership.lock().unwrap();
        let pid = ownership
            .pid()
            .ok_or_else(|| "No active backend root is owned".to_string())?;
        let tree = ownership
            .tree()
            .ok_or_else(|| "Active backend has no durable process-tree ownership".to_string())?;
        (pid, tree)
    };
    let evidence = BackendRootCrashEvidence::capture(tree, Duration::from_secs(1))?;
    debug_assert_eq!(evidence.root_pid(), pid);
    evidence.tree.kill_root()?;
    Ok(evidence)
}

async fn wait_for_backend_ownership_release(
    ownership: &Mutex<crate::startup::BackendOwnershipState>,
    cleanup_notify: &tokio::sync::Notify,
    deadline: tokio::time::Instant,
) -> bool {
    loop {
        let notified = cleanup_notify.notified();
        if !ownership.lock().unwrap().has_owned_work() {
            return true;
        }
        if tokio::time::timeout_at(deadline, notified).await.is_err() {
            return !ownership.lock().unwrap().has_owned_work();
        }
    }
}

fn finish_bounded_backend_cleanup(
    stop_result: Result<(), String>,
    cleanup_confirmed: bool,
    bound: Duration,
) -> Result<(), String> {
    if cleanup_confirmed {
        return Ok(());
    }
    let cleanup = format!(
        "Backend child reap exceeded the {}ms cleanup bound",
        bound.as_millis()
    );
    match stop_result {
        Ok(()) => Err(cleanup),
        Err(stop) => Err(format!("{stop}; {cleanup}")),
    }
}

fn finish_forced_backend_exit_cleanup(
    termination: Result<(), String>,
    release: impl FnOnce(),
) -> Result<(), String> {
    termination?;
    release();
    Ok(())
}

#[cfg(test)]
async fn serialize_backend_cleanup<C>(
    cleanup_gate: &Arc<tokio::sync::Mutex<()>>,
    deadline: tokio::time::Instant,
    cleanup: C,
) -> Result<(), String>
where
    C: Future<Output = Result<(), String>>,
{
    let _guard = tokio::time::timeout_at(deadline, cleanup_gate.clone().lock_owned())
        .await
        .map_err(|_| "Backend cleanup coordination exceeded its bound".to_string())?;
    cleanup.await
}

async fn await_cleanup_task_with_retained_gate<T>(
    guard: tokio::sync::OwnedMutexGuard<()>,
    deadline: tokio::time::Instant,
    mut cleanup_task: tauri::async_runtime::JoinHandle<T>,
    timeout_error: String,
) -> Result<(tokio::sync::OwnedMutexGuard<()>, T), String>
where
    T: Send + 'static,
{
    match tokio::time::timeout_at(deadline, &mut cleanup_task).await {
        Ok(Ok(result)) => Ok((guard, result)),
        Ok(Err(error)) => Err(format!("Backend cleanup task failed: {error}")),
        Err(_) => {
            tauri::async_runtime::spawn(async move {
                let _guard = guard;
                let _ = cleanup_task.await;
            });
            Err(timeout_error)
        }
    }
}

pub async fn stop_backend_bounded(app_handle: &AppHandle, bound: Duration) -> Result<(), String> {
    if bound.is_zero() {
        return Err("Backend cleanup bound must be nonzero".to_string());
    }
    let Some(state) = app_handle.try_state::<crate::AppState>() else {
        return Ok(());
    };
    let deadline = tokio::time::Instant::now() + bound;
    let cleanup_guard =
        tokio::time::timeout_at(deadline, state.backend_cleanup_gate.clone().lock_owned())
            .await
            .map_err(|_| "Backend cleanup coordination exceeded its bound".to_string())?;
    let wait_for_cleanup = state.backend_ownership.lock().unwrap().has_owned_work();
    let stop_handle = app_handle.clone();
    let stop_task = tauri::async_runtime::spawn_blocking(move || stop_backend(&stop_handle));
    let timeout_error = format!("Backend process-tree stop exceeded {}ms", bound.as_millis());
    let (_cleanup_guard, stop_result) =
        await_cleanup_task_with_retained_gate(cleanup_guard, deadline, stop_task, timeout_error)
            .await?;
    if !wait_for_cleanup && !state.backend_ownership.lock().unwrap().has_owned_work() {
        return stop_result;
    }

    let cleanup_confirmed = wait_for_backend_ownership_release(
        &state.backend_ownership,
        &state.backend_cleanup_notify,
        deadline,
    )
    .await;
    finish_bounded_backend_cleanup(stop_result, cleanup_confirmed, bound)
}

pub async fn force_release_backend_for_exit(
    app_handle: &AppHandle,
    bound: Duration,
) -> Result<(), String> {
    if bound.is_zero() {
        return Err("Forced backend cleanup bound must be nonzero".to_string());
    }
    let Some(state) = app_handle.try_state::<crate::AppState>() else {
        return Ok(());
    };
    let deadline = tokio::time::Instant::now() + bound;
    let cleanup_guard =
        tokio::time::timeout_at(deadline, state.backend_cleanup_gate.clone().lock_owned())
            .await
            .map_err(|_| "Forced backend cleanup coordination exceeded its bound".to_string())?;
    let tree = {
        let ownership = state
            .backend_ownership
            .lock()
            .map_err(|_| "backend ownership mutex is poisoned".to_string())?;
        if !ownership.has_owned_work() {
            return Ok(());
        }
        ownership
            .tree()
            .ok_or_else(|| "Forced backend cleanup has no owned process tree".to_string())?
    };
    let force_tree = tree.clone();
    let force_task =
        tauri::async_runtime::spawn_blocking(move || force_tree.force_terminate_for_exit(bound));
    let timeout_error = format!("Forced backend cleanup exceeded {}ms", bound.as_millis());
    let (_cleanup_guard, termination) =
        await_cleanup_task_with_retained_gate(cleanup_guard, deadline, force_task, timeout_error)
            .await?;
    finish_forced_backend_exit_cleanup(termination, || {
        clear_backend_tree(app_handle, &tree);
    })
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

    #[tokio::test]
    async fn bounded_cleanup_waits_for_cancelled_spawn_and_exact_pid_reap() {
        let ownership = std::sync::Arc::new(std::sync::Mutex::new(
            crate::startup::BackendOwnershipState::default(),
        ));
        let notify = std::sync::Arc::new(tokio::sync::Notify::new());
        let start = ownership.lock().unwrap().reserve_start();
        assert_eq!(ownership.lock().unwrap().request_stop(), None);

        let pending_ownership = ownership.clone();
        let pending_notify = notify.clone();
        let pending_wait = tokio::spawn(async move {
            super::wait_for_backend_ownership_release(
                &pending_ownership,
                &pending_notify,
                tokio::time::Instant::now() + Duration::from_secs(1),
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(!pending_wait.is_finished());
        assert!(ownership.lock().unwrap().complete_start(start));
        notify.notify_waiters();
        assert!(pending_wait.await.unwrap());

        let start = ownership.lock().unwrap().reserve_start();
        assert!(ownership.lock().unwrap().register_spawn(start, 42));
        assert_eq!(ownership.lock().unwrap().request_stop(), Some(42));
        assert_eq!(ownership.lock().unwrap().request_stop(), None);
        let pid_ownership = ownership.clone();
        let pid_notify = notify.clone();
        let pid_wait = tokio::spawn(async move {
            super::wait_for_backend_ownership_release(
                &pid_ownership,
                &pid_notify,
                tokio::time::Instant::now() + Duration::from_secs(1),
            )
            .await
        });
        assert!(ownership.lock().unwrap().clear_spawn(7));
        notify.notify_waiters();
        tokio::task::yield_now().await;
        assert!(!pid_wait.is_finished());
        assert!(ownership.lock().unwrap().clear_spawn(42));
        notify.notify_waiters();
        assert!(pid_wait.await.unwrap());
    }

    #[test]
    fn confirmed_ownership_release_recovers_an_initial_tree_termination_failure() {
        let result = super::finish_bounded_backend_cleanup(
            Err("process tree termination failed".to_string()),
            true,
            Duration::from_secs(5),
        );
        assert_eq!(result, Ok(()));
    }

    #[test]
    fn ownership_release_requires_tree_confirmation_and_root_reap() {
        for (tree, reap, should_release) in [
            (Ok(()), Ok(()), true),
            (Err("tree failed".to_string()), Ok(()), false),
            (Ok(()), Err("reap failed".to_string()), false),
            (
                Err("tree failed".to_string()),
                Err("reap failed".to_string()),
                false,
            ),
        ] {
            let released = std::cell::Cell::new(false);
            let result = super::finish_owned_tree_cleanup(tree, reap, || released.set(true));

            assert_eq!(released.get(), should_release);
            assert_eq!(result.is_ok(), should_release);
        }
    }

    #[test]
    fn backend_spawn_counter_saturates() {
        let counter = std::sync::atomic::AtomicU64::new(u64::MAX - 1);

        super::increment_backend_spawn_count(&counter);
        super::increment_backend_spawn_count(&counter);

        assert_eq!(counter.load(std::sync::atomic::Ordering::Relaxed), u64::MAX);
    }

    #[test]
    fn stale_ready_result_cannot_overwrite_the_accepted_backend_pid() {
        let ready_pid = std::sync::Mutex::new(Some(41));

        super::set_backend_ready_pid_if_accepted(&ready_pid, 42, false);
        assert_eq!(*ready_pid.lock().unwrap(), Some(41));

        super::set_backend_ready_pid_if_accepted(&ready_pid, 43, true);
        assert_eq!(*ready_pid.lock().unwrap(), Some(43));
    }

    #[tokio::test]
    async fn serialized_cleanup_callers_retry_after_the_first_failure() {
        let cleanup_gate = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let second_cleanup_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let first_state = cleanup_gate.clone();
        let first = tokio::spawn(async move {
            super::serialize_backend_cleanup(
                &first_state,
                tokio::time::Instant::now() + Duration::from_secs(1),
                async move {
                    entered_tx.send(()).unwrap();
                    release_rx.await.unwrap();
                    Err("process tree termination failed".to_string())
                },
            )
            .await
        });
        entered_rx.await.unwrap();

        let second_state = cleanup_gate.clone();
        let observed_second_calls = second_cleanup_calls.clone();
        let second = tokio::spawn(async move {
            super::serialize_backend_cleanup(
                &second_state,
                tokio::time::Instant::now() + Duration::from_secs(1),
                async move {
                    observed_second_calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
        });
        tokio::task::yield_now().await;
        assert!(!second.is_finished());
        release_tx.send(()).unwrap();

        assert_eq!(
            first.await.unwrap(),
            Err("process tree termination failed".to_string())
        );
        assert_eq!(second.await.unwrap(), Ok(()));
        assert_eq!(
            second_cleanup_calls.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    #[tokio::test]
    async fn timed_out_blocking_cleanup_retains_the_serialization_gate() {
        let cleanup_gate = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let guard = cleanup_gate.clone().lock_owned().await;
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let cleanup_task = tauri::async_runtime::spawn_blocking(move || {
            release_rx.recv().unwrap();
        });

        let result = super::await_cleanup_task_with_retained_gate(
            guard,
            tokio::time::Instant::now() + Duration::from_millis(10),
            cleanup_task,
            "cleanup timed out".to_string(),
        )
        .await;
        assert_eq!(result.unwrap_err(), "cleanup timed out");
        assert!(
            tokio::time::timeout(Duration::from_millis(20), cleanup_gate.clone().lock_owned())
                .await
                .is_err()
        );

        release_tx.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), cleanup_gate.lock_owned())
            .await
            .expect("cleanup gate is released after the blocking task exits");
    }

    #[tokio::test]
    async fn tree_termination_failure_never_reaps_or_releases_the_root() {
        let reaps = std::sync::atomic::AtomicUsize::new(0);
        let released = std::cell::Cell::new(false);

        let result = super::finish_owned_tree_cleanup_async(
            async { Err("tree failed".to_string()) },
            || async {
                reaps.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Ok(())
            },
            || released.set(true),
        )
        .await;

        assert_eq!(result, Err("tree failed".to_string()));
        assert_eq!(reaps.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(!released.get());
    }

    #[test]
    fn stop_fallback_remains_registered_until_confirmed_cleanup() {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let fallback = std::sync::Mutex::new(Some((42, sender)));

        let signal = super::clone_backend_stop_fallback(&fallback, Some(42))
            .expect("matching fallback is cloned");
        signal.send(()).expect("signal retained cleanup watcher");

        assert_eq!(
            fallback.lock().unwrap().as_ref().map(|(pid, _)| *pid),
            Some(42)
        );
        assert_eq!(receiver.try_recv(), Ok(()));
    }

    #[test]
    fn forced_exit_cleanup_releases_only_after_os_termination() {
        for (termination, should_release) in [
            (Ok(()), true),
            (Err("os termination failed".to_string()), false),
        ] {
            let released = std::cell::Cell::new(false);
            let result =
                super::finish_forced_backend_exit_cleanup(termination, || released.set(true));

            assert_eq!(released.get(), should_release);
            assert_eq!(result.is_ok(), should_release);
        }
    }

    #[test]
    fn backend_child_environment_removes_smoke_secrets_and_preserves_unrelated_values() {
        const UNRELATED_ENV: &str = "RIDE_SIDECAR_TEST_UNRELATED";
        let mut pty = portable_pty::CommandBuilder::new("backend");
        let mut direct = tokio::process::Command::new("backend");
        for name in crate::smoke::SMOKE_ENV_NAMES {
            pty.env(name, "secret");
            direct.env(name, "secret");
        }
        pty.env(UNRELATED_ENV, "preserved");
        direct.env(UNRELATED_ENV, "preserved");

        super::remove_smoke_environment(&mut pty);
        super::remove_smoke_environment(&mut direct);

        for name in crate::smoke::SMOKE_ENV_NAMES {
            assert!(pty.get_env(name).is_none(), "PTY retained {name}");
            assert_eq!(
                direct
                    .as_std()
                    .get_envs()
                    .find(|(key, _)| *key == std::ffi::OsStr::new(name))
                    .map(|(_, value)| value),
                Some(None),
                "direct command did not explicitly remove {name}"
            );
        }
        assert_eq!(
            pty.get_env(UNRELATED_ENV),
            Some(std::ffi::OsStr::new("preserved"))
        );
        assert_eq!(
            direct
                .as_std()
                .get_envs()
                .find(|(key, _)| *key == std::ffi::OsStr::new(UNRELATED_ENV))
                .and_then(|(_, value)| value),
            Some(std::ffi::OsStr::new("preserved"))
        );
    }

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

    #[tokio::test]
    async fn backend_readiness_observes_a_real_child_exit_before_ready() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("reserve unused port");
        let port = listener.local_addr().expect("listener address").port();
        drop(listener);
        let (_line_tx, mut line_rx) = mpsc::unbounded_channel();
        let (exit_tx, mut exit_rx) = mpsc::unbounded_channel();
        let child = tokio::spawn(async move {
            #[cfg(windows)]
            let mut child = tokio::process::Command::new("cmd")
                .args(["/C", "exit", "17"])
                .spawn()
                .expect("spawn failing child");
            #[cfg(not(windows))]
            let mut child = tokio::process::Command::new("sh")
                .args(["-c", "exit 17"])
                .spawn()
                .expect("spawn failing child");
            let status = child.wait().await.expect("wait for failing child");
            exit_tx
                .send(status.to_string())
                .expect("publish child exit");
        });

        let error = wait_for_node_backend_readiness(
            &mut line_rx,
            &mut exit_rx,
            port,
            Duration::from_secs(30),
        )
        .await
        .expect_err("an exited child cannot become ready");
        child.await.unwrap();

        assert!(
            matches!(
                error,
                super::BackendReadinessFailure::ChildExited(ref exit)
                    if exit.contains("17")
            ),
            "{error:?}"
        );
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

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_job_keeps_owning_descendants_after_a_root_only_crash() {
        let pid_file = std::env::temp_dir().join(format!(
            "ride-backend-tree-descendant-{}.pid",
            uuid::Uuid::new_v4()
        ));
        let script = format!(
            "$child = Start-Process -FilePath $env:ComSpec -ArgumentList '/D /S /C ping -t 127.0.0.1 ^>NUL' -WindowStyle Hidden -PassThru; Set-Content -LiteralPath '{}' -Value $child.Id; Start-Sleep -Seconds 30",
            pid_file.display()
        );
        let mut command = tokio::process::Command::new("powershell.exe");
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &script,
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());

        let prepared = super::prepare_direct_backend_tree(&mut command)
            .expect("prepare a suspended direct backend");
        let mut child = command.spawn().expect("spawn suspended backend root");
        let pid = child.id().expect("backend root pid");
        let tree = super::claim_direct_backend_tree(prepared, &child, pid)
            .expect("assign and resume the backend root");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !pid_file.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(
            pid_file.exists(),
            "backend root did not report its descendant"
        );
        let descendant_pid = std::fs::read_to_string(&pid_file)
            .expect("read descendant pid")
            .trim()
            .parse::<u32>()
            .expect("parse descendant pid");
        let evidence =
            super::BackendRootCrashEvidence::capture(tree.clone(), Duration::from_secs(1))
                .expect("capture bounded owned-tree evidence");
        assert_eq!(evidence.root_pid(), pid);
        assert!(evidence.descendant_pids().contains(&descendant_pid));
        tree.kill_root().expect("crash only the owned backend root");
        child.wait().await.expect("reap crashed backend root");
        assert!(
            evidence
                .active_process_ids(Duration::from_secs(1))
                .expect("query old backend Job")
                .contains(&descendant_pid),
            "the descendant escaped when its root exited"
        );

        tree.terminate_and_confirm(Duration::from_secs(5))
            .expect("terminate the retained backend Job");
        assert!(evidence
            .active_process_ids(Duration::from_secs(1))
            .expect("query empty old Job")
            .is_empty());
        let mut cancelled = crate::startup::BackendOwnershipState::default();
        let token = cancelled.reserve_start();
        assert_eq!(cancelled.request_stop(), None);
        assert!(cancelled.retain_tree_for_cancelled_start(token, tree.clone()));
        assert!(cancelled.clear_tree(&tree));
        assert!(
            !cancelled.has_owned_work(),
            "confirmed cleanup must fully release a tree retained after cancelled registration"
        );
        let _ = std::fs::remove_file(pid_file);
    }

    #[cfg(windows)]
    #[test]
    fn windows_pty_fails_closed_without_atomic_job_assignment_support() {
        assert!(!super::backend_pty_tree_ownership_supported());
    }

    #[cfg(unix)]
    #[test]
    fn unix_pty_can_be_verified_as_an_owned_session_process_group() {
        assert!(super::backend_pty_tree_ownership_supported());
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

    #[tokio::test]
    async fn pty_publication_cleanup_retains_ownership_when_exit_cannot_be_confirmed() {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let kill_events = events.clone();
        let first_reap_events = events.clone();
        let tree_events = events.clone();
        let second_reap_events = events.clone();
        let clear_events = events.clone();
        let retain_events = events.clone();
        let clear_called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed_clear = clear_called.clone();
        let watcher_clear_called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed_watcher_clear = watcher_clear_called.clone();

        let error = super::finish_pty_readiness_publication(
            Err("gateway publication rejected".to_string()),
            move || async move {
                kill_events.lock().unwrap().push("kill");
                Err("portable child kill failed".to_string())
            },
            move || async move {
                first_reap_events.lock().unwrap().push("first-reap");
                Err("first reap timed out".to_string())
            },
            move || async move {
                tree_events.lock().unwrap().push("tree-fallback");
                Err("process tree termination failed".to_string())
            },
            move || async move {
                second_reap_events.lock().unwrap().push("second-reap");
                Err("second reap timed out".to_string())
            },
            move || {
                observed_clear.store(true, std::sync::atomic::Ordering::SeqCst);
                clear_events.lock().unwrap().push("clear");
            },
            move || async move {
                retain_events.lock().unwrap().push("retain-watcher");
                super::clear_retained_pty_ownership_after_exit(
                    async { None::<String> },
                    move || {
                        observed_watcher_clear.store(true, std::sync::atomic::Ordering::SeqCst);
                    },
                )
                .await;
            },
        )
        .await
        .expect_err("publication rejection must fail PTY startup");

        assert_eq!(
            *events.lock().unwrap(),
            [
                "kill",
                "first-reap",
                "tree-fallback",
                "second-reap",
                "retain-watcher"
            ]
        );
        assert!(!clear_called.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!watcher_clear_called.load(std::sync::atomic::Ordering::SeqCst));
        assert!(error.contains("gateway publication rejected"), "{error}");
        assert!(error.contains("portable child kill failed"), "{error}");
        assert!(error.contains("first reap timed out"), "{error}");
        assert!(error.contains("process tree termination failed"), "{error}");
        assert!(error.contains("second reap timed out"), "{error}");
        assert!(error.contains("ownership retained"), "{error}");
    }

    #[tokio::test]
    async fn pty_publication_tree_fallback_clears_only_after_confirmed_exit() {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let kill_events = events.clone();
        let first_reap_events = events.clone();
        let tree_events = events.clone();
        let second_reap_events = events.clone();
        let clear_events = events.clone();
        let retain_events = events.clone();

        let error = super::finish_pty_readiness_publication(
            Ok(false),
            move || async move {
                kill_events.lock().unwrap().push("kill");
                Err("portable child kill failed".to_string())
            },
            move || async move {
                first_reap_events.lock().unwrap().push("first-reap");
                Err("first reap timed out".to_string())
            },
            move || async move {
                tree_events.lock().unwrap().push("tree-fallback");
                Ok(())
            },
            move || async move {
                second_reap_events.lock().unwrap().push("second-reap");
                Ok(())
            },
            move || clear_events.lock().unwrap().push("clear"),
            move || async move {
                retain_events.lock().unwrap().push("retain-watcher");
            },
        )
        .await
        .expect_err("cancelled publication must fail PTY startup");

        assert_eq!(
            *events.lock().unwrap(),
            [
                "kill",
                "first-reap",
                "tree-fallback",
                "second-reap",
                "clear"
            ]
        );
        assert!(
            error.contains("cancelled before PTY publication"),
            "{error}"
        );
        assert!(error.contains("portable child kill failed"), "{error}");
        assert!(error.contains("first reap timed out"), "{error}");
        assert!(error.contains("tree fallback: ok"), "{error}");
        assert!(error.contains("second reap: ok"), "{error}");
        assert!(error.contains("ownership cleared"), "{error}");
    }
}
