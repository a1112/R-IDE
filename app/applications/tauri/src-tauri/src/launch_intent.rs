/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchSource {
    Initial,
    SingleInstance,
    OpenedUrl,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchIntent {
    pub id: u64,
    pub source: LaunchSource,
    pub workspace: PathBuf,
    pub files: Vec<PathBuf>,
}

#[derive(Debug)]
pub struct LaunchIntentIdSource {
    next: AtomicU64,
}

impl LaunchIntentIdSource {
    pub fn new(first: u64) -> Option<Self> {
        (first != 0).then(|| Self {
            next: AtomicU64::new(first),
        })
    }

    pub fn next(&self) -> Option<u64> {
        let mut current = self.next.load(Ordering::Relaxed);
        loop {
            if current == 0 {
                return None;
            }

            let following = current.checked_add(1).unwrap_or(0);
            match self.next.compare_exchange_weak(
                current,
                following,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Some(current),
                Err(actual) => current = actual,
            }
        }
    }
}

#[derive(Debug)]
pub struct LaunchIntentQueue {
    ready: bool,
    maximum_length: usize,
    pending: VecDeque<LaunchIntent>,
    seen_ids: HashSet<u64>,
    in_flight_ids: HashSet<u64>,
    consumed_ids: HashSet<u64>,
}

impl LaunchIntentQueue {
    /// Creates a queue whose pending capacity is at least one.
    ///
    /// IDs are remembered for the process lifetime, including IDs evicted from
    /// `pending`, so an out-of-order retry can never create a second delivery.
    pub fn new(maximum_length: usize) -> Self {
        Self {
            ready: false,
            maximum_length: maximum_length.max(1),
            pending: VecDeque::new(),
            seen_ids: HashSet::new(),
            in_flight_ids: HashSet::new(),
            consumed_ids: HashSet::new(),
        }
    }

    /// Queues an unseen intent until the frontend is ready, or returns it as an
    /// owned delivery immediately when ready. Duplicate IDs return no delivery.
    pub fn enqueue(&mut self, intent: LaunchIntent) -> Vec<LaunchIntent> {
        if !self.seen_ids.insert(intent.id) {
            return Vec::new();
        }

        if self.ready {
            self.in_flight_ids.insert(intent.id);
            return vec![intent];
        }

        if self.pending.len() == self.maximum_length {
            self.pending.pop_front();
        }
        self.pending.push_back(intent);
        Vec::new()
    }

    /// Marks the frontend ready and returns queued intents in arrival order.
    /// Returned deliveries become in-flight until acknowledged.
    pub fn mark_ready(&mut self) -> Vec<LaunchIntent> {
        self.ready = true;
        let deliveries = self.pending.drain(..).collect::<Vec<_>>();
        self.in_flight_ids
            .extend(deliveries.iter().map(|intent| intent.id));
        deliveries
    }

    /// Acknowledges a delivery. Returns `true` for both the first acknowledgement
    /// and retries of a consumed delivery, and `false` for IDs never delivered.
    pub fn acknowledge(&mut self, id: u64) -> bool {
        if self.in_flight_ids.remove(&id) {
            self.consumed_ids.insert(id);
            return true;
        }

        self.consumed_ids.contains(&id)
    }

    pub fn is_acknowledged(&self, id: u64) -> bool {
        self.consumed_ids.contains(&id)
    }
}

#[derive(Debug)]
pub struct LaunchIntentDeliveryFailure<E> {
    pub intent: LaunchIntent,
    pub error: E,
}

#[derive(Debug)]
pub struct LaunchIntentDeliveryReport<E> {
    pub delivered_ids: Vec<u64>,
    pub failures: Vec<LaunchIntentDeliveryFailure<E>>,
}

impl<E> LaunchIntentDeliveryReport<E> {
    fn empty() -> Self {
        Self {
            delivered_ids: Vec::new(),
            failures: Vec::new(),
        }
    }
}

/// Routes desktop activations while keeping all UI and emit callbacks outside
/// the queue mutex. Failed deliveries remain terminally in flight: they are
/// reported to the caller, are not acknowledged, and are never emitted twice.
#[derive(Debug)]
pub struct LaunchIntentRouter {
    id_source: Option<LaunchIntentIdSource>,
    queue: Mutex<LaunchIntentQueue>,
}

impl LaunchIntentRouter {
    pub fn new(maximum_length: usize, initial: Option<LaunchIntent>) -> Self {
        let next_id = initial
            .as_ref()
            .map_or(Some(1), |intent| intent.id.checked_add(1));
        let mut queue = LaunchIntentQueue::new(maximum_length);
        if let Some(intent) = initial {
            queue.enqueue(intent);
        }

        Self {
            id_source: next_id.and_then(LaunchIntentIdSource::new),
            queue: Mutex::new(queue),
        }
    }

    pub fn next_id(&self) -> Option<u64> {
        self.id_source.as_ref().and_then(LaunchIntentIdSource::next)
    }

    pub fn route_forwarded_args<I, F, D, E>(
        &self,
        args: I,
        cwd: &Path,
        focus: F,
        emit: D,
    ) -> LaunchIntentDeliveryReport<E>
    where
        I: IntoIterator<Item = OsString>,
        F: FnOnce(),
        D: FnMut(&LaunchIntent) -> Result<(), E>,
    {
        let deliveries = self
            .next_id()
            .and_then(|id| parse_args(args, cwd, LaunchSource::SingleInstance, id))
            .map_or_else(Vec::new, |intent| self.enqueue(intent));

        focus();
        self.deliver(deliveries, emit)
    }

    pub fn route_opened_urls<F, D, E>(
        &self,
        urls: &[tauri::Url],
        focus: F,
        emit: D,
    ) -> LaunchIntentDeliveryReport<E>
    where
        F: FnOnce(),
        D: FnMut(&LaunchIntent) -> Result<(), E>,
    {
        let deliveries = self
            .next_id()
            .and_then(|id| parse_opened_urls(urls, LaunchSource::OpenedUrl, id))
            .map_or_else(Vec::new, |intent| self.enqueue(intent));

        focus();
        self.deliver(deliveries, emit)
    }

    pub fn frontend_ready<D, E>(&self, emit: D) -> LaunchIntentDeliveryReport<E>
    where
        D: FnMut(&LaunchIntent) -> Result<(), E>,
    {
        let deliveries = self.lock_queue().mark_ready();
        self.deliver(deliveries, emit)
    }

    pub fn acknowledge(&self, id: u64) -> bool {
        self.lock_queue().acknowledge(id)
    }

    pub fn is_acknowledged(&self, id: u64) -> bool {
        self.lock_queue().is_acknowledged(id)
    }

    fn enqueue(&self, intent: LaunchIntent) -> Vec<LaunchIntent> {
        self.lock_queue().enqueue(intent)
    }

    fn deliver<D, E>(
        &self,
        deliveries: Vec<LaunchIntent>,
        mut emit: D,
    ) -> LaunchIntentDeliveryReport<E>
    where
        D: FnMut(&LaunchIntent) -> Result<(), E>,
    {
        let mut report = LaunchIntentDeliveryReport::empty();
        for intent in deliveries {
            match emit(&intent) {
                Ok(()) => {
                    self.acknowledge(intent.id);
                    report.delivered_ids.push(intent.id);
                }
                Err(error) => report
                    .failures
                    .push(LaunchIntentDeliveryFailure { intent, error }),
            }
        }
        report
    }

    fn lock_queue(&self) -> MutexGuard<'_, LaunchIntentQueue> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub fn parse_args(
    args: impl IntoIterator<Item = OsString>,
    cwd: &Path,
    source: LaunchSource,
    next_id: u64,
) -> Option<LaunchIntent> {
    let mut args = args.into_iter();
    args.next()?;

    let files = args
        .filter_map(|argument| path_from_argument(&argument, cwd))
        .collect();

    build_intent(files, source, next_id)
}

pub fn parse_opened_urls(
    urls: &[tauri::Url],
    source: LaunchSource,
    next_id: u64,
) -> Option<LaunchIntent> {
    let files = urls.iter().filter_map(path_from_file_url).collect();

    build_intent(files, source, next_id)
}

fn path_from_argument(argument: &OsStr, cwd: &Path) -> Option<PathBuf> {
    if contains_nul(argument) {
        return None;
    }

    let path = Path::new(argument);
    if path.is_absolute() {
        return resolve_existing_file(path.to_path_buf());
    }

    #[cfg(windows)]
    match drive_relative_path(path, cwd) {
        DriveRelativePath::Resolved(path) => return resolve_existing_file(path),
        DriveRelativePath::Invalid => return None,
        DriveRelativePath::NotDriveRelative => {}
    }

    if let Some(native_path) = native_path_against_cwd(path, cwd) {
        if std::fs::metadata(&native_path).is_ok() {
            return resolve_existing_file(native_path);
        }
    }
    if is_flag(argument) {
        return None;
    }

    if let Some(argument) = argument.to_str() {
        if let Ok(url) = tauri::Url::parse(argument) {
            return path_from_file_url(&url);
        }
    }

    None
}

#[cfg(windows)]
enum DriveRelativePath {
    NotDriveRelative,
    Resolved(PathBuf),
    Invalid,
}

#[cfg(windows)]
fn drive_relative_path(path: &Path, cwd: &Path) -> DriveRelativePath {
    use std::path::{Component, Prefix};

    let mut components = path.components();
    let input_drive = match components.next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) if !path.has_root() => drive,
            _ => return DriveRelativePath::NotDriveRelative,
        },
        _ => return DriveRelativePath::NotDriveRelative,
    };

    if !cwd.is_absolute() {
        return DriveRelativePath::Invalid;
    }
    let cwd_drive = match cwd.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => drive,
            _ => return DriveRelativePath::Invalid,
        },
        _ => return DriveRelativePath::Invalid,
    };
    if !input_drive.eq_ignore_ascii_case(&cwd_drive) {
        return DriveRelativePath::Invalid;
    }

    DriveRelativePath::Resolved(cwd.join(components.collect::<PathBuf>()))
}

