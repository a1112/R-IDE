/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use bytes::Bytes;
use futures_util::poll;
use http_body_util::{BodyExt, Empty};
use hyper::header::{
    CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, LOCATION, SET_COOKIE,
};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use ride_tauri::startup_gateway::{
    BackendAddressError, BackendGeneration, BackendPhase, GatewayError, GatewayLimits,
    GatewayState, PathError, RouteKind, RouteTable, StartupGateway,
};
use ride_tauri::startup_metrics::{
    ElapsedClock, StartupMetrics, StartupMilestone, StartupMode, StartupReport, StartupReportWriter,
};
use std::fs;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use uuid::Uuid;

const EXPECTED_STATIC_ASSET_CHUNK_SIZE: usize = 16 * 1024;

struct TemporaryFrontend {
    root: PathBuf,
}

impl TemporaryFrontend {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ride-startup-gateway-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::write(
            root.join("index.html"),
            b"<!doctype html><title>R-IDE</title>",
        )
        .unwrap();
        fs::write(root.join("bundle.js"), b"globalThis.ride = true;").unwrap();
        fs::write(root.join("bundle.css"), b"body { color: white; }").unwrap();
        fs::write(root.join("chunk.0123456789abcdef.js"), b"export default 1;").unwrap();
        fs::create_dir(root.join("assets")).unwrap();
        Self { root }
    }

    fn write_large_asset(&self, relative: &str, size: usize) -> Vec<u8> {
        let bytes = (0..size)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        fs::write(self.root.join(relative), &bytes).unwrap();
        bytes
    }
}

impl Drop for TemporaryFrontend {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Debug)]
struct ZeroClock;

impl ElapsedClock for ZeroClock {
    fn elapsed_ms(&self) -> u64 {
        0
    }
}

#[derive(Debug)]
struct SettableClock(AtomicU64);

impl ElapsedClock for SettableClock {
    fn elapsed_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

struct ChannelWriter(mpsc::Sender<StartupReport>);

impl StartupReportWriter for ChannelWriter {
    fn write(&mut self, report: &StartupReport) -> io::Result<()> {
        self.0
            .send(report.clone())
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "report receiver closed"))
    }
}

fn disabled_metrics() -> StartupMetrics {
    StartupMetrics::with_clock(
        None,
        "test",
        "test",
        1,
        StartupMode::RustGateway,
        Arc::new(ZeroClock),
    )
}

async fn bind_gateway(frontend: &TemporaryFrontend) -> StartupGateway {
    StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits::test_defaults(),
    )
    .await
    .unwrap()
}

async fn send_request(
    gateway: &StartupGateway,
    method: Method,
    target: &str,
    headers: &[(&str, &str)],
) -> Response<hyper::body::Incoming> {
    let stream = TcpStream::connect(gateway_addr(gateway)).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(async move {
        let _ = connection.await;
    });

    let mut request = Request::builder().method(method).uri(target);
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case(HOST.as_str()))
    {
        request = request.header(HOST, gateway.public_authority());
    }
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    sender
        .send_request(request.body(Empty::<Bytes>::new()).unwrap())
        .await
        .unwrap()
}

fn gateway_addr(gateway: &StartupGateway) -> SocketAddr {
    gateway.public_authority().parse().unwrap()
}

async fn response_bytes(response: Response<hyper::body::Incoming>) -> Bytes {
    response.into_body().collect().await.unwrap().to_bytes()
}

async fn bootstrap_session(gateway: &StartupGateway) -> String {
    let response = send_request(gateway, Method::GET, gateway.bootstrap_url().path(), &[]).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    response
        .headers()
        .get(SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

async fn open_partial_request(gateway: &StartupGateway) -> TcpStream {
    let mut stream = TcpStream::connect(gateway_addr(gateway)).await.unwrap();
    stream
        .write_all(format!("GET / HTTP/1.1\r\nHost: {}\r\n", gateway.public_authority()).as_bytes())
        .await
        .unwrap();
    stream
}

async fn socket_closes_within(mut stream: TcpStream, duration: Duration) -> bool {
    tokio::time::timeout(duration, async move {
        let mut buffer = [0_u8; 256];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
        }
    })
    .await
    .is_ok()
}

async fn raw_anonymous_get(gateway: &StartupGateway) -> Vec<u8> {
    let mut stream = TcpStream::connect(gateway_addr(gateway)).await.unwrap();
    let request = format!(
        "GET / HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
        gateway.public_authority()
    );
    if stream.write_all(request.as_bytes()).await.is_err() {
        return Vec::new();
    }
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_millis(100), async {
        let mut buffer = [0_u8; 512];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => response.extend_from_slice(&buffer[..read]),
            }
        }
    })
    .await;
    response
}

