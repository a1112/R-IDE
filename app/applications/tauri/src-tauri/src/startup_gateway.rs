/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use std::collections::HashSet;
use std::fmt;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{watch, Mutex, Semaphore};

const BROWSER_BACKEND_FAILURE: &str = "Backend process failed before becoming ready.";

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
