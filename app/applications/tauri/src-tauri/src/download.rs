/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use std::{
    collections::HashMap,
    fs::{self, File as StdFile},
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

use flate2::read::GzDecoder;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{fs as tokio_fs, io::AsyncWriteExt, sync::Semaphore};
use uuid::Uuid;

const DEFAULT_MAX_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_MAX_PLUGIN_DOWNLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_EXTRACTED_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const MAX_CONCURRENT_DOWNLOADS: usize = 3;
const CONNECT_TIMEOUT_SECONDS: u64 = 30;
const REQUEST_TIMEOUT_SECONDS: u64 = 30 * 60;

const STATUS_QUEUED: &str = "queued";
const STATUS_RUNNING: &str = "running";
const STATUS_COMPLETED: &str = "completed";
const STATUS_FAILED: &str = "failed";
const STATUS_CANCELING: &str = "canceling";
const STATUS_CANCELED: &str = "canceled";

#[derive(Clone)]
pub struct DownloadManager {
    records: Arc<Mutex<HashMap<String, DownloadRecord>>>,
    concurrency: Arc<Semaphore>,
}

struct DownloadRecord {
    task: DownloadTask,
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DownloadStartRequest {
    pub url: String,
    pub target_dir: Option<String>,
    pub filename: Option<String>,
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DownloadCancelRequest {
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PluginDownloadRequest {
    pub id: Option<String>,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ConfiguredPluginsRequest {
    pub ids: Option<Vec<String>>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadTask {
    pub id: String,
    pub url: String,
    pub status: String,
    pub kind: Option<String>,
    pub bytes_downloaded: u64,
    pub total_bytes: Option<u64>,
    pub percent: Option<f64>,
    pub target_path: Option<String>,
    pub sha256: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadFinishedEvent {
    pub id: String,
    pub target_path: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DownloadFailedEvent {
    pub id: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct InstalledPlugin {
    pub plugin_id: String,
    pub target_dir: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PluginDownloadResult {
    pub plugin_id: String,
    pub url: String,
    pub download_id: String,
    pub target_dir: Option<String>,
    pub installed_plugins: Vec<InstalledPlugin>,
}

#[derive(Deserialize)]
struct TheiaPackageConfig {
    #[serde(rename = "theiaPlugins")]
    theia_plugins: Option<HashMap<String, String>>,
}

#[derive(Deserialize)]
struct ExtensionPackage {
    name: String,
    publisher: Option<String>,
}

struct CompletedDownload {
    id: String,
    target_path: PathBuf,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            records: Arc::new(Mutex::new(HashMap::new())),
            concurrency: Arc::new(Semaphore::new(MAX_CONCURRENT_DOWNLOADS)),
        }
    }

    pub fn list(&self) -> Vec<DownloadTask> {
        let mut tasks = self
            .records
            .lock()
            .unwrap()
            .values()
            .map(|record| record.task.clone())
            .collect::<Vec<_>>();
        tasks.sort_by(|left, right| left.id.cmp(&right.id));
        tasks
    }

    pub fn cancel(&self, id: &str) -> bool {
        let mut records = self.records.lock().unwrap();
        let Some(record) = records.get_mut(id) else {
            return false;
        };

        if matches!(
            record.task.status.as_str(),
            STATUS_COMPLETED | STATUS_FAILED | STATUS_CANCELED
        ) {
            return false;
        }

        record.cancel.store(true, Ordering::SeqCst);
        record.task.status = if record.task.status == STATUS_QUEUED {
            STATUS_CANCELED.to_string()
        } else {
            STATUS_CANCELING.to_string()
        };
        record.task.error = Some("Download cancelled".to_string());
        true
    }

    pub fn start_download(
        &self,
        app: AppHandle,
        request: DownloadStartRequest,
    ) -> Result<DownloadTask, String> {
        let parsed_url = parse_http_url(&request.url)?;
        validate_initial_url_policy(&parsed_url)?;
        let target_path = resolve_download_target(&parsed_url, &request)?;
        let (task, cancel) = self.insert_task(&request, target_path.clone())?;
        let manager = self.clone();
        let task_id = task.id.clone();
        let request_url = request.url.clone();

        tauri::async_runtime::spawn(async move {
            if let Err(error) = manager
                .run_download(
                    Some(app.clone()),
                    task_id.clone(),
                    request_url,
                    target_path,
                    cancel,
                )
                .await
            {
                manager.fail_task_unless_canceled(Some(&app), &task_id, error);
            }
        });

        Ok(task)
    }

    pub async fn download_plugin(
        &self,
        app: AppHandle,
        request: PluginDownloadRequest,
    ) -> Result<PluginDownloadResult, String> {
        let (plugin_key, url) = self.resolve_plugin_request(&app, request)?;
        let parsed_url = parse_http_url(&url)?;
        validate_initial_url_policy(&parsed_url)?;
        let extension = archive_extension_from_url(&parsed_url)
            .ok_or_else(|| "Plugin URL must end with .vsix or .tar.gz".to_string())?;
        let filename = format!("{}.{}", sanitize_path_segment(&plugin_key)?, extension);
        let cache_dir = ride_downloads_dir()?;
        let download_request = DownloadStartRequest {
            url: url.clone(),
            target_dir: Some(cache_dir.to_string_lossy().to_string()),
            filename: Some(filename),
            kind: Some("plugin".to_string()),
        };
        let target_path = resolve_download_target(&parsed_url, &download_request)?;
        let (task, cancel) = self.insert_task(&download_request, target_path.clone())?;
        let completed = match self
            .run_download(
                Some(app.clone()),
                task.id.clone(),
                url.clone(),
                target_path,
                cancel,
            )
            .await
        {
            Ok(completed) => completed,
            Err(error) => {
                self.fail_task_unless_canceled(Some(&app), &task.id, error.clone());
                return Err(error);
            }
        };

        let installed_plugins = install_plugin_archive(&completed.target_path, Some(&plugin_key))
            .map_err(|error| {
            let message = format!("Failed to install plugin archive: {}", error);
            self.fail_task_unless_canceled(Some(&app), &completed.id, message.clone());
            message
        })?;

        for plugin in &installed_plugins {
            let _ = app.emit("plugin-download-finished", plugin);
        }

        Ok(PluginDownloadResult {
            plugin_id: plugin_key,
            url,
            download_id: completed.id,
            target_dir: installed_plugins
                .first()
                .map(|plugin| plugin.target_dir.clone()),
            installed_plugins,
        })
    }

    pub async fn download_configured_plugins(
        &self,
        app: AppHandle,
        request: ConfiguredPluginsRequest,
    ) -> Result<Vec<PluginDownloadResult>, String> {
        let configured_plugins = read_configured_plugins(&app)?;
        let plugin_ids = request.ids.unwrap_or_else(|| {
            let mut ids = configured_plugins.keys().cloned().collect::<Vec<_>>();
            ids.sort();
            ids
        });

        let mut results = Vec::new();
        for plugin_id in plugin_ids {
            let url = configured_plugins
                .get(&plugin_id)
                .ok_or_else(|| format!("Configured plugin not found: {}", plugin_id))?
                .clone();
            results.push(
                self.download_plugin(
                    app.clone(),
                    PluginDownloadRequest {
                        id: Some(plugin_id),
                        url: Some(url),
                    },
                )
                .await?,
            );
        }

        Ok(results)
    }

    fn resolve_plugin_request(
        &self,
        app: &AppHandle,
        request: PluginDownloadRequest,
    ) -> Result<(String, String), String> {
        let configured_plugins = read_configured_plugins(app)?;
        let allow_untrusted = allow_untrusted_plugin_downloads();

        match (request.id, request.url) {
            (Some(id), Some(url)) => {
                let id = sanitize_path_segment(&id)?;
                if !allow_untrusted
                    && configured_plugins
                        .get(&id)
                        .map(|configured_url| configured_url != &url)
                        .unwrap_or(true)
                {
                    return Err(format!(
                        "Plugin URL is not allowlisted for {id}; use a configured plugin id"
                    ));
                }
                Ok((id, url))
            }
            (Some(id), None) => {
                let id = sanitize_path_segment(&id)?;
                let url = configured_plugins
                    .get(&id)
                    .ok_or_else(|| format!("Configured plugin not found: {}", id))?
                    .clone();
                Ok((id, url))
            }
            (None, Some(url)) => {
                if !allow_untrusted {
                    return Err(
                        "Arbitrary plugin URLs are disabled; use a configured plugin id"
                            .to_string(),
                    );
                }
                let parsed_url = parse_http_url(&url)?;
                let key = filename_from_url(&parsed_url)
                    .and_then(|filename| {
                        filename
                            .strip_suffix(".vsix")
                            .or_else(|| filename.strip_suffix(".tar.gz"))
                            .map(|value| value.to_string())
                    })
                    .unwrap_or_else(|| Uuid::new_v4().to_string());
                Ok((key, url))
            }
            (None, None) => Err("Plugin download requires an id or url".to_string()),
        }
    }

    fn insert_task(
        &self,
        request: &DownloadStartRequest,
        target_path: PathBuf,
    ) -> Result<(DownloadTask, Arc<AtomicBool>), String> {
        let id = Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let task = DownloadTask {
            id: id.clone(),
            url: request.url.clone(),
            status: STATUS_QUEUED.to_string(),
            kind: request.kind.clone(),
            bytes_downloaded: 0,
            total_bytes: None,
            percent: None,
            target_path: Some(target_path.to_string_lossy().to_string()),
            sha256: None,
            error: None,
        };

        let mut records = self.records.lock().unwrap();
        let target = task.target_path.as_deref();
        let target_in_use = records.values().any(|record| {
            record.task.target_path.as_deref() == target
                && !matches!(
                    record.task.status.as_str(),
                    STATUS_COMPLETED | STATUS_FAILED | STATUS_CANCELED
                )
        });
        if target_in_use {
            return Err(format!(
                "Another download is already writing {}",
                target_path.display()
            ));
        }

        records.insert(
            id,
            DownloadRecord {
                task: task.clone(),
                cancel: cancel.clone(),
            },
        );

        Ok((task, cancel))
    }

    async fn run_download(
        &self,
        app: Option<AppHandle>,
        id: String,
        url: String,
        target_path: PathBuf,
        cancel: Arc<AtomicBool>,
    ) -> Result<CompletedDownload, String> {
        let _permit = self
            .concurrency
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| "Download manager is shutting down".to_string())?;

        if cancel.load(Ordering::SeqCst) {
            self.cancel_task(app.as_ref(), &id, None);
            return Err("Download cancelled".to_string());
        }

        let parsed_url = parse_http_url(&url)?;
        let response = send_download_request(parsed_url).await?;

        if !response.status().is_success() {
            return Err(format!("Download failed with HTTP {}", response.status()));
        }

        let total_bytes = response.content_length();
        let max_bytes = self.max_bytes_for_task(&id);
        if total_bytes.is_some_and(|total| total > max_bytes) {
            return Err(format!(
                "Download exceeds the {} byte size limit",
                max_bytes
            ));
        }
        self.update_task(&id, |task| {
            task.status = STATUS_RUNNING.to_string();
            task.total_bytes = total_bytes;
        });
        self.emit_progress(app.as_ref(), &id);

        if let Some(parent) = target_path.parent() {
            tokio_fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Failed to create target directory: {}", error))?;
        }

        let part_path = part_path_for(&target_path, &id)?;
        let mut file = tokio_fs::File::create(&part_path)
            .await
            .map_err(|error| format!("Failed to create temporary download file: {}", error))?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::SeqCst) {
                self.cancel_task(app.as_ref(), &id, Some(&part_path));
                return Err("Download cancelled".to_string());
            }

            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    let _ = tokio_fs::remove_file(&part_path).await;
                    return Err(format!("Failed to read download stream: {}", error));
                }
            };
            if downloaded.saturating_add(chunk.len() as u64) > max_bytes {
                let _ = tokio_fs::remove_file(&part_path).await;
                return Err(format!(
                    "Download exceeds the {} byte size limit",
                    max_bytes
                ));
            }
            if let Err(error) = file.write_all(&chunk).await {
                let _ = tokio_fs::remove_file(&part_path).await;
                return Err(format!("Failed to write download file: {}", error));
            }
            hasher.update(&chunk);
            downloaded += chunk.len() as u64;

            self.update_task(&id, |task| {
                task.bytes_downloaded = downloaded;
                task.total_bytes = total_bytes;
                task.percent = total_bytes
                    .filter(|total| *total > 0)
                    .map(|total| (downloaded as f64 / total as f64) * 100.0);
            });
            self.emit_progress(app.as_ref(), &id);
        }

        if cancel.load(Ordering::SeqCst) {
            self.cancel_task(app.as_ref(), &id, Some(&part_path));
            return Err("Download cancelled".to_string());
        }

        if let Err(error) = file.flush().await {
            let _ = tokio_fs::remove_file(&part_path).await;
            return Err(format!("Failed to flush download file: {}", error));
        }
        drop(file);

        if let Err(error) = replace_completed_download(&part_path, &target_path).await {
            let _ = tokio_fs::remove_file(&part_path).await;
            return Err(error);
        }

        let sha256 = to_hex(&hasher.finalize());
        self.update_task(&id, |task| {
            task.status = STATUS_COMPLETED.to_string();
            task.bytes_downloaded = downloaded;
            task.total_bytes = total_bytes;
            task.percent = Some(100.0);
            task.sha256 = Some(sha256.clone());
            task.error = None;
        });
        self.emit_progress(app.as_ref(), &id);

        let finished = DownloadFinishedEvent {
            id: id.clone(),
            target_path: target_path.to_string_lossy().to_string(),
            sha256: sha256.clone(),
        };
        if let Some(app) = app.as_ref() {
            let _ = app.emit("download-finished", finished);
        }

        Ok(CompletedDownload { id, target_path })
    }

    fn cancel_task(&self, app: Option<&AppHandle>, id: &str, partial_path: Option<&Path>) {
        if let Some(partial_path) = partial_path {
            let _ = fs::remove_file(partial_path);
        }
        self.update_task(id, |task| {
            task.status = STATUS_CANCELED.to_string();
            task.error = Some("Download cancelled".to_string());
        });
        self.emit_progress(app, id);
    }

    fn fail_task(&self, app: Option<&AppHandle>, id: &str, message: String) {
        self.update_task(id, |task| {
            task.status = STATUS_FAILED.to_string();
            task.error = Some(message.clone());
        });
        self.emit_progress(app, id);
        if let Some(app) = app {
            let _ = app.emit(
                "download-failed",
                DownloadFailedEvent {
                    id: id.to_string(),
                    message,
                },
            );
        }
    }

    fn fail_task_unless_canceled(&self, app: Option<&AppHandle>, id: &str, message: String) {
        let canceled = self
            .records
            .lock()
            .unwrap()
            .get(id)
            .map(|record| {
                matches!(
                    record.task.status.as_str(),
                    STATUS_CANCELING | STATUS_CANCELED
                ) || record.cancel.load(Ordering::SeqCst)
            })
            .unwrap_or(false);
        if !canceled {
            self.fail_task(app, id, message);
        }
    }

    fn max_bytes_for_task(&self, id: &str) -> u64 {
        let plugin_download = self
            .records
            .lock()
            .unwrap()
            .get(id)
            .and_then(|record| record.task.kind.as_deref())
            == Some("plugin");
        max_download_bytes(plugin_download)
    }

    fn update_task<F>(&self, id: &str, update: F)
    where
        F: FnOnce(&mut DownloadTask),
    {
        if let Some(record) = self.records.lock().unwrap().get_mut(id) {
            update(&mut record.task);
        }
    }

    fn emit_progress(&self, app: Option<&AppHandle>, id: &str) {
        let task = self
            .records
            .lock()
            .unwrap()
            .get(id)
            .map(|record| record.task.clone());

        if let (Some(app), Some(task)) = (app, task) {
            let _ = app.emit("download-progress", task);
        }
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_http_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url).map_err(|error| format!("Invalid URL: {}", error))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        scheme => Err(format!("Unsupported URL scheme: {}", scheme)),
    }
}

fn validate_initial_url_policy(url: &reqwest::Url) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Download URLs cannot contain credentials".to_string());
    }

    if url.scheme() == "http" && !allow_insecure_downloads() {
        return Err(
            "Plain HTTP downloads are disabled; use HTTPS or set RIDE_ALLOW_INSECURE_DOWNLOADS=1"
                .to_string(),
        );
    }

    if !allow_private_downloads() && is_obviously_private_url(url) {
        return Err(
            "Downloads from loopback or private network addresses are disabled".to_string(),
        );
    }

    Ok(())
}