#[cfg(unix)]
fn symlink_file(original: &Path, link: &Path) -> io::Result<()> {
    std::os::unix::fs::symlink(original, link)
}

#[cfg(windows)]
fn symlink_file(original: &Path, link: &Path) -> io::Result<()> {
    std::os::windows::fs::symlink_file(original, link)
}

#[cfg(unix)]
fn link_creation_is_unavailable(error: &io::Error) -> bool {
    matches!(
        error.raw_os_error(),
        Some(code) if matches!(code, libc::EPERM | libc::EOPNOTSUPP | libc::ENOSYS)
    )
}

#[cfg(windows)]
fn link_creation_is_unavailable(error: &io::Error) -> bool {
    use windows_sys::Win32::Foundation::{ERROR_NOT_SUPPORTED, ERROR_PRIVILEGE_NOT_HELD};

    matches!(
        error.raw_os_error(),
        Some(code)
            if code == ERROR_PRIVILEGE_NOT_HELD as i32 || code == ERROR_NOT_SUPPORTED as i32
    )
}

async fn assert_bounded_not_found_for_get_and_head(
    gateway: &StartupGateway,
    cookie: &str,
    path: &str,
) {
    for method in [Method::GET, Method::HEAD] {
        let response =
            send_request(gateway, method.clone(), path, &[(COOKIE.as_str(), cookie)]).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{method} {path}");
        let body = response_bytes(response).await;
        assert!(body.len() <= 32, "{method} {path}");
    }
}

#[tokio::test]
async fn one_time_bootstrap_sets_a_host_only_strict_session_and_redirects_to_root() {
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    assert_eq!(gateway_addr(&gateway).ip(), IpAddr::V4(Ipv4Addr::LOCALHOST));
    assert_ne!(gateway_addr(&gateway).port(), 0);

    let bootstrap_url = gateway.bootstrap_url();
    assert_eq!(bootstrap_url.host_str(), Some("127.0.0.1"));
    assert_eq!(bootstrap_url.port(), Some(gateway_addr(&gateway).port()));
    let capability = bootstrap_url.path_segments().unwrap().next_back().unwrap();
    assert_eq!(Uuid::parse_str(capability).unwrap().get_version_num(), 4);

    let response = send_request(&gateway, Method::GET, bootstrap_url.path(), &[]).await;
    assert_eq!(response.status(), StatusCode::SEE_OTHER);
    assert_eq!(response.headers().get(LOCATION).unwrap(), "/");
    assert_eq!(response.headers().get(CACHE_CONTROL).unwrap(), "no-store");
    assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 1);
    let set_cookie = response
        .headers()
        .get(SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(set_cookie.starts_with("ride_session="));
    assert!(set_cookie.contains("; Path=/"));
    assert!(set_cookie.contains("; HttpOnly"));
    assert!(set_cookie.contains("; SameSite=Strict"));
    assert!(!set_cookie.contains("Domain="));
    assert!(!set_cookie.contains("Secure"));
    assert!(!set_cookie.contains("__Host-"));
    let session = set_cookie
        .split(';')
        .next()
        .unwrap()
        .strip_prefix("ride_session=")
        .unwrap();
    assert_eq!(Uuid::parse_str(session).unwrap().get_version_num(), 4);
    assert_ne!(session, capability);
    assert!(response_bytes(response).await.is_empty());

    let replay = send_request(&gateway, Method::GET, bootstrap_url.path(), &[]).await;
    assert_eq!(replay.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        response_bytes(replay).await,
        Bytes::from_static(b"Not Found")
    );
    gateway.shutdown().await;
}

