/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

use ride_tauri::smoke::{
    CompleteRequest, FailurePhase, RecordStepRequest, SmokeAction, SmokeDiagnostic, SmokeMode,
    SmokeProfile, SmokeProtocol, SmokeScenario, SmokeStepState, SmokeTerminalStatus,
    SmokeUpdateResponse, SmokeUpdateStatus,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Barrier, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

const SPEC_ENV: &str = "RIDE_TAURI_SMOKE_SPEC";
const REPORT_ENV: &str = "RIDE_TAURI_SMOKE_REPORT";
const TOKEN_ENV: &str = "RIDE_TAURI_SMOKE_TOKEN";

#[derive(Debug)]
struct Fixture {
    root: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("ride-smoke-{}", Uuid::new_v4()));
        fs::create_dir(&root).expect("create smoke fixture root");
        Self { root }
    }

    fn canonical_root(&self) -> PathBuf {
        dunce::canonicalize(&self.root).expect("canonical fixture root")
    }

    fn spec_path(&self) -> PathBuf {
        self.root.join("spec.json")
    }

    fn report_path(&self) -> PathBuf {
        self.canonical_root().join("report.json")
    }

    fn write_spec(&self, token: &str, overrides: Value) -> PathBuf {
        let mut spec = json!({
            "schema": "ride.tauri-packaged-smoke-spec",
            "version": 1,
            "scenario": "critical-file",
            "profile": "tauri-critical",
            "workspace": ".",
            "files": ["startup.R", "forwarded.R"],
            "actions": [
                "editor-save",
                "terminal-sentinel",
                "workspace-search",
                "scm-status",
                "packaged-plugin-command",
                "secondary-window",
                "second-file-forwarding"
            ],
            "tokenSha256": sha256(token.as_bytes()),
            "actionTimeoutMs": 30_000
        });
        if let (Some(target), Some(source)) = (spec.as_object_mut(), overrides.as_object()) {
            target.extend(source.clone());
        }
        fs::write(
            self.spec_path(),
            serde_json::to_vec_pretty(&spec).expect("serialize smoke spec"),
        )
        .expect("write smoke spec");
        dunce::canonicalize(self.spec_path()).expect("canonical smoke spec")
    }

    fn environment(&self, token: &str, overrides: Value) -> BTreeMap<OsString, OsString> {
        let spec = self.write_spec(token, overrides);
        BTreeMap::from([
            (OsString::from(SPEC_ENV), spec.into_os_string()),
            (
                OsString::from(REPORT_ENV),
                self.report_path().into_os_string(),
            ),
            (OsString::from(TOKEN_ENV), OsString::from(token)),
        ])
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn diagnostic(code: &str, message: &str) -> SmokeDiagnostic {
    SmokeDiagnostic {
        code: code.to_string(),
        message: message.to_string(),
    }
}

fn step(action: SmokeAction, state: SmokeStepState, duration_ms: u64) -> RecordStepRequest {
    RecordStepRequest {
        action,
        state,
        duration_ms,
        diagnostic: None,
    }
}

fn complete_passed(duration_ms: u64) -> CompleteRequest {
    CompleteRequest {
        status: SmokeTerminalStatus::Passed,
        failure_phase: None,
        duration_ms,
        diagnostic: None,
    }
}

fn complete_actions(protocol: &SmokeProtocol, proof: &str, actions: &[SmokeAction]) {
    let mut duration_ms = 0;
    for action in actions {
        protocol
            .record_step(proof, step(*action, SmokeStepState::Started, duration_ms))
            .expect("start smoke action");
        duration_ms += 1;
        protocol
            .record_step(proof, step(*action, SmokeStepState::Passed, duration_ms))
            .expect("pass smoke action");
        duration_ms += 1;
    }
}

fn active_session_proof(protocol: &SmokeProtocol) -> String {
    protocol
        .plan()
        .session_proof
        .expect("active smoke session proof")
}

fn record_envelope(proof: &str, request: Value) -> Value {
    json!({ "sessionProof": proof, "request": request })
}

fn assert_static_rejection(error: &ride_tauri::smoke::SmokeError, secret: &str) {
    assert_eq!(error.code, "smoke-request-rejected");
    assert_eq!(error.message, "Smoke protocol request was rejected.");
    let serialized = serde_json::to_string(error).expect("serialize static smoke error");
    assert!(!serialized.contains(secret));
}

#[test]
fn smoke_protocol_is_disabled_when_all_environment_variables_are_absent() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(&BTreeMap::new(), &fixture.root);
    let plan = protocol.plan();

    assert_eq!(plan.mode, SmokeMode::Disabled);
    assert!(plan.plan.is_none());
    assert!(plan.diagnostic.is_none());
}

#[test]
fn smoke_protocol_rejects_partial_contract_without_echoing_environment_values() {
    let fixture = Fixture::new();
    let secret = "do-not-echo-this-token";
    let environment = BTreeMap::from([
        (OsString::from(SPEC_ENV), OsString::from(secret)),
        (OsString::from(TOKEN_ENV), OsString::from(secret)),
    ]);
    let protocol = SmokeProtocol::from_environment(&environment, &fixture.root);
    let plan = protocol.plan();
    let serialized = serde_json::to_string(&plan).expect("serialize rejected plan");

    assert_eq!(plan.mode, SmokeMode::Rejected);
    assert_eq!(
        plan.diagnostic,
        Some(diagnostic("protocol-failed", "Smoke protocol failed."))
    );
    assert!(!serialized.contains(secret));
    assert!(!serialized.contains(fixture.root.to_string_lossy().as_ref()));
}

#[test]
fn smoke_protocol_constructs_a_safe_plan_from_explicit_environment_and_cwd() {
    let fixture = Fixture::new();
    let token = "opaque-smoke-token";
    let environment = fixture.environment(token, json!({}));
    let protocol = SmokeProtocol::from_environment(&environment, &fixture.root);
    let response = protocol.plan();
    let plan = response.plan.expect("active smoke plan");
    let serialized = serde_json::to_string(&plan).expect("serialize smoke plan");

    assert_eq!(response.mode, SmokeMode::Active);
    assert_eq!(plan.scenario, SmokeScenario::CriticalFile);
    assert_eq!(plan.profile, SmokeProfile::TauriCritical);
    assert_eq!(plan.workspace, ".");
    assert_eq!(plan.files, ["startup.R", "forwarded.R"]);
    assert_eq!(plan.actions.len(), 7);
    assert_eq!(plan.action_timeout_ms, 30_000);
    assert!(!serialized.contains(token));
    assert!(!serialized.contains(fixture.root.to_string_lossy().as_ref()));
}