async fn send_download_request(initial_url: reqwest::Url) -> Result<reqwest::Response, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(CONNECT_TIMEOUT_SECONDS))
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECONDS));
    if is_loopback_url(&initial_url) {
        builder = builder.no_proxy();
    }
    let client = builder
        .build()
        .map_err(|error| format!("Failed to create download client: {}", error))?;

    let mut url = initial_url;
    for redirect_count in 0..=MAX_REDIRECTS {
        validate_initial_url_policy(&url)?;
        validate_resolved_destination(&url).await?;

        let response = client
            .get(url.clone())
            .send()
            .await
            .map_err(|error| format!("Failed to start download: {}", error))?;

        if !response.status().is_redirection() {
            return Ok(response);
        }
        if redirect_count == MAX_REDIRECTS {
            return Err(format!("Download exceeded {} redirects", MAX_REDIRECTS));
        }

        let location = response
            .headers()
            .get(reqwest::header::LOCATION)
            .ok_or_else(|| "Download redirect is missing a Location header".to_string())?
            .to_str()
            .map_err(|_| "Download redirect contains an invalid Location header".to_string())?;
        url = url
            .join(location)
            .map_err(|error| format!("Invalid download redirect: {}", error))?;
    }

    Err("Download redirect limit reached".to_string())
}