#[tokio::test]
async fn authenticated_index_and_assets_are_available_before_backend_readiness() {
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;

    let anonymous = send_request(&gateway, Method::GET, "/", &[]).await;
    assert_eq!(anonymous.status(), StatusCode::NOT_FOUND);

    let cookie = bootstrap_session(&gateway).await;
    let index = send_request(&gateway, Method::GET, "/", &[(COOKIE.as_str(), &cookie)]).await;
    assert_eq!(index.status(), StatusCode::OK);
    assert_eq!(
        index.headers().get(CONTENT_TYPE).unwrap(),
        "text/html; charset=utf-8"
    );
    assert_eq!(index.headers().get(CACHE_CONTROL).unwrap(), "no-store");
    let index_length = index.headers().get(CONTENT_LENGTH).unwrap().clone();
    assert_eq!(
        response_bytes(index).await,
        Bytes::from_static(b"<!doctype html><title>R-IDE</title>")
    );

    let head = send_request(&gateway, Method::HEAD, "/", &[(COOKIE.as_str(), &cookie)]).await;
    assert_eq!(head.status(), StatusCode::OK);
    assert_eq!(head.headers().get(CONTENT_LENGTH).unwrap(), index_length);
    assert!(response_bytes(head).await.is_empty());

    let bundle = send_request(
        &gateway,
        Method::GET,
        "/bundle.js",
        &[(COOKIE.as_str(), &cookie)],
    )
    .await;
    assert_eq!(bundle.status(), StatusCode::OK);
    assert_eq!(
        bundle.headers().get(CONTENT_TYPE).unwrap(),
        "text/javascript; charset=utf-8"
    );
    assert_eq!(bundle.headers().get(CACHE_CONTROL).unwrap(), "no-cache");

    let hashed = send_request(
        &gateway,
        Method::GET,
        "/chunk.0123456789abcdef.js",
        &[(COOKIE.as_str(), &cookie)],
    )
    .await;
    assert_eq!(hashed.status(), StatusCode::OK);
    assert_eq!(hashed.headers().get(CACHE_CONTROL).unwrap(), "no-cache");
    gateway.shutdown().await;
}

#[tokio::test]
async fn get_and_head_reject_a_regular_asset_replaced_after_bind() {
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let asset = frontend.root.join("bundle.js");
    fs::rename(&asset, frontend.root.join("bundle.bound.js")).unwrap();
    fs::write(&asset, b"globalThis.replacedWithLongerContent = true;").unwrap();

    assert_bounded_not_found_for_get_and_head(&gateway, &cookie, "/bundle.js").await;
    gateway.shutdown().await;
}

#[tokio::test]
async fn get_and_head_reject_a_final_symlink_installed_after_bind() {
    let frontend = TemporaryFrontend::new();
    let external = frontend.root.with_file_name(format!(
        "ride-startup-gateway-link-target-{}",
        Uuid::new_v4()
    ));
    fs::write(&external, b"body { color: red; }").unwrap();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let asset = frontend.root.join("bundle.css");
    fs::rename(&asset, frontend.root.join("bundle.bound.css")).unwrap();
    if let Err(error) = symlink_file(&external, &asset) {
        gateway.shutdown().await;
        fs::remove_file(&external).unwrap();
        if link_creation_is_unavailable(&error) {
            eprintln!("skipping symlink replacement assertion: platform link creation unavailable");
            return;
        }
        panic!("create replacement symlink: {error}");
    }

    assert_bounded_not_found_for_get_and_head(&gateway, &cookie, "/bundle.css").await;
    gateway.shutdown().await;
    fs::remove_file(external).unwrap();
}

#[tokio::test]
async fn get_and_head_reject_a_replaced_parent_even_for_the_same_file_identity() {
    let frontend = TemporaryFrontend::new();
    let parent = frontend.root.join("nested");
    fs::create_dir(&parent).unwrap();
    fs::write(parent.join("asset.js"), b"same identity through hard link").unwrap();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;

    let original_parent = frontend.root.join("nested.bound");
    fs::rename(&parent, &original_parent).unwrap();
    fs::create_dir(&parent).unwrap();
    fs::hard_link(original_parent.join("asset.js"), parent.join("asset.js")).unwrap();

    assert_bounded_not_found_for_get_and_head(&gateway, &cookie, "/nested/asset.js").await;
    gateway.shutdown().await;
}

