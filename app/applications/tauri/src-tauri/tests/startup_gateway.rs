/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use bytes::Bytes;
use futures_util::{future::BoxFuture, poll, stream, FutureExt, SinkExt, StreamExt};
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{
    CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, COOKIE, HOST, LOCATION, ORIGIN, SET_COOKIE,
};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use ride_tauri::startup_gateway::{
    BackendAddressError, BackendGeneration, BackendPhase, GatewayError, GatewayLimitError,
    GatewayLimits, GatewayState, PathError, RouteKind, RouteTable, StartupGateway,
};
use ride_tauri::startup_metrics::{
    ElapsedClock, StartupMetrics, StartupMilestone, StartupMode, StartupReport, StartupReportWriter,
};
use std::fs;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::task::Poll;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::handshake::server::{
    Request as WebSocketRequest, Response as WebSocketResponse,
};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_hdr_async, connect_async};
use uuid::Uuid;

const EXPECTED_STATIC_ASSET_CHUNK_SIZE: usize = 16 * 1024;
const STREAM_CHUNK_COUNT: usize = 512;
const STREAM_CHUNK_SIZE: usize = 65_536;
const STREAM_BYTE_COUNT: usize = STREAM_CHUNK_COUNT * STREAM_CHUNK_SIZE;
const UPLOAD_CHUNK: &[u8; STREAM_CHUNK_SIZE] = &[7_u8; STREAM_CHUNK_SIZE];
const DOWNLOAD_CHUNK: &[u8; STREAM_CHUNK_SIZE] = &[9_u8; STREAM_CHUNK_SIZE];

type TestBody = UnsyncBoxBody<Bytes, io::Error>;
type FakeBackendHandler =
    Arc<dyn Fn(Request<Incoming>) -> BoxFuture<'static, Response<TestBody>> + Send + Sync>;

struct FakeBackend {
    addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    task: JoinHandle<()>,
}

#[derive(Debug)]
struct ObservedWebSocketHandshake {
    target: String,
    host: String,
    origin: String,
    cookie: Option<String>,
}

struct FakeWebSocketBackend {
    addr: SocketAddr,
    task: JoinHandle<Vec<ObservedWebSocketHandshake>>,
}

impl FakeWebSocketBackend {
    async fn spawn_echo() -> Self {
        Self::spawn_echo_connections(1).await
    }

    async fn spawn_echo_connections(connection_count: usize) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut handshakes = Vec::with_capacity(connection_count);
            for _ in 0..connection_count {
                let (stream, _) = listener.accept().await.unwrap();
                let observed = Arc::new(std::sync::Mutex::new(None));
                let callback_observed = observed.clone();
                let mut socket = accept_hdr_async(
                    stream,
                    move |request: &WebSocketRequest, mut response: WebSocketResponse| {
                        *callback_observed.lock().unwrap() = Some(ObservedWebSocketHandshake {
                            target: request.uri().to_string(),
                            host: request
                                .headers()
                                .get(HOST)
                                .unwrap()
                                .to_str()
                                .unwrap()
                                .to_string(),
                            origin: request
                                .headers()
                                .get(ORIGIN)
                                .unwrap()
                                .to_str()
                                .unwrap()
                                .to_string(),
                            cookie: request
                                .headers()
                                .get(COOKIE)
                                .map(|value| value.to_str().unwrap().to_string()),
                        });
                        response
                            .headers_mut()
                            .append(SET_COOKIE, "theme=dark; Path=/".parse().unwrap());
                        response.headers_mut().append(
                            SET_COOKIE,
                            "ride_session=backend-value; Path=/".parse().unwrap(),
                        );
                        Ok(response)
                    },
                )
                .await
                .unwrap();

                socket
                    .send(Message::Text("backend-text".into()))
                    .await
                    .unwrap();
                socket
                    .send(Message::Binary(vec![9_u8, 8, 7].into()))
                    .await
                    .unwrap();
                while let Some(message) = socket.next().await {
                    let Ok(message) = message else {
                        break;
                    };
                    match message {
                        message @ (Message::Text(_) | Message::Binary(_)) => {
                            if socket.send(message).await.is_err() {
                                break;
                            }
                        }
                        Message::Close(frame) => {
                            let _ = socket.close(frame).await;
                            break;
                        }
                        Message::Ping(payload) => {
                            if socket.send(Message::Pong(payload)).await.is_err() {
                                break;
                            }
                        }
                        Message::Pong(_) | Message::Frame(_) => {}
                    }
                }
                handshakes.push(
                    Arc::try_unwrap(observed)
                        .unwrap()
                        .into_inner()
                        .unwrap()
                        .unwrap(),
                );
            }
            handshakes
        });
        Self { addr, task }
    }

    async fn finish(self) -> Vec<ObservedWebSocketHandshake> {
        tokio::time::timeout(Duration::from_secs(1), self.task)
            .await
            .expect("WebSocket backend did not close")
            .unwrap()
    }
}

impl FakeBackend {
    async fn spawn(handler: FakeBackendHandler) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown, mut shutdown_receiver) = oneshot::channel();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut shutdown_receiver => break,
                    completed = connections.join_next(), if !connections.is_empty() => {
                        let _ = completed;
                    }
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let handler = handler.clone();
                        connections.spawn(async move {
                            let service = service_fn(move |request| {
                                let handler = handler.clone();
                                async move { Ok::<_, std::convert::Infallible>(handler(request).await) }
                            });
                            let _ = http1::Builder::new()
                                .serve_connection(TokioIo::new(stream), service)
                                .await;
                        });
                    }
                }
            }
            connections.abort_all();
            while connections.join_next().await.is_some() {}
        });
        Self {
            addr,
            shutdown: Some(shutdown),
            task,
        }
    }

    async fn shutdown(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        self.task.await.unwrap();
    }
}

fn empty_test_body() -> TestBody {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn full_test_body(body: impl Into<Bytes>) -> TestBody {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

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
    send_request_to(
        gateway_addr(gateway),
        gateway.public_authority(),
        method,
        target,
        headers,
        empty_test_body(),
    )
    .await
}

async fn send_request_to(
    gateway_addr: SocketAddr,
    public_authority: String,
    method: Method,
    target: &str,
    headers: &[(&str, &str)],
    body: TestBody,
) -> Response<hyper::body::Incoming> {
    let stream = TcpStream::connect(gateway_addr).await.unwrap();
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
        request = request.header(HOST, public_authority);
    }
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    sender
        .send_request(request.body(body).unwrap())
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

fn websocket_client_request(
    gateway: &StartupGateway,
    cookie: Option<&str>,
    target: &str,
    origin: Option<&str>,
) -> WebSocketRequest {
    let mut request = format!("ws://{}{target}", gateway.public_authority())
        .into_client_request()
        .unwrap();
    if let Some(cookie) = cookie {
        request
            .headers_mut()
            .insert(COOKIE, cookie.parse().unwrap());
    }
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert(ORIGIN, origin.parse().unwrap());
    }
    request
}