async fn validate_resolved_destination(url: &reqwest::Url) -> Result<(), String> {
    if allow_private_downloads() {
        return Ok(());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "Download URL is missing a host".to_string())?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| "Download URL is missing a port".to_string())?;
    let addresses = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::net::lookup_host((host, port)),
    )
    .await
    .map_err(|_| "Timed out resolving download host".to_string())?
    .map_err(|error| format!("Failed to resolve download host: {}", error))?;

    let mut resolved = false;
    for address in addresses {
        resolved = true;
        if !is_public_ip(address.ip()) {
            return Err(format!(
                "Download host resolved to blocked address {}",
                address.ip()
            ));
        }
    }
    if !resolved {
        return Err("Download host did not resolve to an address".to_string());
    }
    Ok(())
}

fn is_loopback_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };

    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

fn is_obviously_private_url(url: &reqwest::Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    let normalized = host.trim_end_matches('.').to_ascii_lowercase();
    if normalized == "localhost"
        || normalized.ends_with(".localhost")
        || normalized.ends_with(".local")
    {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| !is_public_ip(ip))
        .unwrap_or(false)
}

fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let octets = ip.octets();
            !ip.is_private()
                && !ip.is_loopback()
                && !ip.is_link_local()
                && !ip.is_multicast()
                && !ip.is_broadcast()
                && !ip.is_documentation()
                && !ip.is_unspecified()
                && octets[0] != 0
                && !(octets[0] == 100 && (64..=127).contains(&octets[1]))
                && !(octets[0] == 198 && (18..=19).contains(&octets[1]))
        }
        std::net::IpAddr::V6(ip) => {
            !ip.is_loopback()
                && !ip.is_unspecified()
                && !ip.is_multicast()
                && !ip.is_unique_local()
                && !ip.is_unicast_link_local()
        }
    }
}