#[tokio::test]
async fn invalid_unknown_directory_and_symlink_paths_return_bounded_not_found() {
    let frontend = TemporaryFrontend::new();
    let external_root = frontend
        .root
        .parent()
        .unwrap()
        .join(format!("ride-startup-gateway-external-{}", Uuid::new_v4()));
    fs::create_dir(&external_root).unwrap();
    let external_file = external_root.join("secret.js");
    fs::write(&external_file, b"private path and token material").unwrap();
    symlink_file(&external_file, &frontend.root.join("escape.js")).unwrap();

    let gateway = bind_gateway(&frontend).await;
    let capability = gateway
        .bootstrap_url()
        .path_segments()
        .unwrap()
        .next_back()
        .unwrap()
        .to_string();
    let cookie = bootstrap_session(&gateway).await;
    for target in [
        "/%2e%2e/secret.js",
        "/assets%2fsecret.js",
        "/assets%5csecret.js",
        "/assets\\secret.js",
        "/nul%00.js",
        "/%252e%252e/secret.js",
        "/missing.js",
        "/assets/",
        "/escape.js",
    ] {
        let response =
            send_request(&gateway, Method::GET, target, &[(COOKIE.as_str(), &cookie)]).await;
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "target {target:?}"
        );
        let body = response_bytes(response).await;
        assert!(body.len() <= 32, "target {target:?}");
        let body = String::from_utf8_lossy(&body);
        assert!(!body.contains(&capability));
        assert!(!body.contains(&cookie));
        assert!(!body.contains(frontend.root.to_string_lossy().as_ref()));
        assert!(!body.contains(external_root.to_string_lossy().as_ref()));
    }

    gateway.shutdown().await;
    fs::remove_dir_all(external_root).unwrap();
}

#[tokio::test]
async fn foreign_authority_origin_forwarding_and_absolute_targets_are_rejected() {
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let public_authority = gateway.public_authority();
    let public_origin = format!("http://{public_authority}");
    let absolute_target = format!("{public_origin}/");
    let foreign_host_headers = [
        (HOST.as_str(), "localhost:1"),
        (COOKIE.as_str(), cookie.as_str()),
    ];
    let foreign_origin_headers = [
        ("origin", "http://example.invalid"),
        (COOKIE.as_str(), cookie.as_str()),
    ];
    let forwarded_host_headers = [
        ("x-forwarded-host", public_authority.as_str()),
        (COOKIE.as_str(), cookie.as_str()),
    ];
    let forwarded_headers = [
        ("forwarded", "host=127.0.0.1"),
        (COOKIE.as_str(), cookie.as_str()),
    ];
    let absolute_headers = [(COOKIE.as_str(), cookie.as_str())];
    let cases: [(&str, &[(&str, &str)]); 5] = [
        ("/", &foreign_host_headers),
        ("/", &foreign_origin_headers),
        ("/", &forwarded_host_headers),
        ("/", &forwarded_headers),
        (&absolute_target, &absolute_headers),
    ];
    for (target, headers) in cases {
        let response = send_request(&gateway, Method::GET, target, headers).await;
        assert_eq!(
            response.status(),
            StatusCode::NOT_FOUND,
            "target {target:?}"
        );
        assert_eq!(
            response_bytes(response).await,
            Bytes::from_static(b"Not Found")
        );
    }

    let allowed = send_request(
        &gateway,
        Method::GET,
        "/",
        &[(COOKIE.as_str(), &cookie), ("origin", &public_origin)],
    )
    .await;
    assert_eq!(allowed.status(), StatusCode::OK);
    gateway.shutdown().await;
}

