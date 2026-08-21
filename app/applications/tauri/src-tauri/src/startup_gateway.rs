/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use crate::startup_metrics::{StartupMetrics, StartupMilestone};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use bytes::Bytes;
use futures_util::{FutureExt, TryStreamExt};
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::{Body, Frame, Incoming, SizeHint};
use hyper::header::{
    CACHE_CONTROL, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, LOCATION, ORIGIN,
    SET_COOKIE, TRANSFER_ENCODING, UPGRADE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{HeaderMap, Method, Request, Response, StatusCode, Uri};
use hyper_util::client::legacy::{connect::HttpConnector, Client};
use hyper_util::rt::{TokioExecutor, TokioIo, TokioTimer};
use reqwest::Url;
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
#[cfg(unix)]
use std::ffi::OsStr;
use std::ffi::OsString;
use std::fmt;
use std::fs as std_fs;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::panic::AssertUnwindSafe;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::fs::File;
use tokio::io::{copy_bidirectional, AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch, Mutex, Notify, OwnedSemaphorePermit, Semaphore};
use tokio::task::{JoinError, JoinHandle, JoinSet};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

const BROWSER_BACKEND_FAILURE: &str = "Backend process failed before becoming ready.";
const NOT_FOUND_BODY: &[u8] = b"Not Found";
const INDEX_PATH: &str = "/index.html";
const SESSION_COOKIE_NAME: &str = "ride_session";
const STATIC_ASSET_CHUNK_SIZE: usize = 16 * 1024;
const BACKEND_UNAVAILABLE_BODY: &[u8] = b"{\"error\":\"backend_unavailable\"}";
const BACKEND_PROXY_FAILED_BODY: &[u8] = b"{\"error\":\"backend_proxy_failed\"}";
const INVALID_HTTP_MESSAGE_BODY: &[u8] = b"{\"error\":\"invalid_http_message\"}";
const SOCKET_IO_PATH: &str = "/socket.io/";
const SOCKET_IO_WEBSOCKET_QUERY: &str = "EIO=4&transport=websocket";
const WEBSOCKET_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const HOP_BY_HOP_HEADERS: [&str; 9] = [
    "connection",
    "proxy-connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
];

type GatewayBody = BoxBody<Bytes, io::Error>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendPhase {
    Starting,
    Ready,
    Failed,
    Stopping,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BackendAddressError {
    ZeroPort,
    NonLoopback,
}

impl fmt::Display for BackendAddressError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::ZeroPort => "backend address has port zero",
            Self::NonLoopback => "backend address is not loopback",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for BackendAddressError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GatewayLimitError {
    ZeroMaxConnections,
    ZeroMaxTunnels,
    ZeroWebSocketUpgradeTimeout,
}

impl fmt::Display for GatewayLimitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroMaxConnections => formatter.write_str("max_connections must be nonzero"),
            Self::ZeroMaxTunnels => formatter.write_str("max_tunnels must be nonzero"),
            Self::ZeroWebSocketUpgradeTimeout => {
                formatter.write_str("websocket_upgrade_timeout must be nonzero")
            }
        }
    }
}

impl std::error::Error for GatewayLimitError {}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct BackendGeneration(u64);

