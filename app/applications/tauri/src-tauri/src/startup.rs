/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use std::ffi::OsString;
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::startup_gateway::{
    BackendGeneration, GatewayBindCancellation, GatewayError, GatewayLimits, StartupGateway,
};
use crate::startup_metrics::{StartupMetricError, StartupMetrics, StartupMode};

pub const GATEWAY_CAPABILITY_PERMISSIONS: [&str; 12] = [
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "allow-ride-frontend-ready",
    "allow-ride-performance-snapshot",
    "allow-ride-plugin-directories",
    "allow-ride-record-startup-milestone",
    "allow-ride-show-main-menu",
    "allow-ride-smoke-complete",
    "allow-ride-smoke-plan",
    "allow-ride-smoke-record-step",
    "allow-ride-start-window-drag",
    "allow-ride-window-control",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewayCapabilitySpec {
    pub identifier: String,
    pub origin: String,
    pub windows: [&'static str; 2],
    pub permissions: Vec<&'static str>,
}

impl GatewayCapabilitySpec {
    pub fn for_gateway(gateway: &StartupGateway) -> Self {
        let authority = gateway.public_authority();
        let port = authority
            .rsplit_once(':')
            .map(|(_, port)| port)
            .expect("validated gateway authority contains a port");
        Self {
            identifier: format!("ride-gateway-{port}"),
            origin: format!("http://{authority}"),
            windows: ["main", "theia-secondary-*"],
            permissions: GATEWAY_CAPABILITY_PERMISSIONS.to_vec(),
        }
    }
}

#[derive(Clone, Default)]
pub struct StartupWindowCreatedGate {
    inner: Arc<StartupWindowCreatedGateInner>,
}

#[derive(Default)]
struct StartupWindowCreatedGateInner {
    created: AtomicBool,
    notify: tokio::sync::Notify,
}

impl StartupWindowCreatedGate {
    pub fn mark_created(&self) {
        self.inner.created.store(true, Ordering::Release);
        self.inner.notify.notify_waiters();
    }

    pub async fn wait(&self) {
        loop {
            let notified = self.inner.notify.notified();
            if self.inner.created.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
}

pub struct StartupLaunch {
    pub mode: StartupMode,
    pub initial_url: tauri::WebviewUrl,
    pub gateway: Option<StartupGateway>,
    pub backend_generation: BackendGeneration,
    pub fallback_reason: Option<String>,
    window_created: StartupWindowCreatedGate,
    initial_navigation_dispatched: AtomicBool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StartupVisibilityDeadline {
    started_at: tokio::time::Instant,
    absolute_deadline: tokio::time::Instant,
    presentation_budget: Duration,
    cleanup_grace: Duration,
}

impl StartupVisibilityDeadline {
    pub fn new(
        started_at: tokio::time::Instant,
        visible_after: Duration,
        presentation_budget: Duration,
    ) -> Result<Self, &'static str> {
        Self::with_cleanup_grace(
            started_at,
            visible_after,
            presentation_budget,
            crate::GATEWAY_BIND_CLEANUP_GRACE,
        )
    }

    #[doc(hidden)]
    pub fn with_cleanup_grace(
        started_at: tokio::time::Instant,
        visible_after: Duration,
        presentation_budget: Duration,
        cleanup_grace: Duration,
    ) -> Result<Self, &'static str> {
        if visible_after.is_zero() {
            return Err("window visibility deadline must be nonzero");
        }
        if presentation_budget.is_zero() || cleanup_grace.is_zero() {
            return Err("window presentation budget and bind cleanup grace must be nonzero");
        }
        let reserved = presentation_budget
            .checked_add(cleanup_grace)
            .ok_or("reserved startup budget overflowed")?;
        if reserved >= visible_after {
            return Err("reserved startup budgets must be below the visibility deadline");
        }
        let absolute_deadline = started_at
            .checked_add(visible_after)
            .ok_or("window visibility deadline overflowed")?;
        Ok(Self {
            started_at,
            absolute_deadline,
            presentation_budget,
            cleanup_grace,
        })
    }

    pub fn started_at(self) -> tokio::time::Instant {
        self.started_at
    }

    pub fn absolute_deadline(self) -> tokio::time::Instant {
        self.absolute_deadline
    }

    pub fn presentation_budget(self) -> Duration {
        self.presentation_budget
    }

    pub fn cleanup_deadline(self) -> tokio::time::Instant {
        self.absolute_deadline
            .checked_sub(self.presentation_budget)
            .expect("validated presentation budget must fit the absolute deadline")
    }

    pub fn bind_deadline(self, now: tokio::time::Instant) -> Option<tokio::time::Instant> {
        let bind_deadline = self.cleanup_deadline().checked_sub(self.cleanup_grace)?;
        (now < bind_deadline).then_some(bind_deadline)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WindowPresentationObservation {
    pub show_started_at: tokio::time::Instant,
    pub shown_at: tokio::time::Instant,
    pub show_started_within_deadline: bool,
    pub shown_within_deadline: bool,
}

pub fn present_startup_window<Window, Error>(
    visibility: StartupVisibilityDeadline,
    prepare: impl FnOnce() -> Result<Window, Error>,
    show: impl FnOnce(&Window) -> Result<(), Error>,
    mut now: impl FnMut() -> tokio::time::Instant,
) -> Result<WindowPresentationObservation, Error> {
    let window = prepare()?;
    let show_started_at = now();
    show(&window)?;
    let shown_at = now();
    Ok(WindowPresentationObservation {
        show_started_at,
        shown_at,
        show_started_within_deadline: show_started_at <= visibility.absolute_deadline(),
        shown_within_deadline: shown_at <= visibility.absolute_deadline(),
    })
}

impl StartupLaunch {
    pub fn window_created_gate(&self) -> StartupWindowCreatedGate {
        self.window_created.clone()
    }

    pub fn mark_window_created(&self) {
        self.window_created.mark_created();
    }

    pub fn dispatch_initial_navigation(&self, navigate: impl FnOnce(tauri::WebviewUrl)) -> bool {
        if self
            .initial_navigation_dispatched
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return false;
        }
        navigate(self.initial_url.clone());
        true
    }
}

#[derive(Debug)]
pub enum StartupCoordinatorError {
    Gateway(GatewayError),
    Metrics(StartupMetricError),
}

impl fmt::Display for StartupCoordinatorError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Gateway(error) => write!(formatter, "startup gateway state failed: {error}"),
            Self::Metrics(error) => write!(formatter, "startup metrics failed: {error}"),
        }
    }
}

impl std::error::Error for StartupCoordinatorError {}

pub struct StartupCoordinator {
    requested_mode: StartupMode,
    metrics: StartupMetrics,
    limits: GatewayLimits,
    visibility_deadline: StartupVisibilityDeadline,
}

impl StartupCoordinator {
    pub fn new(
        requested_mode: StartupMode,
        metrics: StartupMetrics,
        visibility_deadline: StartupVisibilityDeadline,
    ) -> Self {
        Self::with_limits(
            requested_mode,
            metrics,
            GatewayLimits::default(),
            visibility_deadline,
        )
    }

    pub fn with_limits(
        requested_mode: StartupMode,
        metrics: StartupMetrics,
        limits: GatewayLimits,
        visibility_deadline: StartupVisibilityDeadline,
    ) -> Self {
        Self {
            requested_mode,
            metrics,
            limits,
            visibility_deadline,
        }
    }

    pub async fn launch(
        self,
        gateway_frontend_directory: PathBuf,
        legacy_initial_url: tauri::WebviewUrl,
    ) -> Result<StartupLaunch, StartupCoordinatorError> {
        self.launch_with_gateway_bind(
            gateway_frontend_directory,
            legacy_initial_url,
            StartupGateway::bind_cancellable,
        )
        .await
    }

    pub async fn launch_with_gateway_bind<B, BindFuture>(
        self,
        gateway_frontend_directory: PathBuf,
        legacy_initial_url: tauri::WebviewUrl,
        bind_gateway: B,
    ) -> Result<StartupLaunch, StartupCoordinatorError>
    where
        B: FnOnce(PathBuf, StartupMetrics, GatewayLimits, GatewayBindCancellation) -> BindFuture
            + Send
            + 'static,
        BindFuture: Future<Output = Result<StartupGateway, GatewayError>> + Send + 'static,
    {
        let window_created = StartupWindowCreatedGate::default();
        if self.requested_mode != StartupMode::RustGateway {
            return Ok(StartupLaunch {
                mode: StartupMode::LegacyExplicit,
                initial_url: legacy_initial_url,
                gateway: None,
                backend_generation: BackendGeneration::UNMANAGED,
                fallback_reason: None,
                window_created,
                initial_navigation_dispatched: AtomicBool::new(false),
            });
        }

        let Some(bind_deadline) = self
            .visibility_deadline
            .bind_deadline(tokio::time::Instant::now())
        else {
            return self.legacy_fallback(
                legacy_initial_url,
                window_created,
                "startup gateway bind budget was exhausted while preserving the window presentation budget",
            );
        };
        let cancellation = GatewayBindCancellation::new();
        let bind_metrics = self.metrics.clone();
        let bind_limits = self.limits;
        let bind_cancellation = cancellation.clone();
        let mut bind_task = tokio::spawn(async move {
            bind_gateway(
                gateway_frontend_directory,
                bind_metrics,
                bind_limits,
                bind_cancellation,
            )
            .await
        });
        let bind_result = match tokio::time::timeout_at(bind_deadline, &mut bind_task).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                return self.legacy_fallback(
                    legacy_initial_url,
                    window_created,
                    "startup gateway bind task stopped before completion",
                );
            }
            Err(_) => {
                cancellation.cancel();
                let cleanup_deadline = self.visibility_deadline.cleanup_deadline();
                match tokio::time::timeout_at(cleanup_deadline, &mut bind_task).await {
                    Ok(Ok(Ok(gateway))) => gateway.abort().await,
                    Ok(Ok(Err(_))) | Ok(Err(_)) => {}
                    Err(_) => {
                        bind_task.abort();
                        let _ = bind_task.await;
                    }
                }
                return self.legacy_fallback(
                    legacy_initial_url,
                    window_created,
                    "startup gateway initialization exceeded its bind budget and bounded cleanup grace while preserving the window presentation budget",
                );
            }
        };

        match bind_result {
            Ok(gateway) => {
                let backend_generation = gateway
                    .state()
                    .begin_backend_start()
                    .await
                    .map_err(StartupCoordinatorError::Gateway)?;
                let initial_url = tauri::WebviewUrl::External(gateway.bootstrap_url());
                Ok(StartupLaunch {
                    mode: StartupMode::RustGateway,
                    initial_url,
                    gateway: Some(gateway),
                    backend_generation,
                    fallback_reason: None,
                    window_created,
                    initial_navigation_dispatched: AtomicBool::new(false),
                })
            }
            Err(error) => self.legacy_fallback(
                legacy_initial_url,
                window_created,
                &bounded_gateway_failure(&error),
            ),
        }
    }

    fn legacy_fallback(
        self,
        legacy_initial_url: tauri::WebviewUrl,
        window_created: StartupWindowCreatedGate,
        reason: &str,
    ) -> Result<StartupLaunch, StartupCoordinatorError> {
        self.metrics
            .select_effective_mode(StartupMode::LegacyFallback)
            .map_err(StartupCoordinatorError::Metrics)?;
        Ok(StartupLaunch {
            mode: StartupMode::LegacyFallback,
            initial_url: legacy_initial_url,
            gateway: None,
            backend_generation: BackendGeneration::UNMANAGED,
            fallback_reason: Some(bounded_gateway_failure_text(reason)),
            window_created,
            initial_navigation_dispatched: AtomicBool::new(false),
        })
    }
}