#[test]
fn smoke_protocol_rejects_token_mismatch_and_unsafe_owned_paths() {
    let fixture = Fixture::new();
    let token = "correct-token";
    let mismatched = fixture.environment(token, json!({ "tokenSha256": "0".repeat(64) }));
    assert_eq!(
        SmokeProtocol::from_environment(&mismatched, &fixture.root)
            .plan()
            .mode,
        SmokeMode::Rejected
    );

    let outside = Fixture::new();
    let mut outside_spec = fixture.environment(token, json!({}));
    outside_spec.insert(
        OsString::from(SPEC_ENV),
        outside.write_spec(token, json!({})).into_os_string(),
    );
    assert_eq!(
        SmokeProtocol::from_environment(&outside_spec, &fixture.root)
            .plan()
            .mode,
        SmokeMode::Rejected
    );

    let mut relative_report = fixture.environment(token, json!({}));
    relative_report.insert(OsString::from(REPORT_ENV), OsString::from("report.json"));
    assert_eq!(
        SmokeProtocol::from_environment(&relative_report, &fixture.root)
            .plan()
            .mode,
        SmokeMode::Rejected
    );
}

#[test]
fn smoke_protocol_rejects_report_hard_linked_to_the_spec() {
    let fixture = Fixture::new();
    let environment = fixture.environment("hard-link-token", json!({ "actions": [] }));
    let spec_path = PathBuf::from(
        environment
            .get(OsStr::new(SPEC_ENV))
            .expect("spec environment path"),
    );
    fs::hard_link(&spec_path, fixture.report_path())
        .expect("create deterministic spec/report hard link");

    assert_eq!(
        SmokeProtocol::from_environment(&environment, &fixture.root)
            .plan()
            .mode,
        SmokeMode::Rejected
    );
}

#[cfg(windows)]
#[test]
fn smoke_protocol_rejects_windows_case_alias_of_the_spec_as_report() {
    let fixture = Fixture::new();
    let mut environment = fixture.environment("case-alias-token", json!({ "actions": [] }));
    let spec_path = PathBuf::from(
        environment
            .get(OsStr::new(SPEC_ENV))
            .expect("spec environment path"),
    );
    let alias = spec_path.parent().expect("spec parent").join("SPEC.JSON");
    fs::metadata(&alias).expect("Windows filesystem resolves the explicit case alias");
    environment.insert(OsString::from(REPORT_ENV), alias.into_os_string());

    assert_eq!(
        SmokeProtocol::from_environment(&environment, &fixture.root)
            .plan()
            .mode,
        SmokeMode::Rejected
    );
}

#[test]
fn smoke_protocol_rejects_symlinks_non_files_and_oversized_inputs() {
    let fixture = Fixture::new();
    let token = "bounded-token";

    let mut directory_spec = fixture.environment(token, json!({}));
    directory_spec.insert(
        OsString::from(SPEC_ENV),
        fixture.canonical_root().into_os_string(),
    );
    assert_eq!(
        SmokeProtocol::from_environment(&directory_spec, &fixture.root)
            .plan()
            .mode,
        SmokeMode::Rejected
    );

    let oversized = fixture.root.join("oversized.json");
    fs::write(&oversized, vec![b' '; 1_048_577]).expect("write oversized spec");
    let mut oversized_environment = fixture.environment(token, json!({}));
    oversized_environment.insert(
        OsString::from(SPEC_ENV),
        dunce::canonicalize(&oversized)
            .expect("canonical oversized spec")
            .into_os_string(),
    );
    assert_eq!(
        SmokeProtocol::from_environment(&oversized_environment, &fixture.root)
            .plan()
            .mode,
        SmokeMode::Rejected
    );

    let target = fixture.write_spec(token, json!({}));
    let link = fixture.root.join("spec-link.json");
    match create_file_symlink(&target, &link) {
        Ok(()) => {
            let mut symlink_environment = fixture.environment(token, json!({}));
            symlink_environment.insert(OsString::from(SPEC_ENV), link.into_os_string());
            assert_eq!(
                SmokeProtocol::from_environment(&symlink_environment, &fixture.root)
                    .plan()
                    .mode,
                SmokeMode::Rejected
            );
        }
        #[cfg(windows)]
        Err(error)
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314) =>
        {
            eprintln!(
                "Windows symlink integration unavailable; deterministic capability-seam test remains mandatory"
            );
        }
        Err(_) => panic!("unexpected failure creating smoke symlink fixture"),
    }
}

#[cfg(unix)]
fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn create_file_symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

#[test]
fn smoke_protocol_matches_node_contract_constants_and_rejects_non_parity_fixtures() {
    assert_eq!(
        SmokeScenario::ALL,
        [
            SmokeScenario::CriticalFile,
            SmokeScenario::CriticalEmpty,
            SmokeScenario::FullFile,
        ]
    );
    assert_eq!(
        SmokeAction::ALL,
        [
            SmokeAction::EditorSave,
            SmokeAction::TerminalSentinel,
            SmokeAction::WorkspaceSearch,
            SmokeAction::ScmStatus,
            SmokeAction::PackagedPluginCommand,
            SmokeAction::SecondaryWindow,
            SmokeAction::SecondFileForwarding,
        ]
    );

    for (scenario, profile, files, actions) in [
        (
            "critical-file",
            "tauri-critical",
            json!(["workspace\\startup.R"]),
            json!(["editor-save"]),
        ),
        ("critical-empty", "tauri-critical", json!([]), json!([])),
        (
            "full-file",
            "full",
            json!(["nested\\startup.R"]),
            json!([
                "editor-save",
                "terminal-sentinel",
                "workspace-search",
                "scm-status",
                "packaged-plugin-command",
                "secondary-window",
                "second-file-forwarding"
            ]),
        ),
    ] {
        let fixture = Fixture::new();
        let protocol = SmokeProtocol::from_environment(
            &fixture.environment(
                "parity-token",
                json!({
                    "scenario": scenario,
                    "profile": profile,
                    "files": files,
                    "actions": actions,
                }),
            ),
            &fixture.root,
        );
        assert_eq!(protocol.plan().mode, SmokeMode::Active);
    }

    for invalid in [
        json!({ "schema": "ride.tauri-packaged-smoke-spec@1" }),
        json!({ "version": 2 }),
        json!({ "scenario": "unknown" }),
        json!({ "profile": "unknown" }),
        json!({ "workspace": "../outside" }),
        json!({ "files": ["bad?.R"] }),
        json!({ "files": ["nested/CON"] }),
        json!({ "files": ["same.R", "SAME.r"] }),
        json!({ "actions": ["terminal-sentinel", "editor-save"] }),
        json!({ "actions": ["editor-save", "editor-save"] }),
        json!({ "actionTimeoutMs": 999 }),
        json!({ "unexpected": true }),
    ] {
        let fixture = Fixture::new();
        let protocol = SmokeProtocol::from_environment(
            &fixture.environment("parity-token", invalid),
            &fixture.root,
        );
        assert_eq!(protocol.plan().mode, SmokeMode::Rejected);
    }
}

#[test]
fn smoke_protocol_disabled_and_rejected_updates_are_safe_noops() {
    let fixture = Fixture::new();
    let disabled = SmokeProtocol::from_environment(&BTreeMap::new(), &fixture.root);
    assert_eq!(
        disabled
            .record_step(
                "",
                step(SmokeAction::EditorSave, SmokeStepState::Started, 0)
            )
            .expect("disabled update")
            .status,
        SmokeUpdateStatus::Disabled
    );
    assert_eq!(
        disabled
            .complete("", complete_passed(0))
            .expect("disabled completion")
            .status,
        SmokeUpdateStatus::Disabled
    );

    let rejected = SmokeProtocol::from_environment(
        &BTreeMap::from([(OsString::from(SPEC_ENV), OsString::from("secret"))]),
        &fixture.root,
    );
    let response = rejected
        .record_step(
            "",
            step(SmokeAction::EditorSave, SmokeStepState::Started, 0),
        )
        .expect("rejected update response");
    assert_eq!(response.status, SmokeUpdateStatus::Rejected);
    assert_eq!(
        response.diagnostic,
        Some(diagnostic("protocol-failed", "Smoke protocol failed."))
    );
}