impl BackendGeneration {
    /// Sentinel used by the legacy launch path, which is not managed by a
    /// gateway generation. Real gateway generations start at one.
    pub(crate) const UNMANAGED: Self = Self(0);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BackendLease {
    pub generation: BackendGeneration,
    pub address: SocketAddr,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GatewayLimits {
    pub backend_wait: Duration,
    pub backend_response_header_timeout: Duration,
    pub max_waiters: usize,
    pub max_connections: usize,
    pub max_tunnels: usize,
    pub http_header_read_timeout: Duration,
    pub websocket_upgrade_timeout: Duration,
    pub shutdown_drain: Duration,
}

impl GatewayLimits {
    pub fn test_defaults() -> Self {
        Self {
            backend_wait: Duration::from_secs(1),
            backend_response_header_timeout: Duration::from_secs(1),
            max_waiters: 8,
            max_connections: 16,
            max_tunnels: 4,
            http_header_read_timeout: Duration::from_secs(1),
            websocket_upgrade_timeout: Duration::from_secs(1),
            shutdown_drain: Duration::from_millis(100),
        }
    }
}

impl Default for GatewayLimits {
    fn default() -> Self {
        Self {
            backend_wait: Duration::from_secs(5),
            backend_response_header_timeout: Duration::from_secs(30),
            max_waiters: 64,
            max_connections: 128,
            max_tunnels: 64,
            http_header_read_timeout: Duration::from_secs(10),
            websocket_upgrade_timeout: Duration::from_secs(5),
            shutdown_drain: Duration::from_secs(2),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GatewaySnapshot {
    pub generation: BackendGeneration,
    pub phase: BackendPhase,
    pub diagnostic: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GatewayError {
    StaleGeneration(BackendGeneration),
    BackendStartInProgress(BackendGeneration),
    InvalidTransition {
        generation: BackendGeneration,
        phase: BackendPhase,
    },
    BackendFailed {
        generation: BackendGeneration,
        diagnostic: String,
    },
    TooManyBackendWaiters,
    BackendWaitTimedOut(BackendGeneration),
    BackendGenerationSuperseded {
        expected: BackendGeneration,
        observed: BackendGeneration,
    },
    InvalidBackendAddress(BackendAddressError),
    InvalidLimits(GatewayLimitError),
    FrontendUnavailable,
    ListenerUnavailable,
    ListenerStopped,
    GenerationExhausted,
    ShuttingDown,
}

impl fmt::Display for GatewayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::StaleGeneration(generation) => {
                write!(formatter, "stale backend generation {generation:?}")
            }
            Self::BackendStartInProgress(generation) => {
                write!(
                    formatter,
                    "backend generation {generation:?} is already starting"
                )
            }
            Self::InvalidTransition { generation, phase } => write!(
                formatter,
                "backend generation {generation:?} cannot transition from {phase:?}"
            ),
            Self::BackendFailed {
                generation,
                diagnostic,
            } => write!(
                formatter,
                "backend generation {generation:?} failed: {diagnostic}"
            ),
            Self::TooManyBackendWaiters => write!(formatter, "backend waiter limit reached"),
            Self::BackendWaitTimedOut(generation) => {
                write!(
                    formatter,
                    "backend generation {generation:?} readiness timed out"
                )
            }
            Self::BackendGenerationSuperseded { expected, observed } => write!(
                formatter,
                "backend generation {expected:?} was superseded by {observed:?}"
            ),
            Self::InvalidBackendAddress(error) => error.fmt(formatter),
            Self::InvalidLimits(error) => error.fmt(formatter),
            Self::FrontendUnavailable => write!(formatter, "frontend assets are unavailable"),
            Self::ListenerUnavailable => {
                write!(formatter, "startup gateway listener is unavailable")
            }
            Self::ListenerStopped => write!(formatter, "startup gateway listener stopped"),
            Self::GenerationExhausted => write!(formatter, "backend generation exhausted"),
            Self::ShuttingDown => write!(formatter, "startup gateway is shutting down"),
        }
    }
}

impl std::error::Error for GatewayError {}

#[derive(Clone, Debug)]
struct PublishedBackend {
    snapshot: GatewaySnapshot,
    backend_addr: Option<SocketAddr>,
}

struct GatewayInner {
    current: Mutex<PublishedBackend>,
    readiness: watch::Sender<PublishedBackend>,
    shutdown: watch::Sender<bool>,
    waiters: Arc<Semaphore>,
    limits: GatewayLimits,
}

#[derive(Clone)]
pub struct GatewayState {
    inner: Arc<GatewayInner>,
}

impl GatewayState {
    pub fn new(limits: GatewayLimits) -> Self {
        let initial = PublishedBackend {
            snapshot: GatewaySnapshot {
                generation: BackendGeneration(0),
                phase: BackendPhase::Failed,
                diagnostic: None,
            },
            backend_addr: None,
        };
        let (readiness, _) = watch::channel(initial.clone());
        let (shutdown, _) = watch::channel(false);
        Self {
            inner: Arc::new(GatewayInner {
                current: Mutex::new(initial),
                readiness,
                shutdown,
                waiters: Arc::new(Semaphore::new(limits.max_waiters)),
                limits,
            }),
        }
    }

    pub async fn begin_backend_start(&self) -> Result<BackendGeneration, GatewayError> {
        if *self.inner.shutdown.borrow() {
            return Err(GatewayError::ShuttingDown);
        }

        let mut current = self.inner.current.lock().await;
        match current.snapshot.phase {
            BackendPhase::Failed => {}
            BackendPhase::Starting => {
                return Err(GatewayError::BackendStartInProgress(
                    current.snapshot.generation,
                ));
            }
            BackendPhase::Stopping => return Err(GatewayError::ShuttingDown),
            phase => {
                return Err(GatewayError::InvalidTransition {
                    generation: current.snapshot.generation,
                    phase,
                });
            }
        }

        let generation = BackendGeneration(
            current
                .snapshot
                .generation
                .0
                .checked_add(1)
                .ok_or(GatewayError::GenerationExhausted)?,
        );
        *current = PublishedBackend {
            snapshot: GatewaySnapshot {
                generation,
                phase: BackendPhase::Starting,
                diagnostic: None,
            },
            backend_addr: None,
        };
        self.inner.readiness.send_replace(current.clone());
        Ok(generation)
    }

    pub async fn backend_ready(
        &self,
        generation: BackendGeneration,
        backend_addr: SocketAddr,
    ) -> Result<(), GatewayError> {
        self.backend_ready_if_current(generation, backend_addr, || true)
            .await
            .map(|_| ())
    }

    pub async fn backend_ready_if_current<F>(
        &self,
        generation: BackendGeneration,
        backend_addr: SocketAddr,
        before_publish: F,
    ) -> Result<bool, GatewayError>
    where
        F: FnOnce() -> bool + Send,
    {
        Self::validate_backend_addr(backend_addr)?;
        let mut current = self.inner.current.lock().await;
        Self::require_current_generation(&current, generation)?;
        if current.snapshot.phase == BackendPhase::Stopping {
            return Err(GatewayError::ShuttingDown);
        }
        if current.snapshot.phase != BackendPhase::Starting {
            return Err(GatewayError::InvalidTransition {
                generation,
                phase: current.snapshot.phase,
            });
        }
        if !before_publish() {
            return Ok(false);
        }

        *current = PublishedBackend {
            snapshot: GatewaySnapshot {
                generation,
                phase: BackendPhase::Ready,
                diagnostic: None,
            },
            backend_addr: Some(backend_addr),
        };
        self.inner.readiness.send_replace(current.clone());
        Ok(true)
    }

    pub async fn fail_backend(
        &self,
        generation: BackendGeneration,
        _private_diagnostic: &str,
    ) -> Result<(), GatewayError> {
        let mut current = self.inner.current.lock().await;
        Self::require_current_generation(&current, generation)?;
        if current.snapshot.phase == BackendPhase::Stopping {
            return Err(GatewayError::ShuttingDown);
        }
        if !matches!(
            current.snapshot.phase,
            BackendPhase::Starting | BackendPhase::Ready
        ) {
            return Err(GatewayError::InvalidTransition {
                generation,
                phase: current.snapshot.phase,
            });
        }

        *current = PublishedBackend {
            snapshot: GatewaySnapshot {
                generation,
                phase: BackendPhase::Failed,
                diagnostic: Some(BROWSER_BACKEND_FAILURE.to_string()),
            },
            backend_addr: None,
        };
        self.inner.readiness.send_replace(current.clone());
        Ok(())
    }

    pub async fn snapshot(&self) -> GatewaySnapshot {
        self.inner.current.lock().await.snapshot.clone()
    }

    async fn backend_lease_is_current(&self, lease: BackendLease) -> bool {
        let current = self.inner.current.lock().await;
        current.snapshot.generation == lease.generation
            && current.snapshot.phase == BackendPhase::Ready
            && current.backend_addr == Some(lease.address)
    }

    pub async fn wait_for_backend(&self) -> Result<SocketAddr, GatewayError> {
        self.wait_for_backend_lease()
            .await
            .map(|lease| lease.address)
    }

    pub async fn wait_for_backend_lease(&self) -> Result<BackendLease, GatewayError> {
        self.wait_for_backend_lease_with_timeout(self.inner.limits.backend_wait)
            .await
    }

    async fn wait_for_backend_lease_with_timeout(
        &self,
        backend_wait: Duration,
    ) -> Result<BackendLease, GatewayError> {
        let mut readiness = self.inner.readiness.subscribe();
        let mut shutdown = self.inner.shutdown.subscribe();
        let expected_generation = readiness.borrow().snapshot.generation;

        if let Some(result) = Self::published_result(&readiness.borrow(), expected_generation) {
            return result;
        }
        if *shutdown.borrow() {
            return Err(GatewayError::ShuttingDown);
        }

        let _waiter = self
            .inner
            .waiters
            .clone()
            .try_acquire_owned()
            .map_err(|_| GatewayError::TooManyBackendWaiters)?;
        let wait = async {
            loop {
                tokio::select! {
                    changed = readiness.changed() => {
                        if changed.is_err() {
                            return Err(GatewayError::ShuttingDown);
                        }
                    }
                    changed = shutdown.changed() => {
                        if changed.is_err() || *shutdown.borrow() {
                            return Err(GatewayError::ShuttingDown);
                        }
                    }
                }

                if *shutdown.borrow() {
                    return Err(GatewayError::ShuttingDown);
                }
                if let Some(result) =
                    Self::published_result(&readiness.borrow(), expected_generation)
                {
                    return result;
                }
            }
        };

        tokio::time::timeout(backend_wait, wait)
            .await
            .unwrap_or(Err(GatewayError::BackendWaitTimedOut(expected_generation)))
    }

    pub async fn shutdown(&self) {
        let mut current = self.inner.current.lock().await;
        current.snapshot.phase = BackendPhase::Stopping;
        current.snapshot.diagnostic = None;
        current.backend_addr = None;
        self.inner.readiness.send_replace(current.clone());
        self.inner.shutdown.send_replace(true);
    }

    fn require_current_generation(
        current: &PublishedBackend,
        generation: BackendGeneration,
    ) -> Result<(), GatewayError> {
        if current.snapshot.generation == generation {
            Ok(())
        } else {
            Err(GatewayError::StaleGeneration(generation))
        }
    }

    fn validate_backend_addr(backend_addr: SocketAddr) -> Result<(), GatewayError> {
        if backend_addr.port() == 0 {
            Err(GatewayError::InvalidBackendAddress(
                BackendAddressError::ZeroPort,
            ))
        } else if !backend_addr.ip().is_loopback() {
            Err(GatewayError::InvalidBackendAddress(
                BackendAddressError::NonLoopback,
            ))
        } else {
            Ok(())
        }
    }

    fn published_result(
        published: &PublishedBackend,
        expected_generation: BackendGeneration,
    ) -> Option<Result<BackendLease, GatewayError>> {
        if published.snapshot.generation != expected_generation {
            return Some(Err(GatewayError::BackendGenerationSuperseded {
                expected: expected_generation,
                observed: published.snapshot.generation,
            }));
        }

        match published.snapshot.phase {
            BackendPhase::Ready => Some(Ok(BackendLease {
                generation: published.snapshot.generation,
                address: published
                    .backend_addr
                    .expect("ready backend must publish an address"),
            })),
            BackendPhase::Failed if published.snapshot.generation.0 > 0 => {
                Some(Err(GatewayError::BackendFailed {
                    generation: published.snapshot.generation,
                    diagnostic: published
                        .snapshot
                        .diagnostic
                        .clone()
                        .unwrap_or_else(|| BROWSER_BACKEND_FAILURE.to_string()),
                }))
            }
            BackendPhase::Stopping => Some(Err(GatewayError::ShuttingDown)),
            BackendPhase::Starting | BackendPhase::Failed => None,
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct StaticFileIdentity {
    volume: u64,
    file: [u8; 16],
}

#[derive(Clone)]
struct BoundStaticFile {
    root_identity: StaticFileIdentity,
    parent_identities: Vec<StaticFileIdentity>,
    file_identity: StaticFileIdentity,
    content_length: u64,
}

#[derive(Clone)]
struct StaticAsset {
    relative_components: Vec<OsString>,
    binding: BoundStaticFile,
    content_type: &'static str,
    cache_control: &'static str,
}

struct GatewaySession {
    bootstrap_capability: Mutex<Option<String>>,
    bootstrap_path: String,
    session_value: String,
}

struct StaticInventory {
    canonical_root: PathBuf,
    assets: HashMap<NormalizedPath, StaticAsset>,
}

#[derive(Clone)]
struct TunnelRegistry {
    inner: Arc<Mutex<TunnelRegistryInner>>,
    permits: Arc<Semaphore>,
}

struct TunnelRegistryInner {
    accepting: bool,
    tasks: JoinSet<()>,
}

impl TunnelRegistry {
    fn new(max_tunnels: usize) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TunnelRegistryInner {
                accepting: true,
                tasks: JoinSet::new(),
            })),
            permits: Arc::new(Semaphore::new(max_tunnels.min(Semaphore::MAX_PERMITS))),
        }
    }

    fn try_acquire(&self) -> Option<OwnedSemaphorePermit> {
        self.permits.clone().try_acquire_owned().ok()
    }

    async fn spawn(&self, future: impl Future<Output = ()> + Send + 'static) -> bool {
        let mut inner = self.inner.lock().await;
        while let Some(result) = inner.tasks.try_join_next() {
            observe_tunnel_task_result(result);
        }
        if !inner.accepting {
            return false;
        }
        inner.tasks.spawn(future);
        true
    }

    async fn shutdown(&self, drain: Duration) {
        let mut tasks = {
            let mut inner = self.inner.lock().await;
            inner.accepting = false;
            self.permits.close();
            std::mem::replace(&mut inner.tasks, JoinSet::new())
        };
        let deadline = tokio::time::sleep(drain);
        tokio::pin!(deadline);
        while !tasks.is_empty() {
            tokio::select! {
                _ = &mut deadline => {
                    tasks.abort_all();
                    break;
                }
                completed = tasks.join_next() => {
                    if let Some(result) = completed {
                        observe_tunnel_task_result(result);
                    }
                }
            }
        }
        while let Some(result) = tasks.join_next().await {
            observe_tunnel_task_result(result);
        }
    }
}

#[derive(Clone)]
struct RpcMilestoneRecorder {
    metrics: StartupMetrics,
    last_recorded_generation: Arc<Mutex<Option<BackendGeneration>>>,
}

impl RpcMilestoneRecorder {
    fn new(metrics: StartupMetrics) -> Self {
        Self {
            metrics,
            last_recorded_generation: Arc::new(Mutex::new(None)),
        }
    }

    async fn record_connected(&self, generation: BackendGeneration) {
        let mut last_recorded = self.last_recorded_generation.lock().await;
        if last_recorded.is_some_and(|recorded| generation <= recorded) {
            return;
        }
        *last_recorded = Some(generation);
        drop(last_recorded);
        self.metrics.record_or_warn(StartupMilestone::RpcConnected);
    }
}

#[derive(Clone)]
struct BackendProxy {
    pool: Arc<Mutex<Option<GenerationBackendClient>>>,
    state: GatewayState,
    limits: GatewayLimits,
    public_origin: String,
    tunnels: TunnelRegistry,
    rpc_milestones: RpcMilestoneRecorder,
}

struct GenerationBackendClient {
    lease: BackendLease,
    client: Client<HttpConnector, UploadCompletionBody>,
}

struct UploadCompletionBody {
    inner: Incoming,
    completion: Option<oneshot::Sender<()>>,
}

impl UploadCompletionBody {
    fn new(inner: Incoming, completion: oneshot::Sender<()>) -> Self {
        let mut body = Self {
            inner,
            completion: Some(completion),
        };
        if body.inner.is_end_stream() {
            body.complete();
        }
        body
    }

    fn complete(&mut self) {
        if let Some(completion) = self.completion.take() {
            let _ = completion.send(());
        }
    }
}

impl Body for UploadCompletionBody {
    type Data = Bytes;
    type Error = hyper::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let body = self.get_mut();
        let frame = Pin::new(&mut body.inner).poll_frame(context);
        if matches!(&frame, Poll::Ready(None) | Poll::Ready(Some(Err(_)))) {
            body.complete();
        }
        frame
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

impl Drop for UploadCompletionBody {
    fn drop(&mut self) {
        self.complete();
    }
}

#[derive(Clone)]
struct StaticGatewayService {
    public_authority: String,
    public_origin: String,
    routes: RouteTable,
    frontend_root: Arc<PathBuf>,
    assets: Arc<HashMap<NormalizedPath, StaticAsset>>,
    session: Arc<GatewaySession>,
    backend_proxy: BackendProxy,
    tunnels: TunnelRegistry,
}

pub struct StartupGateway {
    public_addr: SocketAddr,
    bootstrap_capability: String,
    state: GatewayState,
    shutdown: watch::Sender<bool>,
    shutdown_drain: Duration,
    accept_task: JoinHandle<()>,
}

impl StartupGateway {
    pub async fn bind(
        frontend_root: PathBuf,
        metrics: StartupMetrics,
        limits: GatewayLimits,
    ) -> Result<Self, GatewayError> {
        if limits.max_connections == 0 {
            return Err(GatewayError::InvalidLimits(
                GatewayLimitError::ZeroMaxConnections,
            ));
        }
        if limits.max_tunnels == 0 {
            return Err(GatewayError::InvalidLimits(
                GatewayLimitError::ZeroMaxTunnels,
            ));
        }
        if limits.websocket_upgrade_timeout.is_zero() {
            return Err(GatewayError::InvalidLimits(
                GatewayLimitError::ZeroWebSocketUpgradeTimeout,
            ));
        }
        let inventory = tokio::task::spawn_blocking(move || build_static_inventory(&frontend_root))
            .await
            .map_err(|_| GatewayError::FrontendUnavailable)??;
        let routes = RouteTable {
            static_paths: inventory.assets.keys().cloned().collect(),
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|_| GatewayError::ListenerUnavailable)?;
        let public_addr = listener
            .local_addr()
            .map_err(|_| GatewayError::ListenerUnavailable)?;
        if public_addr.ip() != IpAddr::V4(Ipv4Addr::LOCALHOST) || public_addr.port() == 0 {
            return Err(GatewayError::ListenerUnavailable);
        }

        let public_authority = public_addr.to_string();
        let public_origin = format!("http://{public_authority}");
        let bootstrap_capability = Uuid::new_v4().to_string();
        let bootstrap_path = format!("/_ride/bootstrap/{bootstrap_capability}");
        let session_value = Uuid::new_v4().to_string();
        debug_assert_ne!(bootstrap_capability, session_value);
        let state = GatewayState::new(limits);
        let tunnels = TunnelRegistry::new(limits.max_tunnels);
        let backend_proxy = BackendProxy::new(
            state.clone(),
            limits,
            public_origin.clone(),
            tunnels.clone(),
            RpcMilestoneRecorder::new(metrics.clone()),
        );
        let service = StaticGatewayService {
            public_authority,
            public_origin,
            routes,
            frontend_root: Arc::new(inventory.canonical_root),
            assets: Arc::new(inventory.assets),
            session: Arc::new(GatewaySession {
                bootstrap_capability: Mutex::new(Some(bootstrap_capability.clone())),
                bootstrap_path,
                session_value,
            }),
            backend_proxy,
            tunnels,
        };
        let (shutdown, shutdown_receiver) = watch::channel(false);
        let (accept_ready, ready) = oneshot::channel();
        let accept_state = state.clone();
        let accept_task = tokio::spawn(async move {
            let accept_loop = run_accept_loop(
                listener,
                service,
                accept_state.clone(),
                shutdown_receiver,
                limits.max_connections,
                limits.http_header_read_timeout,
                limits.shutdown_drain,
                accept_ready,
            );
            if AssertUnwindSafe(accept_loop).catch_unwind().await.is_err() {
                log::warn!("Startup gateway accept loop panicked.");
                accept_state.shutdown().await;
            }
        });
        ready.await.map_err(|_| GatewayError::ListenerStopped)?;
        metrics.record_or_warn(StartupMilestone::GatewayListening);

        Ok(Self {
            public_addr,
            bootstrap_capability,
            state,
            shutdown,
            shutdown_drain: limits.shutdown_drain,
            accept_task,
        })
    }

    pub fn bootstrap_url(&self) -> Url {
        Url::parse(&format!(
            "http://{}/_ride/bootstrap/{}",
            self.public_authority(),
            self.bootstrap_capability
        ))
        .expect("validated loopback gateway URL must parse")
    }

    pub fn public_authority(&self) -> String {
        self.public_addr.to_string()
    }

    pub fn state(&self) -> GatewayState {
        self.state.clone()
    }

    pub async fn shutdown(self) {
        self.state.shutdown().await;
        self.shutdown.send_replace(true);
        let mut accept_task = self.accept_task;
        match tokio::time::timeout(self.shutdown_drain, &mut accept_task).await {
            Ok(result) => observe_accept_task_result(result),
            Err(_) => {
                accept_task.abort();
                observe_accept_task_result(accept_task.await);
            }
        }
    }
}

fn join_error_diagnostic<T>(result: &Result<T, JoinError>) -> Option<&'static str> {
    match result {
        Ok(_) => None,
        Err(error) if error.is_cancelled() => {
            Some("Startup gateway connection task was cancelled.")
        }
        Err(_) => Some("Startup gateway connection task panicked."),
    }
}

fn observe_connection_task_result(result: Result<(), JoinError>) {
    let Some(diagnostic) = join_error_diagnostic(&result) else {
        return;
    };
    if result.as_ref().is_err_and(JoinError::is_cancelled) {
        log::debug!("{diagnostic}");
    } else {
        log::warn!("{diagnostic}");
    }
}

fn observe_tunnel_task_result(result: Result<(), JoinError>) {
    let Some(diagnostic) = join_error_diagnostic(&result) else {
        return;
    };
    if result.as_ref().is_err_and(JoinError::is_cancelled) {
        log::debug!("Startup gateway tunnel task was cancelled.");
    } else {
        log::warn!("Startup gateway tunnel task panicked: {diagnostic}");
    }
}

fn observe_accept_task_result(result: Result<(), JoinError>) {
    if let Err(error) = result {
        if error.is_cancelled() {
            log::debug!("Startup gateway accept task was cancelled during bounded shutdown.");
        } else {
            log::warn!("Startup gateway accept task panicked.");
        }
    }
}

async fn run_accept_loop(
    listener: TcpListener,
    service: StaticGatewayService,
    state: GatewayState,
    mut shutdown: watch::Receiver<bool>,
    max_connections: usize,
    http_header_read_timeout: Duration,
    shutdown_drain: Duration,
    accept_ready: oneshot::Sender<()>,
) {
    let mut connections = JoinSet::new();
    let connection_limit = Arc::new(Semaphore::new(max_connections.min(Semaphore::MAX_PERMITS)));
    if accept_ready.send(()).is_err() {
        state.shutdown().await;
        return;
    }

    loop {
        tokio::select! {
            biased;
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            completed = connections.join_next(), if !connections.is_empty() => {
                if let Some(result) = completed {
                    observe_connection_task_result(result);
                }
            }
            accepted = listener.accept() => {
                let Ok((stream, peer_addr)) = accepted else {
                    state.shutdown().await;
                    break;
                };
                if !peer_addr.ip().is_loopback() {
                    continue;
                }
                let Ok(connection_permit) = connection_limit.clone().try_acquire_owned() else {
                    drop(stream);
                    continue;
                };
                let service = service.clone();
                connections.spawn(async move {
                    let _connection_permit = connection_permit;
                    serve_connection(stream, service, http_header_read_timeout).await;
                });
            }
        }
    }
    drop(listener);

    let drain = tokio::time::sleep(shutdown_drain);
    tokio::pin!(drain);
    while !connections.is_empty() {
        tokio::select! {
            _ = &mut drain => {
                connections.abort_all();
                break;
            }
            completed = connections.join_next() => {
                if let Some(result) = completed {
                    observe_connection_task_result(result);
                }
            }
        }
    }
    while let Some(result) = connections.join_next().await {
        observe_connection_task_result(result);
    }
    service.tunnels.shutdown(shutdown_drain).await;
}

async fn serve_connection(
    stream: TcpStream,
    service: StaticGatewayService,
    http_header_read_timeout: Duration,
) {
    let request_service = service_fn(move |request| {
        let service = service.clone();
        async move { Ok::<_, Infallible>(service.handle(request).await) }
    });
    let mut builder = http1::Builder::new();
    builder
        .timer(TokioTimer::new())
        .header_read_timeout(http_header_read_timeout);
    let _ = builder
        .serve_connection(TokioIo::new(stream), request_service)
        .with_upgrades()
        .await;
}

impl BackendProxy {
    fn new(
        state: GatewayState,
        limits: GatewayLimits,
        public_origin: String,
        tunnels: TunnelRegistry,
        rpc_milestones: RpcMilestoneRecorder,
    ) -> Self {
        Self {
            pool: Arc::new(Mutex::new(None)),
            state,
            limits,
            public_origin,
            tunnels,
            rpc_milestones,
        }
    }

    fn build_client() -> Client<HttpConnector, UploadCompletionBody> {
        let mut builder = Client::builder(TokioExecutor::new());
        builder.retry_canceled_requests(false);
        builder.build(HttpConnector::new())
    }

    async fn client_for_generation(
        &self,
        lease: BackendLease,
    ) -> Option<Client<HttpConnector, UploadCompletionBody>> {
        let mut pool = self.pool.lock().await;
        if let Some(current) = pool.as_ref() {
            if current.lease == lease {
                return Some(current.client.clone());
            }
            if current.lease.generation > lease.generation {
                return None;
            }
        }
        let client = Self::build_client();
        *pool = Some(GenerationBackendClient {
            lease,
            client: client.clone(),
        });
        Some(client)
    }

    async fn forward(&self, request: Request<hyper::body::Incoming>) -> Response<GatewayBody> {
        match proxy_request_kind(&request, &self.public_origin) {
            Ok(ProxyRequestKind::Http) => self.forward_http(request).await,
            Ok(ProxyRequestKind::WebSocket(handshake)) => {
                self.forward_websocket(request, handshake).await
            }
            Err(_) => invalid_http_message(),
        }
    }

    async fn forward_http(
        &self,
        mut request: Request<hyper::body::Incoming>,
    ) -> Response<GatewayBody> {
        strip_gateway_session_cookie(request.headers_mut());
        if normalize_message_framing(request.headers_mut()).is_err()
            || strip_hop_by_hop_headers(request.headers_mut()).is_err()
        {
            return invalid_http_message();
        }
        let backend_lease = match self
            .state
            .wait_for_backend_lease_with_timeout(self.limits.backend_wait)
            .await
        {
            Ok(backend_lease) => backend_lease,
            Err(_) => return backend_unavailable(),
        };
        let Some(client) = self.client_for_generation(backend_lease).await else {
            return backend_unavailable();
        };
        let backend_addr = backend_lease.address;
        let backend_authority = backend_addr.to_string();
        let path_and_query = request
            .uri()
            .path_and_query()
            .cloned()
            .unwrap_or_else(|| hyper::http::uri::PathAndQuery::from_static("/"));
        let backend_uri = match Uri::builder()
            .scheme("http")
            .authority(backend_authority.as_str())
            .path_and_query(path_and_query)
            .build()
        {
            Ok(uri) => uri,
            Err(_) => return backend_proxy_failed(),
        };

        *request.uri_mut() = backend_uri;
        let backend_host =
            match hyper::header::HeaderValue::from_bytes(backend_authority.as_bytes()) {
                Ok(host) => host,
                Err(_) => return backend_proxy_failed(),
            };
        request.headers_mut().insert(HOST, backend_host);
        if !self.state.backend_lease_is_current(backend_lease).await {
            return backend_unavailable();
        }

        let (parts, body) = request.into_parts();
        let (upload_completion, mut upload_completed) = oneshot::channel();
        let request =
            Request::from_parts(parts, UploadCompletionBody::new(body, upload_completion));
        let backend_request = client.request(request);
        tokio::pin!(backend_request);
        let response = match tokio::select! {
            response = &mut backend_request => response,
            _ = &mut upload_completed => {
                match tokio::time::timeout(
                    self.limits.backend_response_header_timeout,
                    &mut backend_request,
                )
                .await
                {
                    Ok(response) => response,
                    Err(_) => return backend_proxy_failed(),
                }
            }
        } {
            Ok(response) => response,
            Err(_) => return backend_proxy_failed(),
        };
        let (mut parts, body) = response.into_parts();
        if normalize_message_framing(&mut parts.headers).is_err()
            || strip_hop_by_hop_headers(&mut parts.headers).is_err()
        {
            return backend_proxy_failed();
        }
        strip_backend_session_cookie(&mut parts.headers);
        let body = body.map_err(io::Error::other).boxed();
        Response::from_parts(parts, body)
    }

    async fn forward_websocket(
        &self,
        mut request: Request<hyper::body::Incoming>,
        handshake: ValidatedWebSocketHandshake,
    ) -> Response<GatewayBody> {
        let Some(tunnel_permit) = self.tunnels.try_acquire() else {
            return backend_unavailable();
        };
        let public_upgrade = hyper::upgrade::on(&mut request);
        strip_gateway_session_cookie(request.headers_mut());
        if normalize_message_framing(request.headers_mut()).is_err()
            || strip_hop_by_hop_headers(request.headers_mut()).is_err()
        {
            return invalid_http_message();
        }
        request.headers_mut().remove("sec-websocket-extensions");
        restore_websocket_upgrade_headers(request.headers_mut());

        let backend_lease = match self
            .state
            .wait_for_backend_lease_with_timeout(self.limits.backend_wait)
            .await
        {
            Ok(backend_lease) => backend_lease,
            Err(_) => return backend_unavailable(),
        };
        let Some(client) = self.client_for_generation(backend_lease).await else {
            return backend_unavailable();
        };
        let backend_authority = backend_lease.address.to_string();
        let path_and_query = request
            .uri()
            .path_and_query()
            .cloned()
            .expect("validated Socket.IO target must have path and query");
        let backend_uri = match Uri::builder()
            .scheme("http")
            .authority(backend_authority.as_str())
            .path_and_query(path_and_query)
            .build()
        {
            Ok(uri) => uri,
            Err(_) => return backend_proxy_failed(),
        };
        *request.uri_mut() = backend_uri;
        let backend_host =
            match hyper::header::HeaderValue::from_bytes(backend_authority.as_bytes()) {
                Ok(host) => host,
                Err(_) => return backend_proxy_failed(),
            };
        request.headers_mut().insert(HOST, backend_host);
        if !self.state.backend_lease_is_current(backend_lease).await {
            return backend_unavailable();
        }

        let (parts, body) = request.into_parts();
        let (upload_completion, _upload_completed) = oneshot::channel();
        let request =
            Request::from_parts(parts, UploadCompletionBody::new(body, upload_completion));
        let mut response = match tokio::time::timeout(
            self.limits.backend_response_header_timeout,
            client.request(request),
        )
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(_)) | Err(_) => return backend_proxy_failed(),
        };
        if response.status() != StatusCode::SWITCHING_PROTOCOLS
            || validate_websocket_upgrade_response(&mut response, &handshake).is_err()
            || !self.state.backend_lease_is_current(backend_lease).await
        {
            return backend_proxy_failed();
        }
        let backend_upgrade = hyper::upgrade::on(&mut response);
        let (mut parts, _body) = response.into_parts();
        if normalize_message_framing(&mut parts.headers).is_err()
            || strip_hop_by_hop_headers(&mut parts.headers).is_err()
        {
            return backend_proxy_failed();
        }
        strip_backend_session_cookie(&mut parts.headers);
        restore_websocket_upgrade_headers(&mut parts.headers);

        let tunnel = run_websocket_tunnel(
            public_upgrade,
            backend_upgrade,
            self.state.clone(),
            backend_lease,
            self.rpc_milestones.clone(),
            self.limits.websocket_upgrade_timeout,
            tunnel_permit,
        );
        if !self.tunnels.spawn(tunnel).await {
            return backend_unavailable();
        }
        Response::from_parts(parts, empty_body())
    }
}