fn env_flag(name: &str) -> bool {
    std::env::var(name)
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn allow_insecure_downloads() -> bool {
    cfg!(test) || env_flag("RIDE_ALLOW_INSECURE_DOWNLOADS")
}

fn allow_private_downloads() -> bool {
    cfg!(test) || env_flag("RIDE_ALLOW_PRIVATE_DOWNLOADS")
}

fn allow_untrusted_plugin_downloads() -> bool {
    cfg!(test) || env_flag("RIDE_ALLOW_UNTRUSTED_PLUGIN_DOWNLOADS")
}

fn max_download_bytes(plugin_download: bool) -> u64 {
    let variable = if plugin_download {
        "RIDE_MAX_PLUGIN_DOWNLOAD_BYTES"
    } else {
        "RIDE_MAX_DOWNLOAD_BYTES"
    };
    std::env::var(variable)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(if plugin_download {
            DEFAULT_MAX_PLUGIN_DOWNLOAD_BYTES
        } else {
            DEFAULT_MAX_DOWNLOAD_BYTES
        })
}

fn resolve_download_target(
    parsed_url: &reqwest::Url,
    request: &DownloadStartRequest,
) -> Result<PathBuf, String> {
    let downloads_dir = normalize_absolute_path(&ride_downloads_dir()?)?;
    let requested_dir = request
        .target_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| downloads_dir.clone());
    let target_dir = normalize_absolute_path(&requested_dir)?;
    if target_dir.strip_prefix(&downloads_dir).is_err() {
        return Err(format!(
            "Download target must stay inside {}",
            downloads_dir.display()
        ));
    }
    reject_symlinked_path(&downloads_dir, &target_dir)?;

    let filename = infer_filename(parsed_url, request.filename.as_deref())?;
    Ok(target_dir.join(filename))
}

