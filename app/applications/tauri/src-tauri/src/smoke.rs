/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use crate::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SPEC_ENV: &str = "RIDE_TAURI_SMOKE_SPEC";
const REPORT_ENV: &str = "RIDE_TAURI_SMOKE_REPORT";
const TOKEN_ENV: &str = "RIDE_TAURI_SMOKE_TOKEN";
const SPEC_SCHEMA: &str = "ride.tauri-packaged-smoke-spec";
const REPORT_SCHEMA: &str = "ride.tauri-packaged-smoke";
const PROTOCOL_VERSION: u32 = 1;
const MAX_SPEC_BYTES: u64 = 1024 * 1024;
const MAX_REPORT_BYTES: u64 = 4 * 1024 * 1024;
const MIN_ACTION_TIMEOUT_MS: u64 = 1_000;
const MAX_ACTION_TIMEOUT_MS: u64 = 300_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SmokeScenario {
    CriticalFile,
    CriticalEmpty,
    FullFile,
}

impl SmokeScenario {
    pub const ALL: [Self; 3] = [Self::CriticalFile, Self::CriticalEmpty, Self::FullFile];
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SmokeProfile {
    TauriCritical,
    Full,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SmokeAction {
    EditorSave,
    TerminalSentinel,
    WorkspaceSearch,
    ScmStatus,
    PackagedPluginCommand,
    SecondaryWindow,
    SecondFileForwarding,
}

impl SmokeAction {
    pub const ALL: [Self; 7] = [
        Self::EditorSave,
        Self::TerminalSentinel,
        Self::WorkspaceSearch,
        Self::ScmStatus,
        Self::PackagedPluginCommand,
        Self::SecondaryWindow,
        Self::SecondFileForwarding,
    ];

    fn index(self) -> usize {
        Self::ALL
            .iter()
            .position(|candidate| *candidate == self)
            .expect("all smoke actions have a canonical index")
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SmokeStepState {
    Started,
    Passed,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SmokeTerminalStatus {
    Passed,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FailurePhase {
    Startup,
    Sidecar,
    Protocol,
    Action,
    Cleanup,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SmokeMode {
    Disabled,
    Rejected,
    Active,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SmokeUpdateStatus {
    Disabled,
    Rejected,
    Recorded,
    Completed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SmokeDiagnostic {
    pub code: String,
    pub message: String,
}

impl SmokeDiagnostic {
    fn protocol_failed() -> Self {
        Self::catalog("protocol-failed").expect("protocol diagnostic is in the catalog")
    }

    fn catalog(code: &str) -> Option<Self> {
        diagnostic_message(code).map(|message| Self {
            code: code.to_string(),
            message: message.to_string(),
        })
    }

    fn is_exact_catalog_entry(&self) -> bool {
        diagnostic_message(&self.code) == Some(self.message.as_str())
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokePlan {
    pub spec_sha256: String,
    pub scenario: SmokeScenario,
    pub profile: SmokeProfile,
    pub workspace: String,
    pub files: Vec<String>,
    pub actions: Vec<SmokeAction>,
    pub action_timeout_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokePlanResponse {
    pub mode: SmokeMode,
    pub plan: Option<SmokePlan>,
    pub diagnostic: Option<SmokeDiagnostic>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecordStepRequest {
    pub action: SmokeAction,
    pub state: SmokeStepState,
    pub duration_ms: u64,
    pub diagnostic: Option<SmokeDiagnostic>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompleteRequest {
    pub status: SmokeTerminalStatus,
    pub failure_phase: Option<FailurePhase>,
    pub duration_ms: u64,
    pub diagnostic: Option<SmokeDiagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeUpdateResponse {
    pub status: SmokeUpdateStatus,
    pub diagnostic: Option<SmokeDiagnostic>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SmokeError {
    pub code: &'static str,
    pub message: &'static str,
}

impl SmokeError {
    fn rejected() -> Self {
        Self {
            code: "smoke-request-rejected",
            message: "Smoke protocol request was rejected.",
        }
    }
}

impl fmt::Display for SmokeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for SmokeError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SmokeSpec {
    schema: String,
    version: u32,
    scenario: SmokeScenario,
    profile: SmokeProfile,
    workspace: String,
    files: Vec<String>,
    actions: Vec<SmokeAction>,
    token_sha256: String,
    action_timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeTransition {
    action: SmokeAction,
    state: SmokeStepState,
    duration_ms: u64,
    diagnostic: Option<SmokeDiagnostic>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmokeReport {
    schema: &'static str,
    version: u32,
    spec_sha256: String,
    scenario: SmokeScenario,
    profile: SmokeProfile,
    status: SmokeTerminalStatus,
    failure_phase: Option<FailurePhase>,
    duration_ms: u64,
    diagnostic: Option<SmokeDiagnostic>,
    steps: Vec<SmokeTransition>,
}

#[derive(Debug)]
struct ActiveProtocol {
    plan: SmokePlan,
    report_path: PathBuf,
    owned_root: PathBuf,
    transitions: Vec<SmokeTransition>,
    next_action: usize,
    pending_action: Option<SmokeAction>,
    action_failure: Option<SmokeDiagnostic>,
    terminal: bool,
}

#[derive(Debug)]
enum ProtocolState {
    Disabled,
    Rejected,
    Active(Box<ActiveProtocol>),
}

#[derive(Debug)]
pub struct SmokeProtocol {
    state: Mutex<ProtocolState>,
}

impl SmokeProtocol {
    pub fn from_process_environment() -> Self {
        let environment = std::env::vars_os().collect::<BTreeMap<_, _>>();
        match std::env::current_dir() {
            Ok(cwd) => Self::from_environment(&environment, &cwd),
            Err(_) => Self::rejected(),
        }
    }

    pub fn from_environment(environment: &BTreeMap<OsString, OsString>, cwd: &Path) -> Self {
        let values =
            [SPEC_ENV, REPORT_ENV, TOKEN_ENV].map(|name| environment.get(OsStr::new(name)));
        let present = values.iter().filter(|value| value.is_some()).count();
        if present == 0 {
            return Self {
                state: Mutex::new(ProtocolState::Disabled),
            };
        }
        if present != values.len() {
            return Self::rejected();
        }

        match build_active_protocol(
            values[0].expect("complete smoke environment"),
            values[1].expect("complete smoke environment"),
            values[2].expect("complete smoke environment"),
            cwd,
        ) {
            Ok(active) => Self {
                state: Mutex::new(ProtocolState::Active(Box::new(active))),
            },
            Err(()) => Self::rejected(),
        }
    }

    fn rejected() -> Self {
        Self {
            state: Mutex::new(ProtocolState::Rejected),
        }
    }

    pub fn plan(&self) -> SmokePlanResponse {
        match self.state.lock() {
            Ok(state) => match &*state {
                ProtocolState::Disabled => SmokePlanResponse {
                    mode: SmokeMode::Disabled,
                    plan: None,
                    diagnostic: None,
                },
                ProtocolState::Rejected => SmokePlanResponse {
                    mode: SmokeMode::Rejected,
                    plan: None,
                    diagnostic: Some(SmokeDiagnostic::protocol_failed()),
                },
                ProtocolState::Active(active) => SmokePlanResponse {
                    mode: SmokeMode::Active,
                    plan: Some(active.plan.clone()),
                    diagnostic: None,
                },
            },
            Err(_) => SmokePlanResponse {
                mode: SmokeMode::Rejected,
                plan: None,
                diagnostic: Some(SmokeDiagnostic::protocol_failed()),
            },
        }
    }

    pub fn record_step(
        &self,
        request: RecordStepRequest,
    ) -> Result<SmokeUpdateResponse, SmokeError> {
        let mut state = self.state.lock().map_err(|_| SmokeError::rejected())?;
        let active = match &mut *state {
            ProtocolState::Disabled => return Ok(disabled_update()),
            ProtocolState::Rejected => return Ok(rejected_update()),
            ProtocolState::Active(active) => active,
        };
        if active.terminal || active.action_failure.is_some() {
            return Err(SmokeError::rejected());
        }
        let last_duration = active
            .transitions
            .last()
            .map_or(0, |transition| transition.duration_ms);
        if request.duration_ms > MAX_SAFE_INTEGER || request.duration_ms < last_duration {
            return Err(SmokeError::rejected());
        }

        match request.state {
            SmokeStepState::Started => {
                if request.diagnostic.is_some()
                    || active.pending_action.is_some()
                    || active.plan.actions.get(active.next_action) != Some(&request.action)
                {
                    return Err(SmokeError::rejected());
                }
                active.pending_action = Some(request.action);
            }
            SmokeStepState::Passed => {
                if request.diagnostic.is_some() || active.pending_action != Some(request.action) {
                    return Err(SmokeError::rejected());
                }
                active.pending_action = None;
                active.next_action += 1;
            }
            SmokeStepState::Failed => {
                let Some(diagnostic) = request.diagnostic.as_ref() else {
                    return Err(SmokeError::rejected());
                };
                if active.pending_action != Some(request.action)
                    || !diagnostic.is_exact_catalog_entry()
                    || !matches!(diagnostic.code.as_str(), "action-failed" | "action-timeout")
                {
                    return Err(SmokeError::rejected());
                }
                active.pending_action = None;
                active.action_failure = Some(diagnostic.clone());
            }
        }

        active.transitions.push(SmokeTransition {
            action: request.action,
            state: request.state,
            duration_ms: request.duration_ms,
            diagnostic: request.diagnostic,
        });
        Ok(SmokeUpdateResponse {
            status: SmokeUpdateStatus::Recorded,
            diagnostic: None,
        })
    }

    pub fn complete(&self, request: CompleteRequest) -> Result<SmokeUpdateResponse, SmokeError> {
        let mut state = self.state.lock().map_err(|_| SmokeError::rejected())?;
        let active = match &mut *state {
            ProtocolState::Disabled => return Ok(disabled_update()),
            ProtocolState::Rejected => return Ok(rejected_update()),
            ProtocolState::Active(active) => active,
        };
        if active.terminal || active.pending_action.is_some() {
            return Err(SmokeError::rejected());
        }
        let last_duration = active
            .transitions
            .last()
            .map_or(0, |transition| transition.duration_ms);
        if request.duration_ms > MAX_SAFE_INTEGER || request.duration_ms < last_duration {
            return Err(SmokeError::rejected());
        }

        validate_completion(active, &request)?;
        let report = SmokeReport {
            schema: REPORT_SCHEMA,
            version: PROTOCOL_VERSION,
            spec_sha256: active.plan.spec_sha256.clone(),
            scenario: active.plan.scenario,
            profile: active.plan.profile,
            status: request.status,
            failure_phase: request.failure_phase,
            duration_ms: request.duration_ms,
            diagnostic: request.diagnostic,
            steps: active.transitions.clone(),
        };
        write_report_atomically(&active.report_path, &active.owned_root, &report)
            .map_err(|_| SmokeError::rejected())?;
        active.terminal = true;
        Ok(SmokeUpdateResponse {
            status: SmokeUpdateStatus::Completed,
            diagnostic: None,
        })
    }
}

fn validate_completion(
    active: &ActiveProtocol,
    request: &CompleteRequest,
) -> Result<(), SmokeError> {
    match request.status {
        SmokeTerminalStatus::Passed => {
            if request.failure_phase.is_some()
                || request.diagnostic.is_some()
                || active.action_failure.is_some()
                || active.next_action != active.plan.actions.len()
            {
                return Err(SmokeError::rejected());
            }
        }
        SmokeTerminalStatus::Failed => {
            let diagnostic = request
                .diagnostic
                .as_ref()
                .filter(|diagnostic| diagnostic.is_exact_catalog_entry())
                .ok_or_else(SmokeError::rejected)?;
            match request.failure_phase {
                Some(FailurePhase::Action) => {
                    if active.action_failure.as_ref() != Some(diagnostic)
                        || !matches!(diagnostic.code.as_str(), "action-failed" | "action-timeout")
                    {
                        return Err(SmokeError::rejected());
                    }
                }
                Some(FailurePhase::Cleanup) => {
                    if active.action_failure.is_some()
                        || active.next_action != active.plan.actions.len()
                        || diagnostic.code != "cleanup-failed"
                    {
                        return Err(SmokeError::rejected());
                    }
                }
                Some(FailurePhase::Startup) => {
                    validate_pre_action_failure(active, diagnostic, "startup-failed")?;
                }
                Some(FailurePhase::Sidecar) => {
                    validate_pre_action_failure(active, diagnostic, "sidecar-failed")?;
                }
                Some(FailurePhase::Protocol) => {
                    validate_pre_action_failure(active, diagnostic, "protocol-failed")?;
                }
                None => return Err(SmokeError::rejected()),
            }
        }
    }
    Ok(())
}

fn validate_pre_action_failure(
    active: &ActiveProtocol,
    diagnostic: &SmokeDiagnostic,
    expected_code: &str,
) -> Result<(), SmokeError> {
    if !active.transitions.is_empty() || diagnostic.code != expected_code {
        return Err(SmokeError::rejected());
    }
    Ok(())
}

fn disabled_update() -> SmokeUpdateResponse {
    SmokeUpdateResponse {
        status: SmokeUpdateStatus::Disabled,
        diagnostic: None,
    }
}

fn rejected_update() -> SmokeUpdateResponse {
    SmokeUpdateResponse {
        status: SmokeUpdateStatus::Rejected,
        diagnostic: Some(SmokeDiagnostic::protocol_failed()),
    }
}

#[tauri::command]
pub fn ride_smoke_plan(state: tauri::State<'_, AppState>) -> SmokePlanResponse {
    state.smoke.plan()
}

#[tauri::command]
pub fn ride_smoke_record_step(
    state: tauri::State<'_, AppState>,
    request: RecordStepRequest,
) -> Result<SmokeUpdateResponse, SmokeError> {
    state.smoke.record_step(request)
}

#[tauri::command]
pub fn ride_smoke_complete(
    state: tauri::State<'_, AppState>,
    request: CompleteRequest,
) -> Result<SmokeUpdateResponse, SmokeError> {
    state.smoke.complete(request)
}

fn build_active_protocol(
    spec_value: &OsString,
    report_value: &OsString,
    token_value: &OsString,
    cwd: &Path,
) -> Result<ActiveProtocol, ()> {
    let owned_root = canonical_owned_root(cwd)?;
    let spec_path = canonical_existing_file(spec_value, &owned_root, MAX_SPEC_BYTES)?;
    let report_path = canonical_report_path(report_value, &owned_root)?;
    if spec_path == report_path {
        return Err(());
    }

    let spec_bytes = read_bounded_file(&spec_path, MAX_SPEC_BYTES)?;
    let spec: SmokeSpec = serde_json::from_slice(&spec_bytes).map_err(|_| ())?;
    validate_spec(&spec)?;
    let token = token_value
        .to_str()
        .filter(|token| !token.is_empty())
        .ok_or(())?;
    if token.len() > 4_096 || sha256(token.as_bytes()) != spec.token_sha256 {
        return Err(());
    }

    Ok(ActiveProtocol {
        plan: SmokePlan {
            spec_sha256: sha256(&spec_bytes),
            scenario: spec.scenario,
            profile: spec.profile,
            workspace: normalize_relative_path(&spec.workspace, true)?,
            files: validate_files(&spec.files)?,
            actions: validate_actions(&spec.actions)?,
            action_timeout_ms: spec.action_timeout_ms,
        },
        report_path,
        owned_root,
        transitions: Vec::new(),
        next_action: 0,
        pending_action: None,
        action_failure: None,
        terminal: false,
    })
}

fn canonical_owned_root(cwd: &Path) -> Result<PathBuf, ()> {
    if !cwd.is_absolute()
        || fs::symlink_metadata(cwd)
            .map_err(|_| ())?
            .file_type()
            .is_symlink()
    {
        return Err(());
    }
    let canonical = dunce::canonicalize(cwd).map_err(|_| ())?;
    if !canonical.is_dir() {
        return Err(());
    }
    Ok(canonical)
}

fn canonical_existing_file(
    value: &OsString,
    owned_root: &Path,
    max_bytes: u64,
) -> Result<PathBuf, ()> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(());
    }
    let link_metadata = fs::symlink_metadata(&path).map_err(|_| ())?;
    if link_metadata.file_type().is_symlink() || !link_metadata.is_file() {
        return Err(());
    }
    let canonical = dunce::canonicalize(&path).map_err(|_| ())?;
    if canonical != path || !canonical.starts_with(owned_root) {
        return Err(());
    }
    let metadata = fs::metadata(&canonical).map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(());
    }
    Ok(canonical)
}

fn canonical_report_path(value: &OsString, owned_root: &Path) -> Result<PathBuf, ()> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(());
    }
    let file_name = path.file_name().filter(|name| !name.is_empty()).ok_or(())?;
    let parent = path.parent().ok_or(())?;
    if fs::symlink_metadata(parent)
        .map_err(|_| ())?
        .file_type()
        .is_symlink()
    {
        return Err(());
    }
    let canonical_parent = dunce::canonicalize(parent).map_err(|_| ())?;
    if canonical_parent != parent || !canonical_parent.starts_with(owned_root) {
        return Err(());
    }
    let canonical_path = canonical_parent.join(file_name);
    if canonical_path != path {
        return Err(());
    }
    validate_existing_report(&canonical_path)?;
    Ok(canonical_path)
}

fn validate_existing_report(path: &Path) -> Result<(), ()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() > MAX_REPORT_BYTES
            {
                return Err(());
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(()),
    }
    Ok(())
}

fn read_bounded_file(path: &Path, max_bytes: u64) -> Result<Vec<u8>, ()> {
    let file = OpenOptions::new().read(true).open(path).map_err(|_| ())?;
    let metadata = file.metadata().map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > max_bytes {
        return Err(());
    }
    Ok(bytes)
}

fn validate_spec(spec: &SmokeSpec) -> Result<(), ()> {
    if spec.schema != SPEC_SCHEMA
        || spec.version != PROTOCOL_VERSION
        || !is_canonical_sha256(&spec.token_sha256)
        || !(MIN_ACTION_TIMEOUT_MS..=MAX_ACTION_TIMEOUT_MS).contains(&spec.action_timeout_ms)
    {
        return Err(());
    }
    normalize_relative_path(&spec.workspace, true)?;
    validate_files(&spec.files)?;
    validate_actions(&spec.actions)?;
    Ok(())
}

fn validate_files(files: &[String]) -> Result<Vec<String>, ()> {
    let normalized = files
        .iter()
        .map(|file| normalize_relative_path(file, false))
        .collect::<Result<Vec<_>, _>>()?;
    let mut seen = HashSet::new();
    for file in &normalized {
        if !seen.insert(windows_ordinal_case_key(file)) {
            return Err(());
        }
    }
    Ok(normalized)
}

fn validate_actions(actions: &[SmokeAction]) -> Result<Vec<SmokeAction>, ()> {
    let mut previous = None;
    for action in actions {
        let index = action.index();
        if previous.is_some_and(|previous| index <= previous) {
            return Err(());
        }
        previous = Some(index);
    }
    Ok(actions.to_vec())
}

fn normalize_relative_path(value: &str, allow_dot: bool) -> Result<String, ()> {
    if value.is_empty() || value.trim() != value {
        return Err(());
    }
    let slash_path = value.replace('\\', "/");
    if slash_path.starts_with('/') || has_drive_prefix(&slash_path) || has_uri_scheme(&slash_path) {
        return Err(());
    }
    let segments = slash_path.split('/').collect::<Vec<_>>();
    if segments.contains(&"..")
        || segments
            .iter()
            .enumerate()
            .any(|(index, segment)| segment.is_empty() && index + 1 != segments.len())
    {
        return Err(());
    }
    for segment in &segments {
        if !segment.is_empty() && *segment != "." {
            validate_windows_portable_segment(segment)?;
        }
    }
    let normalized = segments
        .into_iter()
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect::<Vec<_>>();
    if normalized.is_empty() {
        if allow_dot {
            return Ok(".".to_string());
        }
        return Err(());
    }
    Ok(normalized.join("/"))
}

fn has_drive_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

fn has_uri_scheme(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let scheme = &value[..colon];
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .as_bytes()
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'))
}

fn validate_windows_portable_segment(segment: &str) -> Result<(), ()> {
    if segment.chars().any(|character| {
        character <= '\u{1f}' || matches!(character, '<' | '>' | ':' | '"' | '|' | '?' | '*')
    }) || segment.ends_with('.')
        || segment.ends_with(' ')
    {
        return Err(());
    }
    let device = segment
        .split_once('.')
        .map_or(segment, |(prefix, _)| prefix)
        .to_uppercase();
    if matches!(
        device.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "CLOCK$"
            | "CONIN$"
            | "CONOUT$"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "COM¹"
            | "COM²"
            | "COM³"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
            | "LPT¹"
            | "LPT²"
            | "LPT³"
    ) {
        return Err(());
    }
    Ok(())
}

fn windows_ordinal_case_key(path: &str) -> String {
    path.chars()
        .flat_map(|character| {
            let uppercase = character.to_uppercase().collect::<Vec<_>>();
            if uppercase.len() == 1 {
                uppercase
            } else {
                vec![character]
            }
        })
        .collect()
}

fn is_canonical_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn diagnostic_message(code: &str) -> Option<&'static str> {
    match code {
        "startup-failed" => Some("Application startup failed."),
        "action-failed" => Some("Smoke action failed."),
        "action-timeout" => Some("Smoke action timed out."),
        "sidecar-failed" => Some("Backend sidecar failed."),
        "protocol-failed" => Some("Smoke protocol failed."),
        "cleanup-failed" => Some("Process cleanup failed."),
        _ => None,
    }
}

fn write_report_atomically(path: &Path, owned_root: &Path, report: &SmokeReport) -> io::Result<()> {
    let parent = path.parent().ok_or_else(invalid_report_path)?;
    let file_name = path.file_name().ok_or_else(invalid_report_path)?;
    let canonical_parent = dunce::canonicalize(parent)?;
    if canonical_parent != parent || !canonical_parent.starts_with(owned_root) {
        return Err(invalid_report_path());
    }
    validate_existing_report(path).map_err(|_| invalid_report_path())?;
    let mut bytes = serde_json::to_vec_pretty(report).map_err(io::Error::other)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_REPORT_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "smoke report exceeds size limit",
        ));
    }

    let temporary_path = parent.join(format!(
        ".{}.{}.tmp",
        file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary_path)?;
        file.write_all(&bytes)?;
        file.flush()?;
        file.sync_all()?;
        replace_file(&temporary_path, path)?;
        sync_parent(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn invalid_report_path() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid smoke report path")
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, replacement: *const u16, flags: u32) -> i32;
    }

    let existing = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replacement = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let replaced = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            replacement.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> io::Result<()> {
    Ok(())
}