impl StaticGatewayService {
    async fn handle(&self, request: Request<hyper::body::Incoming>) -> Response<GatewayBody> {
        if !self.has_valid_request_envelope(&request) {
            return not_found();
        }
        let raw_path = request.uri().path();
        let route = match self.routes.classify(raw_path) {
            Ok(route) => route,
            Err(_) => return not_found(),
        };

        if route == RouteKind::Bootstrap {
            return self.bootstrap(request).await;
        }
        if !self.has_valid_session(request.headers()) {
            return not_found();
        }
        if route != RouteKind::Backend && request_attempts_upgrade(request.headers()) {
            return not_found();
        }
        match route {
            RouteKind::Static => self.static_asset(request).await,
            RouteKind::Backend => self.backend_proxy.forward(request).await,
            RouteKind::Bootstrap | RouteKind::Control => not_found(),
        }
    }

    fn has_valid_request_envelope(&self, request: &Request<hyper::body::Incoming>) -> bool {
        if request.uri().scheme().is_some() || request.uri().authority().is_some() {
            return false;
        }
        let mut hosts = request.headers().get_all(HOST).iter();
        let Some(host) = hosts.next() else {
            return false;
        };
        if hosts.next().is_some()
            || host.to_str().ok() != Some(self.public_authority.as_str())
            || request.headers().contains_key("forwarded")
            || request.headers().contains_key("x-forwarded-host")
        {
            return false;
        }

        let mut origins = request.headers().get_all(ORIGIN).iter();
        if let Some(origin) = origins.next() {
            if origins.next().is_some() || origin.to_str().ok() != Some(self.public_origin.as_str())
            {
                return false;
            }
        }
        true
    }