fn normalize_absolute_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Download target directory must be absolute".to_string());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::Normal(segment) => normalized.push(segment),
            Component::ParentDir => {
                return Err("Download target directory cannot contain '..'".to_string())
            }
        }
    }
    Ok(normalized)
}

fn reject_symlinked_path(base: &Path, target: &Path) -> Result<(), String> {
    let mut current = base.to_path_buf();
    for component in target
        .strip_prefix(base)
        .map_err(|_| "Download target escaped the downloads directory".to_string())?
        .components()
    {
        current.push(component.as_os_str());
        if current.exists()
            && fs::symlink_metadata(&current)
                .map_err(|error| format!("Failed to inspect download target: {}", error))?
                .file_type()
                .is_symlink()
        {
            return Err(format!(
                "Download target cannot traverse symlink {}",
                current.display()
            ));
        }
    }
    Ok(())
}

fn infer_filename(parsed_url: &reqwest::Url, explicit: Option<&str>) -> Result<String, String> {
    let filename = explicit
        .map(ToString::to_string)
        .or_else(|| filename_from_url(parsed_url))
        .unwrap_or_else(|| format!("download-{}", Uuid::new_v4()));
    sanitize_path_segment(&filename)
}

fn filename_from_url(parsed_url: &reqwest::Url) -> Option<String> {
    parsed_url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.trim().is_empty())
        .map(ToString::to_string)
}

fn archive_extension_from_url(parsed_url: &reqwest::Url) -> Option<&'static str> {
    let path = parsed_url.path().to_ascii_lowercase();
    if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        Some("tar.gz")
    } else if path.ends_with(".vsix") {
        Some("vsix")
    } else {
        None
    }
}

fn sanitize_path_segment(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Filename cannot be empty".to_string());
    }
    if trimmed == "." || trimmed == ".." {
        return Err("Filename cannot be a relative path segment".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Filename cannot contain path separators".to_string());
    }
    if trimmed.contains('\0') {
        return Err("Filename cannot contain NUL bytes".to_string());
    }
    Ok(trimmed.to_string())
}

fn part_path_for(target_path: &Path, download_id: &str) -> Result<PathBuf, String> {
    let filename = target_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Target path must include a filename".to_string())?;
    Ok(target_path.with_file_name(format!("{}.{}.part", filename, download_id)))
}

async fn replace_completed_download(part_path: &Path, target_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        tokio_fs::rename(part_path, target_path)
            .await
            .map_err(|error| format!("Failed to atomically replace target file: {}", error))
    }

    #[cfg(not(unix))]
    {
        if target_path.exists() {
            tokio_fs::remove_file(target_path)
                .await
                .map_err(|error| format!("Failed to replace target file: {}", error))?;
        }
        tokio_fs::rename(part_path, target_path)
            .await
            .map_err(|error| format!("Failed to move completed download: {}", error))
    }
}

fn ride_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".ride"))
        .ok_or_else(|| "Could not determine home directory".to_string())
}

fn ride_downloads_dir() -> Result<PathBuf, String> {
    Ok(ride_dir()?.join("downloads"))
}

fn ride_plugins_dir() -> Result<PathBuf, String> {
    Ok(ride_dir()?.join("plugins"))
}

fn read_configured_plugins(app: &AppHandle) -> Result<HashMap<String, String>, String> {
    for path in package_json_candidates(app) {
        if !path.is_file() {
            continue;
        }

        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Failed to read {}: {}", path.display(), error))?;
        let config: TheiaPackageConfig = serde_json::from_str(&content)
            .map_err(|error| format!("Failed to parse {}: {}", path.display(), error))?;
        if let Some(plugins) = config.theia_plugins {
            if !plugins.is_empty() {
                return Ok(plugins);
            }
        }
    }

    Err("No configured Theia plugins found".to_string())
}