async fn consume_backend_websocket_greeting<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        Message::Text("backend-text".into())
    );
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        Message::Binary(vec![9_u8, 8, 7].into())
    );
}

fn report_has_milestone(report: &StartupReport, name: &str) -> bool {
    serde_json::to_value(report)
        .unwrap()
        .get("milestones")
        .and_then(|milestones| milestones.get(name))
        .is_some()
}

fn receive_report_with_milestone(
    reports: &mpsc::Receiver<StartupReport>,
    milestone: &str,
) -> StartupReport {
    loop {
        let report = reports
            .recv_timeout(Duration::from_secs(1))
            .expect("startup report milestone was not published");
        if report_has_milestone(&report, milestone) {
            return report;
        }
    }
}

async fn websocket_failure_status(request: WebSocketRequest) -> StatusCode {
    match connect_async(request).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => response.status(),
        Ok(_) => panic!("invalid WebSocket request unexpectedly upgraded"),
        Err(error) => panic!("invalid WebSocket request failed without an HTTP status: {error}"),
    }
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

async fn raw_http_exchange(address: SocketAddr, request: &[u8]) -> Vec<u8> {
    let mut stream = TcpStream::connect(address).await.unwrap();
    stream.write_all(request).await.unwrap();
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_millis(500), async {
        let mut buffer = [0_u8; 4096];
        loop {
            match stream.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    response.extend_from_slice(&buffer[..read]);
                    if raw_http_response_is_complete(&response) {
                        break;
                    }
                }
            }
        }
    })
    .await;
    response
}

fn raw_http_response_is_complete(response: &[u8]) -> bool {
    let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let body_offset = header_end + 4;
    let headers = String::from_utf8_lossy(&response[..header_end]).to_ascii_lowercase();
    if let Some(content_length) = headers.lines().find_map(|line| {
        line.strip_prefix("content-length:")
            .and_then(|value| value.trim().parse::<usize>().ok())
    }) {
        return response.len() >= body_offset + content_length;
    }
    headers.contains("transfer-encoding: chunked") && response.ends_with(b"\r\n0\r\n\r\n")
}

fn raw_authenticated_request(
    gateway: &StartupGateway,
    cookie: &str,
    headers: &[u8],
    body: &[u8],
) -> Vec<u8> {
    let mut request = format!(
        "POST /api/raw-framing HTTP/1.1\r\nHost: {}\r\nCookie: {cookie}\r\n",
        gateway.public_authority()
    )
    .into_bytes();
    request.extend_from_slice(headers);
    request.extend_from_slice(b"\r\n");
    request.extend_from_slice(body);
    request
}

struct RawResponseBackend {
    addr: SocketAddr,
    task: JoinHandle<()>,
}