    async fn bootstrap(&self, request: Request<hyper::body::Incoming>) -> Response<GatewayBody> {
        if request.method() != Method::GET
            || request.uri().query().is_some()
            || request.uri().path() != self.session.bootstrap_path
        {
            return not_found();
        }
        let mut capability = self.session.bootstrap_capability.lock().await;
        if capability.as_deref() != Some(self.bootstrap_capability_from_path()) {
            return not_found();
        }
        capability.take();
        Response::builder()
            .status(StatusCode::SEE_OTHER)
            .header(LOCATION, "/")
            .header(CACHE_CONTROL, "no-store")
            .header(
                SET_COOKIE,
                format!(
                    "{SESSION_COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict",
                    self.session.session_value
                ),
            )
            .body(empty_body())
            .expect("fixed bootstrap response must be valid")
    }

    fn bootstrap_capability_from_path(&self) -> &str {
        self.session
            .bootstrap_path
            .strip_prefix("/_ride/bootstrap/")
            .expect("bootstrap path prefix is fixed")
    }

    fn has_valid_session(&self, headers: &hyper::HeaderMap) -> bool {
        let mut matches = 0;
        for header in headers.get_all(COOKIE).iter() {
            let Ok(header) = header.to_str() else {
                return false;
            };
            for pair in header.split(';') {
                let Some((name, value)) = pair.trim().split_once('=') else {
                    continue;
                };
                if name == SESSION_COOKIE_NAME {
                    if value != self.session.session_value {
                        return false;
                    }
                    matches += 1;
                }
            }
        }
        matches == 1
    }

    async fn static_asset(&self, request: Request<hyper::body::Incoming>) -> Response<GatewayBody> {
        if !matches!(*request.method(), Method::GET | Method::HEAD) {
            return not_found();
        }
        let Ok(path) = NormalizedPath::parse(request.uri().path()) else {
            return not_found();
        };
        let Some(asset) = self.assets.get(&path) else {
            return not_found();
        };
        let asset = asset.clone();
        let frontend_root = self.frontend_root.clone();
        let opened = tokio::task::spawn_blocking(move || {
            reopen_bound_static_file(frontend_root.as_ref(), &asset).map(|file| (file, asset))
        })
        .await;
        let (file, asset) = match opened {
            Ok(Ok(opened)) => opened,
            Ok(Err(_)) => return not_found(),
            Err(_) => {
                log::warn!("Startup gateway asset validation task failed.");
                return not_found();
            }
        };
        let response = Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, asset.content_type)
            .header(CONTENT_LENGTH, asset.binding.content_length)
            .header(CACHE_CONTROL, asset.cache_control)
            .header("x-content-type-options", "nosniff");

        if request.method() == Method::HEAD {
            drop(file);
            return response
                .body(empty_body())
                .expect("fixed static HEAD response must be valid");
        }
        let file = File::from_std(file);
        response
            .body(stream_static_file(file, asset.binding.content_length))
            .expect("fixed static response must be valid")
    }
}

fn request_attempts_upgrade(headers: &HeaderMap) -> bool {
    if headers.contains_key(UPGRADE) {
        return true;
    }
    connection_header_tokens(headers)
        .map(|tokens| tokens.iter().any(|name| name == UPGRADE))
        .unwrap_or(true)
}