#[tokio::test]
async fn large_static_assets_stream_incrementally_over_http() {
    let frontend = TemporaryFrontend::new();
    let expected = frontend.write_large_asset(
        "large.js",
        EXPECTED_STATIC_ASSET_CHUNK_SIZE * 3 + EXPECTED_STATIC_ASSET_CHUNK_SIZE / 2,
    );
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let response = send_request(
        &gateway,
        Method::GET,
        "/large.js",
        &[(COOKIE.as_str(), &cookie)],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(CONTENT_LENGTH).unwrap(),
        expected.len().to_string().as_str()
    );

    let mut body = response.into_body();
    let mut observed = Vec::with_capacity(expected.len());
    let mut frame_count = 0;
    while let Some(frame) = body.frame().await {
        let frame = frame.unwrap();
        if let Some(data) = frame.data_ref() {
            frame_count += 1;
            observed.extend_from_slice(data);
        }
    }
    // HTTP/1.1 does not preserve Body frame boundaries, so Hyper may merge
    // adjacent 16 KiB server reads. The module-level stream test verifies the
    // producer's exact bound; this real-socket test verifies incremental delivery.
    assert!(frame_count >= 2);
    assert_eq!(observed, expected);
    gateway.shutdown().await;
}

#[tokio::test]
async fn shutdown_is_bounded_and_releases_the_loopback_listener() {
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            max_connections: 1,
            http_header_read_timeout: Duration::from_secs(30),
            shutdown_drain: Duration::from_millis(25),
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
    let address = gateway_addr(&gateway);
    let idle_connection = open_partial_request(&gateway).await;

    tokio::time::timeout(Duration::from_millis(250), gateway.shutdown())
        .await
        .expect("gateway shutdown exceeded its drain bound");
    assert!(socket_closes_within(idle_connection, Duration::from_millis(250)).await);
    assert!(TcpStream::connect(address).await.is_err());
}

#[tokio::test]
async fn connection_saturation_closes_over_limit_sockets_before_http_work() {
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            max_connections: 1,
            http_header_read_timeout: Duration::from_secs(5),
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
    let mut first = open_partial_request(&gateway).await;
    let second = TcpStream::connect(gateway_addr(&gateway)).await.unwrap();

    assert!(socket_closes_within(second, Duration::from_millis(250)).await);
    let mut probe = [0_u8; 1];
    assert!(
        tokio::time::timeout(Duration::from_millis(20), first.read(&mut probe))
            .await
            .is_err(),
        "the permit-owning partial request closed before its configured timeout"
    );
    drop(first);
    gateway.shutdown().await;
}

#[tokio::test]
async fn header_timeout_closes_silent_clients_and_releases_the_connection_permit() {
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            max_connections: 1,
            http_header_read_timeout: Duration::from_millis(30),
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
    let first = open_partial_request(&gateway).await;

    assert!(socket_closes_within(first, Duration::from_millis(250)).await);
    let response = raw_anonymous_get(&gateway).await;
    assert!(
        response.starts_with(b"HTTP/1.1 404"),
        "released permit did not admit a complete request"
    );
    gateway.shutdown().await;
}

#[tokio::test]
async fn client_cancellation_releases_the_connection_permit() {
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            max_connections: 1,
            http_header_read_timeout: Duration::from_secs(5),
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
    let first = open_partial_request(&gateway).await;
    let saturation_probe = TcpStream::connect(gateway_addr(&gateway)).await.unwrap();
    assert!(socket_closes_within(saturation_probe, Duration::from_millis(250)).await);
    drop(first);

    let deadline = tokio::time::Instant::now() + Duration::from_millis(250);
    loop {
        let response = raw_anonymous_get(&gateway).await;
        if response.starts_with(b"HTTP/1.1 404") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "cancelled connection did not release its permit"
        );
        tokio::task::yield_now().await;
    }
    gateway.shutdown().await;
}

#[tokio::test]
async fn bind_records_gateway_listening_once_after_the_accept_loop_is_ready() {
    let frontend = TemporaryFrontend::new();
    let clock = Arc::new(SettableClock(AtomicU64::new(0)));
    let (reports, receiver) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "test",
        "test",
        1,
        StartupMode::RustGateway,
        clock.clone(),
        Box::new(ChannelWriter(reports)),
    );
    metrics.record(StartupMilestone::ProcessStarted).unwrap();
    receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    clock.0.store(7, Ordering::SeqCst);

    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        metrics,
        GatewayLimits::test_defaults(),
    )
    .await
    .unwrap();
    assert!(TcpStream::connect(gateway_addr(&gateway)).await.is_ok());
    let report = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(
        serde_json::to_value(report).unwrap()["milestones"]["gateway_listening"],
        7
    );
    assert!(receiver.recv_timeout(Duration::from_millis(50)).is_err());
    gateway.shutdown().await;
}