#[test]
fn smoke_protocol_replays_identical_steps_but_rejects_different_out_of_order_requests() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(
            "ordering-token",
            json!({ "actions": ["editor-save", "terminal-sentinel"] }),
        ),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);

    assert!(protocol
        .record_step(
            &proof,
            step(SmokeAction::TerminalSentinel, SmokeStepState::Started, 0)
        )
        .is_err());
    protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Started, 2),
        )
        .expect("start first action");
    assert_eq!(
        protocol
            .record_step(
                &proof,
                step(SmokeAction::EditorSave, SmokeStepState::Started, 2)
            )
            .expect("identical started response replay"),
        SmokeUpdateResponse {
            status: SmokeUpdateStatus::Recorded,
            diagnostic: None,
        }
    );
    assert!(protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Started, 3)
        )
        .is_err());
    assert!(protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Passed, 1)
        )
        .is_err());
    protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Passed, 3),
        )
        .expect("pass first action");
    protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Passed, 3),
        )
        .expect("identical passed response replay");
}

#[test]
fn smoke_protocol_replays_identical_started_passed_and_complete_without_report_side_effects() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(
            "replay-success-token",
            json!({ "actions": ["editor-save"] }),
        ),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    let started = step(SmokeAction::EditorSave, SmokeStepState::Started, 0);
    let passed = step(SmokeAction::EditorSave, SmokeStepState::Passed, 1);
    let completion = complete_passed(2);

    for request in [started.clone(), started] {
        assert_eq!(
            protocol
                .record_step(&proof, request)
                .expect("started request or response-loss replay"),
            SmokeUpdateResponse {
                status: SmokeUpdateStatus::Recorded,
                diagnostic: None,
            }
        );
    }
    for request in [passed.clone(), passed] {
        assert_eq!(
            protocol
                .record_step(&proof, request)
                .expect("passed request or response-loss replay"),
            SmokeUpdateResponse {
                status: SmokeUpdateStatus::Recorded,
                diagnostic: None,
            }
        );
    }

    let first_response = protocol
        .complete(&proof, completion.clone())
        .expect("first completion");
    let first_report = fs::read(fixture.report_path()).expect("read first report");
    let replayed_response = protocol
        .complete(&proof, completion)
        .expect("identical completion response replay");
    let replayed_report = fs::read(fixture.report_path()).expect("read replayed report");

    assert_eq!(replayed_response, first_response);
    assert_eq!(replayed_report, first_report);
    assert_eq!(temporary_report_count(&fixture.root), 0);
    let report: Value = serde_json::from_slice(&replayed_report).expect("parse replayed report");
    assert_eq!(report["steps"].as_array().expect("report steps").len(), 2);
    assert!(protocol.complete(&proof, complete_passed(3)).is_err());
    assert!(protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Passed, 1)
        )
        .is_err());
}

#[test]
fn smoke_protocol_replays_identical_failed_step_without_duplicate_failure_state() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(
            "replay-failure-token",
            json!({ "actions": ["editor-save"] }),
        ),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Started, 0),
        )
        .expect("start failed action");
    let failure = diagnostic("action-failed", "Smoke action failed.");
    let failed = RecordStepRequest {
        action: SmokeAction::EditorSave,
        state: SmokeStepState::Failed,
        duration_ms: 1,
        diagnostic: Some(failure.clone()),
    };

    for request in [failed.clone(), failed] {
        assert_eq!(
            protocol
                .record_step(&proof, request)
                .expect("failed request or response-loss replay")
                .status,
            SmokeUpdateStatus::Recorded
        );
    }
    protocol
        .complete(
            &proof,
            CompleteRequest {
                status: SmokeTerminalStatus::Failed,
                failure_phase: Some(FailurePhase::Action),
                duration_ms: 2,
                diagnostic: Some(failure),
            },
        )
        .expect("complete replayed action failure");

    let report: Value =
        serde_json::from_slice(&fs::read(fixture.report_path()).expect("read failed report"))
            .expect("parse failed report");
    assert_eq!(
        report["steps"]
            .as_array()
            .expect("failed report steps")
            .len(),
        2
    );
}

#[test]
fn smoke_record_step_immediately_publishes_strict_progress_snapshots() {
    let fixture = Fixture::new();
    let token = "progress-snapshot-token";
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(
            token,
            json!({ "actions": ["editor-save", "terminal-sentinel"] }),
        ),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);

    protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Started, 3),
        )
        .expect("record started progress");
    let started_bytes = fs::read(fixture.report_path()).expect("started progress is visible");
    let started: Value =
        serde_json::from_slice(&started_bytes).expect("started progress is complete JSON");
    assert_eq!(started["schema"], "ride.tauri-packaged-smoke-progress");
    assert_eq!(started["durationMs"], 3);
    assert_eq!(started["steps"].as_array().expect("started steps").len(), 1);
    assert_eq!(started["steps"][0]["state"], "started");

    protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Passed, 5),
        )
        .expect("record passed progress");
    let passed: Value = serde_json::from_slice(
        &fs::read(fixture.report_path()).expect("passed progress is visible"),
    )
    .expect("passed progress is complete JSON");
    assert_eq!(passed["durationMs"], 5);
    assert_eq!(passed["steps"].as_array().expect("passed steps").len(), 2);
    assert_eq!(passed["steps"][1]["state"], "passed");

    protocol
        .record_step(
            &proof,
            step(SmokeAction::TerminalSentinel, SmokeStepState::Started, 8),
        )
        .expect("record second started progress");
    let failure = diagnostic("action-timeout", "Smoke action timed out.");
    protocol
        .record_step(
            &proof,
            RecordStepRequest {
                action: SmokeAction::TerminalSentinel,
                state: SmokeStepState::Failed,
                duration_ms: 13,
                diagnostic: Some(failure),
            },
        )
        .expect("record failed progress");
    let failed_bytes = fs::read(fixture.report_path()).expect("failed progress is visible");
    let failed: Value =
        serde_json::from_slice(&failed_bytes).expect("failed progress is complete JSON");
    assert_eq!(failed["durationMs"], 13);
    assert_eq!(failed["steps"].as_array().expect("failed steps").len(), 4);
    assert_eq!(failed["steps"][3]["state"], "failed");

    let serialized = String::from_utf8(failed_bytes).expect("progress is UTF-8");
    assert!(!serialized.contains(token));
    assert!(!serialized.contains(&proof));
    assert!(!serialized.contains(fixture.root.to_string_lossy().as_ref()));
    assert!(failed.get("workspace").is_none());
    assert_eq!(
        failed
            .as_object()
            .expect("progress object")
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        [
            "durationMs",
            "profile",
            "scenario",
            "schema",
            "specSha256",
            "steps",
            "version",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    );
}