fn package_json_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("plugin-manifest.json"));
        candidates.push(resource_dir.join("package.json"));
    }
    if let Ok(current_dir) = std::env::current_dir() {
        candidates.extend([
            current_dir.join("resources").join("package.json"),
            current_dir.join("package.json"),
            current_dir.join("../../package.json"),
            current_dir.join("../../../package.json"),
        ]);
    }
    candidates
}

fn install_plugin_archive(
    archive_path: &Path,
    fallback_id: Option<&str>,
) -> Result<Vec<InstalledPlugin>, String> {
    let staging_root = ride_dir()?
        .join("tmp")
        .join("plugins")
        .join(Uuid::new_v4().to_string());
    fs::create_dir_all(&staging_root)
        .map_err(|error| format!("Failed to create plugin staging directory: {}", error))?;

    let unpacked_dir = staging_root.join("unpacked");
    let archive_name = archive_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let extract_result = if archive_name.ends_with(".vsix") {
        extract_zip_archive(archive_path, &unpacked_dir)
    } else if archive_name.ends_with(".tar.gz") || archive_name.ends_with(".tgz") {
        extract_tar_gz_archive(archive_path, &unpacked_dir)
    } else {
        Err("Unsupported plugin archive format".to_string())
    };

    if let Err(error) = extract_result {
        let _ = fs::remove_dir_all(&staging_root);
        return Err(error);
    }

    let mut plugin_roots = Vec::new();
    find_plugin_roots(&unpacked_dir, &mut plugin_roots)
        .map_err(|error| format!("Failed to inspect plugin archive: {}", error))?;

    if plugin_roots.is_empty()
        && unpacked_dir
            .join("extension")
            .join("package.json")
            .is_file()
    {
        plugin_roots.push(unpacked_dir.clone());
    }

    if plugin_roots.is_empty() {
        let _ = fs::remove_dir_all(&staging_root);
        return Err("No VS Code plugin package found in archive".to_string());
    }

    let plugins_dir = ride_plugins_dir()?;
    fs::create_dir_all(&plugins_dir)
        .map_err(|error| format!("Failed to create user plugins directory: {}", error))?;

    let mut installed = Vec::new();
    for plugin_root in plugin_roots {
        let plugin_id = read_plugin_id(&plugin_root, fallback_id)?;
        let target_dir = plugins_dir.join(sanitize_path_segment(&plugin_id)?);
        install_plugin_root(&plugin_root, &target_dir)?;
        installed.push(InstalledPlugin {
            plugin_id,
            target_dir: target_dir.to_string_lossy().to_string(),
        });
    }

    let _ = fs::remove_dir_all(&staging_root);
    Ok(installed)
}

fn extract_zip_archive(archive_path: &Path, target_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_dir)
        .map_err(|error| format!("Failed to create extraction directory: {}", error))?;
    let archive_file = StdFile::open(archive_path)
        .map_err(|error| format!("Failed to open zip archive: {}", error))?;
    let mut archive = zip::ZipArchive::new(archive_file)
        .map_err(|error| format!("Failed to read zip archive: {}", error))?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "Plugin archive contains more than {} entries",
            MAX_ARCHIVE_ENTRIES
        ));
    }
    let mut extracted_bytes = 0u64;

    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read zip entry: {}", error))?;
        let Some(relative_path) = entry.enclosed_name().map(|path| path.to_owned()) else {
            return Err(format!("Unsafe zip entry path: {}", entry.name()));
        };
        let output_path = safe_join(target_dir, &relative_path)?;

        if entry.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("Failed to create zip directory: {}", error))?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create zip parent directory: {}", error))?;
        }
        let mut output = StdFile::create(&output_path)
            .map_err(|error| format!("Failed to create extracted zip file: {}", error))?;
        let copied = io::copy(&mut entry.take(MAX_EXTRACTED_BYTES + 1), &mut output)
            .map_err(|error| format!("Failed to extract zip file: {}", error))?;
        extracted_bytes = extracted_bytes.saturating_add(copied);
        if extracted_bytes > MAX_EXTRACTED_BYTES {
            return Err(format!(
                "Plugin archive expands beyond {} bytes",
                MAX_EXTRACTED_BYTES
            ));
        }
    }

    Ok(())
}