#[cfg(windows)]
fn native_path_against_cwd(path: &Path, cwd: &Path) -> Option<PathBuf> {
    if path.has_root() && (!cwd.is_absolute() || disk_drive(cwd).is_none()) {
        return None;
    }
    Some(cwd.join(path))
}

#[cfg(windows)]
fn disk_drive(path: &Path) -> Option<u8> {
    use std::path::{Component, Prefix};

    match path.components().next()? {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => Some(drive),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(not(windows))]
fn native_path_against_cwd(path: &Path, cwd: &Path) -> Option<PathBuf> {
    Some(cwd.join(path))
}

fn path_from_file_url(url: &tauri::Url) -> Option<PathBuf> {
    if !has_local_file_host(url) {
        return None;
    }

    let path = url.to_file_path().ok()?;
    if !path.is_absolute() {
        return None;
    }
    resolve_existing_file(path)
}

fn has_local_file_host(url: &tauri::Url) -> bool {
    url.scheme() == "file"
        && url
            .host_str()
            .is_none_or(|host| host.is_empty() || host.eq_ignore_ascii_case("localhost"))
}

fn resolve_existing_file(path: PathBuf) -> Option<PathBuf> {
    if contains_nul(path.as_os_str()) {
        return None;
    }

    let canonical = std::fs::canonicalize(path).ok()?;
    if !canonical.is_file() || canonical.to_str().is_none() {
        return None;
    }
    Some(canonical)
}

fn build_intent(paths: Vec<PathBuf>, source: LaunchSource, next_id: u64) -> Option<LaunchIntent> {
    let mut files: Vec<PathBuf> = Vec::with_capacity(paths.len());
    let mut seen = HashSet::with_capacity(paths.len());
    for path in paths {
        if seen.insert(path.clone()) {
            files.push(path);
        }
    }

    let workspace = files.first()?.parent()?.to_path_buf();
    Some(LaunchIntent {
        id: next_id,
        source,
        workspace,
        files,
    })
}

fn is_flag(argument: &OsStr) -> bool {
    let text = argument.to_string_lossy();
    if text.starts_with('-') {
        return true;
    }

    #[cfg(windows)]
    if text.starts_with('/') && !text.starts_with("//") {
        return true;
    }

    false
}

#[cfg(unix)]
fn contains_nul(value: &OsStr) -> bool {
    use std::os::unix::ffi::OsStrExt;

    value.as_bytes().contains(&0)
}

#[cfg(windows)]
fn contains_nul(value: &OsStr) -> bool {
    use std::os::windows::ffi::OsStrExt;

    value.encode_wide().any(|unit| unit == 0)
}

#[cfg(not(any(unix, windows)))]
fn contains_nul(value: &OsStr) -> bool {
    value.to_string_lossy().contains('\0')
}

#[cfg(test)]
mod tests {
    use super::has_local_file_host;

    #[test]
    fn local_file_host_policy_is_independent_of_filesystem_access() {
        for allowed in [
            "file:///definitely-missing.R",
            "file://LOCALHOST/definitely-missing.R",
        ] {
            let url = tauri::Url::parse(allowed).expect("allowed file URL");
            assert!(has_local_file_host(&url), "expected local host: {url}");
        }

        for rejected in [
            "https://localhost/definitely-missing.R",
            "file://remote-host/share/definitely-missing.R",
        ] {
            let url = tauri::Url::parse(rejected).expect("rejected file URL");
            assert!(!has_local_file_host(&url), "expected remote host: {url}");
        }
    }
}