#[test]
fn smoke_complete_atomically_replaces_progress_with_the_final_report_schema() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(
            "progress-complete-token",
            json!({ "actions": ["editor-save"] }),
        ),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    complete_actions(&protocol, &proof, &[SmokeAction::EditorSave]);

    let progress: Value = serde_json::from_slice(
        &fs::read(fixture.report_path()).expect("final progress is visible before complete"),
    )
    .expect("parse final progress");
    assert_eq!(progress["schema"], "ride.tauri-packaged-smoke-progress");
    assert!(progress.get("status").is_none());

    protocol
        .complete(&proof, complete_passed(2))
        .expect("complete final report");
    let report: Value = serde_json::from_slice(
        &fs::read(fixture.report_path()).expect("final report replaces progress"),
    )
    .expect("parse final report");
    assert_eq!(report["schema"], "ride.tauri-packaged-smoke");
    assert_eq!(report["status"], "passed");
    assert_eq!(report["steps"].as_array().expect("report steps").len(), 2);
}

#[test]
fn smoke_protocol_rejects_durations_beyond_the_node_safe_integer_limit() {
    const ABOVE_NODE_SAFE_INTEGER: u64 = 9_007_199_254_740_992;
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment("duration-token", json!({ "actions": ["editor-save"] })),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);

    assert!(protocol
        .record_step(
            &proof,
            step(
                SmokeAction::EditorSave,
                SmokeStepState::Started,
                ABOVE_NODE_SAFE_INTEGER,
            )
        )
        .is_err());

    let empty_fixture = Fixture::new();
    let empty = SmokeProtocol::from_environment(
        &empty_fixture.environment("empty-duration-token", json!({ "actions": [] })),
        &empty_fixture.root,
    );
    let empty_proof = active_session_proof(&empty);
    assert!(empty
        .complete(&empty_proof, complete_passed(ABOVE_NODE_SAFE_INTEGER))
        .is_err());
}

#[test]
fn smoke_protocol_enforces_closed_diagnostics_and_action_failure_semantics() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(
            "failure-token",
            json!({ "actions": ["editor-save", "terminal-sentinel"] }),
        ),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Started, 0),
        )
        .expect("start action");

    for invalid in [
        diagnostic("token-secret", "Smoke action failed."),
        diagnostic("action-failed", "raw command: git status"),
        diagnostic("cleanup-failed", "Process cleanup failed."),
    ] {
        let mut request = step(SmokeAction::EditorSave, SmokeStepState::Failed, 1);
        request.diagnostic = Some(invalid);
        assert!(protocol.record_step(&proof, request).is_err());
    }

    let failure = diagnostic("action-timeout", "Smoke action timed out.");
    protocol
        .record_step(
            &proof,
            RecordStepRequest {
                action: SmokeAction::EditorSave,
                state: SmokeStepState::Failed,
                duration_ms: 1,
                diagnostic: Some(failure.clone()),
            },
        )
        .expect("record action timeout");
    assert!(protocol
        .record_step(
            &proof,
            step(SmokeAction::TerminalSentinel, SmokeStepState::Started, 2)
        )
        .is_err());
    assert!(protocol.complete(&proof, complete_passed(2)).is_err());
    let completion = CompleteRequest {
        status: SmokeTerminalStatus::Failed,
        failure_phase: Some(FailurePhase::Action),
        duration_ms: 2,
        diagnostic: Some(failure),
    };
    protocol
        .complete(&proof, completion.clone())
        .expect("complete action failure");
    protocol
        .complete(&proof, completion)
        .expect("replay identical action completion");
    assert!(protocol
        .complete(
            &proof,
            CompleteRequest {
                status: SmokeTerminalStatus::Failed,
                failure_phase: Some(FailurePhase::Action),
                duration_ms: 3,
                diagnostic: Some(diagnostic("action-timeout", "Smoke action timed out.")),
            }
        )
        .is_err());
}

#[test]
fn smoke_protocol_enforces_passed_pre_action_and_cleanup_terminal_shapes() {
    let fixture = Fixture::new();
    let passed = SmokeProtocol::from_environment(
        &fixture.environment("passed-token", json!({ "actions": ["editor-save"] })),
        &fixture.root,
    );
    let passed_proof = active_session_proof(&passed);
    assert!(passed.complete(&passed_proof, complete_passed(0)).is_err());
    complete_actions(&passed, &passed_proof, &[SmokeAction::EditorSave]);
    assert_eq!(
        passed
            .complete(&passed_proof, complete_passed(2))
            .expect("complete passed report")
            .status,
        SmokeUpdateStatus::Completed
    );

    let pre_action_fixture = Fixture::new();
    let pre_action = SmokeProtocol::from_environment(
        &pre_action_fixture.environment("pre-action-token", json!({ "actions": ["editor-save"] })),
        &pre_action_fixture.root,
    );
    let pre_action_proof = active_session_proof(&pre_action);
    pre_action
        .complete(
            &pre_action_proof,
            CompleteRequest {
                status: SmokeTerminalStatus::Failed,
                failure_phase: Some(FailurePhase::Startup),
                duration_ms: 0,
                diagnostic: Some(diagnostic("startup-failed", "Application startup failed.")),
            },
        )
        .expect("complete startup failure");

    let cleanup_fixture = Fixture::new();
    let cleanup = SmokeProtocol::from_environment(
        &cleanup_fixture.environment("cleanup-token", json!({ "actions": ["editor-save"] })),
        &cleanup_fixture.root,
    );
    let cleanup_proof = active_session_proof(&cleanup);
    complete_actions(&cleanup, &cleanup_proof, &[SmokeAction::EditorSave]);
    cleanup
        .complete(
            &cleanup_proof,
            CompleteRequest {
                status: SmokeTerminalStatus::Failed,
                failure_phase: Some(FailurePhase::Cleanup),
                duration_ms: 2,
                diagnostic: Some(diagnostic("cleanup-failed", "Process cleanup failed.")),
            },
        )
        .expect("complete cleanup failure");
}

#[test]
fn smoke_protocol_persists_only_bounded_closed_atomic_terminal_reports() {
    let fixture = Fixture::new();
    let token = "persistence-token";
    let environment = fixture.environment(token, json!({ "actions": ["editor-save"] }));
    let spec_path = PathBuf::from(environment.get(OsStr::new(SPEC_ENV)).expect("spec env"));
    let expected_spec_sha = sha256(&fs::read(spec_path).expect("read spec fixture"));
    let protocol = SmokeProtocol::from_environment(&environment, &fixture.root);
    let proof = active_session_proof(&protocol);
    complete_actions(&protocol, &proof, &[SmokeAction::EditorSave]);
    protocol
        .complete(&proof, complete_passed(2))
        .expect("persist terminal report");

    let bytes = fs::read(fixture.report_path()).expect("read smoke report");
    assert!(bytes.len() < 4 * 1024 * 1024);
    let report: Value = serde_json::from_slice(&bytes).expect("parse smoke report");
    assert_eq!(report["schema"], "ride.tauri-packaged-smoke");
    assert_eq!(report["version"], 1);
    assert_eq!(report["specSha256"], expected_spec_sha);
    assert_eq!(report["status"], "passed");
    assert_eq!(report["failurePhase"], Value::Null);
    let serialized = String::from_utf8(bytes).expect("UTF-8 smoke report");
    assert!(!serialized.contains(token));
    assert!(!serialized.contains(fixture.root.to_string_lossy().as_ref()));
    assert_eq!(
        fs::read_dir(&fixture.root)
            .expect("list report directory")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .count(),
        0
    );
}