#[test]
fn startup_mode_defaults_to_rust_gateway_and_accepts_explicit_legacy() {
    assert_eq!(StartupMode::from_env_value(None), StartupMode::RustGateway);
    assert_eq!(
        StartupMode::from_env_value(Some("legacy")),
        StartupMode::LegacyExplicit
    );
}

#[tokio::test]
async fn same_backend_generation_transitions_from_starting_to_ready() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let generation = state.begin_backend_start().await.unwrap();

    let starting = state.snapshot().await;
    assert_eq!(starting.generation, generation);
    assert_eq!(starting.phase, BackendPhase::Starting);

    let backend_addr: SocketAddr = "127.0.0.1:3000".parse().unwrap();
    let waiter = state.wait_for_backend();
    tokio::pin!(waiter);
    assert!(matches!(poll!(&mut waiter), Poll::Pending));

    state.backend_ready(generation, backend_addr).await.unwrap();

    assert_eq!(waiter.await, Ok(backend_addr));
    let ready = state.snapshot().await;
    assert_eq!(ready.generation, generation);
    assert_eq!(ready.phase, BackendPhase::Ready);
    assert_eq!(ready.diagnostic, None);
}

#[tokio::test]
async fn stale_backend_generation_cannot_replace_or_fail_the_active_backend() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let first = state.begin_backend_start().await.unwrap();
    state.fail_backend(first, "first failed").await.unwrap();
    let second = state.begin_backend_start().await.unwrap();

    assert_eq!(
        state
            .backend_ready(first, "127.0.0.1:3000".parse().unwrap())
            .await,
        Err(GatewayError::StaleGeneration(first)),
    );
    assert_eq!(
        state.fail_backend(first, "stale failure").await,
        Err(GatewayError::StaleGeneration(first)),
    );

    state
        .backend_ready(second, "127.0.0.1:3001".parse().unwrap())
        .await
        .unwrap();
    assert_eq!(state.snapshot().await.phase, BackendPhase::Ready);
}

#[tokio::test]
async fn backend_ready_accepts_ipv4_and_ipv6_loopback_addresses() {
    for backend_addr in ["127.0.0.1:3000", "[::1]:3001"] {
        let state = GatewayState::new(GatewayLimits::test_defaults());
        let generation = state.begin_backend_start().await.unwrap();
        let backend_addr = backend_addr.parse().unwrap();

        state.backend_ready(generation, backend_addr).await.unwrap();

        assert_eq!(state.wait_for_backend().await, Ok(backend_addr));
    }
}

#[tokio::test]
async fn backend_ready_rejects_remote_and_zero_port_addresses_before_publication() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let generation = state.begin_backend_start().await.unwrap();

    for remote in ["192.0.2.10:3000", "[2001:db8::10]:3000"] {
        assert_eq!(
            state
                .backend_ready(generation, remote.parse().unwrap())
                .await,
            Err(GatewayError::InvalidBackendAddress(
                BackendAddressError::NonLoopback
            ))
        );
        assert_eq!(state.snapshot().await.phase, BackendPhase::Starting);
    }
    assert_eq!(
        state
            .backend_ready(generation, "127.0.0.1:0".parse().unwrap())
            .await,
        Err(GatewayError::InvalidBackendAddress(
            BackendAddressError::ZeroPort
        ))
    );
    assert_eq!(state.snapshot().await.phase, BackendPhase::Starting);
}

#[tokio::test]
async fn only_one_retry_owns_the_next_generation() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let first = state.begin_backend_start().await.unwrap();
    state
        .fail_backend(first, "retryable failure")
        .await
        .unwrap();

    let left = tokio::spawn({
        let state = state.clone();
        async move { state.begin_backend_start().await }
    });
    let right = tokio::spawn({
        let state = state.clone();
        async move { state.begin_backend_start().await }
    });

    let results: [Result<BackendGeneration, GatewayError>; 2] =
        [left.await.unwrap(), right.await.unwrap()];
    let owner = results
        .iter()
        .filter_map(|result| result.as_ref().ok().copied())
        .collect::<Vec<_>>();
    assert_eq!(owner.len(), 1);
    assert_eq!(state.snapshot().await.generation, owner[0]);
    assert_eq!(state.snapshot().await.phase, BackendPhase::Starting);
    assert!(results.iter().any(|result| {
        matches!(
            result,
            Err(GatewayError::BackendStartInProgress(generation)) if *generation == owner[0]
        )
    }));
}

