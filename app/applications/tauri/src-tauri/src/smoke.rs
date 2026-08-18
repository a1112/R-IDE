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
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const SPEC_ENV: &str = "RIDE_TAURI_SMOKE_SPEC";
const REPORT_ENV: &str = "RIDE_TAURI_SMOKE_REPORT";
const TOKEN_ENV: &str = "RIDE_TAURI_SMOKE_TOKEN";
pub(crate) const SMOKE_ENV_NAMES: [&str; 3] = [SPEC_ENV, REPORT_ENV, TOKEN_ENV];
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

    fn report_durability_warning() -> Self {
        Self {
            code: "report-durability-warning".to_string(),
            message: "Smoke report was committed but durability sync failed.".to_string(),
        }
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

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokePlanResponse {
    pub mode: SmokeMode,
    pub plan: Option<SmokePlan>,
    pub session_proof: Option<String>,
    pub diagnostic: Option<SmokeDiagnostic>,
}

impl fmt::Debug for SmokePlanResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SmokePlanResponse")
            .field("mode", &self.mode)
            .field("plan", &self.plan)
            .field("session_proof_delivered", &self.session_proof.is_some())
            .field("diagnostic", &self.diagnostic)
            .finish()
    }
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

#[derive(Deserialize)]
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SmokeCommandEnvelope<T> {
    session_proof: String,
    request: T,
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

struct ActiveProtocol {
    plan: SmokePlan,
    report_target: ReportTarget,
    replacer: Arc<dyn ReportReplacer>,
    session_proof: String,
    proof_delivered: bool,
    transitions: Vec<SmokeTransition>,
    last_record_request: Option<RecordStepRequest>,
    next_action: usize,
    pending_action: Option<SmokeAction>,
    action_failure: Option<SmokeDiagnostic>,
    terminal: bool,
    completion: Option<(CompleteRequest, SmokeUpdateResponse)>,
}

enum ProtocolState {
    Disabled,
    Rejected,
    Active(Box<ActiveProtocol>),
}

pub struct SmokeProtocol {
    state: Mutex<ProtocolState>,
}

impl fmt::Debug for SmokeProtocol {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mode = self
            .state
            .lock()
            .map_or(SmokeMode::Rejected, |state| match &*state {
                ProtocolState::Disabled => SmokeMode::Disabled,
                ProtocolState::Rejected => SmokeMode::Rejected,
                ProtocolState::Active(_) => SmokeMode::Active,
            });
        formatter
            .debug_struct("SmokeProtocol")
            .field("mode", &mode)
            .finish_non_exhaustive()
    }
}

impl SmokeProtocol {
    pub fn from_process_environment() -> Self {
        Self::from_process_sources(|name| std::env::var_os(name), std::env::current_dir)
    }

    fn from_process_sources(
        mut environment_value: impl FnMut(&str) -> Option<OsString>,
        current_dir: impl FnOnce() -> io::Result<PathBuf>,
    ) -> Self {
        let values = SMOKE_ENV_NAMES.map(&mut environment_value);
        if values.iter().all(Option::is_none) {
            return Self::disabled();
        }
        let environment = SMOKE_ENV_NAMES
            .into_iter()
            .zip(values)
            .filter_map(|(name, value)| value.map(|value| (OsString::from(name), value)))
            .collect::<BTreeMap<_, _>>();
        match current_dir() {
            Ok(cwd) => Self::from_environment(&environment, &cwd),
            Err(_) => Self::rejected(),
        }
    }

    pub fn from_environment(environment: &BTreeMap<OsString, OsString>, cwd: &Path) -> Self {
        Self::from_environment_internal(environment, cwd, Arc::new(SystemReplacer))
    }

    #[cfg(test)]
    fn from_environment_with_replacer(
        environment: &BTreeMap<OsString, OsString>,
        cwd: &Path,
        replacer: Arc<dyn ReportReplacer>,
    ) -> Self {
        Self::from_environment_internal(environment, cwd, replacer)
    }

