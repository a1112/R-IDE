/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use crate::startup_metrics::{StartupMetrics, StartupMilestone};
use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::Frame;
use hyper::header::{
    CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, LOCATION, ORIGIN, SET_COOKIE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use reqwest::Url;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::fmt;
use std::fs as std_fs;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::fs::File;
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch, Mutex, Semaphore};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

const BROWSER_BACKEND_FAILURE: &str = "Backend process failed before becoming ready.";
const NOT_FOUND_BODY: &[u8] = b"Not Found";
const INDEX_PATH: &str = "/index.html";
const SESSION_COOKIE_NAME: &str = "ride_session";
const IMMUTABLE_CACHE: &str = "public, max-age=31536000, immutable";
const STATIC_ASSET_CHUNK_SIZE: usize = 16 * 1024;

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

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct BackendGeneration(u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GatewayLimits {
    pub backend_wait: Duration,
    pub max_waiters: usize,
    pub shutdown_drain: Duration,
}

impl GatewayLimits {
    pub fn test_defaults() -> Self {
        Self {
            backend_wait: Duration::from_secs(1),
            max_waiters: 8,
            shutdown_drain: Duration::from_millis(100),
        }
    }
}

impl Default for GatewayLimits {
    fn default() -> Self {
        Self {
            backend_wait: Duration::from_secs(5),
            max_waiters: 64,
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

        *current = PublishedBackend {
            snapshot: GatewaySnapshot {
                generation,
                phase: BackendPhase::Ready,
                diagnostic: None,
            },
            backend_addr: Some(backend_addr),
        };
        self.inner.readiness.send_replace(current.clone());
        Ok(())
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

    pub async fn wait_for_backend(&self) -> Result<SocketAddr, GatewayError> {
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

        tokio::time::timeout(self.inner.limits.backend_wait, wait)
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
    ) -> Option<Result<SocketAddr, GatewayError>> {
        if published.snapshot.generation != expected_generation {
            return Some(Err(GatewayError::BackendGenerationSuperseded {
                expected: expected_generation,
                observed: published.snapshot.generation,
            }));
        }

        match published.snapshot.phase {
            BackendPhase::Ready => Some(Ok(published
                .backend_addr
                .expect("ready backend must publish an address"))),
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

#[derive(Clone, Debug)]
struct StaticAsset {
    canonical_path: PathBuf,
    content_length: u64,
    content_type: &'static str,
    cache_control: &'static str,
}

#[derive(Debug)]
struct GatewaySession {
    bootstrap_capability: Mutex<Option<String>>,
    bootstrap_path: String,
    session_value: String,
}

#[derive(Clone, Debug)]
struct StaticGatewayService {
    public_authority: String,
    public_origin: String,
    routes: RouteTable,
    assets: Arc<HashMap<NormalizedPath, StaticAsset>>,
    session: Arc<GatewaySession>,
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
        let assets = tokio::task::spawn_blocking(move || build_static_inventory(&frontend_root))
            .await
            .map_err(|_| GatewayError::FrontendUnavailable)??;
        let routes = RouteTable {
            static_paths: assets.keys().cloned().collect(),
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
        let service = StaticGatewayService {
            public_authority,
            public_origin,
            routes,
            assets: Arc::new(assets),
            session: Arc::new(GatewaySession {
                bootstrap_capability: Mutex::new(Some(bootstrap_capability.clone())),
                bootstrap_path,
                session_value,
            }),
        };
        let state = GatewayState::new(limits);
        let (shutdown, shutdown_receiver) = watch::channel(false);
        let (accept_ready, ready) = oneshot::channel();
        let accept_state = state.clone();
        let accept_task = tokio::spawn(run_accept_loop(
            listener,
            service,
            accept_state,
            shutdown_receiver,
            limits.shutdown_drain,
            accept_ready,
        ));
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

    pub async fn shutdown(self) {
        self.state.shutdown().await;
        self.shutdown.send_replace(true);
        let mut accept_task = self.accept_task;
        if tokio::time::timeout(self.shutdown_drain, &mut accept_task)
            .await
            .is_err()
        {
            accept_task.abort();
            let _ = accept_task.await;
        }
    }
}

async fn run_accept_loop(
    listener: TcpListener,
    service: StaticGatewayService,
    state: GatewayState,
    mut shutdown: watch::Receiver<bool>,
    shutdown_drain: Duration,
    accept_ready: oneshot::Sender<()>,
) {
    let mut connections = JoinSet::new();
    if accept_ready.send(()).is_err() {
        state.shutdown().await;
        return;
    }

    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
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
                let service = service.clone();
                connections.spawn(async move {
                    serve_connection(stream, service).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
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
            _ = connections.join_next() => {}
        }
    }
}

async fn serve_connection(stream: TcpStream, service: StaticGatewayService) {
    let request_service = service_fn(move |request| {
        let service = service.clone();
        async move { Ok::<_, Infallible>(service.handle(request).await) }
    });
    let _ = http1::Builder::new()
        .serve_connection(TokioIo::new(stream), request_service)
        .await;
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
        if route != RouteKind::Static {
            return not_found();
        }
        self.static_asset(request).await
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
        let response = Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, asset.content_type)
            .header(CONTENT_LENGTH, asset.content_length)
            .header(CACHE_CONTROL, asset.cache_control)
            .header("x-content-type-options", "nosniff");

        if request.method() == Method::HEAD {
            return response
                .body(empty_body())
                .expect("fixed static HEAD response must be valid");
        }
        let Ok(file) = File::open(&asset.canonical_path).await else {
            return not_found();
        };
        response
            .body(stream_static_file(file, asset.content_length))
            .expect("fixed static response must be valid")
    }
}

fn build_static_inventory(
    frontend_root: &Path,
) -> Result<HashMap<NormalizedPath, StaticAsset>, GatewayError> {
    let canonical_root =
        std_fs::canonicalize(frontend_root).map_err(|_| GatewayError::FrontendUnavailable)?;
    let root_metadata =
        std_fs::metadata(&canonical_root).map_err(|_| GatewayError::FrontendUnavailable)?;
    if !root_metadata.is_dir() {
        return Err(GatewayError::FrontendUnavailable);
    }

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
            let url_path = path_to_url_path(relative)?;
            let normalized =
                NormalizedPath::parse(&url_path).map_err(|_| GatewayError::FrontendUnavailable)?;
            let cache_control = if relative == Path::new("index.html") {
                "no-store"
            } else if has_content_hash(relative) {
                IMMUTABLE_CACHE
            } else {
                "no-cache"
            };
            assets.insert(
                normalized,
                StaticAsset {
                    canonical_path,
                    content_length: canonical_metadata.len(),
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
    Ok(assets)
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

fn has_content_hash(path: &Path) -> bool {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .into_iter()
        .flat_map(|stem| stem.split(['.', '-']))
        .any(|segment| segment.len() >= 8 && segment.bytes().all(|byte| byte.is_ascii_hexdigit()))
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
}