fn bounded_gateway_failure(error: &GatewayError) -> String {
    bounded_gateway_failure_text(&error.to_string())
}

fn bounded_gateway_failure_text(reason: &str) -> String {
    const MAX_CHARS: usize = 256;
    reason.chars().take(MAX_CHARS).collect()
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendTransport {
    DirectPipes,
    Pty,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendSpawnStrategy {
    DirectPipes,
    Pty,
}

impl BackendSpawnStrategy {
    pub fn for_transport(transport: BackendTransport) -> Self {
        match transport {
            BackendTransport::DirectPipes => Self::DirectPipes,
            BackendTransport::Pty => Self::Pty,
        }
    }

    pub fn for_backend(transport: BackendTransport, watcher_process: bool) -> Result<Self, String> {
        if watcher_process && transport == BackendTransport::DirectPipes {
            return Err(
                "RIDE_BACKEND_WATCHER_PROCESS requires RIDE_BACKEND_TRANSPORT=pty because the listener is owned by a descendant"
                    .to_string(),
            );
        }
        Ok(Self::for_transport(transport))
    }
}

impl BackendTransport {
    pub fn from_env_value(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("direct") | Some("pipes") => Ok(Self::DirectPipes),
            Some("pty") => Ok(Self::Pty),
            Some(value) => Err(format!("Unsupported RIDE_BACKEND_TRANSPORT value: {value}")),
        }
    }

    pub fn from_env() -> Result<Self, String> {
        Self::from_env_value(std::env::var("RIDE_BACKEND_TRANSPORT").ok().as_deref())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BackendReadinessPolicy {
    startup_timeout: Duration,
    probe_interval: Duration,
    connect_timeout: Duration,
}

impl BackendReadinessPolicy {
    pub fn new(
        startup_timeout: Duration,
        probe_interval: Duration,
        connect_timeout: Duration,
    ) -> Result<Self, String> {
        if startup_timeout.is_zero() || probe_interval.is_zero() || connect_timeout.is_zero() {
            return Err("Backend readiness durations must be non-zero".to_string());
        }
        Ok(Self {
            startup_timeout,
            probe_interval,
            connect_timeout,
        })
    }

    pub fn startup_timeout(&self) -> Duration {
        self.startup_timeout
    }

    pub fn probe_interval(&self) -> Duration {
        self.probe_interval
    }

    pub fn connect_timeout(&self) -> Duration {
        self.connect_timeout
    }

    pub fn maximum_probe_attempts(&self) -> u128 {
        self.startup_timeout
            .as_nanos()
            .div_ceil(self.probe_interval.as_nanos())
    }
}

pub async fn wait_for_loopback(port: u16, policy: BackendReadinessPolicy) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + policy.startup_timeout();
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(format!(
                "Backend startup timeout: port {port} did not accept loopback connections within {}ms",
                policy.startup_timeout().as_millis()
            ));
        }
        if matches!(
            tokio::time::timeout(
                policy.connect_timeout().min(deadline - now),
                tokio::net::TcpStream::connect(("127.0.0.1", port)),
            )
            .await,
            Ok(Ok(_))
        ) {
            return Ok(());
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(format!(
                "Backend startup timeout: port {port} did not accept loopback connections within {}ms",
                policy.startup_timeout().as_millis()
            ));
        }
        tokio::time::sleep(policy.probe_interval().min(deadline - now)).await;
    }
}

