/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use serde::Serialize;
use std::collections::HashSet;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

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
    if is_flag(argument) {
        return None;
    }

    let native_path = cwd.join(path);
    if std::fs::metadata(&native_path).is_ok() {
        return resolve_existing_file(native_path);
    }

    if let Some(argument) = argument.to_str() {
        if let Ok(url) = tauri::Url::parse(argument) {
            return path_from_file_url(&url);
        }
    }

    None
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