#[tokio::test]
async fn backend_waiter_cannot_cross_into_a_retry_generation() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let first = state.begin_backend_start().await.unwrap();
    let waiter = state.wait_for_backend();
    tokio::pin!(waiter);
    assert!(matches!(poll!(&mut waiter), Poll::Pending));

    state.fail_backend(first, "first failed").await.unwrap();
    let second = state.begin_backend_start().await.unwrap();
    let second_addr = "127.0.0.1:3001".parse().unwrap();
    state.backend_ready(second, second_addr).await.unwrap();

    assert_eq!(
        waiter.await,
        Err(GatewayError::BackendGenerationSuperseded {
            expected: first,
            observed: second,
        })
    );
}

#[tokio::test]
async fn backend_waiter_limit_rejects_excess_waiters_without_waiting() {
    let state = GatewayState::new(GatewayLimits {
        backend_wait: Duration::from_secs(30),
        max_waiters: 1,
        ..GatewayLimits::test_defaults()
    });
    state.begin_backend_start().await.unwrap();
    let first = state.wait_for_backend();
    tokio::pin!(first);
    assert!(matches!(poll!(&mut first), Poll::Pending));

    assert_eq!(
        state.wait_for_backend().await,
        Err(GatewayError::TooManyBackendWaiters)
    );

    state.shutdown().await;
    assert_eq!(first.await, Err(GatewayError::ShuttingDown));
}

#[tokio::test]
async fn cancelling_a_backend_waiter_releases_its_permit() {
    let state = GatewayState::new(GatewayLimits {
        backend_wait: Duration::from_secs(30),
        max_waiters: 1,
        ..GatewayLimits::test_defaults()
    });
    state.begin_backend_start().await.unwrap();
    let mut cancelled = Box::pin(state.wait_for_backend());
    assert!(matches!(poll!(&mut cancelled), Poll::Pending));
    drop(cancelled);

    let replacement = state.wait_for_backend();
    tokio::pin!(replacement);
    assert!(matches!(poll!(&mut replacement), Poll::Pending));
    state.shutdown().await;
    assert_eq!(replacement.await, Err(GatewayError::ShuttingDown));
}

#[tokio::test]
async fn backend_waiter_timeout_is_typed_and_generation_bound() {
    let state = GatewayState::new(GatewayLimits {
        backend_wait: Duration::from_millis(10),
        ..GatewayLimits::test_defaults()
    });
    let generation = state.begin_backend_start().await.unwrap();

    assert_eq!(
        state.wait_for_backend().await,
        Err(GatewayError::BackendWaitTimedOut(generation))
    );
}

#[tokio::test]
async fn shutdown_releases_backend_readiness_waiters() {
    let state = GatewayState::new(GatewayLimits {
        backend_wait: Duration::from_secs(30),
        ..GatewayLimits::test_defaults()
    });
    state.begin_backend_start().await.unwrap();

    let waiter = state.wait_for_backend();
    tokio::pin!(waiter);
    assert!(matches!(poll!(&mut waiter), Poll::Pending));
    state.shutdown().await;

    let result = tokio::time::timeout(Duration::from_millis(250), waiter)
        .await
        .expect("shutdown must wake the readiness waiter");
    assert_eq!(result, Err(GatewayError::ShuttingDown));
    assert_eq!(state.snapshot().await.phase, BackendPhase::Stopping);
}