#[test]
fn smoke_protocol_serializes_concurrent_updates() {
    let fixture = Fixture::new();
    let protocol = Arc::new(SmokeProtocol::from_environment(
        &fixture.environment("concurrency-token", json!({ "actions": ["editor-save"] })),
        &fixture.root,
    ));
    let proof = Arc::new(active_session_proof(&protocol));
    let barrier = Arc::new(Barrier::new(9));
    let handles = (0..8)
        .map(|_| {
            let protocol = Arc::clone(&protocol);
            let proof = Arc::clone(&proof);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                protocol.record_step(
                    proof.as_str(),
                    step(SmokeAction::EditorSave, SmokeStepState::Started, 0),
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let successes = handles
        .into_iter()
        .map(|handle| handle.join().expect("join concurrent update"))
        .filter(Result::is_ok)
        .count();

    assert_eq!(successes, 8);
    let barrier = Arc::new(Barrier::new(9));
    let handles = (0..8)
        .map(|_| {
            let protocol = Arc::clone(&protocol);
            let proof = Arc::clone(&proof);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                protocol.record_step(
                    proof.as_str(),
                    step(SmokeAction::EditorSave, SmokeStepState::Passed, 1),
                )
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    assert_eq!(
        handles
            .into_iter()
            .map(|handle| handle.join().expect("join concurrent passed update"))
            .filter(Result::is_ok)
            .count(),
        8
    );

    let barrier = Arc::new(Barrier::new(9));
    let handles = (0..8)
        .map(|_| {
            let protocol = Arc::clone(&protocol);
            let proof = Arc::clone(&proof);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                protocol.complete(proof.as_str(), complete_passed(2))
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let responses = handles
        .into_iter()
        .map(|handle| {
            handle
                .join()
                .expect("join concurrent completion")
                .expect("identical concurrent completion")
        })
        .collect::<Vec<_>>();
    assert!(responses.windows(2).all(|pair| pair[0] == pair[1]));
    let report: Value =
        serde_json::from_slice(&fs::read(fixture.report_path()).expect("read concurrent report"))
            .expect("parse concurrent report");
    assert_eq!(
        report["steps"].as_array().expect("concurrent steps").len(),
        2
    );
}

#[test]
fn smoke_plan_returns_one_time_session_proof() {
    let fixture = Fixture::new();
    let token = "one-time-environment-token";
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(token, json!({ "actions": [] })),
        &fixture.root,
    );

    let first = protocol.plan();
    let proof = first
        .session_proof
        .clone()
        .expect("first plan returns proof");
    assert_eq!(proof.len(), 64);
    assert!(proof
        .bytes()
        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    assert_ne!(proof, sha256(token.as_bytes()));
    assert!(!format!("{first:?}").contains(&proof));
    assert!(!format!("{first:?}").contains(token));
    assert!(protocol.plan().session_proof.is_none());
}

#[test]
fn smoke_commands_require_matching_session_proof_without_state_change() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment("command-proof-token", json!({ "actions": ["editor-save"] })),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    let request = json!({
        "action": "editor-save",
        "state": "started",
        "durationMs": 0,
        "diagnostic": null
    });

    let error = protocol
        .record_step_command(record_envelope("0", request.clone()))
        .expect_err("wrong proof rejected");
    assert_static_rejection(&error, "command-proof-token");
    assert_eq!(
        protocol
            .record_step_command(record_envelope(&proof, request))
            .expect("correct proof records unchanged first transition")
            .status,
        SmokeUpdateStatus::Recorded
    );
}

#[test]
fn smoke_public_mutation_api_requires_proof_and_rejection_preserves_state() {
    let _: fn(
        &SmokeProtocol,
        &str,
        RecordStepRequest,
    ) -> Result<SmokeUpdateResponse, ride_tauri::smoke::SmokeError> = SmokeProtocol::record_step;
    let _: fn(
        &SmokeProtocol,
        &str,
        CompleteRequest,
    ) -> Result<SmokeUpdateResponse, ride_tauri::smoke::SmokeError> = SmokeProtocol::complete;

    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment("public-proof-token", json!({ "actions": ["editor-save"] })),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    let started = step(SmokeAction::EditorSave, SmokeStepState::Started, 0);

    let error = protocol
        .record_step_command(json!({ "request": started.clone() }))
        .expect_err("raw public mutation rejects missing proof");
    assert_static_rejection(&error, &proof);

    let error = protocol
        .record_step("missing-or-mismatched-proof", started)
        .expect_err("public mutation rejects mismatched proof");
    assert_static_rejection(&error, &proof);

    assert_eq!(
        protocol
            .record_step(
                &proof,
                step(SmokeAction::EditorSave, SmokeStepState::Started, 0),
            )
            .expect("rejected mutation did not advance state")
            .status,
        SmokeUpdateStatus::Recorded
    );
    protocol
        .record_step(
            &proof,
            step(SmokeAction::EditorSave, SmokeStepState::Passed, 1),
        )
        .expect("finish authenticated action");

    let completion = complete_passed(2);
    let error = protocol
        .complete_command(json!({ "request": completion.clone() }))
        .expect_err("raw public completion rejects missing proof");
    assert_static_rejection(&error, &proof);
    let error = protocol
        .complete("missing-or-mismatched-proof", completion.clone())
        .expect_err("typed public completion rejects mismatched proof");
    assert_static_rejection(&error, &proof);
    assert_eq!(
        protocol
            .complete(&proof, completion)
            .expect("rejected completions did not make state terminal")
            .status,
        SmokeUpdateStatus::Completed
    );
}

#[test]
fn smoke_stale_session_proof_is_rejected() {
    let first_fixture = Fixture::new();
    let first = SmokeProtocol::from_environment(
        &first_fixture.environment("first-process-token", json!({ "actions": [] })),
        &first_fixture.root,
    );
    let stale = active_session_proof(&first);
    let second_fixture = Fixture::new();
    let second = SmokeProtocol::from_environment(
        &second_fixture.environment("second-process-token", json!({ "actions": [] })),
        &second_fixture.root,
    );
    let current = active_session_proof(&second);

    let error = second
        .complete_command(record_envelope(
            &stale,
            json!({
                "status": "passed",
                "failurePhase": null,
                "durationMs": 0,
                "diagnostic": null
            }),
        ))
        .expect_err("stale proof rejected");
    assert_static_rejection(&error, &stale);
    assert_eq!(
        second
            .complete_command(record_envelope(
                &current,
                json!({
                    "status": "passed",
                    "failurePhase": null,
                    "durationMs": 0,
                    "diagnostic": null
                }),
            ))
            .expect("current proof remains usable")
            .status,
        SmokeUpdateStatus::Completed
    );
}

#[test]
fn smoke_report_never_persists_session_proof_or_environment_token() {
    let fixture = Fixture::new();
    let token = "never-persist-environment-token";
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(token, json!({ "actions": [] })),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    protocol
        .complete_command(record_envelope(
            &proof,
            json!({
                "status": "passed",
                "failurePhase": null,
                "durationMs": 0,
                "diagnostic": null
            }),
        ))
        .expect("complete authenticated smoke report");

    let report = fs::read_to_string(fixture.report_path()).expect("read smoke report");
    assert!(!report.contains(token));
    assert!(!report.contains(&proof));
    assert!(!format!("{protocol:?}").contains(token));
    assert!(!format!("{protocol:?}").contains(&proof));
}

#[test]
fn smoke_record_command_maps_malformed_values_to_static_error() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment("record-parser-token", json!({ "actions": ["editor-save"] })),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    let secret = "C:\\host\\secret-token";
    let malformed = [
        Value::Null,
        json!([]),
        json!({ "sessionProof": proof }),
        json!({ "sessionProof": proof, "request": secret, "unknown": secret }),
        record_envelope(
            &proof,
            json!({
                "action": secret,
                "state": "started",
                "durationMs": 0,
                "diagnostic": null
            }),
        ),
        record_envelope(
            &proof,
            json!({
                "action": "editor-save",
                "state": secret,
                "durationMs": 0,
                "diagnostic": null
            }),
        ),
    ];

    for value in malformed {
        let error = protocol
            .record_step_command(value)
            .expect_err("schema-invalid record request rejected");
        assert_static_rejection(&error, secret);
    }
}

#[test]
fn smoke_complete_command_maps_malformed_values_to_static_error() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment("complete-parser-token", json!({ "actions": [] })),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    let secret = "untrusted-failure-phase-value";
    for value in [
        Value::Null,
        json!({ "sessionProof": proof, "request": null }),
        record_envelope(
            &proof,
            json!({
                "status": "failed",
                "failurePhase": secret,
                "durationMs": 0,
                "diagnostic": null
            }),
        ),
        record_envelope(
            &proof,
            json!({
                "status": "passed",
                "failurePhase": null,
                "durationMs": 0,
                "diagnostic": null,
                "unknown": secret
            }),
        ),
    ] {
        let error = protocol
            .complete_command(value)
            .expect_err("schema-invalid completion rejected");
        assert_static_rejection(&error, secret);
    }
}

#[test]
fn smoke_disabled_commands_return_disabled_for_untrusted_payloads() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(&BTreeMap::new(), &fixture.root);

    assert_eq!(
        protocol
            .record_step_command(json!({ "secret": ["malformed"] }))
            .expect("disabled record is a safe no-op")
            .status,
        SmokeUpdateStatus::Disabled
    );
    assert_eq!(
        protocol
            .complete_command(Value::Null)
            .expect("disabled completion is a safe no-op")
            .status,
        SmokeUpdateStatus::Disabled
    );
}

#[cfg(windows)]
#[test]
fn windows_smoke_reparse_integration_has_explicit_fallback() {
    let fixture = Fixture::new();
    let token = "windows-reparse-token";
    let target = fixture.write_spec(token, json!({ "actions": [] }));
    let spec_link = fixture.root.join("spec-link.json");
    match create_file_symlink(&target, &spec_link) {
        Ok(()) => {
            let mut environment = fixture.environment(token, json!({ "actions": [] }));
            environment.insert(OsString::from(SPEC_ENV), spec_link.into_os_string());
            assert_eq!(
                SmokeProtocol::from_environment(&environment, &fixture.root)
                    .plan()
                    .mode,
                SmokeMode::Rejected
            );
        }
        Err(error) => {
            assert!(
                error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314),
                "unexpected Windows symlink error kind"
            );
            eprintln!(
                "Windows symlink integration unavailable; deterministic capability-seam test remains mandatory"
            );
        }
    }

    let report_fixture = Fixture::new();
    let report_target = report_fixture.root.join("existing-report.json");
    let report_link = report_fixture.root.join("report-link.json");
    fs::write(&report_target, br#"{"generation":"old"}"#).expect("write report link target");
    match create_file_symlink(&report_target, &report_link) {
        Ok(()) => {
            let mut environment = report_fixture.environment(token, json!({ "actions": [] }));
            environment.insert(OsString::from(REPORT_ENV), report_link.into_os_string());
            assert_eq!(
                SmokeProtocol::from_environment(&environment, &report_fixture.root)
                    .plan()
                    .mode,
                SmokeMode::Rejected
            );
        }
        Err(error) => {
            assert!(
                error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314),
                "unexpected Windows report symlink error kind"
            );
            eprintln!(
                "Windows report symlink integration unavailable; deterministic capability-seam test remains mandatory"
            );
        }
    }

    let target_parent = fixture.root.join("report-target");
    let junction_parent = fixture.root.join("report-junction");
    fs::create_dir(&target_parent).expect("create junction target");
    let junction = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&junction_parent)
        .arg(&target_parent)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    match junction {
        Ok(status) if status.success() => {
            let mut environment = fixture.environment(token, json!({ "actions": [] }));
            environment.insert(
                OsString::from(REPORT_ENV),
                junction_parent.join("report.json").into_os_string(),
            );
            assert_eq!(
                SmokeProtocol::from_environment(&environment, &fixture.root)
                    .plan()
                    .mode,
                SmokeMode::Rejected
            );
        }
        Ok(_) | Err(_) => eprintln!(
            "Windows junction integration unavailable; deterministic capability-seam test remains mandatory"
        ),
    }
}

#[test]
fn smoke_atomic_publish_replaces_an_existing_valid_report() {
    let fixture = Fixture::new();
    let old = json!({ "generation": "old", "complete": true });
    fs::write(
        fixture.report_path(),
        serde_json::to_vec(&old).expect("serialize old report"),
    )
    .expect("write old report");
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment("replacement-token", json!({ "actions": [] })),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);

    protocol
        .complete(&proof, complete_passed(0))
        .expect("replace existing report");
    let new: Value =
        serde_json::from_slice(&fs::read(fixture.report_path()).expect("read replacement report"))
            .expect("replacement remains complete JSON");
    assert_ne!(new, old);
    assert_eq!(new["schema"], "ride.tauri-packaged-smoke");
    assert_eq!(new["status"], "passed");
    assert_eq!(temporary_report_count(&fixture.root), 0);
}