fn build_static_inventory(frontend_root: &Path) -> Result<StaticInventory, GatewayError> {
    let canonical_root =
        std_fs::canonicalize(frontend_root).map_err(|_| GatewayError::FrontendUnavailable)?;
    let root_metadata =
        std_fs::metadata(&canonical_root).map_err(|_| GatewayError::FrontendUnavailable)?;
    if !root_metadata.is_dir() {
        return Err(GatewayError::FrontendUnavailable);
    }
    let root_identity = secure_static_root_identity(&canonical_root)
        .map_err(|_| GatewayError::FrontendUnavailable)?;

    let mut assets = HashMap::new();
    let mut directories = vec![canonical_root.clone()];
    while let Some(directory) = directories.pop() {
        let entries =
            std_fs::read_dir(&directory).map_err(|_| GatewayError::FrontendUnavailable)?;
        for entry in entries {
            let entry = entry.map_err(|_| GatewayError::FrontendUnavailable)?;
            let path = entry.path();
            let metadata =
                std_fs::symlink_metadata(&path).map_err(|_| GatewayError::FrontendUnavailable)?;
            let file_type = metadata.file_type();
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                directories.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let Some(content_type) = fixed_content_type(&path) else {
                continue;
            };
            let canonical_path =
                std_fs::canonicalize(&path).map_err(|_| GatewayError::FrontendUnavailable)?;
            if !canonical_path.starts_with(&canonical_root) {
                continue;
            }
            let canonical_metadata =
                std_fs::metadata(&canonical_path).map_err(|_| GatewayError::FrontendUnavailable)?;
            if !canonical_metadata.is_file() {
                continue;
            }
            let relative = canonical_path
                .strip_prefix(&canonical_root)
                .map_err(|_| GatewayError::FrontendUnavailable)?;
            let relative_components = relative_path_components(relative)?;
            let binding =
                capture_bound_static_file(&canonical_root, &relative_components, root_identity)
                    .map_err(|_| GatewayError::FrontendUnavailable)?;
            let url_path = path_to_url_path(relative)?;
            let normalized =
                NormalizedPath::parse(&url_path).map_err(|_| GatewayError::FrontendUnavailable)?;
            let cache_control = if relative == Path::new("index.html") {
                "no-store"
            } else {
                "no-cache"
            };
            assets.insert(
                normalized,
                StaticAsset {
                    relative_components,
                    binding,
                    content_type,
                    cache_control,
                },
            );
        }
    }

    let index = assets
        .get(&NormalizedPath(INDEX_PATH.to_string()))
        .cloned()
        .ok_or(GatewayError::FrontendUnavailable)?;
    assets.insert(NormalizedPath("/".to_string()), index);
    Ok(StaticInventory {
        canonical_root,
        assets,
    })
}

fn relative_path_components(relative: &Path) -> Result<Vec<OsString>, GatewayError> {
    let components = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(value) => Ok(value.to_os_string()),
            _ => Err(GatewayError::FrontendUnavailable),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        Err(GatewayError::FrontendUnavailable)
    } else {
        Ok(components)
    }
}

struct OpenedStaticFile {
    file: std_fs::File,
    root_identity: StaticFileIdentity,
    parent_identities: Vec<StaticFileIdentity>,
    file_identity: StaticFileIdentity,
    content_length: u64,
}

fn capture_bound_static_file(
    root: &Path,
    relative_components: &[OsString],
    expected_root_identity: StaticFileIdentity,
) -> io::Result<BoundStaticFile> {
    let opened = platform_open_static_file(root, relative_components)?;
    if opened.root_identity != expected_root_identity {
        return Err(static_asset_changed());
    }
    Ok(BoundStaticFile {
        root_identity: opened.root_identity,
        parent_identities: opened.parent_identities,
        file_identity: opened.file_identity,
        content_length: opened.content_length,
    })
}

fn reopen_bound_static_file(root: &Path, asset: &StaticAsset) -> io::Result<std_fs::File> {
    let opened = platform_open_static_file(root, &asset.relative_components)?;
    if opened.root_identity != asset.binding.root_identity
        || opened.parent_identities != asset.binding.parent_identities
        || opened.file_identity != asset.binding.file_identity
        || opened.content_length != asset.binding.content_length
    {
        return Err(static_asset_changed());
    }
    Ok(opened.file)
}

fn static_asset_changed() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "static asset identity changed",
    )
}

#[cfg(unix)]
fn secure_static_root_identity(root: &Path) -> io::Result<StaticFileIdentity> {
    let directory = unix_open_directory_path(root)?;
    let facts = unix_file_facts(&directory)?;
    if !facts.is_directory {
        return Err(static_asset_changed());
    }
    unix_file_identity(&directory)
}

#[cfg(unix)]
fn platform_open_static_file(
    root: &Path,
    relative_components: &[OsString],
) -> io::Result<OpenedStaticFile> {
    use std::os::fd::AsRawFd;

    let (parents, file_name) = relative_components.split_at(
        relative_components
            .len()
            .checked_sub(1)
            .ok_or_else(static_asset_changed)?,
    );
    let mut directory = unix_open_directory_path(root)?;
    let root_facts = unix_file_facts(&directory)?;
    if !root_facts.is_directory {
        return Err(static_asset_changed());
    }
    let root_identity = unix_file_identity(&directory)?;
    let mut parent_identities = Vec::with_capacity(parents.len());
    for component in parents {
        directory = unix_open_at(
            directory.as_raw_fd(),
            component,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )?;
        let facts = unix_file_facts(&directory)?;
        if !facts.is_directory {
            return Err(static_asset_changed());
        }
        parent_identities.push(unix_file_identity(&directory)?);
    }
    let file = unix_open_at(
        directory.as_raw_fd(),
        &file_name[0],
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
    )?;
    let facts = unix_file_facts(&file)?;
    if !facts.is_file {
        return Err(static_asset_changed());
    }
    let file_identity = unix_file_identity(&file)?;
    Ok(OpenedStaticFile {
        file,
        root_identity,
        parent_identities,
        file_identity,
        content_length: facts.length,
    })
}

#[cfg(unix)]
fn unix_open_directory_path(path: &Path) -> io::Result<std_fs::File> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid static root"))?;
    let descriptor = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { std_fs::File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
fn unix_open_at(
    directory: std::os::fd::RawFd,
    name: &OsStr,
    flags: i32,
) -> io::Result<std_fs::File> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid static path"))?;
    let descriptor = unsafe { libc::openat(directory, name.as_ptr(), flags) };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { std_fs::File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
struct StaticFileFacts {
    is_file: bool,
    is_directory: bool,
    length: u64,
}

#[cfg(unix)]
fn unix_file_facts(file: &std_fs::File) -> io::Result<StaticFileFacts> {
    use std::os::fd::AsRawFd;

    let mut status = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(file.as_raw_fd(), status.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let status = unsafe { status.assume_init() };
    let kind = status.st_mode & libc::S_IFMT;
    Ok(StaticFileFacts {
        is_file: kind == libc::S_IFREG,
        is_directory: kind == libc::S_IFDIR,
        length: status.st_size.try_into().unwrap_or(u64::MAX),
    })
}

#[cfg(unix)]
fn unix_file_identity(file: &std_fs::File) -> io::Result<StaticFileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    let mut identity = [0_u8; 16];
    identity[..8].copy_from_slice(&metadata.ino().to_le_bytes());
    Ok(StaticFileIdentity {
        volume: metadata.dev(),
        file: identity,
    })
}

#[cfg(windows)]
fn secure_static_root_identity(root: &Path) -> io::Result<StaticFileIdentity> {
    let directory = windows_open_directory_no_follow(root)?;
    let facts = windows_file_facts(&directory)?;
    if !facts.is_directory || facts.is_reparse_point {
        return Err(static_asset_changed());
    }
    windows_file_identity(&directory)
}

#[cfg(windows)]
fn platform_open_static_file(
    root: &Path,
    relative_components: &[OsString],
) -> io::Result<OpenedStaticFile> {
    let (parents, file_name) = relative_components.split_at(
        relative_components
            .len()
            .checked_sub(1)
            .ok_or_else(static_asset_changed)?,
    );
    let root_directory = windows_open_directory_no_follow(root)?;
    let root_facts = windows_file_facts(&root_directory)?;
    if !root_facts.is_directory || root_facts.is_reparse_point {
        return Err(static_asset_changed());
    }
    let root_identity = windows_file_identity(&root_directory)?;
    let mut held_directories = vec![root_directory];
    let mut parent_identities = Vec::with_capacity(parents.len());
    let mut current_path = root.to_path_buf();
    for component in parents {
        current_path.push(component);
        let directory = windows_open_directory_no_follow(&current_path)?;
        let facts = windows_file_facts(&directory)?;
        if !facts.is_directory || facts.is_reparse_point {
            return Err(static_asset_changed());
        }
        parent_identities.push(windows_file_identity(&directory)?);
        held_directories.push(directory);
    }
    current_path.push(&file_name[0]);
    let file = windows_open_regular_file_no_follow(&current_path)?;
    let facts = windows_file_facts(&file)?;
    if !facts.is_file || facts.is_reparse_point {
        return Err(static_asset_changed());
    }
    let file_identity = windows_file_identity(&file)?;
    drop(held_directories);
    Ok(OpenedStaticFile {
        file,
        root_identity,
        parent_identities,
        file_identity,
        content_length: facts.length,
    })
}

#[cfg(windows)]
fn windows_open_directory_no_follow(path: &Path) -> io::Result<std_fs::File> {
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    windows_open_file(
        path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
    )
}

#[cfg(windows)]
fn windows_open_regular_file_no_follow(path: &Path) -> io::Result<std_fs::File> {
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, OPEN_EXISTING,
    };

    windows_open_file(
        path,
        GENERIC_READ,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
    )
}

#[cfg(windows)]
fn windows_open_file(
    path: &Path,
    access: u32,
    sharing: u32,
    creation: u32,
    flags: u32,
) -> io::Result<std_fs::File> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::CreateFileW;

    let path = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            path.as_ptr(),
            access,
            sharing,
            std::ptr::null(),
            creation,
            flags,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { std_fs::File::from_raw_handle(handle) })
    }
}

#[cfg(windows)]
struct StaticFileFacts {
    is_file: bool,
    is_directory: bool,
    is_reparse_point: bool,
    length: u64,
}