#[tokio::test]
async fn browser_diagnostics_are_bounded_and_do_not_echo_sensitive_input() {
    let state = GatewayState::new(GatewayLimits::test_defaults());
    let generation = state.begin_backend_start().await.unwrap();
    let sensitive = concat!(
        "node C:\\Users\\person\\R-IDE\\backend.js --capability=secret ",
        "Cookie: ride_session=session-secret RIDE_TOKEN=environment-secret ",
        "/home/person/private/config.json"
    );

    state.fail_backend(generation, sensitive).await.unwrap();

    let diagnostic = state.snapshot().await.diagnostic.unwrap();
    assert!(diagnostic.len() <= 160);
    for secret in [
        "node",
        "C:\\Users",
        "--capability",
        "Cookie",
        "session-secret",
        "RIDE_TOKEN",
        "environment-secret",
        "/home/",
    ] {
        assert!(!diagnostic.contains(secret), "leaked {secret:?}");
    }
}

#[test]
fn routes_are_classified_from_the_inventory_not_the_filesystem() {
    let routes = RouteTable::new(["/", "/bundle.js", "/bundle.css"]).unwrap();

    assert_eq!(
        routes.classify("/_ride/bootstrap/one-time-value"),
        Ok(RouteKind::Bootstrap)
    );
    assert_eq!(
        routes.classify("/_ride/startup/status"),
        Ok(RouteKind::Control)
    );
    assert_eq!(routes.classify("/bundle.js"), Ok(RouteKind::Static));
    assert_eq!(routes.classify("/bundle.js/"), Ok(RouteKind::Backend));
    assert_eq!(
        routes.classify("/services/filesystem"),
        Ok(RouteKind::Backend)
    );
    assert_eq!(routes.classify("/socket.io/"), Ok(RouteKind::Backend));
}

#[test]
fn route_classification_decodes_each_inventory_and_request_path_once() {
    let routes = RouteTable::new(["/", "/bundle%2Ejs", "/bundle.css"]).unwrap();

    assert_eq!(
        routes.classify("/%5Fride/bootstrap/one-time-value"),
        Ok(RouteKind::Bootstrap)
    );
    assert_eq!(
        routes.classify("/%5Fride/startup/status"),
        Ok(RouteKind::Control)
    );
    assert_eq!(routes.classify("/bundle.js"), Ok(RouteKind::Static));
    assert_eq!(routes.classify("/bundle%2Ejs"), Ok(RouteKind::Static));
}

#[test]
fn invalid_or_ambiguous_route_paths_are_rejected_instead_of_becoming_backend_routes() {
    let routes = RouteTable::new(["/", "/bundle.js"]).unwrap();
    let invalid = [
        ("/bundle%2Fjs", PathError::EncodedSeparator),
        ("/bundle%5cjs", PathError::EncodedSeparator),
        ("//bundle.js", PathError::RepeatedSeparator),
        ("/assets//bundle.js", PathError::RepeatedSeparator),
        ("/./bundle.js", PathError::DotSegment),
        ("/assets/../bundle.js", PathError::DotSegment),
        ("/%2e%2E/bundle.js", PathError::DotSegment),
        ("/assets\\bundle.js", PathError::Backslash),
        ("/nul\0.js", PathError::Nul),
        ("/nul%00.js", PathError::Nul),
        ("/bad%", PathError::MalformedPercentEncoding),
        ("/bad%2", PathError::MalformedPercentEncoding),
        ("/bad%GG", PathError::MalformedPercentEncoding),
        ("/bundle.js?cache=1", PathError::QueryOrFragment),
        ("/bundle.js#fragment", PathError::QueryOrFragment),
        ("/bundle.js%3Fcache=1", PathError::QueryOrFragment),
        ("/%252e%252e/bundle.js", PathError::DoubleEncoding),
        ("/%255Fride/startup/status", PathError::DoubleEncoding),
        ("relative/path", PathError::NotAbsolute),
        ("/%FF", PathError::InvalidUtf8),
    ];

    for (path, expected) in invalid {
        assert_eq!(routes.classify(path), Err(expected), "path {path:?}");
    }
}

#[test]
fn route_inventory_is_rejected_by_the_same_path_rules_as_requests() {
    assert!(matches!(
        RouteTable::new(["/bundle.js", "../outside.js"]),
        Err(PathError::NotAbsolute)
    ));
    assert!(matches!(
        RouteTable::new(["/bundle.js", "/%252e%252e/hidden.js"]),
        Err(PathError::DoubleEncoding)
    ));
}