#[test]
fn smoke_atomic_publish_is_old_or_new_json_for_concurrent_readers() {
    let fixture = Fixture::new();
    let old = json!({ "generation": "old", "payload": "x".repeat(16_384) });
    fs::write(
        fixture.report_path(),
        serde_json::to_vec(&old).expect("serialize old report"),
    )
    .expect("write old report");
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment("reader-token", json!({ "actions": [] })),
        &fixture.root,
    );
    let proof = active_session_proof(&protocol);
    let report_path = fixture.report_path();
    let running = Arc::new(AtomicBool::new(true));
    let observations = Arc::new(Mutex::new(Vec::<Value>::new()));
    let reader_running = Arc::clone(&running);
    let reader_observations = Arc::clone(&observations);
    let reader = thread::spawn(move || {
        while reader_running.load(Ordering::Acquire) {
            let bytes = fs::read(&report_path).expect("atomic destination is always present");
            let value = serde_json::from_slice(&bytes).expect("reader sees complete JSON");
            reader_observations
                .lock()
                .expect("lock reader observations")
                .push(value);
            thread::yield_now();
        }
    });

    thread::sleep(Duration::from_millis(10));
    protocol
        .complete(&proof, complete_passed(0))
        .expect("publish while reader is active");
    let new: Value =
        serde_json::from_slice(&fs::read(fixture.report_path()).expect("read new report"))
            .expect("parse new report");
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline
        && !observations
            .lock()
            .expect("inspect reader observations")
            .iter()
            .any(|value| value == &new)
    {
        thread::yield_now();
    }
    running.store(false, Ordering::Release);
    reader.join().expect("join atomic reader");

    let observations = observations.lock().expect("lock final observations");
    assert!(observations.iter().any(|value| value == &old));
    assert!(observations.iter().any(|value| value == &new));
    assert!(observations
        .iter()
        .all(|value| value == &old || value == &new));
    assert_eq!(temporary_report_count(&fixture.root), 0);
}