#[cfg(windows)]
fn windows_file_facts(file: &std_fs::File) -> io::Result<StaticFileFacts> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, FileStandardInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO, FILE_STANDARD_INFO,
    };

    let mut basic = FILE_BASIC_INFO::default();
    let mut standard = FILE_STANDARD_INFO::default();
    let basic_ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    let standard_ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStandardInfo,
            (&mut standard as *mut FILE_STANDARD_INFO).cast(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if basic_ok == 0 || standard_ok == 0 {
        return Err(io::Error::last_os_error());
    }
    let is_directory = basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    Ok(StaticFileFacts {
        is_file: !is_directory,
        is_directory,
        is_reparse_point: basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        length: standard.EndOfFile.try_into().unwrap_or(u64::MAX),
    })
}

#[cfg(windows)]
fn windows_file_identity(file: &std_fs::File) -> io::Result<StaticFileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };

    let mut identity = FILE_ID_INFO::default();
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            (&mut identity as *mut FILE_ID_INFO).cast(),
            std::mem::size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(StaticFileIdentity {
            volume: identity.VolumeSerialNumber,
            file: identity.FileId.Identifier,
        })
    }
}

fn path_to_url_path(relative: &Path) -> Result<String, GatewayError> {
    let mut result = String::new();
    for component in relative.components() {
        let std::path::Component::Normal(component) = component else {
            return Err(GatewayError::FrontendUnavailable);
        };
        let component = component
            .to_str()
            .ok_or(GatewayError::FrontendUnavailable)?;
        result.push('/');
        result.push_str(component);
    }
    if result.is_empty() {
        Err(GatewayError::FrontendUnavailable)
    } else {
        Ok(result)
    }
}

fn fixed_content_type(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "html" => Some("text/html; charset=utf-8"),
        "js" => Some("text/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "json" | "map" => Some("application/json; charset=utf-8"),
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "ico" => Some("image/x-icon"),
        "woff" => Some("font/woff"),
        "woff2" => Some("font/woff2"),
        _ => None,
    }
}

#[derive(Clone, Debug)]
enum ProxyRequestKind {
    Http,
    WebSocket(ValidatedWebSocketHandshake),
}

#[derive(Clone, Debug)]
struct ValidatedWebSocketHandshake {
    expected_accept: hyper::header::HeaderValue,
    offered_protocols: Vec<Vec<u8>>,
}

fn proxy_request_kind(
    request: &Request<Incoming>,
    public_origin: &str,
) -> Result<ProxyRequestKind, ProxyHeaderError> {
    let connection_tokens = connection_header_tokens(request.headers())?;
    let requests_upgrade = connection_tokens.iter().any(|name| name == UPGRADE);
    if !requests_upgrade {
        let websocket_intent = request
            .headers()
            .get_all(UPGRADE)
            .iter()
            .any(|value| trim_ows(value.as_bytes()).eq_ignore_ascii_case(b"websocket"))
            || request.headers().contains_key("sec-websocket-key")
            || request.headers().contains_key("sec-websocket-version");
        if websocket_intent {
            return Err(ProxyHeaderError::InvalidUpgrade);
        }
        return Ok(ProxyRequestKind::Http);
    }
    if connection_tokens
        .iter()
        .any(is_protected_websocket_handshake_header)
    {
        return Err(ProxyHeaderError::InvalidUpgrade);
    }
    let client_key = validated_websocket_key(request.headers());
    let offered_protocols = validated_websocket_protocol_offers(request.headers())?;
    if request.method() != Method::GET
        || request.version() != hyper::Version::HTTP_11
        || request.uri().path() != SOCKET_IO_PATH
        || request.uri().query() != Some(SOCKET_IO_WEBSOCKET_QUERY)
        || request.headers().contains_key(CONTENT_LENGTH)
        || request.headers().contains_key(TRANSFER_ENCODING)
        || !request.body().is_end_stream()
        || !single_header_equals(request.headers(), UPGRADE, b"websocket")
        || !single_header_equals(request.headers(), ORIGIN, public_origin.as_bytes())
        || !single_header_equals(request.headers(), "sec-websocket-version", b"13")
        || client_key.is_none()
    {
        return Err(ProxyHeaderError::InvalidUpgrade);
    }
    Ok(ProxyRequestKind::WebSocket(ValidatedWebSocketHandshake {
        expected_accept: websocket_accept(client_key.expect("validated above")),
        offered_protocols,
    }))
}

fn is_protected_websocket_handshake_header(name: &hyper::header::HeaderName) -> bool {
    name == HOST || name == ORIGIN || name == COOKIE || name.as_str().starts_with("sec-websocket-")
}

fn validate_websocket_upgrade_response<B>(
    response: &mut Response<B>,
    handshake: &ValidatedWebSocketHandshake,
) -> Result<(), ProxyHeaderError> {
    let connection_tokens = connection_header_tokens(response.headers())?;
    if connection_tokens
        .iter()
        .any(is_protected_websocket_response_header)
        || !connection_tokens.iter().any(|name| name == UPGRADE)
        || !single_header_equals(response.headers(), UPGRADE, b"websocket")
        || !single_header_exactly_equals(
            response.headers(),
            "sec-websocket-accept",
            &handshake.expected_accept,
        )
        || response.headers().contains_key("sec-websocket-extensions")
    {
        return Err(ProxyHeaderError::InvalidUpgrade);
    }
    validate_backend_websocket_protocol(response.headers_mut(), &handshake.offered_protocols)
}

fn is_protected_websocket_response_header(name: &hyper::header::HeaderName) -> bool {
    name == HOST
        || name == ORIGIN
        || name == COOKIE
        || name == SET_COOKIE
        || name.as_str().starts_with("sec-websocket-")
}

fn single_header_equals(
    headers: &HeaderMap,
    name: impl hyper::header::AsHeaderName,
    expected: &[u8],
) -> bool {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return false;
    };
    values.next().is_none() && trim_ows(value.as_bytes()).eq_ignore_ascii_case(expected)
}

fn single_header_exactly_equals(
    headers: &HeaderMap,
    name: impl hyper::header::AsHeaderName,
    expected: &hyper::header::HeaderValue,
) -> bool {
    let mut values = headers.get_all(name).iter();
    let Some(value) = values.next() else {
        return false;
    };
    values.next().is_none() && value.as_bytes() == expected.as_bytes()
}

fn validated_websocket_key(headers: &HeaderMap) -> Option<&[u8]> {
    let mut values = headers.get_all("sec-websocket-key").iter();
    let value = values.next()?;
    let value = trim_ows(value.as_bytes());
    if values.next().is_some()
        || value.len() != 24
        || !value[..22]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        || &value[22..] != b"=="
    {
        return None;
    }
    let decoded = BASE64_STANDARD.decode(value).ok()?;
    (decoded.len() == 16 && BASE64_STANDARD.encode(decoded).as_bytes() == value).then_some(value)
}

fn validated_websocket_protocol_offers(
    headers: &HeaderMap,
) -> Result<Vec<Vec<u8>>, ProxyHeaderError> {
    let mut protocols = Vec::new();
    for value in headers.get_all("sec-websocket-protocol").iter() {
        for protocol in value.as_bytes().split(|byte| *byte == b',') {
            let protocol = trim_ows(protocol);
            if protocol.is_empty()
                || !protocol.iter().copied().all(is_tchar)
                || protocols
                    .iter()
                    .any(|offered: &Vec<u8>| offered.as_slice() == protocol)
            {
                return Err(ProxyHeaderError::InvalidUpgrade);
            }
            protocols.push(protocol.to_vec());
        }
    }
    Ok(protocols)
}

fn validate_backend_websocket_protocol(
    headers: &mut HeaderMap,
    offered_protocols: &[Vec<u8>],
) -> Result<(), ProxyHeaderError> {
    let values = headers
        .get_all("sec-websocket-protocol")
        .iter()
        .map(|value| value.as_bytes().to_vec())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Ok(());
    }
    if values.len() != 1 {
        return Err(ProxyHeaderError::InvalidUpgrade);
    }
    let selected = trim_ows(&values[0]);
    if selected.is_empty()
        || !selected.iter().copied().all(is_tchar)
        || !offered_protocols
            .iter()
            .any(|offered| offered.as_slice() == selected)
    {
        return Err(ProxyHeaderError::InvalidUpgrade);
    }
    let selected = hyper::header::HeaderValue::from_bytes(selected)
        .map_err(|_| ProxyHeaderError::InvalidUpgrade)?;
    headers.insert("sec-websocket-protocol", selected);
    Ok(())
}

fn websocket_accept(client_key: &[u8]) -> hyper::header::HeaderValue {
    let mut digest = Sha1::new();
    digest.update(client_key);
    digest.update(WEBSOCKET_GUID);
    let encoded = BASE64_STANDARD.encode(digest.finalize());
    hyper::header::HeaderValue::from_bytes(encoded.as_bytes())
        .expect("base64 SHA-1 output is always a valid visible ASCII header")
}

fn restore_websocket_upgrade_headers(headers: &mut HeaderMap) {
    headers.insert(
        CONNECTION,
        hyper::header::HeaderValue::from_static("upgrade"),
    );
    headers.insert(
        UPGRADE,
        hyper::header::HeaderValue::from_static("websocket"),
    );
}

async fn run_websocket_tunnel(
    public_upgrade: hyper::upgrade::OnUpgrade,
    backend_upgrade: hyper::upgrade::OnUpgrade,
    state: GatewayState,
    lease: BackendLease,
    rpc_milestones: RpcMilestoneRecorder,
    upgrade_timeout: Duration,
    _tunnel_permit: OwnedSemaphorePermit,
) {
    let mut readiness = state.inner.readiness.subscribe();
    let mut shutdown = state.inner.shutdown.subscribe();
    if !published_backend_matches_lease(&readiness.borrow(), lease) || *shutdown.borrow() {
        return;
    }
    let upgrades =
        establish_websocket_upgrade_pair(public_upgrade, backend_upgrade, upgrade_timeout);
    tokio::pin!(upgrades);
    let (public, private) = loop {
        tokio::select! {
            result = &mut upgrades => {
                let Some(upgrades) = result else {
                    return;
                };
                break upgrades;
            }
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
            changed = readiness.changed() => {
                if changed.is_err() || !published_backend_matches_lease(&readiness.borrow(), lease) {
                    return;
                }
            }
        }
    };
    if !state.backend_lease_is_current(lease).await {
        return;
    }
    rpc_milestones.record_connected(lease.generation).await;

    let eof = Arc::new(Notify::new());
    let mut public = TunnelIo::new(TokioIo::new(public), eof.clone());
    let mut private = TunnelIo::new(TokioIo::new(private), eof.clone());
    let tunnel = copy_bidirectional(&mut public, &mut private);
    let either_side_closed = eof.notified();
    tokio::pin!(tunnel);
    tokio::pin!(either_side_closed);
    loop {
        tokio::select! {
            _ = &mut tunnel => return,
            _ = &mut either_side_closed => return,
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    return;
                }
            }
            changed = readiness.changed() => {
                if changed.is_err() || !published_backend_matches_lease(&readiness.borrow(), lease) {
                    return;
                }
            }
        }
    }
}