impl RawResponseBackend {
    async fn spawn(responses: Vec<Vec<u8>>) -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 1024];
                while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                    let read = stream.read(&mut buffer).await.unwrap();
                    assert_ne!(read, 0, "gateway closed before sending backend headers");
                    request.extend_from_slice(&buffer[..read]);
                    assert!(request.len() <= 16 * 1024);
                }
                stream.write_all(&response).await.unwrap();
                let _ = stream.shutdown().await;
            }
        });
        Self { addr, task }
    }

    async fn finish(self) {
        self.task.await.unwrap();
    }
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
async fn invalid_paths_are_not_found_and_non_inventory_paths_are_backend_owned() {
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

    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            backend_wait: Duration::from_millis(10),
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
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
    for target in ["/missing.js", "/assets/", "/escape.js"] {
        let response =
            send_request(&gateway, Method::GET, target, &[(COOKIE.as_str(), &cookie)]).await;
        assert_eq!(
            response.status(),
            StatusCode::SERVICE_UNAVAILABLE,
            "target {target:?}"
        );
        let body = response_bytes(response).await;
        assert!(body.len() <= 256, "target {target:?}");
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
async fn bind_rejects_zero_max_connections_with_a_typed_bounded_error() {
    let frontend = TemporaryFrontend::new();
    let result = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            max_connections: 0,
            ..GatewayLimits::test_defaults()
        },
    )
    .await;

    match result {
        Err(GatewayError::InvalidLimits(GatewayLimitError::ZeroMaxConnections)) => {}
        _ => panic!("zero max_connections did not return the typed configuration error"),
    }
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
    let lease = state.wait_for_backend_lease().await.unwrap();
    assert_eq!(lease.generation, generation);
    assert_eq!(lease.address, backend_addr);
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

#[tokio::test]
async fn http_proxy_timeout_is_retryable_and_bounded() {
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            backend_wait: Duration::from_millis(25),
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
    let cookie = bootstrap_session(&gateway).await;

    let response = send_request(
        &gateway,
        Method::GET,
        "/api/not-ready",
        &[(COOKIE.as_str(), &cookie)],
    )
    .await;

    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(response.headers().get("retry-after").unwrap(), "1");
    assert_eq!(
        response.headers().get(CONTENT_TYPE).unwrap(),
        "application/json"
    );
    let body = response_bytes(response).await;
    assert!(body.len() <= 256);
    assert_eq!(
        body,
        Bytes::from_static(b"{\"error\":\"backend_unavailable\"}")
    );
    gateway.shutdown().await;
}

#[tokio::test]
async fn http_proxy_static_bundle_completes_while_backend_request_is_blocked() {
    let backend = FakeBackend::spawn(Arc::new(|_request| {
        async move {
            Response::builder()
                .status(StatusCode::OK)
                .body(full_test_body("backend ready"))
                .unwrap()
        }
        .boxed()
    }))
    .await;
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            backend_wait: Duration::from_secs(2),
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    let gateway_addr = gateway_addr(&gateway);
    let public_authority = gateway.public_authority();
    let waiting_cookie = cookie.clone();
    let waiting = tokio::spawn(async move {
        send_request_to(
            gateway_addr,
            public_authority,
            Method::GET,
            "/api/waits-for-backend",
            &[(COOKIE.as_str(), waiting_cookie.as_str())],
            empty_test_body(),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(!waiting.is_finished());

    let bundle = tokio::time::timeout(
        Duration::from_millis(250),
        send_request(
            &gateway,
            Method::GET,
            "/bundle.js",
            &[(COOKIE.as_str(), &cookie)],
        ),
    )
    .await
    .expect("static bundle waited for backend readiness");
    assert_eq!(bundle.status(), StatusCode::OK);
    assert_eq!(
        response_bytes(bundle).await,
        Bytes::from_static(b"globalThis.ride = true;")
    );

    state.backend_ready(generation, backend.addr).await.unwrap();
    let backend_response = waiting.await.unwrap();
    assert_eq!(backend_response.status(), StatusCode::OK);
    gateway.shutdown().await;
    backend.shutdown().await;
}

#[tokio::test]
async fn http_proxy_rejects_unsafe_request_framing_and_invalid_connection_before_backend_delivery()
{
    let backend_deliveries = Arc::new(AtomicUsize::new(0));
    let observed_deliveries = backend_deliveries.clone();
    let backend = FakeBackend::spawn(Arc::new(move |_request| {
        let observed_deliveries = observed_deliveries.clone();
        async move {
            observed_deliveries.fetch_add(1, Ordering::SeqCst);
            Response::builder()
                .status(StatusCode::OK)
                .body(full_test_body("unexpected backend delivery"))
                .unwrap()
        }
        .boxed()
    }))
    .await;
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();

    let cases = [
        (
            b"Transfer-Encoding: gzip, chunked\r\nConnection: close\r\n".as_slice(),
            b"4\r\ntest\r\n0\r\n\r\n".as_slice(),
        ),
        (
            b"Content-Length: 4\r\nContent-Length: 5\r\nConnection: close\r\n".as_slice(),
            b"test".as_slice(),
        ),
        (
            b"Content-Length: 4, 5\r\nConnection: close\r\n".as_slice(),
            b"test".as_slice(),
        ),
        (
            b"Content-Length: 0\r\nConnection: x-\thop\r\nX-Hop: secret\r\n".as_slice(),
            b"".as_slice(),
        ),
        (
            b"Content-Length: 0\r\nConnection: x-hop,,keep-alive\r\nX-Hop: secret\r\n".as_slice(),
            b"".as_slice(),
        ),
        (
            b"Content-Length: 0\r\nConnection: x@hop\r\nX-Hop: secret\r\n".as_slice(),
            b"".as_slice(),
        ),
        (
            b"Content-Length: 0\r\nConnection: x-\x80hop\r\nX-Hop: secret\r\n".as_slice(),
            b"".as_slice(),
        ),
    ];

    for (headers, body) in cases {
        let request = raw_authenticated_request(&gateway, &cookie, headers, body);
        let response = raw_http_exchange(gateway_addr(&gateway), &request).await;
        assert!(
            response.is_empty() || response.starts_with(b"HTTP/1.1 400"),
            "unsafe request was not rejected: {}",
            String::from_utf8_lossy(&response)
        );
        assert!(response.len() <= 1024);
    }
    assert_eq!(backend_deliveries.load(Ordering::SeqCst), 0);
    gateway.shutdown().await;
    backend.shutdown().await;
}

#[tokio::test]
async fn http_proxy_accepts_consistent_length_plain_chunked_and_connection_ows() {
    let observed = Arc::new(Mutex::new(Vec::new()));
    let backend_observed = observed.clone();
    let backend = FakeBackend::spawn(Arc::new(move |request| {
        let backend_observed = backend_observed.clone();
        async move {
            let leaked_hop = request.headers().contains_key("x-raw-hop");
            let ambiguous_framing = request.headers().contains_key(CONTENT_LENGTH)
                && request.headers().contains_key("transfer-encoding");
            let body = request.into_body().collect().await.unwrap().to_bytes();
            backend_observed
                .lock()
                .await
                .push((body, leaked_hop, ambiguous_framing));
            Response::builder()
                .status(StatusCode::OK)
                .body(full_test_body("accepted"))
                .unwrap()
        }
        .boxed()
    }))
    .await;
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();

    for headers in [
        b"Content-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n".as_slice(),
        b"Transfer-Encoding: chunked\r\nContent-Length: 4\r\nConnection: close\r\n".as_slice(),
    ] {
        let request =
            raw_authenticated_request(&gateway, &cookie, headers, b"4\r\ntest\r\n0\r\n\r\n");
        let response = raw_http_exchange(gateway_addr(&gateway), &request).await;
        assert!(response.starts_with(b"HTTP/1.1 200"));
    }

    let duplicate_length = raw_authenticated_request(
        &gateway,
        &cookie,
        b"Content-Length: 4\r\nContent-Length: 4\r\nConnection: close\r\n",
        b"test",
    );
    let response = raw_http_exchange(gateway_addr(&gateway), &duplicate_length).await;
    assert!(response.starts_with(b"HTTP/1.1 200"));

    let plain_chunked = raw_authenticated_request(
        &gateway,
        &cookie,
        b"Transfer-Encoding:\tchunked\t\r\nConnection:\t x-raw-hop \t,\tkeep-alive\t\r\nX-Raw-Hop: secret\r\n",
        b"4\r\ntest\r\n0\r\n\r\n",
    );
    let response = raw_http_exchange(gateway_addr(&gateway), &plain_chunked).await;
    assert!(response.starts_with(b"HTTP/1.1 200"));

    assert_eq!(
        observed.lock().await.as_slice(),
        &[
            (Bytes::from_static(b"test"), false, false),
            (Bytes::from_static(b"test"), false, false),
            (Bytes::from_static(b"test"), false, false),
            (Bytes::from_static(b"test"), false, false),
        ]
    );
    gateway.shutdown().await;
    backend.shutdown().await;
}

#[tokio::test]
async fn http_proxy_rejects_ambiguous_response_framing_and_invalid_connection() {
    let responses = vec![
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n4\r\ntest\r\n0\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 4\r\nConnection: close\r\n\r\n4\r\ntest\r\n0\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\nConnection: close\r\n\r\n4\r\ntest\r\n0\r\n\r\n".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Length: 5\r\nConnection: close\r\n\r\ntest".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: x-\thop\r\nX-Hop: secret\r\n\r\ntest".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: x-hop,,keep-alive\r\nX-Hop: secret\r\n\r\ntest".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: x@hop\r\nX-Hop: secret\r\n\r\ntest".to_vec(),
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: x-\x80hop\r\nX-Hop: secret\r\n\r\ntest".to_vec(),
    ];
    let backend = RawResponseBackend::spawn(responses).await;
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();

    for index in 0..8 {
        let response = send_request(
            &gateway,
            Method::GET,
            &format!("/api/raw-response/{index}"),
            &[(COOKIE.as_str(), &cookie)],
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = response_bytes(response).await;
        assert_eq!(
            body,
            Bytes::from_static(b"{\"error\":\"backend_proxy_failed\"}")
        );
    }
    gateway.shutdown().await;
    backend.finish().await;
}

#[tokio::test]
async fn http_proxy_accepts_safe_backend_framing_and_connection_ows() {
    let responses = vec![
        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nContent-Length: 4\r\nConnection: close\r\n\r\ntest".to_vec(),
        b"HTTP/1.1 200 OK\r\nTransfer-Encoding:\tchunked\t\r\nConnection:\t x-raw-hop \t,\tclose\t\r\nX-Raw-Hop: secret\r\n\r\n4\r\ntest\r\n0\r\n\r\n".to_vec(),
    ];
    let backend = RawResponseBackend::spawn(responses).await;
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();

    for index in 0..2 {
        let response = send_request(
            &gateway,
            Method::GET,
            &format!("/api/safe-response/{index}"),
            &[(COOKIE.as_str(), &cookie)],
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!response.headers().contains_key("x-raw-hop"));
        assert_eq!(response_bytes(response).await, Bytes::from_static(b"test"));
    }
    gateway.shutdown().await;
    backend.finish().await;
}

#[derive(Debug)]
struct ObservedProxyRequest {
    method: Method,
    target: String,
    headers: hyper::HeaderMap,
    body: Bytes,
}

#[tokio::test]
async fn http_proxy_preserves_end_to_end_request_and_response_semantics() {
    let (observed_sender, observed_receiver) = oneshot::channel();
    let observed_sender = Arc::new(Mutex::new(Some(observed_sender)));
    let backend = FakeBackend::spawn(Arc::new(move |request| {
        let observed_sender = observed_sender.clone();
        async move {
            let method = request.method().clone();
            let target = request.uri().to_string();
            let headers = request.headers().clone();
            let body = request.into_body().collect().await.unwrap().to_bytes();
            observed_sender
                .lock()
                .await
                .take()
                .unwrap()
                .send(ObservedProxyRequest {
                    method,
                    target,
                    headers,
                    body,
                })
                .unwrap();
            Response::builder()
                .status(StatusCode::CREATED)
                .header("x-response-value", "first")
                .header("x-response-value", "second")
                .header(SET_COOKIE, "theme=dark; Path=/")
                .header(SET_COOKIE, "ride_session=backend-value; Path=/")
                .header(SET_COOKIE, "application=value; HttpOnly")
                .header("connection", "x-response-hop, x-response-hop-second")
                .header("x-response-hop", "private")
                .header("x-response-hop-second", "private")
                .header("proxy-connection", "keep-alive")
                .header("keep-alive", "timeout=5")
                .header("transfer-encoding", "chunked")
                .header("te", "trailers")
                .header("trailer", "x-response-trailer")
                .header("upgrade", "h2c")
                .header("proxy-authenticate", "Basic realm=private")
                .header("proxy-authorization", "Basic private")
                .body(full_test_body("proxied response"))
                .unwrap()
        }
        .boxed()
    }))
    .await;
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    let gateway_addr = gateway_addr(&gateway);
    let public_authority = gateway.public_authority();
    let public_origin = format!("http://{public_authority}");
    let cookie_header = format!("theme=dark; {cookie}; application=value");
    let pending = tokio::spawn(async move {
        send_request_to(
            gateway_addr,
            public_authority,
            Method::POST,
            "/api/items?limit=2&order=desc",
            &[
                (COOKIE.as_str(), cookie_header.as_str()),
                ("origin", public_origin.as_str()),
                ("x-request-value", "first"),
                ("x-request-value", "second"),
                (
                    "connection",
                    "x-request-hop, x-request-hop-second, keep-alive",
                ),
                ("x-request-hop", "private"),
                ("x-request-hop-second", "private"),
                ("proxy-connection", "keep-alive"),
                ("keep-alive", "timeout=5"),
                ("transfer-encoding", "chunked"),
                ("te", "trailers"),
                ("trailer", "x-trailer"),
                ("upgrade", "h2c"),
                ("proxy-authenticate", "Basic realm=private"),
                ("proxy-authorization", "Basic private"),
            ],
            full_test_body("proxied request"),
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(!pending.is_finished());
    state.backend_ready(generation, backend.addr).await.unwrap();

    let response = pending.await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(
        response
            .headers()
            .get_all("x-response-value")
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    assert_eq!(
        response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["theme=dark; Path=/", "application=value; HttpOnly"]
    );
    for removed in [
        "connection",
        "x-response-hop",
        "x-response-hop-second",
        "proxy-connection",
        "keep-alive",
        "te",
        "trailer",
        "upgrade",
        "proxy-authenticate",
        "proxy-authorization",
    ] {
        assert!(
            !response.headers().contains_key(removed),
            "response leaked {removed}"
        );
    }
    assert!(response
        .headers()
        .get_all("transfer-encoding")
        .iter()
        .all(|value| value.as_bytes().eq_ignore_ascii_case(b"chunked")));
    assert_eq!(
        response_bytes(response).await,
        Bytes::from_static(b"proxied response")
    );

    let observed = observed_receiver.await.unwrap();
    assert_eq!(observed.method, Method::POST);
    assert_eq!(observed.target, "/api/items?limit=2&order=desc");
    assert_eq!(observed.body, Bytes::from_static(b"proxied request"));
    assert_eq!(
        observed.headers.get(HOST).unwrap(),
        backend.addr.to_string().as_str()
    );
    assert_eq!(
        observed
            .headers
            .get_all("x-request-value")
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    assert_eq!(
        observed.headers.get(COOKIE).unwrap(),
        "theme=dark; application=value"
    );
    assert_eq!(
        observed.headers.get("origin").unwrap(),
        format!("http://{}", gateway.public_authority()).as_str()
    );
    for removed in [
        "connection",
        "x-request-hop",
        "x-request-hop-second",
        "proxy-connection",
        "keep-alive",
        "te",
        "trailer",
        "upgrade",
        "proxy-authenticate",
        "proxy-authorization",
    ] {
        assert!(
            !observed.headers.contains_key(removed),
            "request leaked {removed}"
        );
    }
    assert!(observed
        .headers
        .get_all("transfer-encoding")
        .iter()
        .all(|value| value.as_bytes().eq_ignore_ascii_case(b"chunked")));
    gateway.shutdown().await;
    backend.shutdown().await;
}

#[tokio::test]
async fn http_proxy_authenticates_before_rejecting_excess_waiters() {
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            backend_wait: Duration::from_secs(2),
            max_waiters: 0,
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
    let cookie = bootstrap_session(&gateway).await;

    let anonymous = send_request(&gateway, Method::GET, "/api/private", &[]).await;
    assert_eq!(anonymous.status(), StatusCode::NOT_FOUND);

    let started = tokio::time::Instant::now();
    let saturated = send_request(
        &gateway,
        Method::GET,
        "/api/private",
        &[(COOKIE.as_str(), &cookie)],
    )
    .await;
    assert!(started.elapsed() < Duration::from_millis(250));
    assert_eq!(saturated.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(saturated.headers().get("retry-after").unwrap(), "1");
    assert_eq!(
        response_bytes(saturated).await,
        Bytes::from_static(b"{\"error\":\"backend_unavailable\"}")
    );
    gateway.shutdown().await;
}

#[tokio::test]
async fn http_proxy_backend_failure_releases_all_waiting_requests() {
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            backend_wait: Duration::from_secs(5),
            max_waiters: 4,
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    let mut requests = Vec::new();
    for index in 0..4 {
        let gateway_addr = gateway_addr(&gateway);
        let public_authority = gateway.public_authority();
        let cookie = cookie.clone();
        requests.push(tokio::spawn(async move {
            send_request_to(
                gateway_addr,
                public_authority,
                Method::POST,
                &format!("/api/waiter/{index}"),
                &[(COOKIE.as_str(), cookie.as_str())],
                full_test_body(format!("request-{index}")),
            )
            .await
        }));
    }
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(requests.iter().all(|request| !request.is_finished()));

    state
        .fail_backend(generation, "private child process details")
        .await
        .unwrap();
    for request in requests {
        let response = tokio::time::timeout(Duration::from_millis(250), request)
            .await
            .expect("backend failure did not release a waiter")
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers().get("retry-after").unwrap(), "1");
        let body = response_bytes(response).await;
        assert_eq!(
            body,
            Bytes::from_static(b"{\"error\":\"backend_unavailable\"}")
        );
        assert!(!String::from_utf8_lossy(&body).contains("private"));
    }
    gateway.shutdown().await;
}

#[tokio::test]
async fn http_proxy_connect_failure_is_bounded_and_never_echoes_private_authority() {
    let unused_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let unused_addr = unused_listener.local_addr().unwrap();
    drop(unused_listener);
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, unused_addr).await.unwrap();

    let response = send_request(
        &gateway,
        Method::POST,
        "/api/connect-failure",
        &[(COOKIE.as_str(), &cookie)],
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        response.headers().get(CONTENT_TYPE).unwrap(),
        "application/json"
    );
    let body = response_bytes(response).await;
    assert!(body.len() <= 256);
    assert_eq!(
        body,
        Bytes::from_static(b"{\"error\":\"backend_proxy_failed\"}")
    );
    assert!(!String::from_utf8_lossy(&body).contains(&unused_addr.to_string()));
    gateway.shutdown().await;
}

struct ActiveBackendRequest(Arc<AtomicUsize>);

impl Drop for ActiveBackendRequest {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn http_proxy_bounds_response_headers_without_timing_out_streaming_bodies() {
    let active_stalls = Arc::new(AtomicUsize::new(0));
    let observed_active_stalls = active_stalls.clone();
    let backend = FakeBackend::spawn(Arc::new(move |request| {
        let active_stalls = observed_active_stalls.clone();
        async move {
            match request.uri().path() {
                "/api/stalled-response-headers" => {
                    request.into_body().collect().await.unwrap();
                    active_stalls.fetch_add(1, Ordering::SeqCst);
                    let _active = ActiveBackendRequest(active_stalls);
                    std::future::pending::<Response<TestBody>>().await
                }
                "/api/slow-upload-before-headers" => {
                    let body = request.into_body().collect().await.unwrap().to_bytes();
                    assert_eq!(body, Bytes::from_static(b"slow-upload"));
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(full_test_body("upload-complete"))
                        .unwrap()
                }
                "/api/slow-download-after-headers" => {
                    let download = stream::unfold(0_usize, |index| async move {
                        if index == 8 {
                            return None;
                        }
                        tokio::time::sleep(Duration::from_millis(15)).await;
                        Some((
                            Ok::<_, io::Error>(Frame::data(Bytes::from_static(b"download"))),
                            index + 1,
                        ))
                    });
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(StreamBody::new(download).boxed_unsync())
                        .unwrap()
                }
                path => panic!("unexpected backend path: {path}"),
            }
        }
        .boxed()
    }))
    .await;
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        disabled_metrics(),
        GatewayLimits {
            backend_response_header_timeout: Duration::from_millis(30),
            ..GatewayLimits::test_defaults()
        },
    )
    .await
    .unwrap();
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();

    let stalled = tokio::time::timeout(
        Duration::from_millis(250),
        send_request(
            &gateway,
            Method::POST,
            "/api/stalled-response-headers",
            &[(COOKIE.as_str(), &cookie)],
        ),
    )
    .await
    .expect("backend response-header wait was not bounded");
    assert_eq!(stalled.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        response_bytes(stalled).await,
        Bytes::from_static(b"{\"error\":\"backend_proxy_failed\"}")
    );
    tokio::time::timeout(Duration::from_millis(250), async {
        while active_stalls.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cancelled response-header wait retained backend resources");

    let upload = stream::unfold(0_usize, |index| async move {
        if index == b"slow-upload".len() {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(15)).await;
        Some((
            Ok::<_, io::Error>(Frame::data(Bytes::from_static(
                &b"slow-upload"[index..index + 1],
            ))),
            index + 1,
        ))
    });
    let upload_response = send_request_to(
        gateway_addr(&gateway),
        gateway.public_authority(),
        Method::POST,
        "/api/slow-upload-before-headers",
        &[(COOKIE.as_str(), &cookie)],
        StreamBody::new(upload).boxed_unsync(),
    )
    .await;
    assert_eq!(upload_response.status(), StatusCode::OK);
    assert_eq!(
        response_bytes(upload_response).await,
        Bytes::from_static(b"upload-complete")
    );

    let download_response = send_request(
        &gateway,
        Method::GET,
        "/api/slow-download-after-headers",
        &[(COOKIE.as_str(), &cookie)],
    )
    .await;
    assert_eq!(download_response.status(), StatusCode::OK);
    assert_eq!(
        response_bytes(download_response).await,
        Bytes::from_static(b"downloaddownloaddownloaddownloaddownloaddownloaddownloaddownload")
    );

    gateway.shutdown().await;
    backend.shutdown().await;
}

#[tokio::test]
async fn http_proxy_discards_idle_backend_connections_when_generation_changes() {
    let old_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let backend_addr = old_listener.local_addr().unwrap();
    let old_requests = Arc::new(AtomicUsize::new(0));
    let old_request_counter = old_requests.clone();
    let (old_listener_released, old_listener_released_receiver) = oneshot::channel();
    let old_task = tokio::spawn(async move {
        let (stream, _) = old_listener.accept().await.unwrap();
        drop(old_listener);
        let _ = old_listener_released.send(());
        let service = service_fn(move |request: Request<Incoming>| {
            let old_requests = old_request_counter.clone();
            async move {
                request.into_body().collect().await.unwrap();
                old_requests.fetch_add(1, Ordering::SeqCst);
                Ok::<_, std::convert::Infallible>(
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(full_test_body("generation-n"))
                        .unwrap(),
                )
            }
        });
        let _ = http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .await;
    });

    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation_n = state.begin_backend_start().await.unwrap();
    state
        .backend_ready(generation_n, backend_addr)
        .await
        .unwrap();

    let warmup = send_request(
        &gateway,
        Method::GET,
        "/api/generation-n",
        &[(COOKIE.as_str(), &cookie)],
    )
    .await;
    assert_eq!(
        response_bytes(warmup).await,
        Bytes::from_static(b"generation-n")
    );
    old_listener_released_receiver.await.unwrap();

    let new_listener = TcpListener::bind(backend_addr).await.unwrap();
    let new_requests = Arc::new(AtomicUsize::new(0));
    let new_request_counter = new_requests.clone();
    let new_task = tokio::spawn(async move {
        let (stream, _) = new_listener.accept().await.unwrap();
        let service = service_fn(move |request: Request<Incoming>| {
            let new_requests = new_request_counter.clone();
            async move {
                let body = request.into_body().collect().await.unwrap().to_bytes();
                assert_eq!(body, Bytes::from_static(b"streamed-post"));
                new_requests.fetch_add(1, Ordering::SeqCst);
                Ok::<_, std::convert::Infallible>(
                    Response::builder()
                        .status(StatusCode::OK)
                        .body(full_test_body("generation-n-plus-one"))
                        .unwrap(),
                )
            }
        });
        let _ = http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .await;
    });

    state
        .fail_backend(generation_n, "generation n exited")
        .await
        .unwrap();
    let generation_n_plus_one = state.begin_backend_start().await.unwrap();
    state
        .backend_ready(generation_n_plus_one, backend_addr)
        .await
        .unwrap();

    let post_stream = stream::iter([
        Ok::<_, io::Error>(Frame::data(Bytes::from_static(b"streamed-"))),
        Ok::<_, io::Error>(Frame::data(Bytes::from_static(b"post"))),
    ]);
    let response = send_request_to(
        gateway_addr(&gateway),
        gateway.public_authority(),
        Method::POST,
        "/api/generation-n-plus-one",
        &[(COOKIE.as_str(), &cookie)],
        StreamBody::new(post_stream).boxed_unsync(),
    )
    .await;
    assert_eq!(
        response_bytes(response).await,
        Bytes::from_static(b"generation-n-plus-one")
    );
    assert_eq!(old_requests.load(Ordering::SeqCst), 1);
    assert_eq!(new_requests.load(Ordering::SeqCst), 1);

    gateway.shutdown().await;
    old_task.abort();
    new_task.abort();
    let _ = old_task.await;
    let _ = new_task.await;
}

#[tokio::test]
async fn http_proxy_does_not_replay_a_stale_pooled_streaming_post() {
    let old_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let backend_addr = old_listener.local_addr().unwrap();
    let streamed_posts = Arc::new(AtomicUsize::new(0));
    let observed_streamed_posts = streamed_posts.clone();
    let (old_listener_released, old_listener_released_receiver) = oneshot::channel();
    let old_task = tokio::spawn(async move {
        let (stream, _) = old_listener.accept().await.unwrap();
        drop(old_listener);
        let _ = old_listener_released.send(());
        let service = service_fn(move |request: Request<Incoming>| {
            let streamed_posts = observed_streamed_posts.clone();
            async move {
                if request.uri().path() == "/api/warm-pool" {
                    return Ok::<_, io::Error>(
                        Response::builder()
                            .status(StatusCode::OK)
                            .body(full_test_body("warm"))
                            .unwrap(),
                    );
                }
                let mut body = request.into_body();
                let first = body.frame().await.unwrap().unwrap();
                assert!(first.data_ref().is_some_and(|data| !data.is_empty()));
                streamed_posts.fetch_add(1, Ordering::SeqCst);
                Err(io::Error::new(
                    io::ErrorKind::ConnectionReset,
                    "intentional stale pooled connection reset",
                ))
            }
        });
        let _ = http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .await;
    });

    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend_addr).await.unwrap();

    let warmup = send_request(
        &gateway,
        Method::GET,
        "/api/warm-pool",
        &[(COOKIE.as_str(), &cookie)],
    )
    .await;
    assert_eq!(response_bytes(warmup).await, Bytes::from_static(b"warm"));
    old_listener_released_receiver.await.unwrap();
    let new_listener = TcpListener::bind(backend_addr).await.unwrap();

    let post_stream = stream::unfold(0_usize, |index| async move {
        if index == 8 {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
        Some((
            Ok::<_, io::Error>(Frame::data(Bytes::from_static(b"post-chunk"))),
            index + 1,
        ))
    });
    let response = send_request_to(
        gateway_addr(&gateway),
        gateway.public_authority(),
        Method::POST,
        "/api/stale-streaming-post",
        &[(COOKIE.as_str(), &cookie)],
        StreamBody::new(post_stream).boxed_unsync(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    assert_eq!(
        response_bytes(response).await,
        Bytes::from_static(b"{\"error\":\"backend_proxy_failed\"}")
    );
    assert_eq!(streamed_posts.load(Ordering::SeqCst), 1);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), new_listener.accept())
            .await
            .is_err(),
        "the non-idempotent streaming POST was replayed on a new connection"
    );

    gateway.shutdown().await;
    let _ = old_task.await;
}

#[tokio::test]
async fn http_proxy_streams_32_mib_upload_and_download_without_aggregation() {
    let upload_produced = Arc::new(AtomicUsize::new(0));
    let download_produced = Arc::new(AtomicUsize::new(0));
    let (first_upload_sender, first_upload_receiver) = oneshot::channel();
    let first_upload_sender = Arc::new(Mutex::new(Some(first_upload_sender)));
    let (upload_total_sender, upload_total_receiver) = oneshot::channel();
    let upload_total_sender = Arc::new(Mutex::new(Some(upload_total_sender)));
    let backend_download_produced = download_produced.clone();
    let backend = FakeBackend::spawn(Arc::new(move |request| {
        let first_upload_sender = first_upload_sender.clone();
        let upload_total_sender = upload_total_sender.clone();
        let download_produced = backend_download_produced.clone();
        async move {
            let mut body = request.into_body();
            let mut upload_total = 0_usize;
            while let Some(frame) = body.frame().await {
                let frame = frame.unwrap();
                if let Some(data) = frame.data_ref() {
                    assert!(data.iter().all(|byte| *byte == 7));
                    upload_total += data.len();
                    if let Some(sender) = first_upload_sender.lock().await.take() {
                        let _ = sender.send(());
                    }
                }
            }
            upload_total_sender
                .lock()
                .await
                .take()
                .unwrap()
                .send(upload_total)
                .unwrap();

            let download_stream = stream::unfold(0_usize, move |index| {
                let download_produced = download_produced.clone();
                async move {
                    if index == STREAM_CHUNK_COUNT {
                        return None;
                    }
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    download_produced.fetch_add(1, Ordering::SeqCst);
                    Some((
                        Ok::<_, io::Error>(Frame::data(Bytes::from_static(DOWNLOAD_CHUNK))),
                        index + 1,
                    ))
                }
            });
            Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/octet-stream")
                .body(StreamBody::new(download_stream).boxed_unsync())
                .unwrap()
        }
        .boxed()
    }))
    .await;
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();

    let producer_counter = upload_produced.clone();
    let upload_stream = stream::unfold(0_usize, move |index| {
        let producer_counter = producer_counter.clone();
        async move {
            if index == STREAM_CHUNK_COUNT {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
            producer_counter.fetch_add(1, Ordering::SeqCst);
            Some((
                Ok::<_, io::Error>(Frame::data(Bytes::from_static(UPLOAD_CHUNK))),
                index + 1,
            ))
        }
    });
    let gateway_addr = gateway_addr(&gateway);
    let public_authority = gateway.public_authority();
    let upload_request = tokio::spawn(async move {
        send_request_to(
            gateway_addr,
            public_authority,
            Method::POST,
            "/large-transfer?kind=stream",
            &[(COOKIE.as_str(), cookie.as_str())],
            StreamBody::new(upload_stream).boxed_unsync(),
        )
        .await
    });

    tokio::time::timeout(Duration::from_secs(2), first_upload_receiver)
        .await
        .expect("backend did not receive the first streamed upload chunk")
        .unwrap();
    assert!(
        upload_produced.load(Ordering::SeqCst) < STREAM_CHUNK_COUNT,
        "gateway buffered the complete upload before forwarding"
    );

    let response = tokio::time::timeout(Duration::from_secs(10), upload_request)
        .await
        .expect("streaming upload did not complete")
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        download_produced.load(Ordering::SeqCst) < STREAM_CHUNK_COUNT,
        "gateway buffered the complete download before returning response headers"
    );

    let mut body = response.into_body();
    let first_data = loop {
        let frame = body
            .frame()
            .await
            .expect("streaming download ended before its first data frame")
            .unwrap();
        if let Some(data) = frame.into_data().ok() {
            break data;
        }
    };
    assert!(first_data.iter().all(|byte| *byte == 9));
    assert!(
        download_produced.load(Ordering::SeqCst) < STREAM_CHUNK_COUNT,
        "gateway buffered the complete download before forwarding its first body frame"
    );
    let mut download_total = first_data.len();
    while let Some(frame) = body.frame().await {
        let frame = frame.unwrap();
        if let Some(data) = frame.data_ref() {
            assert!(data.iter().all(|byte| *byte == 9));
            download_total += data.len();
        }
    }
    assert_eq!(upload_total_receiver.await.unwrap(), STREAM_BYTE_COUNT);
    assert_eq!(download_total, STREAM_BYTE_COUNT);
    assert_eq!(upload_produced.load(Ordering::SeqCst), STREAM_CHUNK_COUNT);
    assert_eq!(download_produced.load(Ordering::SeqCst), STREAM_CHUNK_COUNT);
    gateway.shutdown().await;
    backend.shutdown().await;
}

#[tokio::test]
async fn websocket_proxy_tunnels_socket_io_frames_and_rewrites_only_private_host() {
    let backend = FakeWebSocketBackend::spawn_echo().await;
    let backend_authority = backend.addr.to_string();
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();
    let public_origin = format!("http://{}", gateway.public_authority());
    let mut request = format!(
        "ws://{}/socket.io/?EIO=4&transport=websocket",
        gateway.public_authority()
    )
    .into_client_request()
    .unwrap();
    request
        .headers_mut()
        .insert(COOKIE, cookie.parse().unwrap());
    request
        .headers_mut()
        .insert(ORIGIN, public_origin.parse().unwrap());

    let (mut socket, response) = connect_async(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    assert_eq!(
        response
            .headers()
            .get_all(SET_COOKIE)
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["theme=dark; Path=/"]
    );
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        Message::Text("backend-text".into())
    );
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        Message::Binary(vec![9_u8, 8, 7].into())
    );

    socket
        .send(Message::Text("public-text".into()))
        .await
        .unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        Message::Text("public-text".into())
    );
    socket
        .send(Message::Binary(vec![1_u8, 2, 3, 4].into()))
        .await
        .unwrap();
    assert_eq!(
        socket.next().await.unwrap().unwrap(),
        Message::Binary(vec![1_u8, 2, 3, 4].into())
    );
    socket.close(None).await.unwrap();

    let observed = backend.finish().await;
    let observed = &observed[0];
    assert_eq!(observed.target, "/socket.io/?EIO=4&transport=websocket");
    assert_eq!(observed.host, backend_authority);
    assert_eq!(observed.origin, public_origin);
    assert_eq!(observed.cookie, None);
    gateway.shutdown().await;
}

#[tokio::test]
async fn websocket_proxy_fails_closed_for_invalid_auth_origin_route_and_handshake() {
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let public_origin = format!("http://{}", gateway.public_authority());

    let unauthenticated = websocket_client_request(
        &gateway,
        None,
        "/socket.io/?EIO=4&transport=websocket",
        Some(&public_origin),
    );
    assert_eq!(
        websocket_failure_status(unauthenticated).await,
        StatusCode::NOT_FOUND
    );

    let foreign_origin = websocket_client_request(
        &gateway,
        Some(&cookie),
        "/socket.io/?EIO=4&transport=websocket",
        Some("http://foreign.invalid"),
    );
    assert_eq!(
        websocket_failure_status(foreign_origin).await,
        StatusCode::NOT_FOUND
    );

    let static_upgrade =
        websocket_client_request(&gateway, Some(&cookie), "/bundle.js", Some(&public_origin));
    assert_eq!(
        websocket_failure_status(static_upgrade).await,
        StatusCode::NOT_FOUND
    );

    let wrong_socket_io_target = websocket_client_request(
        &gateway,
        Some(&cookie),
        "/socket.io/?EIO=4&transport=polling",
        Some(&public_origin),
    );
    assert_eq!(
        websocket_failure_status(wrong_socket_io_target).await,
        StatusCode::BAD_REQUEST
    );

    let malformed = format!(
        "GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: {}\r\nCookie: {cookie}\r\nOrigin: {public_origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n\r\n",
        gateway.public_authority()
    );
    let response = raw_http_exchange(gateway_addr(&gateway), malformed.as_bytes()).await;
    assert!(response.starts_with(b"HTTP/1.1 400"));
    assert!(response.len() <= 1024);
    assert!(!response
        .windows(cookie.len())
        .any(|window| window == cookie.as_bytes()));

    gateway.shutdown().await;
}

#[tokio::test]
async fn websocket_proxy_never_downgrades_a_malformed_websocket_attempt_to_http() {
    let deliveries = Arc::new(AtomicUsize::new(0));
    let backend_deliveries = deliveries.clone();
    let backend = FakeBackend::spawn(Arc::new(move |_request| {
        let backend_deliveries = backend_deliveries.clone();
        async move {
            backend_deliveries.fetch_add(1, Ordering::SeqCst);
            Response::builder()
                .status(StatusCode::OK)
                .body(full_test_body("unexpected HTTP downgrade"))
                .unwrap()
        }
        .boxed()
    }))
    .await;
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();
    let public_origin = format!("http://{}", gateway.public_authority());
    let malformed = format!(
        "GET /socket.io/?EIO=4&transport=websocket HTTP/1.1\r\nHost: {}\r\nCookie: {cookie}\r\nOrigin: {public_origin}\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        gateway.public_authority()
    );

    let response = raw_http_exchange(gateway_addr(&gateway), malformed.as_bytes()).await;
    assert!(response.starts_with(b"HTTP/1.1 400"));
    assert_eq!(deliveries.load(Ordering::SeqCst), 0);
    gateway.shutdown().await;
    backend.shutdown().await;
}

#[tokio::test]
async fn websocket_proxy_terminates_tunnel_when_backend_generation_changes() {
    let backend = FakeWebSocketBackend::spawn_echo().await;
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();
    let public_origin = format!("http://{}", gateway.public_authority());
    let request = websocket_client_request(
        &gateway,
        Some(&cookie),
        "/socket.io/?EIO=4&transport=websocket",
        Some(&public_origin),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    consume_backend_websocket_greeting(&mut socket).await;

    state
        .fail_backend(generation, "private generation diagnostic")
        .await
        .unwrap();
    let next_generation = state.begin_backend_start().await.unwrap();
    assert!(next_generation > generation);
    let terminal = tokio::time::timeout(Duration::from_secs(1), socket.next())
        .await
        .expect("generation change did not terminate the public tunnel");
    assert!(terminal.is_none() || terminal.is_some_and(|message| message.is_err()));

    assert_eq!(backend.finish().await.len(), 1);
    gateway.shutdown().await;
}

#[tokio::test]
async fn websocket_proxy_terminates_tunnel_during_gateway_shutdown() {
    let backend = FakeWebSocketBackend::spawn_echo().await;
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();
    let public_origin = format!("http://{}", gateway.public_authority());
    let request = websocket_client_request(
        &gateway,
        Some(&cookie),
        "/socket.io/?EIO=4&transport=websocket",
        Some(&public_origin),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();
    consume_backend_websocket_greeting(&mut socket).await;

    let shutdown = tokio::spawn(gateway.shutdown());
    let terminal = tokio::time::timeout(Duration::from_secs(1), socket.next())
        .await
        .expect("gateway shutdown did not terminate the public tunnel");
    assert!(terminal.is_none() || terminal.is_some_and(|message| message.is_err()));
    tokio::time::timeout(Duration::from_secs(1), shutdown)
        .await
        .expect("gateway shutdown exceeded its bound")
        .unwrap();
    assert_eq!(backend.finish().await.len(), 1);
}

#[tokio::test]
async fn websocket_proxy_propagates_backend_close_to_the_public_side() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
    let backend_addr = listener.local_addr().unwrap();
    let backend_task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut socket = accept_hdr_async(
            stream,
            |_request: &WebSocketRequest, response: WebSocketResponse| Ok(response),
        )
        .await
        .unwrap();
        socket.close(None).await.unwrap();
    });
    let frontend = TemporaryFrontend::new();
    let gateway = bind_gateway(&frontend).await;
    let cookie = bootstrap_session(&gateway).await;
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend_addr).await.unwrap();
    let public_origin = format!("http://{}", gateway.public_authority());
    let request = websocket_client_request(
        &gateway,
        Some(&cookie),
        "/socket.io/?EIO=4&transport=websocket",
        Some(&public_origin),
    );
    let (mut socket, _) = connect_async(request).await.unwrap();

    let close = tokio::time::timeout(Duration::from_secs(1), socket.next())
        .await
        .expect("backend close was not forwarded")
        .expect("public socket ended before receiving close")
        .unwrap();
    assert!(matches!(close, Message::Close(_)));
    let terminal = tokio::time::timeout(Duration::from_secs(1), socket.next())
        .await
        .expect("backend close did not terminate the public stream");
    assert!(terminal.is_none() || terminal.is_some_and(|message| message.is_err()));
    backend_task.await.unwrap();
    gateway.shutdown().await;
}

#[tokio::test]
async fn websocket_proxy_records_rpc_once_after_backend_101_and_never_on_failure() {
    let (failed_reports_sender, failed_reports) = mpsc::channel();
    let failed_metrics = StartupMetrics::with_clock_and_writer(
        "test",
        "test",
        7,
        StartupMode::RustGateway,
        Arc::new(ZeroClock),
        Box::new(ChannelWriter(failed_reports_sender)),
    );
    failed_metrics
        .record(StartupMilestone::ProcessStarted)
        .unwrap();
    let failed_backend = RawResponseBackend::spawn(vec![
        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
    ])
    .await;
    let failed_frontend = TemporaryFrontend::new();
    let failed_gateway = StartupGateway::bind(
        failed_frontend.root.clone(),
        failed_metrics.clone(),
        GatewayLimits::test_defaults(),
    )
    .await
    .unwrap();
    let failed_cookie = bootstrap_session(&failed_gateway).await;
    failed_metrics
        .record(StartupMilestone::FrontendRequestStarted)
        .unwrap();
    failed_metrics
        .record(StartupMilestone::BackendSpawned)
        .unwrap();
    let failed_state = failed_gateway.state();
    let failed_generation = failed_state.begin_backend_start().await.unwrap();
    failed_state
        .backend_ready(failed_generation, failed_backend.addr)
        .await
        .unwrap();
    failed_metrics
        .record(StartupMilestone::BackendListening)
        .unwrap();
    receive_report_with_milestone(&failed_reports, "backend_listening");
    let failed_origin = format!("http://{}", failed_gateway.public_authority());
    let failed_request = websocket_client_request(
        &failed_gateway,
        Some(&failed_cookie),
        "/socket.io/?EIO=4&transport=websocket",
        Some(&failed_origin),
    );
    assert_eq!(
        websocket_failure_status(failed_request).await,
        StatusCode::BAD_GATEWAY
    );
    assert!(failed_reports
        .recv_timeout(Duration::from_millis(100))
        .is_err());
    failed_gateway.shutdown().await;
    failed_backend.finish().await;

    let (reports_sender, reports) = mpsc::channel();
    let metrics = StartupMetrics::with_clock_and_writer(
        "test",
        "test",
        8,
        StartupMode::RustGateway,
        Arc::new(ZeroClock),
        Box::new(ChannelWriter(reports_sender)),
    );
    metrics.record(StartupMilestone::ProcessStarted).unwrap();
    let backend = FakeWebSocketBackend::spawn_echo_connections(2).await;
    let frontend = TemporaryFrontend::new();
    let gateway = StartupGateway::bind(
        frontend.root.clone(),
        metrics.clone(),
        GatewayLimits::test_defaults(),
    )
    .await
    .unwrap();
    let cookie = bootstrap_session(&gateway).await;
    metrics
        .record(StartupMilestone::FrontendRequestStarted)
        .unwrap();
    metrics.record(StartupMilestone::BackendSpawned).unwrap();
    let state = gateway.state();
    let generation = state.begin_backend_start().await.unwrap();
    state.backend_ready(generation, backend.addr).await.unwrap();
    metrics.record(StartupMilestone::BackendListening).unwrap();
    receive_report_with_milestone(&reports, "backend_listening");
    let public_origin = format!("http://{}", gateway.public_authority());

    for _ in 0..2 {
        let request = websocket_client_request(
            &gateway,
            Some(&cookie),
            "/socket.io/?EIO=4&transport=websocket",
            Some(&public_origin),
        );
        let (mut socket, _) = connect_async(request).await.unwrap();
        consume_backend_websocket_greeting(&mut socket).await;
        socket.close(None).await.unwrap();
    }
    receive_report_with_milestone(&reports, "rpc_connected");
    assert!(reports.recv_timeout(Duration::from_millis(100)).is_err());
    assert_eq!(backend.finish().await.len(), 2);
    gateway.shutdown().await;
}