fn temporary_report_count(parent: &Path) -> usize {
    fs::read_dir(parent)
        .expect("list smoke report directory")
        .filter_map(Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
        .count()
}

fn smoke_spec_value(token: &str, overrides: Value) -> Value {
    let mut value = json!({
        "schema": "ride.tauri-packaged-smoke-spec",
        "version": 1,
        "scenario": "critical-file",
        "profile": "tauri-critical",
        "workspace": ".",
        "files": ["startup.R"],
        "actions": ["editor-save"],
        "tokenSha256": sha256(token.as_bytes()),
        "actionTimeoutMs": 30_000
    });
    if let (Some(target), Some(source)) = (value.as_object_mut(), overrides.as_object()) {
        target.extend(source.clone());
    }
    value
}

fn rust_accepts_spec(value: &Value, token: &str) -> bool {
    let fixture = Fixture::new();
    fs::write(
        fixture.spec_path(),
        serde_json::to_vec(value).expect("serialize parity spec"),
    )
    .expect("write parity spec");
    let environment = BTreeMap::from([
        (
            OsString::from(SPEC_ENV),
            dunce::canonicalize(fixture.spec_path())
                .expect("canonical parity spec")
                .into_os_string(),
        ),
        (
            OsString::from(REPORT_ENV),
            fixture.report_path().into_os_string(),
        ),
        (OsString::from(TOKEN_ENV), OsString::from(token)),
    ]);
    SmokeProtocol::from_environment(&environment, &fixture.root)
        .plan()
        .mode
        == SmokeMode::Active
}

fn run_node_contract(input: &Value) -> Result<Value, &'static str> {
    run_node_contract_with_program("node", input)
}

enum CapturedStream {
    Stdout(Result<Vec<u8>, ()>),
    Stderr(Result<(), ()>),
}

fn run_bounded_child(
    mut command: Command,
    timeout: Duration,
    max_stream_bytes: usize,
) -> Result<Vec<u8>, &'static str> {
    const STATIC_ERROR: &str = "Node smoke parity runner failed.";
    let read_limit = max_stream_bytes.checked_add(1).ok_or(STATIC_ERROR)?;

    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|_| STATIC_ERROR)?;
    let stdout = child.stdout.take().ok_or(STATIC_ERROR)?;
    let stderr = child.stderr.take().ok_or(STATIC_ERROR)?;
    let (stream_tx, stream_rx) = mpsc::channel();
    let stdout_tx = stream_tx.clone();
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(read_limit as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ())
            .and_then(|_| (bytes.len() <= max_stream_bytes).then_some(bytes).ok_or(()));
        let _ = stdout_tx.send(CapturedStream::Stdout(result));
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stderr
            .take(read_limit as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| ())
            .and_then(|_| (bytes.len() <= max_stream_bytes).then_some(()).ok_or(()));
        let _ = stream_tx.send(CapturedStream::Stderr(result));
    });

    let deadline = Instant::now() + timeout;
    let mut status = None;
    let mut stdout = None;
    let mut stderr_done = false;
    let result = 'wait: loop {
        while let Ok(stream) = stream_rx.try_recv() {
            match stream {
                CapturedStream::Stdout(Ok(bytes)) => stdout = Some(bytes),
                CapturedStream::Stderr(Ok(())) => stderr_done = true,
                CapturedStream::Stdout(Err(())) | CapturedStream::Stderr(Err(())) => {
                    break 'wait Err(STATIC_ERROR);
                }
            }
        }
        if status.is_none() {
            match child.try_wait() {
                Ok(current) => status = current,
                Err(_) => break Err(STATIC_ERROR),
            }
        }
        if let (Some(status), Some(stdout)) = (status.as_ref(), stdout.as_ref()) {
            if stderr_done {
                break if status.success() {
                    Ok(stdout.clone())
                } else {
                    Err(STATIC_ERROR)
                };
            }
        }
        if Instant::now() >= deadline {
            break Err(STATIC_ERROR);
        }
        thread::sleep(Duration::from_millis(5));
    };

    if result.is_err() && status.is_none() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = stdout_reader.join();
    let _ = stderr_reader.join();
    result
}

fn run_node_contract_with_program(program: &str, input: &Value) -> Result<Value, &'static str> {
    const STATIC_ERROR: &str = "Node smoke parity runner failed.";
    const MAX_INPUT_BYTES: usize = 64 * 1024;
    const MAX_OUTPUT_BYTES: usize = 64 * 1024;
    const SCRIPT: &str = r#"
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [contractPath, fixturePath] = process.argv.slice(1);
const contract = await import(pathToFileURL(contractPath).href);
const input = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const accepts = (operation) => { try { operation(); return true; } catch { return false; } };
const result = {
  specs: input.specs.map(value => accepts(() => contract.validateSmokeSpec(value))),
  reports: input.reports.map(({ value, expected }) => (
    accepts(() => contract.validateSmokeReport(value, expected))
  )),
};
process.stdout.write(JSON.stringify(result));
"#;

    let fixture = Fixture::new();
    let fixture_path = fixture.root.join("node-parity.json");
    let input = serde_json::to_vec(input).map_err(|_| STATIC_ERROR)?;
    if input.len() > MAX_INPUT_BYTES {
        return Err(STATIC_ERROR);
    }
    fs::write(&fixture_path, input).map_err(|_| STATIC_ERROR)?;
    let contract_path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../scripts/tauri-packaged-smoke-contract.mjs");
    let mut command = Command::new(program);
    command
        .args(["--input-type=module", "-e", SCRIPT])
        .arg(&contract_path)
        .arg(&fixture_path);
    let output = run_bounded_child(command, Duration::from_secs(10), MAX_OUTPUT_BYTES)?;
    serde_json::from_slice(&output).map_err(|_| STATIC_ERROR)
}

fn terminal_report_fixtures() -> Vec<Value> {
    [
        "passed", "action", "startup", "sidecar", "protocol", "cleanup",
    ]
    .into_iter()
    .map(terminal_report_fixture)
    .collect()
}