fn extract_tar_gz_archive(archive_path: &Path, target_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(target_dir)
        .map_err(|error| format!("Failed to create extraction directory: {}", error))?;
    let archive_file = StdFile::open(archive_path)
        .map_err(|error| format!("Failed to open tar archive: {}", error))?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = tar::Archive::new(decoder);
    let mut entry_count = 0usize;
    let mut extracted_bytes = 0u64;

    for entry in archive
        .entries()
        .map_err(|error| format!("Failed to read tar entries: {}", error))?
    {
        entry_count += 1;
        if entry_count > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "Plugin archive contains more than {} entries",
                MAX_ARCHIVE_ENTRIES
            ));
        }
        let mut entry = entry.map_err(|error| format!("Failed to read tar entry: {}", error))?;
        let entry_type = entry.header().entry_type();
        if entry_type.is_symlink() || entry_type.is_hard_link() {
            continue;
        }

        let relative_path = entry
            .path()
            .map_err(|error| format!("Failed to read tar entry path: {}", error))?
            .to_path_buf();
        let output_path = safe_join(target_dir, &relative_path)?;

        if entry_type.is_dir() {
            fs::create_dir_all(&output_path)
                .map_err(|error| format!("Failed to create tar directory: {}", error))?;
        } else {
            let entry_size = entry.size();
            extracted_bytes = extracted_bytes.saturating_add(entry_size);
            if extracted_bytes > MAX_EXTRACTED_BYTES {
                return Err(format!(
                    "Plugin archive expands beyond {} bytes",
                    MAX_EXTRACTED_BYTES
                ));
            }
            if let Some(parent) = output_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Failed to create tar parent directory: {}", error))?;
            }
            entry
                .unpack(&output_path)
                .map_err(|error| format!("Failed to extract tar entry: {}", error))?;
        }
    }

    Ok(())
}

fn safe_join(base: &Path, relative: &Path) -> Result<PathBuf, String> {
    let mut output = base.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(segment) => output.push(segment),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Unsafe archive path: {}", relative.display()));
            }
        }
    }
    Ok(output)
}

fn find_plugin_roots(root: &Path, plugin_roots: &mut Vec<PathBuf>) -> io::Result<()> {
    if root.join("extension").join("package.json").is_file() {
        plugin_roots.push(root.to_path_buf());
        return Ok(());
    }

    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            find_plugin_roots(&entry.path(), plugin_roots)?;
        }
    }

    Ok(())
}

fn read_plugin_id(plugin_root: &Path, fallback_id: Option<&str>) -> Result<String, String> {
    let package_path = plugin_root.join("extension").join("package.json");
    let content = fs::read_to_string(&package_path)
        .map_err(|error| format!("Failed to read {}: {}", package_path.display(), error))?;
    let package: ExtensionPackage = serde_json::from_str(&content)
        .map_err(|error| format!("Failed to parse {}: {}", package_path.display(), error))?;

    if let Some(publisher) = package.publisher.filter(|value| !value.trim().is_empty()) {
        Ok(format!("{}.{}", publisher, package.name))
    } else if !package.name.trim().is_empty() {
        Ok(fallback_id.map(ToString::to_string).unwrap_or(package.name))
    } else {
        Err("Plugin package is missing a name".to_string())
    }
}

fn install_plugin_root(source_root: &Path, target_dir: &Path) -> Result<(), String> {
    let parent = target_dir
        .parent()
        .ok_or_else(|| "Plugin target directory has no parent".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to create plugin target parent: {}", error))?;

    let installing_dir = target_dir.with_file_name(format!(
        ".{}.installing",
        target_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("plugin")
    ));
    let _ = fs::remove_dir_all(&installing_dir);
    copy_dir_recursive(source_root, &installing_dir)
        .map_err(|error| format!("Failed to stage plugin install: {}", error))?;

    let backup_dir = target_dir.with_file_name(format!(
        ".{}.backup-{}",
        target_dir
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("plugin"),
        Uuid::new_v4()
    ));
    if target_dir.exists() {
        fs::rename(target_dir, &backup_dir).map_err(|error| {
            format!("Failed to stage existing plugin for replacement: {}", error)
        })?;
    }

    if let Err(error) = fs::rename(&installing_dir, target_dir) {
        if backup_dir.exists() {
            let _ = fs::rename(&backup_dir, target_dir);
        }
        let _ = fs::remove_dir_all(&installing_dir);
        return Err(format!("Failed to finalize plugin install: {}", error));
    }
    if backup_dir.exists() {
        let _ = fs::remove_dir_all(backup_dir);
    }

    Ok(())
}

fn copy_dir_recursive(source: &Path, target: &Path) -> io::Result<()> {
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            fs::copy(&source_path, &target_path)?;
        }
    }
    Ok(())
}