pub async fn wait_for_owned_loopback(
    port: u16,
    owner_pid: u32,
    policy: BackendReadinessPolicy,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + policy.startup_timeout();
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return Err(format!(
                "Backend startup timeout: port {port} was not owned by child {owner_pid} within {}ms",
                policy.startup_timeout().as_millis()
            ));
        }
        let connected = matches!(
            tokio::time::timeout(
                policy.connect_timeout().min(deadline - now),
                tokio::net::TcpStream::connect(("127.0.0.1", port)),
            )
            .await,
            Ok(Ok(_))
        );
        if connected {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                continue;
            }
            match tokio::time::timeout(deadline - now, listener_is_owned_by(port, owner_pid)).await
            {
                Ok(Ok(true)) => return Ok(()),
                Ok(Ok(false)) => {}
                Ok(Err(error)) => return Err(error),
                Err(_) => continue,
            }
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            continue;
        }
        tokio::time::sleep(policy.probe_interval().min(deadline - now)).await;
    }
}

#[cfg(windows)]
async fn listener_is_owned_by(port: u16, owner_pid: u32) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || windows_listener_is_owned_by(port, owner_pid))
        .await
        .map_err(|error| format!("Windows listener-owner query task failed: {error}"))?
}

#[cfg(windows)]
fn windows_listener_is_owned_by(port: u16, owner_pid: u32) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
    use windows_sys::Win32::NetworkManagement::IpHelper::{
        GetExtendedTcpTable, MIB_TCPROW_OWNER_PID, MIB_TCP_STATE_LISTEN,
        TCP_TABLE_OWNER_PID_LISTENER,
    };
    use windows_sys::Win32::Networking::WinSock::AF_INET;

    let mut size = 0_u32;
    let first = unsafe {
        GetExtendedTcpTable(
            std::ptr::null_mut(),
            &mut size,
            0,
            AF_INET as u32,
            TCP_TABLE_OWNER_PID_LISTENER,
            0,
        )
    };
    if first != ERROR_INSUFFICIENT_BUFFER || size < std::mem::size_of::<u32>() as u32 {
        return Err(format!(
            "GetExtendedTcpTable size query failed with status {first}"
        ));
    }
    for _ in 0..3 {
        let mut table = vec![0_u8; size as usize];
        let status = unsafe {
            GetExtendedTcpTable(
                table.as_mut_ptr().cast(),
                &mut size,
                0,
                AF_INET as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status == ERROR_INSUFFICIENT_BUFFER {
            if size < std::mem::size_of::<u32>() as u32 {
                return Err("Windows TCP owner table reported an invalid size".to_string());
            }
            continue;
        }
        if status != 0 {
            return Err(format!(
                "GetExtendedTcpTable listener query failed with status {status}"
            ));
        }
        let count = unsafe { table.as_ptr().cast::<u32>().read_unaligned() } as usize;
        let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
        let required = std::mem::size_of::<u32>()
            .checked_add(
                count
                    .checked_mul(row_size)
                    .ok_or_else(|| "Windows TCP owner table is too large".to_string())?,
            )
            .ok_or_else(|| "Windows TCP owner table size overflow".to_string())?;
        if required > table.len() {
            return Err("Windows TCP owner table was truncated".to_string());
        }
        let row_base = unsafe { table.as_ptr().add(std::mem::size_of::<u32>()) };
        for index in 0..count {
            let row = unsafe {
                row_base
                    .add(index * row_size)
                    .cast::<MIB_TCPROW_OWNER_PID>()
                    .read_unaligned()
            };
            let local_port = u16::from_be((row.dwLocalPort & 0xffff) as u16);
            if row.dwState == MIB_TCP_STATE_LISTEN as u32
                && local_port == port
                && row.dwOwningPid == owner_pid
            {
                return Ok(true);
            }
        }
        return Ok(false);
    }
    Err("Windows TCP owner table changed during all bounded retries".to_string())
}

#[cfg(target_os = "linux")]
async fn listener_is_owned_by(port: u16, owner_pid: u32) -> Result<bool, String> {
    let tcp = tokio::fs::read_to_string("/proc/net/tcp")
        .await
        .map_err(|error| format!("Failed to read Linux TCP ownership table: {error}"))?;
    let listener_inodes = parse_linux_listener_inodes(&tcp, port)?
        .into_iter()
        .collect::<std::collections::HashSet<_>>();
    if listener_inodes.is_empty() {
        return Ok(false);
    }
    let mut entries = tokio::fs::read_dir(format!("/proc/{owner_pid}/fd"))
        .await
        .map_err(|error| format!("Failed to inspect backend socket ownership: {error}"))?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| format!("Failed to enumerate backend file descriptors: {error}"))?
    {
        match tokio::fs::read_link(entry.path()).await {
            Ok(target) if listener_inodes.contains(&target.to_string_lossy().into_owned()) => {
                return Ok(true)
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Failed to resolve backend socket descriptor ownership: {error}"
                ))
            }
        }
    }
    Ok(false)
}