fn terminal_report_fixture(kind: &str) -> Value {
    let fixture = Fixture::new();
    let actions = if kind == "action" {
        json!(["editor-save"])
    } else {
        json!([])
    };
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(
            &format!("terminal-{kind}-token"),
            json!({ "actions": actions }),
        ),
        &fixture.root,
    );
    let plan_response = protocol.plan();
    let proof = plan_response
        .session_proof
        .expect("terminal fixture session proof");
    let plan = plan_response.plan.expect("terminal fixture plan");
    match kind {
        "passed" => protocol
            .complete(&proof, complete_passed(0))
            .expect("complete passed fixture"),
        "action" => {
            protocol
                .record_step(
                    &proof,
                    step(SmokeAction::EditorSave, SmokeStepState::Started, 0),
                )
                .expect("start failed action fixture");
            let failure = diagnostic("action-failed", "Smoke action failed.");
            protocol
                .record_step(
                    &proof,
                    RecordStepRequest {
                        action: SmokeAction::EditorSave,
                        state: SmokeStepState::Failed,
                        duration_ms: 1,
                        diagnostic: Some(failure.clone()),
                    },
                )
                .expect("fail action fixture");
            protocol
                .complete(
                    &proof,
                    CompleteRequest {
                        status: SmokeTerminalStatus::Failed,
                        failure_phase: Some(FailurePhase::Action),
                        duration_ms: 1,
                        diagnostic: Some(failure),
                    },
                )
                .expect("complete action failure fixture")
        }
        "startup" | "sidecar" | "protocol" | "cleanup" => {
            let (phase, code, message) = match kind {
                "startup" => (
                    FailurePhase::Startup,
                    "startup-failed",
                    "Application startup failed.",
                ),
                "sidecar" => (
                    FailurePhase::Sidecar,
                    "sidecar-failed",
                    "Backend sidecar failed.",
                ),
                "protocol" => (
                    FailurePhase::Protocol,
                    "protocol-failed",
                    "Smoke protocol failed.",
                ),
                "cleanup" => (
                    FailurePhase::Cleanup,
                    "cleanup-failed",
                    "Process cleanup failed.",
                ),
                _ => unreachable!("closed terminal fixture kind"),
            };
            protocol
                .complete(
                    &proof,
                    CompleteRequest {
                        status: SmokeTerminalStatus::Failed,
                        failure_phase: Some(phase),
                        duration_ms: 0,
                        diagnostic: Some(diagnostic(code, message)),
                    },
                )
                .expect("complete terminal failure fixture")
        }
        _ => unreachable!("closed terminal fixture kind"),
    };
    let value: Value = serde_json::from_slice(
        &fs::read(fixture.report_path()).expect("read terminal fixture report"),
    )
    .expect("parse terminal fixture report");
    json!({
        "value": value,
        "expected": {
            "specSha256": plan.spec_sha256,
            "scenario": plan.scenario,
            "profile": plan.profile,
            "actions": plan.actions
        }
    })
}

#[test]
fn smoke_rust_and_node_spec_acceptance_matches() {
    let token = "node-parity-token";
    let specs = vec![
        smoke_spec_value(token, json!({})),
        smoke_spec_value(
            token,
            json!({ "scenario": "critical-empty", "files": [], "actions": [] }),
        ),
        smoke_spec_value(
            token,
            json!({ "schema": "ride.tauri-packaged-smoke-spec@1" }),
        ),
        smoke_spec_value(token, json!({ "workspace": "../outside" })),
        smoke_spec_value(
            token,
            json!({ "actions": ["terminal-sentinel", "editor-save"] }),
        ),
        smoke_spec_value(token, json!({ "unexpected": "must-be-rejected" })),
    ];
    let rust = specs
        .iter()
        .map(|value| rust_accepts_spec(value, token))
        .collect::<Vec<_>>();
    let node = run_node_contract(&json!({ "specs": specs, "reports": [] }))
        .expect("run real Node smoke contract");

    assert_eq!(node["specs"], json!(rust));
    assert_eq!(rust, [true, true, false, false, false, false]);
}

#[test]
fn smoke_node_accepts_all_rust_terminal_report_shapes() {
    let terminal_reports = terminal_report_fixtures();
    let result = run_node_contract(&json!({ "specs": [], "reports": terminal_reports }))
        .expect("validate Rust reports with real Node contract");

    assert_eq!(
        result["reports"],
        json!([true, true, true, true, true, true])
    );
}

#[test]
fn smoke_node_runner_is_bounded_and_non_echoing() {
    let secret = "C:\\private\\node-contract-secret";
    let error = run_node_contract_with_program(
        "ride-node-executable-that-does-not-exist",
        &json!({ "specs": [{ "secret": secret }], "reports": [] }),
    )
    .expect_err("missing Node executable returns static error");

    assert_eq!(error, "Node smoke parity runner failed.");
    assert!(!error.contains(secret));

    let oversized_secret = format!("{secret}{}", "x".repeat(64 * 1024));
    let oversized_error = run_node_contract(&json!({
        "specs": [{ "secret": oversized_secret }],
        "reports": []
    }))
    .expect_err("oversized Node fixture is rejected before spawning");
    assert_eq!(oversized_error, "Node smoke parity runner failed.");
    assert!(!oversized_error.contains(secret));
}

#[test]
fn smoke_node_runner_accepts_each_stream_at_the_limit() {
    let mut command = Command::new("node");
    command.args([
        "-e",
        "process.stdout.write('o'.repeat(4096)); process.stderr.write('e'.repeat(4096));",
    ]);

    let output = run_bounded_child(command, Duration::from_secs(2), 4096)
        .expect("stdout and stderr at the exact cap are accepted");

    assert_eq!(output, vec![b'o'; 4096]);
}

#[test]
fn smoke_node_runner_terminates_on_stdout_or_stderr_overflow_with_static_errors() {
    for stream in ["stdout", "stderr"] {
        let secret = format!("private-{stream}-overflow");
        let script = format!(
            "process.{stream}.write('{secret}'); process.{stream}.write('x'.repeat(4097)); setTimeout(() => {{}}, 10000);"
        );
        let mut command = Command::new("node");
        command.args(["-e", &script]);

        let started = Instant::now();
        let error = run_bounded_child(command, Duration::from_secs(5), 4096)
            .expect_err("stream overflow is rejected");

        assert_eq!(error, "Node smoke parity runner failed.");
        assert!(!error.contains(&secret));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

#[test]
fn smoke_node_runner_terminates_on_timeout_without_echoing_child_text() {
    let secret = "private-timeout-stderr";
    let script = format!("process.stderr.write('{secret}'); setTimeout(() => {{}}, 10000);");
    let mut command = Command::new("node");
    command.args(["-e", &script]);

    let started = Instant::now();
    let error = run_bounded_child(command, Duration::from_millis(100), 4096)
        .expect_err("parity child timeout is rejected");

    assert_eq!(error, "Node smoke parity runner failed.");
    assert!(!error.contains(secret));
    assert!(started.elapsed() < Duration::from_secs(2));
}