fn to_hex(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{:02x}", byte);
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_test_dir(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("ride-download-test-{}-{}", name, Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn infers_filename_from_url() {
        let url = parse_http_url("https://example.com/files/tool.vsix?download=1").unwrap();
        assert_eq!(infer_filename(&url, None).unwrap(), "tool.vsix");
    }

    #[test]
    fn rejects_path_traversal_segments() {
        assert!(sanitize_path_segment("../tool.vsix").is_err());
        assert!(sanitize_path_segment("nested/tool.vsix").is_err());
        assert!(safe_join(Path::new("/tmp/base"), Path::new("../escape")).is_err());
    }

    #[test]
    fn reads_plugin_id_from_extension_package() {
        let root = temp_test_dir("plugin-id");
        let extension = root.join("extension");
        fs::create_dir_all(&extension).unwrap();
        fs::write(
            extension.join("package.json"),
            r#"{"publisher":"acme","name":"tools"}"#,
        )
        .unwrap();

        assert_eq!(read_plugin_id(&root, None).unwrap(), "acme.tools");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cancel_marks_running_task() {
        let manager = DownloadManager::new();
        let request = DownloadStartRequest {
            url: "https://example.com/file.txt".to_string(),
            target_dir: None,
            filename: Some("file.txt".to_string()),
            kind: None,
        };
        let target = temp_test_dir("cancel").join("file.txt");
        let (task, cancel) = manager.insert_task(&request, target).unwrap();
        assert!(manager.cancel(&task.id));
        assert!(cancel.load(Ordering::SeqCst));
        assert_eq!(manager.list()[0].status, STATUS_CANCELED);
        manager.fail_task_unless_canceled(None, &task.id, "late failure".to_string());
        assert_eq!(manager.list()[0].status, STATUS_CANCELED);
    }

    #[test]
    fn rejects_download_targets_outside_ride_downloads() {
        let url = parse_http_url("https://example.com/file.txt").unwrap();
        let request = DownloadStartRequest {
            url: url.to_string(),
            target_dir: Some(temp_test_dir("outside").to_string_lossy().to_string()),
            filename: Some("file.txt".to_string()),
            kind: None,
        };
        assert!(resolve_download_target(&url, &request).is_err());
    }

    #[test]
    fn extracts_vsix_archive_to_plugin_directory() {
        use std::io::Write as _;

        let root = temp_test_dir("vsix");
        let archive_path = root.join("plugin.vsix");
        {
            let file = StdFile::create(&archive_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let options = zip::write::FileOptions::default();
            writer
                .start_file("extension/package.json", options)
                .unwrap();
            writer
                .write_all(br#"{"publisher":"sample","name":"plugin"}"#)
                .unwrap();
            writer.finish().unwrap();
        }

        let staging = root.join("unpacked");
        extract_zip_archive(&archive_path, &staging).unwrap();
        assert_eq!(read_plugin_id(&staging, None).unwrap(), "sample.plugin");
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn downloads_file_from_local_http() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt as _},
            net::TcpListener,
        };

        let body = b"native download body";
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request_buffer = [0u8; 1024];
            let _ = socket.read(&mut request_buffer).await.unwrap();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });

        let manager = DownloadManager::new();
        let target_dir = temp_test_dir("http");
        let request = DownloadStartRequest {
            url: format!("http://{}/sample.bin", addr),
            target_dir: None,
            filename: None,
            kind: None,
        };
        let target_path = target_dir.join("sample.bin");
        let (task, cancel) = manager.insert_task(&request, target_path.clone()).unwrap();
        let completed = manager
            .run_download(
                None,
                task.id.clone(),
                request.url.clone(),
                target_path.clone(),
                cancel,
            )
            .await
            .unwrap();

        server.await.unwrap();
        assert_eq!(fs::read(&target_path).unwrap(), body);
        assert_eq!(completed.target_path, target_path);

        let tasks = manager.list();
        assert_eq!(tasks[0].status, STATUS_COMPLETED);
        assert_eq!(tasks[0].bytes_downloaded, body.len() as u64);
        assert_eq!(tasks[0].percent, Some(100.0));
        assert!(tasks[0].sha256.is_some());

        let _ = fs::remove_dir_all(target_dir);
    }

    #[tokio::test]
    #[ignore]
    async fn downloads_open_vsx_vsix_to_temp_home() {
        let temp_home = temp_test_dir("open-vsx-home");
        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &temp_home);

        let result = async {
            let manager = DownloadManager::new();
            let request = DownloadStartRequest {
                url: "https://open-vsx.org/api/vscjava/vscode-java-dependency/0.27.0/file/vscjava.vscode-java-dependency-0.27.0.vsix".to_string(),
                target_dir: Some(ride_downloads_dir()?.to_string_lossy().to_string()),
                filename: Some("vscjava.vscode-java-dependency.vsix".to_string()),
                kind: Some("plugin".to_string()),
            };
            let parsed_url = parse_http_url(&request.url)?;
            let target_path = resolve_download_target(&parsed_url, &request)?;
            let (task, cancel) = manager.insert_task(&request, target_path.clone())?;
            let completed = manager
                .run_download(None, task.id.clone(), request.url.clone(), target_path, cancel)
                .await?;
            let installed =
                install_plugin_archive(&completed.target_path, Some("vscjava.vscode-java-dependency"))?;
            let plugin = installed
                .iter()
                .find(|plugin| plugin.plugin_id == "vscjava.vscode-java-dependency")
                .ok_or_else(|| "Expected plugin was not installed".to_string())?;
            let package_json = PathBuf::from(&plugin.target_dir)
                .join("extension")
                .join("package.json");
            if !package_json.is_file() {
                return Err(format!("Missing installed package.json: {}", package_json.display()));
            }
            Ok::<(), String>(())
        }
        .await;

        if let Some(previous_home) = previous_home {
            std::env::set_var("HOME", previous_home);
        } else {
            std::env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(temp_home);

        result.unwrap();
    }
}
