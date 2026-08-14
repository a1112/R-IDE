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