async fn establish_websocket_upgrade_pair<PublicFuture, BackendFuture, Public, Backend, Error>(
    public_upgrade: PublicFuture,
    backend_upgrade: BackendFuture,
    timeout: Duration,
) -> Option<(Public, Backend)>
where
    PublicFuture: Future<Output = Result<Public, Error>>,
    BackendFuture: Future<Output = Result<Backend, Error>>,
{
    tokio::time::timeout(timeout, async move {
        tokio::try_join!(public_upgrade, backend_upgrade).ok()
    })
    .await
    .ok()
    .flatten()
}

struct TunnelIo<T> {
    inner: T,
    eof: Arc<Notify>,
}

impl<T> TunnelIo<T> {
    fn new(inner: T, eof: Arc<Notify>) -> Self {
        Self { inner, eof }
    }
}

impl<T> AsyncRead for TunnelIo<T>
where
    T: AsyncRead + Unpin,
{
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let filled_before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(context, buffer);
        if matches!(result, Poll::Ready(Ok(()))) && buffer.filled().len() == filled_before {
            self.eof.notify_one();
        }
        result
    }
}

impl<T> AsyncWrite for TunnelIo<T>
where
    T: AsyncWrite + Unpin,
{
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(context, buffer)
    }

    fn poll_flush(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(context)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(context)
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffers: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write_vectored(context, buffers)
    }
}

fn published_backend_matches_lease(published: &PublishedBackend, lease: BackendLease) -> bool {
    published.snapshot.generation == lease.generation
        && published.snapshot.phase == BackendPhase::Ready
        && published.backend_addr == Some(lease.address)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProxyHeaderError {
    InvalidFraming,
    InvalidConnection,
    InvalidUpgrade,
}

fn normalize_message_framing(headers: &mut HeaderMap) -> Result<(), ProxyHeaderError> {
    let content_length = validated_content_length(headers)?;
    let has_transfer_encoding = validate_plain_chunked_transfer_encoding(headers)?;
    if content_length.is_some() && has_transfer_encoding {
        return Err(ProxyHeaderError::InvalidFraming);
    }
    headers.remove(CONTENT_LENGTH);
    headers.remove(TRANSFER_ENCODING);
    Ok(())
}

fn validated_content_length(headers: &HeaderMap) -> Result<Option<u64>, ProxyHeaderError> {
    let mut parsed = None;
    for value in headers.get_all(CONTENT_LENGTH).iter() {
        for candidate in value.as_bytes().split(|byte| *byte == b',') {
            let candidate = trim_ows(candidate);
            if candidate.is_empty() {
                return Err(ProxyHeaderError::InvalidFraming);
            }
            let mut length = 0_u64;
            for byte in candidate {
                if !byte.is_ascii_digit() {
                    return Err(ProxyHeaderError::InvalidFraming);
                }
                length = length
                    .checked_mul(10)
                    .and_then(|current| current.checked_add(u64::from(*byte - b'0')))
                    .ok_or(ProxyHeaderError::InvalidFraming)?;
            }
            if parsed.is_some_and(|current| current != length) {
                return Err(ProxyHeaderError::InvalidFraming);
            }
            parsed = Some(length);
        }
    }
    Ok(parsed)
}

fn validate_plain_chunked_transfer_encoding(headers: &HeaderMap) -> Result<bool, ProxyHeaderError> {
    let mut count = 0_usize;
    for value in headers.get_all(TRANSFER_ENCODING).iter() {
        for coding in value.as_bytes().split(|byte| *byte == b',') {
            let coding = trim_ows(coding);
            if coding.is_empty() || !coding.eq_ignore_ascii_case(b"chunked") {
                return Err(ProxyHeaderError::InvalidFraming);
            }
            count = count
                .checked_add(1)
                .ok_or(ProxyHeaderError::InvalidFraming)?;
        }
    }
    match count {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(ProxyHeaderError::InvalidFraming),
    }
}

fn trim_ows(mut value: &[u8]) -> &[u8] {
    while value
        .first()
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        value = &value[1..];
    }
    while value
        .last()
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'))
    {
        value = &value[..value.len() - 1];
    }
    value
}

fn strip_hop_by_hop_headers(headers: &mut HeaderMap) -> Result<(), ProxyHeaderError> {
    let nominated = connection_header_tokens(headers)?;
    for name in nominated {
        headers.remove(name);
    }
    for name in HOP_BY_HOP_HEADERS {
        headers.remove(name);
    }
    Ok(())
}

fn connection_header_tokens(
    headers: &HeaderMap,
) -> Result<Vec<hyper::header::HeaderName>, ProxyHeaderError> {
    let mut nominated = Vec::new();
    for value in headers.get_all(CONNECTION).iter() {
        for token in value.as_bytes().split(|byte| *byte == b',') {
            let token = trim_ows(token);
            if token.is_empty() || !token.iter().copied().all(is_tchar) {
                return Err(ProxyHeaderError::InvalidConnection);
            }
            nominated.push(
                hyper::header::HeaderName::from_bytes(token)
                    .map_err(|_| ProxyHeaderError::InvalidConnection)?,
            );
        }
    }
    Ok(nominated)
}