    fn from_environment_internal(
        environment: &BTreeMap<OsString, OsString>,
        cwd: &Path,
        replacer: Arc<dyn ReportReplacer>,
    ) -> Self {
        let values =
            [SPEC_ENV, REPORT_ENV, TOKEN_ENV].map(|name| environment.get(OsStr::new(name)));
        let present = values.iter().filter(|value| value.is_some()).count();
        if present == 0 {
            return Self::disabled();
        }
        if present != values.len() {
            return Self::rejected();
        }

        match build_active_protocol(
            values[0].expect("complete smoke environment"),
            values[1].expect("complete smoke environment"),
            values[2].expect("complete smoke environment"),
            cwd,
            replacer,
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

    fn disabled() -> Self {
        Self {
            state: Mutex::new(ProtocolState::Disabled),
        }
    }

    pub fn plan(&self) -> SmokePlanResponse {
        match self.state.lock() {
            Ok(mut state) => match &mut *state {
                ProtocolState::Disabled => SmokePlanResponse {
                    mode: SmokeMode::Disabled,
                    plan: None,
                    session_proof: None,
                    diagnostic: None,
                },
                ProtocolState::Rejected => SmokePlanResponse {
                    mode: SmokeMode::Rejected,
                    plan: None,
                    session_proof: None,
                    diagnostic: Some(SmokeDiagnostic::protocol_failed()),
                },
                ProtocolState::Active(active) => {
                    let session_proof = (!active.proof_delivered).then(|| {
                        active.proof_delivered = true;
                        active.session_proof.clone()
                    });
                    SmokePlanResponse {
                        mode: SmokeMode::Active,
                        plan: Some(active.plan.clone()),
                        session_proof,
                        diagnostic: None,
                    }
                }
            },
            Err(_) => SmokePlanResponse {
                mode: SmokeMode::Rejected,
                plan: None,
                session_proof: None,
                diagnostic: Some(SmokeDiagnostic::protocol_failed()),
            },
        }
    }

    pub fn record_step_command(
        &self,
        value: serde_json::Value,
    ) -> Result<SmokeUpdateResponse, SmokeError> {
        if let Some(response) = self.non_active_update()? {
            return Ok(response);
        }
        let envelope = serde_json::from_value::<SmokeCommandEnvelope<RecordStepRequest>>(value)
            .map_err(|_| SmokeError::rejected())?;
        self.record_step(&envelope.session_proof, envelope.request)
    }

    pub fn complete_command(
        &self,
        value: serde_json::Value,
    ) -> Result<SmokeUpdateResponse, SmokeError> {
        if let Some(response) = self.non_active_update()? {
            return Ok(response);
        }
        let envelope = serde_json::from_value::<SmokeCommandEnvelope<CompleteRequest>>(value)
            .map_err(|_| SmokeError::rejected())?;
        self.complete(&envelope.session_proof, envelope.request)
    }

    pub fn record_step(
        &self,
        session_proof: &str,
        request: RecordStepRequest,
    ) -> Result<SmokeUpdateResponse, SmokeError> {
        let mut state = self.state.lock().map_err(|_| SmokeError::rejected())?;
        let active = match &mut *state {
            ProtocolState::Disabled => return Ok(disabled_update()),
            ProtocolState::Rejected => return Ok(rejected_update()),
            ProtocolState::Active(active) => active,
        };
        if !constant_time_proof_matches(&active.session_proof, session_proof) {
            return Err(SmokeError::rejected());
        }
        record_step_active(active, request)
    }

    pub fn complete(
        &self,
        session_proof: &str,
        request: CompleteRequest,
    ) -> Result<SmokeUpdateResponse, SmokeError> {
        let mut state = self.state.lock().map_err(|_| SmokeError::rejected())?;
        let active = match &mut *state {
            ProtocolState::Disabled => return Ok(disabled_update()),
            ProtocolState::Rejected => return Ok(rejected_update()),
            ProtocolState::Active(active) => active,
        };
        if !constant_time_proof_matches(&active.session_proof, session_proof) {
            return Err(SmokeError::rejected());
        }
        complete_active(active, request)
    }

    fn non_active_update(&self) -> Result<Option<SmokeUpdateResponse>, SmokeError> {
        let state = self.state.lock().map_err(|_| SmokeError::rejected())?;
        Ok(match &*state {
            ProtocolState::Disabled => Some(disabled_update()),
            ProtocolState::Rejected => Some(rejected_update()),
            ProtocolState::Active(_) => None,
        })
    }
}

fn record_step_active(
    active: &mut ActiveProtocol,
    request: RecordStepRequest,
) -> Result<SmokeUpdateResponse, SmokeError> {
    if active.terminal {
        return Err(SmokeError::rejected());
    }
    if active.last_record_request.as_ref() == Some(&request) {
        return Ok(SmokeUpdateResponse {
            status: SmokeUpdateStatus::Recorded,
            diagnostic: None,
        });
    }
    if active.action_failure.is_some() {
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

    active.last_record_request = Some(request.clone());
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

fn complete_active(
    active: &mut ActiveProtocol,
    request: CompleteRequest,
) -> Result<SmokeUpdateResponse, SmokeError> {
    if let Some((completed_request, response)) = active.completion.as_ref() {
        return if completed_request == &request {
            Ok(response.clone())
        } else {
            Err(SmokeError::rejected())
        };
    }
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
        diagnostic: request.diagnostic.clone(),
        steps: active.transitions.clone(),
    };
    let publish = write_report_atomically(&active.report_target, &report, active.replacer.as_ref())
        .map_err(|_| SmokeError::rejected())?;
    let response = SmokeUpdateResponse {
        status: SmokeUpdateStatus::Completed,
        diagnostic: match publish {
            PublishOutcome::Durable => None,
            PublishOutcome::CommittedWithDurabilityWarning => {
                Some(SmokeDiagnostic::report_durability_warning())
            }
        },
    };
    active.terminal = true;
    active.completion = Some((request, response.clone()));
    Ok(response)
}

fn constant_time_proof_matches(expected: &str, actual: &str) -> bool {
    let expected = expected.as_bytes();
    let actual = actual.as_bytes();
    let mut difference = expected.len() ^ actual.len();
    for (index, expected_byte) in expected.iter().enumerate() {
        difference |= usize::from(*expected_byte ^ actual.get(index).copied().unwrap_or(0));
    }
    difference == 0
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
    request: serde_json::Value,
) -> Result<SmokeUpdateResponse, SmokeError> {
    state.smoke.record_step_command(request)
}

#[tauri::command]
pub fn ride_smoke_complete(
    state: tauri::State<'_, AppState>,
    request: serde_json::Value,
) -> Result<SmokeUpdateResponse, SmokeError> {
    state.smoke.complete_command(request)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CapabilityRole {
    Spec,
    ExistingReport,
    ReportParent,
}

#[derive(Clone, Copy, Debug)]
struct CapabilityFacts {
    is_file: bool,
    is_directory: bool,
    is_reparse_point: bool,
    size: u64,
}

fn validate_capability_facts(role: CapabilityRole, facts: CapabilityFacts) -> Result<(), ()> {
    if facts.is_reparse_point {
        return Err(());
    }
    match role {
        CapabilityRole::Spec => {
            if !facts.is_file || facts.is_directory || facts.size > MAX_SPEC_BYTES {
                return Err(());
            }
        }
        CapabilityRole::ExistingReport => {
            if !facts.is_file || facts.is_directory || facts.size > MAX_REPORT_BYTES {
                return Err(());
            }
        }
        CapabilityRole::ReportParent => {
            if facts.is_file || !facts.is_directory {
                return Err(());
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FileIdentity {
    volume: u64,
    file: [u8; 16],
}

impl FileIdentity {
    #[cfg(test)]
    fn for_test(volume: u64, file: u64) -> Self {
        let mut bytes = [0_u8; 16];
        bytes[..8].copy_from_slice(&file.to_le_bytes());
        Self {
            volume,
            file: bytes,
        }
    }
}

fn verify_parent_identity(expected: FileIdentity, actual: FileIdentity) -> Result<(), ()> {
    if expected == actual {
        Ok(())
    } else {
        Err(())
    }
}

fn verify_distinct_file_identity(spec: FileIdentity, report: FileIdentity) -> Result<(), ()> {
    if spec == report {
        Err(())
    } else {
        Ok(())
    }
}

fn read_bounded_handle(
    reader: &mut impl Read,
    declared_size: u64,
    max_bytes: u64,
) -> Result<Vec<u8>, ()> {
    if declared_size > max_bytes {
        return Err(());
    }
    let mut bytes = Vec::with_capacity(declared_size as usize);
    reader
        .take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > max_bytes {
        return Err(());
    }
    Ok(bytes)
}

struct TemporaryReport {
    file: fs::File,
    #[cfg(unix)]
    name: OsString,
    #[cfg(windows)]
    path: PathBuf,
}

struct OpenedSpec {
    path: PathBuf,
    bytes: Vec<u8>,
    identity: FileIdentity,
}

trait ReportReplacer: Send + Sync {
    fn replace(&self, temporary: &mut TemporaryReport, target: &ReportTarget) -> io::Result<()>;

    fn sync_parent(&self, target: &ReportTarget) -> io::Result<()> {
        sync_report_parent(target)
    }
}

struct SystemReplacer;

fn build_active_protocol(
    spec_value: &OsString,
    report_value: &OsString,
    token_value: &OsString,
    cwd: &Path,
    replacer: Arc<dyn ReportReplacer>,
) -> Result<ActiveProtocol, ()> {
    let owned_root = canonical_owned_root(cwd)?;
    let spec = open_spec_and_read(spec_value, &owned_root)?;
    let report_target = open_report_target(report_value, &owned_root, spec.identity)?;
    if platform_paths_equal(&spec.path, &report_target.path_key) {
        return Err(());
    }

    let parsed_spec: SmokeSpec = serde_json::from_slice(&spec.bytes).map_err(|_| ())?;
    validate_spec(&parsed_spec)?;
    let token = token_value
        .to_str()
        .filter(|token| !token.is_empty())
        .ok_or(())?;
    if token.len() > 4_096 || sha256(token.as_bytes()) != parsed_spec.token_sha256 {
        return Err(());
    }

    Ok(ActiveProtocol {
        plan: SmokePlan {
            spec_sha256: sha256(&spec.bytes),
            scenario: parsed_spec.scenario,
            profile: parsed_spec.profile,
            workspace: normalize_relative_path(&parsed_spec.workspace, true)?,
            files: validate_files(&parsed_spec.files)?,
            actions: validate_actions(&parsed_spec.actions)?,
            action_timeout_ms: parsed_spec.action_timeout_ms,
        },
        report_target,
        replacer,
        session_proof: new_session_proof(),
        proof_delivered: false,
        transitions: Vec::new(),
        last_record_request: None,
        next_action: 0,
        pending_action: None,
        action_failure: None,
        terminal: false,
        completion: None,
    })
}

fn new_session_proof() -> String {
    let first = uuid::Uuid::new_v4();
    let second = uuid::Uuid::new_v4();
    let mut hasher = Sha256::new();
    hasher.update(first.as_bytes());
    hasher.update(second.as_bytes());
    format!("{:x}", hasher.finalize())
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

#[cfg(unix)]
struct ReportTarget {
    parent: fs::File,
    file_name: OsString,
    path_key: PathBuf,
    parent_identity: FileIdentity,
    spec_identity: FileIdentity,
}

#[cfg(windows)]
struct ReportTarget {
    parent: fs::File,
    parent_path: PathBuf,
    file_name: OsString,
    path_key: PathBuf,
    parent_identity: FileIdentity,
    spec_identity: FileIdentity,
}

#[cfg(unix)]
fn open_spec_and_read(value: &OsString, owned_root: &Path) -> Result<OpenedSpec, ()> {
    use std::os::fd::AsRawFd;

    let path = PathBuf::from(value);
    let components = relative_components(&path, owned_root)?;
    let (parents, file_name) = components.split_at(components.len().checked_sub(1).ok_or(())?);
    let parent = unix_open_directory_chain(owned_root, parents)?;
    let mut file = unix_open_at(
        parent.as_raw_fd(),
        &file_name[0],
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    )
    .map_err(|_| ())?;
    let facts = unix_file_facts(&file).map_err(|_| ())?;
    validate_capability_facts(CapabilityRole::Spec, facts)?;
    let identity = unix_file_identity(&file).map_err(|_| ())?;
    let bytes = read_bounded_handle(&mut file, facts.size, MAX_SPEC_BYTES)?;
    Ok(OpenedSpec {
        path,
        bytes,
        identity,
    })
}

#[cfg(unix)]
fn open_report_target(
    value: &OsString,
    owned_root: &Path,
    spec_identity: FileIdentity,
) -> Result<ReportTarget, ()> {
    let path = PathBuf::from(value);
    let components = relative_components(&path, owned_root)?;
    let (parents, file_name) = components.split_at(components.len().checked_sub(1).ok_or(())?);
    let parent = unix_open_directory_chain(owned_root, parents)?;
    let facts = unix_file_facts(&parent).map_err(|_| ())?;
    validate_capability_facts(CapabilityRole::ReportParent, facts)?;
    let target = ReportTarget {
        parent_identity: unix_file_identity(&parent).map_err(|_| ())?,
        parent,
        file_name: file_name[0].clone(),
        path_key: path,
        spec_identity,
    };
    validate_report_destination(&target).map_err(|_| ())?;
    Ok(target)
}

#[cfg(unix)]
fn relative_components(path: &Path, owned_root: &Path) -> Result<Vec<OsString>, ()> {
    use std::path::Component;

    if !path.is_absolute() {
        return Err(());
    }
    let relative = path.strip_prefix(owned_root).map_err(|_| ())?;
    let components = relative
        .components()
        .map(|component| match component {
            Component::Normal(value) => Ok(value.to_os_string()),
            _ => Err(()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() || owned_root.join(components.iter().collect::<PathBuf>()) != path {
        return Err(());
    }
    Ok(components)
}

#[cfg(unix)]
fn unix_open_directory_chain(root: &Path, components: &[OsString]) -> Result<fs::File, ()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let root_bytes = root.as_os_str().as_bytes();
    let root_name = std::ffi::CString::new(root_bytes).map_err(|_| ())?;
    let descriptor = unsafe {
        libc::open(
            root_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if descriptor < 0 {
        return Err(());
    }
    let mut directory = unsafe { fs::File::from_raw_fd(descriptor) };
    for component in components {
        directory = unix_open_at(
            directory.as_raw_fd(),
            component,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0,
        )
        .map_err(|_| ())?;
    }
    Ok(directory)
}

#[cfg(unix)]
fn unix_open_at(
    directory: std::os::fd::RawFd,
    name: &OsStr,
    flags: i32,
    mode: libc::mode_t,
) -> io::Result<fs::File> {
    use std::os::fd::FromRawFd;
    use std::os::unix::ffi::OsStrExt;

    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "invalid path component"))?;
    let descriptor = unsafe { libc::openat(directory, name.as_ptr(), flags, mode) };
    if descriptor < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(unsafe { fs::File::from_raw_fd(descriptor) })
    }
}

#[cfg(unix)]
fn unix_file_facts(file: &fs::File) -> io::Result<CapabilityFacts> {
    use std::os::fd::AsRawFd;

    let mut status = std::mem::MaybeUninit::<libc::stat>::zeroed();
    if unsafe { libc::fstat(file.as_raw_fd(), status.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let status = unsafe { status.assume_init() };
    let kind = status.st_mode & libc::S_IFMT;
    Ok(CapabilityFacts {
        is_file: kind == libc::S_IFREG,
        is_directory: kind == libc::S_IFDIR,
        is_reparse_point: kind == libc::S_IFLNK,
        size: status.st_size.try_into().unwrap_or(u64::MAX),
    })
}

#[cfg(unix)]
fn unix_file_identity(file: &fs::File) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    let mut identity = [0_u8; 16];
    identity[..8].copy_from_slice(&metadata.ino().to_le_bytes());
    Ok(FileIdentity {
        volume: metadata.dev(),
        file: identity,
    })
}

#[cfg(unix)]
fn platform_paths_equal(left: &Path, right: &Path) -> bool {
    left == right
}

#[cfg(windows)]
fn platform_paths_equal(left: &Path, right: &Path) -> bool {
    windows_path_key(left) == windows_path_key(right)
}

#[cfg(windows)]
fn open_spec_and_read(value: &OsString, owned_root: &Path) -> Result<OpenedSpec, ()> {
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, OPEN_EXISTING,
    };

    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(());
    }
    let root = windows_open_directory_no_follow(owned_root).map_err(|_| ())?;
    let root_facts = windows_file_facts(&root).map_err(|_| ())?;
    validate_capability_facts(CapabilityRole::ReportParent, root_facts)?;
    let root_path = windows_final_path(&root).map_err(|_| ())?;
    let mut file = windows_open_file(
        &path,
        GENERIC_READ,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
    )
    .map_err(|_| ())?;
    let facts = windows_file_facts(&file).map_err(|_| ())?;
    validate_capability_facts(CapabilityRole::Spec, facts)?;
    let final_path = windows_final_path(&file).map_err(|_| ())?;
    if !platform_paths_equal(&path, &final_path) || !windows_path_is_within(&final_path, &root_path)
    {
        return Err(());
    }
    let identity = windows_file_identity(&file).map_err(|_| ())?;
    let bytes = read_bounded_handle(&mut file, facts.size, MAX_SPEC_BYTES)?;
    Ok(OpenedSpec {
        path: final_path,
        bytes,
        identity,
    })
}

#[cfg(windows)]
fn open_report_target(
    value: &OsString,
    owned_root: &Path,
    spec_identity: FileIdentity,
) -> Result<ReportTarget, ()> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err(());
    }
    let file_name = path.file_name().filter(|name| !name.is_empty()).ok_or(())?;
    let requested_parent = path.parent().ok_or(())?;
    let root = windows_open_directory_no_follow(owned_root).map_err(|_| ())?;
    let root_facts = windows_file_facts(&root).map_err(|_| ())?;
    validate_capability_facts(CapabilityRole::ReportParent, root_facts)?;
    let root_path = windows_final_path(&root).map_err(|_| ())?;
    let secure_parent = windows_open_directory_no_follow(requested_parent).map_err(|_| ())?;
    let parent_facts = windows_file_facts(&secure_parent).map_err(|_| ())?;
    validate_capability_facts(CapabilityRole::ReportParent, parent_facts)?;
    let parent_path = windows_final_path(&secure_parent).map_err(|_| ())?;
    if !platform_paths_equal(requested_parent, &parent_path)
        || !windows_path_is_within(&parent_path, &root_path)
    {
        return Err(());
    }
    let path_key = parent_path.join(file_name);
    if !platform_paths_equal(&path, &path_key) {
        return Err(());
    }
    let parent_identity = windows_file_identity(&secure_parent).map_err(|_| ())?;
    let parent = windows_open_directory(&parent_path).map_err(|_| ())?;
    verify_parent_identity(
        parent_identity,
        windows_file_identity(&parent).map_err(|_| ())?,
    )?;
    let target = ReportTarget {
        parent_identity,
        parent,
        parent_path,
        file_name: file_name.to_os_string(),
        path_key,
        spec_identity,
    };
    validate_report_destination(&target).map_err(|_| ())?;
    Ok(target)
}

#[cfg(windows)]
fn windows_open_directory(path: &Path) -> io::Result<fs::File> {
    use windows_sys::Win32::Foundation::GENERIC_READ;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };

    windows_open_file(
        path,
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS,
    )
}

#[cfg(windows)]
fn windows_open_directory_no_follow(path: &Path) -> io::Result<fs::File> {
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
fn windows_open_file(
    path: &Path,
    access: u32,
    sharing: u32,
    creation: u32,
    flags: u32,
) -> io::Result<fs::File> {
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
        Ok(unsafe { fs::File::from_raw_handle(handle) })
    }
}

#[cfg(windows)]
fn windows_file_facts(file: &fs::File) -> io::Result<CapabilityFacts> {
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
    Ok(CapabilityFacts {
        is_file: !is_directory,
        is_directory,
        is_reparse_point: basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
        size: standard.EndOfFile.try_into().unwrap_or(u64::MAX),
    })
}

#[cfg(windows)]
fn windows_file_identity(file: &fs::File) -> io::Result<FileIdentity> {
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
        Ok(FileIdentity {
            volume: identity.VolumeSerialNumber,
            file: identity.FileId.Identifier,
        })
    }
}

#[cfg(windows)]
fn windows_final_path(file: &fs::File) -> io::Result<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;

    let required =
        unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), std::ptr::null_mut(), 0, 0) };
    if required == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut buffer = vec![0_u16; required as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if written == 0 || written as usize >= buffer.len() {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(written as usize);
    const EXTENDED_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    const EXTENDED_UNC_PREFIX: &[u16] = &[
        b'\\' as u16,
        b'\\' as u16,
        b'?' as u16,
        b'\\' as u16,
        b'U' as u16,
        b'N' as u16,
        b'C' as u16,
        b'\\' as u16,
    ];
    let normalized = if let Some(remainder) = buffer.strip_prefix(EXTENDED_UNC_PREFIX) {
        [b'\\' as u16, b'\\' as u16]
            .into_iter()
            .chain(remainder.iter().copied())
            .collect::<Vec<_>>()
    } else if let Some(remainder) = buffer.strip_prefix(EXTENDED_PREFIX) {
        remainder.to_vec()
    } else {
        buffer
    };
    Ok(PathBuf::from(OsString::from_wide(&normalized)))
}

#[cfg(windows)]
fn windows_path_key(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;

    path.as_os_str()
        .encode_wide()
        .map(|unit| match unit {
            value if value == b'/' as u16 => b'\\' as u16,
            value if (b'A' as u16..=b'Z' as u16).contains(&value) => value + 32,
            value => value,
        })
        .collect()
}

#[cfg(windows)]
fn windows_path_is_within(path: &Path, root: &Path) -> bool {
    let path = windows_path_key(path);
    let mut root = windows_path_key(root);
    while root.last() == Some(&(b'\\' as u16)) {
        root.pop();
    }
    path == root
        || path
            .strip_prefix(root.as_slice())
            .is_some_and(|suffix| suffix.starts_with(&[b'\\' as u16]))
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PublishOutcome {
    Durable,
    CommittedWithDurabilityWarning,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PublishNotCommitted;

fn write_report_atomically(
    target: &ReportTarget,
    report: &SmokeReport,
    replacer: &dyn ReportReplacer,
) -> Result<PublishOutcome, PublishNotCommitted> {
    validate_report_destination(target).map_err(|_| PublishNotCommitted)?;
    let mut bytes = serde_json::to_vec_pretty(report).map_err(|_| PublishNotCommitted)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_REPORT_BYTES {
        return Err(PublishNotCommitted);
    }

    let temporary_name = OsString::from(format!(
        ".{}.{}.tmp",
        target.file_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    let mut temporary =
        create_temporary_report(target, temporary_name).map_err(|_| PublishNotCommitted)?;
    let before_commit = (|| -> io::Result<()> {
        temporary.file.write_all(&bytes)?;
        temporary.file.flush()?;
        temporary.file.sync_all()?;
        replacer.replace(&mut temporary, target)
    })();
    if before_commit.is_err() {
        cleanup_temporary_report(target, temporary);
        return Err(PublishNotCommitted);
    }
    if replacer.sync_parent(target).is_err() {
        Ok(PublishOutcome::CommittedWithDurabilityWarning)
    } else {
        Ok(PublishOutcome::Durable)
    }
}

fn invalid_report_path() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, "invalid smoke report path")
}

#[cfg(unix)]
fn validate_report_destination(target: &ReportTarget) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    verify_parent_identity(target.parent_identity, unix_file_identity(&target.parent)?)
        .map_err(|_| invalid_report_path())?;
    match unix_open_at(
        target.parent.as_raw_fd(),
        &target.file_name,
        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0,
    ) {
        Ok(file) => {
            validate_capability_facts(CapabilityRole::ExistingReport, unix_file_facts(&file)?)
                .map_err(|_| invalid_report_path())?;
            verify_distinct_file_identity(target.spec_identity, unix_file_identity(&file)?)
                .map_err(|_| invalid_report_path())
        }
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn validate_report_destination(target: &ReportTarget) -> io::Result<()> {
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, GENERIC_READ,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, OPEN_EXISTING,
    };

    verify_parent_identity(
        target.parent_identity,
        windows_file_identity(&target.parent)?,
    )
    .map_err(|_| invalid_report_path())?;
    match windows_open_file(
        &target.path_key,
        GENERIC_READ,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
    ) {
        Ok(file) => {
            validate_capability_facts(CapabilityRole::ExistingReport, windows_file_facts(&file)?)
                .map_err(|_| invalid_report_path())?;
            verify_distinct_file_identity(target.spec_identity, windows_file_identity(&file)?)
                .map_err(|_| invalid_report_path())
        }
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(code) if code == ERROR_FILE_NOT_FOUND as i32 || code == ERROR_PATH_NOT_FOUND as i32
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
fn create_temporary_report(target: &ReportTarget, name: OsString) -> io::Result<TemporaryReport> {
    use std::os::fd::AsRawFd;

    let file = unix_open_at(
        target.parent.as_raw_fd(),
        &name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        0o600,
    )?;
    Ok(TemporaryReport { file, name })
}

#[cfg(windows)]
fn create_temporary_report(target: &ReportTarget, name: OsString) -> io::Result<TemporaryReport> {
    use windows_sys::Win32::Foundation::{GENERIC_READ, GENERIC_WRITE};
    use windows_sys::Win32::Storage::FileSystem::{
        CREATE_NEW, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    };

    // CreateFileW has no public directory-handle-relative create mode. The temp is therefore
    // created empty by pathname, its resolved parent identity is verified against the retained
    // non-delete-shared parent handle, and only then may report bytes be written. A hostile path
    // swap can at worst leave an empty random-name temp outside the owned directory.
    let path = target.parent_path.join(&name);
    let file = windows_open_file(
        &path,
        GENERIC_READ | GENERIC_WRITE | DELETE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
    )?;
    let final_path = windows_final_path(&file)?;
    let final_parent = final_path.parent().ok_or_else(invalid_report_path)?;
    if !platform_paths_equal(final_parent, &target.parent_path) {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(invalid_report_path());
    }
    let verified_parent = windows_open_directory_no_follow(final_parent)?;
    if verify_parent_identity(
        target.parent_identity,
        windows_file_identity(&verified_parent)?,
    )
    .is_err()
    {
        drop(file);
        let _ = fs::remove_file(&path);
        return Err(invalid_report_path());
    }
    Ok(TemporaryReport { file, path })
}

#[cfg(unix)]
impl ReportReplacer for SystemReplacer {
    fn replace(&self, temporary: &mut TemporaryReport, target: &ReportTarget) -> io::Result<()> {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;

        let source =
            std::ffi::CString::new(temporary.name.as_bytes()).map_err(|_| invalid_report_path())?;
        let destination = std::ffi::CString::new(target.file_name.as_bytes())
            .map_err(|_| invalid_report_path())?;
        let result = unsafe {
            libc::renameat(
                target.parent.as_raw_fd(),
                source.as_ptr(),
                target.parent.as_raw_fd(),
                destination.as_ptr(),
            )
        };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}

#[cfg(windows)]
impl ReportReplacer for SystemReplacer {
    fn replace(&self, temporary: &mut TemporaryReport, target: &ReportTarget) -> io::Result<()> {
        use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;

        let relative =
            windows_rename_by_handle(&temporary.file, target, Path::new(&target.file_name), true);
        if !matches!(
            relative.as_ref().err().and_then(io::Error::raw_os_error),
            Some(code) if code == ERROR_INVALID_PARAMETER as i32
        ) {
            return relative;
        }

        // Some Windows filesystems reject FILE_RENAME_INFO.RootDirectory with
        // ERROR_INVALID_PARAMETER. The parent remains open without delete sharing; verify its
        // identity and pathname binding again before the absolute SetFileInformation fallback.
        verify_parent_identity(
            target.parent_identity,
            windows_file_identity(&target.parent)?,
        )
        .map_err(|_| invalid_report_path())?;
        let rebound_parent = windows_open_directory_no_follow(&target.parent_path)?;
        verify_parent_identity(
            target.parent_identity,
            windows_file_identity(&rebound_parent)?,
        )
        .map_err(|_| invalid_report_path())?;
        validate_report_destination(target)?;
        windows_rename_by_handle(&temporary.file, target, &target.path_key, false)
    }
}

#[cfg(windows)]
fn windows_rename_buffer_layout(name_units: usize) -> io::Result<(usize, u32, u32, usize)> {
    use windows_sys::Win32::Storage::FileSystem::FILE_RENAME_INFO;

    let name_bytes = name_units
        .checked_mul(std::mem::size_of::<u16>())
        .ok_or_else(invalid_report_path)?;
    let name_bytes_u32 = u32::try_from(name_bytes).map_err(|_| invalid_report_path())?;
    let total_bytes = std::mem::offset_of!(FILE_RENAME_INFO, FileName)
        .checked_add(name_bytes)
        .ok_or_else(invalid_report_path)?;
    u32::try_from(total_bytes).map_err(|_| invalid_report_path())?;
    // SetFileInformationByHandle requires the ABI structure size plus FileNameLength even
    // though the logical flexible-array payload starts at FileName. Keep the two checked sizes
    // distinct: using the payload size as dwBufferSize can report success while producing a
    // filename with trailing garbage on Windows filesystems.
    let api_bytes = std::mem::size_of::<FILE_RENAME_INFO>()
        .checked_add(name_bytes)
        .ok_or_else(invalid_report_path)?;
    let api_bytes_u32 = u32::try_from(api_bytes).map_err(|_| invalid_report_path())?;
    let unit_bytes = std::mem::size_of::<FILE_RENAME_INFO>();
    let storage_units = api_bytes
        .checked_add(unit_bytes - 1)
        .ok_or_else(invalid_report_path)?
        / unit_bytes;
    Ok((total_bytes, name_bytes_u32, api_bytes_u32, storage_units))
}

#[cfg(windows)]
fn windows_rename_by_handle(
    file: &fs::File,
    target: &ReportTarget,
    name: &Path,
    relative_to_parent: bool,
) -> io::Result<()> {
    use std::mem::MaybeUninit;
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileRenameInfo, SetFileInformationByHandle, FILE_RENAME_INFO,
    };

    let name = name.as_os_str().encode_wide().collect::<Vec<_>>();
    let (_payload_size, name_bytes, api_size, storage_units) =
        windows_rename_buffer_layout(name.len())?;
    let mut storage = Vec::<MaybeUninit<FILE_RENAME_INFO>>::new();
    storage.resize_with(storage_units, MaybeUninit::zeroed);
    let information = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    unsafe {
        std::ptr::addr_of_mut!((*information).Anonymous.ReplaceIfExists).write(true);
        std::ptr::addr_of_mut!((*information).RootDirectory).write(if relative_to_parent {
            target.parent.as_raw_handle()
        } else {
            std::ptr::null_mut()
        });
        std::ptr::addr_of_mut!((*information).FileNameLength).write(name_bytes);
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            information
                .cast::<u8>()
                .add(std::mem::offset_of!(FILE_RENAME_INFO, FileName))
                .cast::<u16>(),
            name.len(),
        );
    }
    let success = unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfo,
            storage.as_ptr().cast(),
            api_size,
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn cleanup_temporary_report(target: &ReportTarget, temporary: TemporaryReport) {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;

    drop(temporary.file);
    if let Ok(name) = std::ffi::CString::new(temporary.name.as_bytes()) {
        unsafe {
            libc::unlinkat(target.parent.as_raw_fd(), name.as_ptr(), 0);
        }
    }
}

#[cfg(windows)]
fn cleanup_temporary_report(_target: &ReportTarget, temporary: TemporaryReport) {
    let path = temporary.path.clone();
    drop(temporary);
    let _ = fs::remove_file(path);
}

#[cfg(unix)]
fn sync_report_parent(target: &ReportTarget) -> io::Result<()> {
    target.parent.sync_all()
}

#[cfg(windows)]
fn sync_report_parent(_target: &ReportTarget) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn smoke_spec_is_read_from_the_validated_no_follow_handle() {
        let original = br#"{"schema":"from-open-handle"}"#.to_vec();
        let mut validated_handle = Cursor::new(original.clone());

        let bytes = read_bounded_handle(&mut validated_handle, original.len() as u64, 1024)
            .expect("read bytes from already validated handle");

        assert_eq!(bytes, original);
    }

    #[test]
    fn smoke_report_parent_identity_mismatch_is_rejected() {
        let expected = FileIdentity::for_test(7, 11);
        let substituted = FileIdentity::for_test(7, 12);

        assert!(verify_parent_identity(expected, substituted).is_err());
        assert!(verify_parent_identity(expected, expected).is_ok());
    }

    #[test]
    fn smoke_spec_and_report_require_distinct_file_identities() {
        let spec = FileIdentity::for_test(7, 11);

        assert!(verify_distinct_file_identity(spec, spec).is_err());
        assert!(verify_distinct_file_identity(spec, FileIdentity::for_test(7, 12)).is_ok());
    }

    #[test]
    fn smoke_process_environment_disabled_fast_path_does_not_resolve_cwd() {
        use std::cell::{Cell, RefCell};

        let requested = RefCell::new(Vec::new());
        let cwd_called = Cell::new(false);
        let protocol = SmokeProtocol::from_process_sources(
            |name| {
                requested.borrow_mut().push(name.to_string());
                None
            },
            || {
                cwd_called.set(true);
                Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "injected current directory failure",
                ))
            },
        );

        assert_eq!(protocol.plan().mode, SmokeMode::Disabled);
        assert_eq!(requested.into_inner(), SMOKE_ENV_NAMES);
        assert!(!cwd_called.get(), "disabled fast path must not resolve cwd");
    }

    #[test]
    fn smoke_rejects_spec_report_and_parent_reparse_points() {
        for role in [
            CapabilityRole::Spec,
            CapabilityRole::ExistingReport,
            CapabilityRole::ReportParent,
        ] {
            assert!(validate_capability_facts(
                role,
                CapabilityFacts {
                    is_file: role != CapabilityRole::ReportParent,
                    is_directory: role == CapabilityRole::ReportParent,
                    is_reparse_point: true,
                    size: 0,
                },
            )
            .is_err());
        }
    }

    #[test]
    fn smoke_atomic_publish_failure_preserves_destination_and_removes_temp() {
        let fixture = TestFixture::new();
        let old = b"{\"generation\":\"old\"}\n";
        serde_json::from_slice::<serde_json::Value>(old).expect("old report fixture is valid JSON");
        fs::write(fixture.report_path(), old).expect("write old report");
        let protocol = SmokeProtocol::from_environment_with_replacer(
            &fixture.environment("replace-failure-token"),
            &fixture.root,
            Arc::new(FailingReplacer),
        );
        let proof = protocol
            .plan()
            .session_proof
            .expect("active smoke session proof");

        let error = protocol
            .complete(
                &proof,
                CompleteRequest {
                    status: SmokeTerminalStatus::Passed,
                    failure_phase: None,
                    duration_ms: 0,
                    diagnostic: None,
                },
            )
            .expect_err("injected replacement failure is static");

        assert_eq!(error, SmokeError::rejected());
        assert_eq!(
            fs::read(fixture.report_path()).expect("read old report"),
            old
        );
        assert_eq!(temporary_report_count(&fixture.root), 0);
    }

    #[test]
    fn smoke_post_commit_sync_failure_replays_cached_warning_without_rewrite() {
        let fixture = TestFixture::new();
        let protocol = SmokeProtocol::from_environment_with_replacer(
            &fixture.environment("post-commit-sync-token"),
            &fixture.root,
            Arc::new(SyncFailingReplacer),
        );
        let proof = protocol
            .plan()
            .session_proof
            .expect("active smoke session proof");

        let response = protocol
            .complete(
                &proof,
                CompleteRequest {
                    status: SmokeTerminalStatus::Passed,
                    failure_phase: None,
                    duration_ms: 0,
                    diagnostic: None,
                },
            )
            .expect("visible report remains a completed command");

        assert_eq!(response.status, SmokeUpdateStatus::Completed);
        assert_eq!(
            response.diagnostic,
            Some(SmokeDiagnostic {
                code: "report-durability-warning".to_string(),
                message: "Smoke report was committed but durability sync failed.".to_string(),
            })
        );
        let report: serde_json::Value = serde_json::from_slice(
            &fs::read(fixture.report_path()).expect("committed report is visible"),
        )
        .expect("visible report is valid JSON");
        assert_eq!(report["status"], "passed");
        assert_eq!(temporary_report_count(&fixture.root), 0);
        let bytes = fs::read(fixture.report_path()).expect("read committed report bytes");
        assert_eq!(
            protocol
                .complete(
                    &proof,
                    CompleteRequest {
                        status: SmokeTerminalStatus::Passed,
                        failure_phase: None,
                        duration_ms: 0,
                        diagnostic: None,
                    },
                )
                .expect("identical completion replays committed warning"),
            response
        );
        assert_eq!(
            fs::read(fixture.report_path()).expect("read report after replay"),
            bytes
        );
        assert_eq!(temporary_report_count(&fixture.root), 0);
    }

    #[test]
    fn smoke_pre_commit_failure_preserves_report_and_state_for_retry() {
        let fixture = TestFixture::new();
        let old = b"{\"generation\":\"old\"}\n";
        fs::write(fixture.report_path(), old).expect("write old report");
        let protocol = SmokeProtocol::from_environment_with_replacer(
            &fixture.environment("pre-commit-retry-token"),
            &fixture.root,
            Arc::new(FailOnceReplacer(AtomicBool::new(false))),
        );
        let proof = protocol
            .plan()
            .session_proof
            .expect("active smoke session proof");
        let request = CompleteRequest {
            status: SmokeTerminalStatus::Passed,
            failure_phase: None,
            duration_ms: 0,
            diagnostic: None,
        };

        assert_eq!(
            protocol
                .complete(&proof, request.clone())
                .expect_err("first replacement fails before commit"),
            SmokeError::rejected()
        );
        assert_eq!(
            fs::read(fixture.report_path()).expect("read old report"),
            old
        );
        assert_eq!(temporary_report_count(&fixture.root), 0);
        assert_eq!(
            protocol
                .complete(&proof, request)
                .expect("pre-commit failure leaves protocol retryable")
                .status,
            SmokeUpdateStatus::Completed
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_path_identity_does_not_collapse_unpaired_utf16() {
        use std::os::windows::ffi::OsStringExt;

        let first = PathBuf::from(OsString::from_wide(&[
            b'C' as u16,
            b':' as u16,
            b'\\' as u16,
            0xd800,
        ]));
        let second = PathBuf::from(OsString::from_wide(&[
            b'C' as u16,
            b':' as u16,
            b'\\' as u16,
            0xd801,
        ]));

        assert_ne!(windows_path_key(&first), windows_path_key(&second));
    }

    #[cfg(windows)]
    #[test]
    fn windows_rename_buffer_layout_is_aligned_and_checked() {
        use windows_sys::Win32::Storage::FileSystem::FILE_RENAME_INFO;

        let (total_bytes, name_bytes, api_bytes, storage_units) =
            windows_rename_buffer_layout(3).expect("small rename buffer layout");
        assert_eq!(name_bytes, 6);
        assert_eq!(
            total_bytes,
            std::mem::offset_of!(FILE_RENAME_INFO, FileName) + name_bytes as usize
        );
        assert!(
            storage_units * std::mem::size_of::<FILE_RENAME_INFO>() >= api_bytes as usize,
            "aligned storage covers the checked Win32 ABI length"
        );
        assert_eq!(
            api_bytes as usize,
            std::mem::size_of::<FILE_RENAME_INFO>() + name_bytes as usize
        );
        assert!(windows_rename_buffer_layout(usize::MAX).is_err());
    }

    #[derive(Debug)]
    struct FailingReplacer;

    impl ReportReplacer for FailingReplacer {
        fn replace(
            &self,
            _temporary: &mut TemporaryReport,
            _target: &ReportTarget,
        ) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "injected static replacement failure",
            ))
        }
    }

    #[derive(Debug)]
    struct SyncFailingReplacer;

    impl ReportReplacer for SyncFailingReplacer {
        fn replace(
            &self,
            temporary: &mut TemporaryReport,
            target: &ReportTarget,
        ) -> io::Result<()> {
            SystemReplacer.replace(temporary, target)
        }

        fn sync_parent(&self, _target: &ReportTarget) -> io::Result<()> {
            Err(io::Error::other("injected post-commit sync failure"))
        }
    }

    #[derive(Debug)]
    struct FailOnceReplacer(AtomicBool);

    impl ReportReplacer for FailOnceReplacer {
        fn replace(
            &self,
            temporary: &mut TemporaryReport,
            target: &ReportTarget,
        ) -> io::Result<()> {
            if !self.0.swap(true, Ordering::SeqCst) {
                Err(io::Error::other("injected pre-commit replacement failure"))
            } else {
                SystemReplacer.replace(temporary, target)
            }
        }
    }

    struct TestFixture {
        root: PathBuf,
    }

    impl TestFixture {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("ride-smoke-unit-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).expect("create unit smoke root");
            Self { root }
        }

        fn report_path(&self) -> PathBuf {
            dunce::canonicalize(&self.root)
                .expect("canonical unit root")
                .join("report.json")
        }

        fn environment(&self, token: &str) -> BTreeMap<OsString, OsString> {
            let spec_path = self.root.join("spec.json");
            let spec = json!({
                "schema": SPEC_SCHEMA,
                "version": PROTOCOL_VERSION,
                "scenario": "critical-empty",
                "profile": "tauri-critical",
                "workspace": ".",
                "files": [],
                "actions": [],
                "tokenSha256": sha256(token.as_bytes()),
                "actionTimeoutMs": 30_000
            });
            fs::write(
                &spec_path,
                serde_json::to_vec(&spec).expect("serialize unit spec"),
            )
            .expect("write unit spec");
            BTreeMap::from([
                (
                    OsString::from(SPEC_ENV),
                    dunce::canonicalize(spec_path)
                        .expect("canonical unit spec")
                        .into_os_string(),
                ),
                (
                    OsString::from(REPORT_ENV),
                    self.report_path().into_os_string(),
                ),
                (OsString::from(TOKEN_ENV), OsString::from(token)),
            ])
        }
    }

    impl Drop for TestFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn temporary_report_count(parent: &Path) -> usize {
        fs::read_dir(parent)
            .expect("list unit report directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count()
    }
}