/// Parses the Linux `/proc/net/tcp` layout documented by proc_pid_net(5).
/// The inode is field 9 after `split_ascii_whitespace` because the combined
/// transmit/receive and timer fields each occupy one whitespace field.
pub fn parse_linux_listener_inodes(table: &str, port: u16) -> Result<Vec<String>, String> {
    let mut listener_inodes = Vec::new();
    for line in table.lines().skip(1) {
        let fields = line.split_ascii_whitespace().collect::<Vec<_>>();
        let Some((_, local_port)) = fields.get(1).and_then(|local| local.rsplit_once(':')) else {
            continue;
        };
        if fields.get(3) == Some(&"0A") && u16::from_str_radix(local_port, 16).ok() == Some(port) {
            // /proc/net/tcp columns place the socket inode at index 9.
            let inode = fields
                .get(9)
                .ok_or_else(|| "Linux TCP ownership row was truncated".to_string())?;
            listener_inodes.push(format!("socket:[{inode}]"));
        }
    }
    Ok(listener_inodes)
}

#[cfg(target_os = "macos")]
async fn listener_is_owned_by(port: u16, owner_pid: u32) -> Result<bool, String> {
    let mut command = tokio::process::Command::new("/usr/sbin/lsof");
    let owner_pid = owner_pid.to_string();
    let port_filter = format!("-iTCP:{port}");
    command
        .args([
            "-nP",
            "-a",
            "-p",
            &owner_pid,
            &port_filter,
            "-sTCP:LISTEN",
            "-Fpn",
        ])
        .env("LC_ALL", "C")
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(2), command.output())
        .await
        .map_err(|_| "macOS listener-owner query timed out".to_string())?
        .map_err(|error| format!("Failed to query macOS listener ownership: {error}"))?;
    match output.status.code() {
        Some(0) => Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line == format!("p{owner_pid}"))),
        Some(1) => Ok(false),
        _ => Err(format!(
            "macOS listener-owner query failed with status {}",
            output.status
        )),
    }
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
async fn listener_is_owned_by(_port: u16, _owner_pid: u32) -> Result<bool, String> {
    Err("Listener ownership attestation is unavailable on this platform".to_string())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendStartupEvent {
    Stdout(String),
    Stderr(String),
    ChildSpawned(u32),
    LoopbackConnected,
    TimedOut,
    Exited(String),
    ShutdownRequested,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BackendStartupAction {
    LogStdout(String),
    LogStderr(String),
    PublishReady { pid: u32, port: u16 },
    TerminateProcessTree(u32),
    ReapOwnedChild(u32),
    ClearState,
    ReportUnexpectedExit(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendStartupState {
    pid: Option<u32>,
    port: Option<u16>,
    configured_port: u16,
    loopback_connected: bool,
    ready: bool,
}

impl BackendStartupState {
    pub fn spawned(pid: u32, port: u16) -> Self {
        let mut state = Self::awaiting_spawn(port);
        state.pid = Some(pid);
        state
    }

    pub fn awaiting_spawn(port: u16) -> Self {
        Self {
            pid: None,
            port: None,
            configured_port: port,
            loopback_connected: false,
            ready: false,
        }
    }

    pub fn observe(&mut self, event: BackendStartupEvent) -> Vec<BackendStartupAction> {
        match event {
            BackendStartupEvent::Stdout(line) => vec![BackendStartupAction::LogStdout(line)],
            BackendStartupEvent::Stderr(line) => vec![BackendStartupAction::LogStderr(line)],
            BackendStartupEvent::ChildSpawned(pid) => {
                self.pid = Some(pid);
                self.publish_if_attested()
            }
            BackendStartupEvent::LoopbackConnected => {
                self.loopback_connected = true;
                self.publish_if_attested()
            }
            BackendStartupEvent::TimedOut | BackendStartupEvent::ShutdownRequested => {
                let mut actions = Vec::new();
                if let Some(pid) = self.pid {
                    actions.push(BackendStartupAction::TerminateProcessTree(pid));
                    actions.push(BackendStartupAction::ReapOwnedChild(pid));
                }
                self.clear();
                actions.push(BackendStartupAction::ClearState);
                actions
            }
            BackendStartupEvent::Exited(exit) => {
                self.clear();
                vec![
                    BackendStartupAction::ClearState,
                    BackendStartupAction::ReportUnexpectedExit(exit),
                ]
            }
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn port(&self) -> Option<u16> {
        self.port
    }

    fn publish_if_attested(&mut self) -> Vec<BackendStartupAction> {
        if self.ready || self.pid.is_none() || !self.loopback_connected {
            return Vec::new();
        }
        self.ready = true;
        self.port = Some(self.configured_port);
        vec![BackendStartupAction::PublishReady {
            pid: self.pid.expect("attested backend has a process id"),
            port: self.configured_port,
        }]
    }

    fn clear(&mut self) {
        self.pid = None;
        self.port = None;
        self.loopback_connected = false;
        self.ready = false;
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BackendStartToken(u64);

/// Serializes backend launch ownership with shutdown requests. A child may be
/// registered only by the still-current launch reservation, so a stop request
/// cannot be undone by a task that finishes spawning later.
#[derive(Debug, Default)]
pub struct BackendOwnershipState {
    generation: u64,
    pending_start: Option<BackendStartToken>,
    pid: Option<u32>,
    stopping_pid: Option<u32>,
    stopping: bool,
}

impl BackendOwnershipState {
    pub fn reserve_start(&mut self) -> BackendStartToken {
        self.generation = self.generation.wrapping_add(1);
        let token = BackendStartToken(self.generation);
        self.pending_start = Some(token);
        self.pid = None;
        self.stopping_pid = None;
        self.stopping = false;
        token
    }

    pub fn register_spawn(&mut self, token: BackendStartToken, pid: u32) -> bool {
        if self.stopping || self.pending_start != Some(token) {
            return false;
        }
        self.pending_start = None;
        self.pid = Some(pid);
        true
    }

    pub fn request_stop(&mut self) -> Option<u32> {
        self.stopping = true;
        let pid = self.pid.take();
        if pid.is_some() {
            self.stopping_pid = pid;
        }
        pid
    }

    pub fn complete_start(&mut self, token: BackendStartToken) -> bool {
        if self.pending_start != Some(token) {
            return false;
        }
        self.pending_start = None;
        if self.stopping_pid.is_none() && self.pid.is_none() {
            self.stopping = false;
        }
        true
    }

    pub fn clear_spawn(&mut self, pid: u32) -> bool {
        if self.stopping_pid == Some(pid) {
            self.stopping_pid = None;
            self.stopping = false;
            return true;
        }
        if self.pid != Some(pid) {
            return self.stopping;
        }
        let was_stopping = self.stopping;
        self.pid = None;
        self.stopping = false;
        was_stopping
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn owns_active(&self, pid: u32) -> bool {
        !self.stopping && self.pid == Some(pid)
    }

    pub fn is_stopping(&self) -> bool {
        self.stopping
    }

    pub fn has_owned_work(&self) -> bool {
        self.pending_start.is_some() || self.pid.is_some() || self.stopping_pid.is_some()
    }

    pub fn owns_process(&self, pid: u32) -> bool {
        self.pid == Some(pid) || self.stopping_pid == Some(pid)
    }
}

pub fn finish_backend_stop(
    termination: Result<(), String>,
    stop_fallback: Option<tokio::sync::mpsc::UnboundedSender<()>>,
) -> Result<(), String> {
    let fallback = stop_fallback
        .map(|sender| {
            sender
                .send(())
                .map_err(|_| "Backend stop fallback receiver was unavailable".to_string())
        })
        .unwrap_or(Ok(()));
    match (termination, fallback) {
        (Ok(()), _) => Ok(()),
        (Err(termination), Ok(())) => Err(format!(
            "{termination}; exact-child stop fallback was requested"
        )),
        (Err(termination), Err(fallback)) => Err(format!("{termination}; {fallback}")),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimePathMode {
    Packaged(PathBuf),
    Development(PathBuf),
}

pub fn resolve_tauri_config_directory(
    configured: Option<PathBuf>,
    home: Option<PathBuf>,
) -> PathBuf {
    configured.unwrap_or_else(|| {
        home.unwrap_or_else(|| PathBuf::from("."))
            .join(".ride-tauri")
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimePaths {
    mode: RuntimePathMode,
    resource_root: PathBuf,
    backend_script: PathBuf,
    node_executable: PathBuf,
    frontend_directory: PathBuf,
    gateway_frontend_directory: PathBuf,
    plugin_directory: PathBuf,
    config_directory: PathBuf,
}

impl RuntimePaths {
    pub fn resolve(mode: RuntimePathMode, config_directory: PathBuf) -> Result<Self, String> {
        let (
            resource_root,
            backend_root,
            frontend_directory,
            gateway_frontend_directory,
            plugin_directory,
        ) = match &mode {
            RuntimePathMode::Packaged(root) => (
                root.clone(),
                root.join("resources").join("backend"),
                root.join("lib").join("frontend"),
                root.join("lib").join("frontend"),
                root.join("resources").join("plugins"),
            ),
            RuntimePathMode::Development(root) => {
                let applications = root.join("app").join("applications");
                let resource_root = applications.join("tauri").join("resources");
                (
                    resource_root.clone(),
                    applications.join("browser").join("lib").join("backend"),
                    applications.join("browser").join("lib").join("frontend"),
                    applications.join("tauri").join("browser-frontend"),
                    resource_root.join("plugins"),
                )
            }
        };
        let node_root = match &mode {
            RuntimePathMode::Packaged(_) => backend_root.clone(),
            RuntimePathMode::Development(root) => root
                .join("app")
                .join("applications")
                .join("tauri")
                .join("resources")
                .join("backend"),
        };
        let node_executable =
            node_root
                .join("runtime")
                .join(if cfg!(windows) { "node.exe" } else { "node" });
        Ok(Self {
            mode,
            backend_script: backend_root.join("main.js"),
            node_executable,
            frontend_directory,
            gateway_frontend_directory,
            plugin_directory,
            resource_root,
            config_directory,
        })
    }

    pub fn mode(&self) -> &RuntimePathMode {
        &self.mode
    }

    pub fn resource_root(&self) -> PathBuf {
        self.resource_root.clone()
    }

    pub fn backend_script(&self) -> PathBuf {
        self.backend_script.clone()
    }

    pub fn node_executable(&self) -> PathBuf {
        self.node_executable.clone()
    }

    pub fn frontend_directory(&self) -> PathBuf {
        self.frontend_directory.clone()
    }

    pub fn gateway_frontend_directory(&self) -> PathBuf {
        self.gateway_frontend_directory.clone()
    }

    pub fn plugin_directory(&self) -> PathBuf {
        self.plugin_directory.clone()
    }

    pub fn config_directory(&self) -> PathBuf {
        self.config_directory.clone()
    }
}

#[derive(Debug, Default)]
pub struct RuntimePathsCache {
    paths: OnceLock<RuntimePaths>,
    initialization: Mutex<()>,
}

impl RuntimePathsCache {
    pub fn get_or_try_init<E>(
        &self,
        resolve: impl FnOnce() -> Result<RuntimePaths, E>,
    ) -> Result<&RuntimePaths, E> {
        if let Some(paths) = self.paths.get() {
            return Ok(paths);
        }
        let _guard = self
            .initialization
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.paths.get().is_none() {
            let paths = resolve()?;
            let _ = self.paths.set(paths);
        }
        Ok(self.paths.get().expect("runtime paths initialized"))
    }
}

/// The workspace-specific suffix for a backend command line.
///
/// A selected workspace follows `--` so even an option-looking path is passed
/// to Theia as one positional argument. An empty plan preserves Theia's normal
/// recent-workspace startup behavior.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackendLaunchPlan {
    arguments: Vec<OsString>,
}

impl BackendLaunchPlan {
    pub fn new(workspace: Option<PathBuf>) -> Self {
        let arguments = workspace.map_or_else(Vec::new, |workspace| {
            vec![OsString::from("--"), workspace.into_os_string()]
        });
        Self { arguments }
    }

    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }
}