fn is_tchar(byte: u8) -> bool {
    byte.is_ascii_alphanumeric()
        || matches!(
            byte,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

fn strip_gateway_session_cookie(headers: &mut HeaderMap) {
    let original = headers.get_all(COOKIE).iter().cloned().collect::<Vec<_>>();
    headers.remove(COOKIE);
    for value in original {
        let Ok(value) = value.to_str() else {
            continue;
        };
        let preserved = value
            .split(';')
            .map(str::trim)
            .filter(|pair| {
                pair.split_once('=')
                    .is_none_or(|(name, _)| name.trim() != SESSION_COOKIE_NAME)
            })
            .filter(|pair| !pair.is_empty())
            .collect::<Vec<_>>()
            .join("; ");
        if !preserved.is_empty() {
            if let Ok(value) = hyper::header::HeaderValue::from_bytes(preserved.as_bytes()) {
                headers.append(COOKIE, value);
            }
        }
    }
}

fn strip_backend_session_cookie(headers: &mut HeaderMap) {
    let original = headers
        .get_all(SET_COOKIE)
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    headers.remove(SET_COOKIE);
    for value in original {
        let Some(name) = legal_set_cookie_name(value.as_bytes()) else {
            continue;
        };
        if name != SESSION_COOKIE_NAME.as_bytes() {
            headers.append(SET_COOKIE, value);
        }
    }
}

fn legal_set_cookie_name(value: &[u8]) -> Option<&[u8]> {
    if value.iter().any(|byte| !(b' '..=b'~').contains(byte)) {
        return None;
    }
    let cookie_pair = value
        .split(|byte| *byte == b';')
        .next()
        .expect("split always yields the first cookie pair");
    let equals = cookie_pair.iter().position(|byte| *byte == b'=')?;
    let (name, cookie_value) = cookie_pair.split_at(equals);
    let cookie_value = &cookie_value[1..];
    if name.is_empty() || !name.iter().copied().all(is_tchar) {
        return None;
    }
    let cookie_value = if cookie_value.len() >= 2
        && cookie_value.first() == Some(&b'"')
        && cookie_value.last() == Some(&b'"')
    {
        &cookie_value[1..cookie_value.len() - 1]
    } else {
        cookie_value
    };
    if !cookie_value.iter().copied().all(is_cookie_octet) {
        return None;
    }
    Some(name)
}

fn is_cookie_octet(byte: u8) -> bool {
    matches!(byte, 0x21 | 0x23..=0x2b | 0x2d..=0x3a | 0x3c..=0x5b | 0x5d..=0x7e)
}

fn empty_body() -> GatewayBody {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

fn stream_static_file(file: File, content_length: u64) -> GatewayBody {
    let stream = ReaderStream::with_capacity(file.take(content_length), STATIC_ASSET_CHUNK_SIZE)
        .map_ok(Frame::data);
    StreamBody::new(stream).boxed()
}

fn full_body(bytes: &'static [u8]) -> GatewayBody {
    Full::new(Bytes::from_static(bytes))
        .map_err(|never| match never {})
        .boxed()
}

fn not_found() -> Response<GatewayBody> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .header(CONTENT_LENGTH, NOT_FOUND_BODY.len())
        .header(CACHE_CONTROL, "no-store")
        .body(full_body(NOT_FOUND_BODY))
        .expect("fixed not-found response must be valid")
}

fn backend_unavailable() -> Response<GatewayBody> {
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header(CONTENT_TYPE, "application/json")
        .header(CONTENT_LENGTH, BACKEND_UNAVAILABLE_BODY.len())
        .header(CACHE_CONTROL, "no-store")
        .header("retry-after", "1")
        .header("x-content-type-options", "nosniff")
        .body(full_body(BACKEND_UNAVAILABLE_BODY))
        .expect("fixed backend-unavailable response must be valid")
}

fn backend_proxy_failed() -> Response<GatewayBody> {
    Response::builder()
        .status(StatusCode::BAD_GATEWAY)
        .header(CONTENT_TYPE, "application/json")
        .header(CONTENT_LENGTH, BACKEND_PROXY_FAILED_BODY.len())
        .header(CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(full_body(BACKEND_PROXY_FAILED_BODY))
        .expect("fixed backend-proxy-failed response must be valid")
}

fn invalid_http_message() -> Response<GatewayBody> {
    Response::builder()
        .status(StatusCode::BAD_REQUEST)
        .header(CONTENT_TYPE, "application/json")
        .header(CONTENT_LENGTH, INVALID_HTTP_MESSAGE_BODY.len())
        .header(CACHE_CONTROL, "no-store")
        .header("x-content-type-options", "nosniff")
        .body(full_body(INVALID_HTTP_MESSAGE_BODY))
        .expect("fixed invalid-http-message response must be valid")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteKind {
    Bootstrap,
    Control,
    Static,
    Backend,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PathError {
    NotAbsolute,
    QueryOrFragment,
    Backslash,
    Nul,
    MalformedPercentEncoding,
    EncodedSeparator,
    RepeatedSeparator,
    DotSegment,
    DoubleEncoding,
    InvalidUtf8,
}

impl fmt::Display for PathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::NotAbsolute => "route path must be absolute",
            Self::QueryOrFragment => "route path contains a query or fragment",
            Self::Backslash => "route path contains a backslash",
            Self::Nul => "route path contains a NUL byte",
            Self::MalformedPercentEncoding => "route path has malformed percent encoding",
            Self::EncodedSeparator => "route path contains an encoded separator",
            Self::RepeatedSeparator => "route path contains repeated separators",
            Self::DotSegment => "route path contains a dot segment",
            Self::DoubleEncoding => "route path contains ambiguous double encoding",
            Self::InvalidUtf8 => "route path is not valid UTF-8",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for PathError {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct NormalizedPath(String);

impl NormalizedPath {
    fn parse(raw_path: &str) -> Result<Self, PathError> {
        if !raw_path.starts_with('/') {
            return Err(PathError::NotAbsolute);
        }
        if raw_path.contains(['?', '#']) {
            return Err(PathError::QueryOrFragment);
        }
        if raw_path.contains('\\') {
            return Err(PathError::Backslash);
        }
        if raw_path.contains('\0') {
            return Err(PathError::Nul);
        }

        let raw = raw_path.as_bytes();
        let mut decoded = Vec::with_capacity(raw.len());
        let mut index = 0;
        while index < raw.len() {
            if raw[index] != b'%' {
                decoded.push(raw[index]);
                index += 1;
                continue;
            }

            let Some(high) = raw.get(index + 1).and_then(|value| decode_hex(*value)) else {
                return Err(PathError::MalformedPercentEncoding);
            };
            let Some(low) = raw.get(index + 2).and_then(|value| decode_hex(*value)) else {
                return Err(PathError::MalformedPercentEncoding);
            };
            let value = (high << 4) | low;
            match value {
                b'/' | b'\\' => return Err(PathError::EncodedSeparator),
                0 => return Err(PathError::Nul),
                _ => decoded.push(value),
            }
            index += 3;
        }

        let decoded = String::from_utf8(decoded).map_err(|_| PathError::InvalidUtf8)?;
        if decoded.contains(['?', '#']) {
            return Err(PathError::QueryOrFragment);
        }
        if decoded.contains('%') {
            return Err(PathError::DoubleEncoding);
        }
        if decoded.contains("//") {
            return Err(PathError::RepeatedSeparator);
        }
        if decoded
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        {
            return Err(PathError::DotSegment);
        }

        Ok(Self(decoded))
    }
}

fn decode_hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

#[derive(Clone, Debug)]
pub struct RouteTable {
    static_paths: HashSet<NormalizedPath>,
}

impl RouteTable {
    pub fn new<I, P>(static_paths: I) -> Result<Self, PathError>
    where
        I: IntoIterator<Item = P>,
        P: AsRef<str>,
    {
        Ok(Self {
            static_paths: static_paths
                .into_iter()
                .map(|path| NormalizedPath::parse(path.as_ref()))
                .collect::<Result<_, _>>()?,
        })
    }

    pub fn classify(&self, path: &str) -> Result<RouteKind, PathError> {
        let path = NormalizedPath::parse(path)?;
        let normalized = path.0.as_str();
        let kind = if normalized
            .strip_prefix("/_ride/bootstrap/")
            .is_some_and(|capability| !capability.is_empty())
        {
            RouteKind::Bootstrap
        } else if normalized == "/_ride" || normalized.starts_with("/_ride/") {
            RouteKind::Control
        } else if self.static_paths.contains(&path) {
            RouteKind::Static
        } else {
            RouteKind::Backend
        };
        Ok(kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_set_cookie_filter_is_fail_closed_and_order_preserving() {
        let values: &[&[u8]] = &[
            b"theme=dark; Path=/",
            b"ride_session=backend; Path=/",
            b"Ride_Session=case-sensitive; Path=/",
            b"RIDE_SESSION=upper; Secure",
            b"ride_sessionx=similar; HttpOnly",
            b"missing-equals",
            b"bad name=value",
            b"bad\tname=value",
            b"theme=bad\tvalue",
            b"obs-text=\x80",
        ];
        let mut headers = HeaderMap::new();
        for value in values {
            headers.append(
                SET_COOKIE,
                hyper::header::HeaderValue::from_bytes(value).unwrap(),
            );
        }

        strip_backend_session_cookie(&mut headers);

        assert_eq!(
            headers
                .get_all(SET_COOKIE)
                .iter()
                .map(|value| value.as_bytes())
                .collect::<Vec<_>>(),
            vec![
                b"theme=dark; Path=/".as_slice(),
                b"Ride_Session=case-sensitive; Path=/".as_slice(),
                b"RIDE_SESSION=upper; Secure".as_slice(),
                b"ride_sessionx=similar; HttpOnly".as_slice(),
            ]
        );

        for malformed in [
            b"control=\x01".as_slice(),
            b"delete=\x7f".as_slice(),
            b"obs-text=\x80".as_slice(),
            b"bad\tname=value".as_slice(),
            b"missing-equals".as_slice(),
            b"bad name=value".as_slice(),
        ] {
            assert_eq!(legal_set_cookie_name(malformed), None);
        }
        assert_eq!(
            legal_set_cookie_name(b"unrelated=\"legal-value\"; Path=/"),
            Some(b"unrelated".as_slice())
        );
    }

    #[tokio::test]
    async fn join_error_diagnostics_are_static_and_redacted() {
        let panic_task = tokio::spawn(async {
            panic!("secret-capability C:\\sensitive\\frontend");
        });
        let panic_result = panic_task.await;
        assert_eq!(
            join_error_diagnostic(&panic_result),
            Some("Startup gateway connection task panicked.")
        );
        let panic_diagnostic = join_error_diagnostic(&panic_result).unwrap();
        assert!(!panic_diagnostic.contains("secret-capability"));
        assert!(!panic_diagnostic.contains("sensitive"));

        let cancelled_task = tokio::spawn(std::future::pending::<()>());
        cancelled_task.abort();
        let cancelled_result = cancelled_task.await;
        assert_eq!(
            join_error_diagnostic(&cancelled_result),
            Some("Startup gateway connection task was cancelled.")
        );
    }

    #[tokio::test]
    async fn static_asset_body_emits_fixed_size_reader_stream_frames() {
        let path = std::env::temp_dir().join(format!("ride-static-stream-{}", Uuid::new_v4()));
        let expected = vec![0x5a; STATIC_ASSET_CHUNK_SIZE * 2 + 37];
        std_fs::write(&path, &expected).unwrap();
        let file = File::open(&path).await.unwrap();
        let mut body = stream_static_file(file, expected.len() as u64);
        let mut observed = Vec::new();
        let mut frame_lengths = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.unwrap();
            if let Some(data) = frame.data_ref() {
                frame_lengths.push(data.len());
                observed.extend_from_slice(data);
            }
        }
        let _ = std_fs::remove_file(path);

        assert_eq!(
            frame_lengths,
            vec![STATIC_ASSET_CHUNK_SIZE, STATIC_ASSET_CHUNK_SIZE, 37]
        );
        assert_eq!(observed, expected);
    }

    #[tokio::test]
    async fn websocket_upgrade_pair_establishment_is_bounded() {
        let result = establish_websocket_upgrade_pair(
            std::future::pending::<Result<(), ()>>(),
            std::future::ready(Ok::<(), ()>(())),
            Duration::from_millis(10),
        )
        .await;

        assert!(result.is_none());
        assert_eq!(
            establish_websocket_upgrade_pair(
                std::future::ready(Ok::<u8, ()>(1)),
                std::future::ready(Ok::<u8, ()>(2)),
                Duration::from_secs(1),
            )
            .await,
            Some((1, 2))
        );
    }

    #[tokio::test]
    async fn tunnel_registry_shutdown_aborts_tasks_and_releases_permits() {
        let registry = TunnelRegistry::new(1);
        let permit = registry.try_acquire().unwrap();
        let (started_sender, started) = oneshot::channel();
        assert!(
            registry
                .spawn(async move {
                    let _permit = permit;
                    let _ = started_sender.send(());
                    std::future::pending::<()>().await;
                })
                .await
        );
        started.await.unwrap();
        assert_eq!(registry.permits.available_permits(), 0);

        registry.shutdown(Duration::from_millis(10)).await;

        assert!(registry.permits.is_closed());
        assert_eq!(registry.permits.available_permits(), 1);
    }

    #[tokio::test]
    async fn websocket_upgrade_timeout_releases_tunnel_permit() {
        let registry = TunnelRegistry::new(1);
        let permit = registry.try_acquire().unwrap();
        assert!(
            registry
                .spawn(async move {
                    let _permit = permit;
                    let _ = establish_websocket_upgrade_pair(
                        std::future::pending::<Result<(), ()>>(),
                        std::future::ready(Ok::<(), ()>(())),
                        Duration::from_millis(10),
                    )
                    .await;
                })
                .await
        );

        let replacement = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(permit) = registry.try_acquire() {
                    break permit;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("upgrade timeout did not release the tunnel permit");
        drop(replacement);
        registry.shutdown(Duration::from_millis(10)).await;
    }

    #[tokio::test]
    async fn rpc_milestone_generation_tracking_is_monotonic_and_constant_space() {
        #[derive(Debug)]
        struct ZeroClock;

        impl crate::startup_metrics::ElapsedClock for ZeroClock {
            fn elapsed_ms(&self) -> u64 {
                0
            }
        }

        let metrics = StartupMetrics::with_clock(
            None,
            "test",
            "test",
            1,
            crate::startup_metrics::StartupMode::RustGateway,
            Arc::new(ZeroClock),
        );
        let recorder = RpcMilestoneRecorder::new(metrics);
        recorder.record_connected(BackendGeneration(1)).await;
        recorder.record_connected(BackendGeneration(2)).await;
        recorder.record_connected(BackendGeneration(1)).await;

        assert_eq!(
            *recorder.last_recorded_generation.lock().await,
            Some(BackendGeneration(2))
        );
    }
}
