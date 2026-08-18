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
    SmokeUpdateStatus,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::thread;
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

fn complete_actions(protocol: &SmokeProtocol, actions: &[SmokeAction]) {
    let mut duration_ms = 0;
    for action in actions {
        protocol
            .record_step(step(*action, SmokeStepState::Started, duration_ms))
            .expect("start smoke action");
        duration_ms += 1;
        protocol
            .record_step(step(*action, SmokeStepState::Passed, duration_ms))
            .expect("pass smoke action");
        duration_ms += 1;
    }
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
    if create_file_symlink(&target, &link).is_ok() {
        let mut symlink_environment = fixture.environment(token, json!({}));
        symlink_environment.insert(OsString::from(SPEC_ENV), link.into_os_string());
        assert_eq!(
            SmokeProtocol::from_environment(&symlink_environment, &fixture.root)
                .plan()
                .mode,
            SmokeMode::Rejected
        );
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
            .record_step(step(SmokeAction::EditorSave, SmokeStepState::Started, 0))
            .expect("disabled update")
            .status,
        SmokeUpdateStatus::Disabled
    );
    assert_eq!(
        disabled
            .complete(complete_passed(0))
            .expect("disabled completion")
            .status,
        SmokeUpdateStatus::Disabled
    );

    let rejected = SmokeProtocol::from_environment(
        &BTreeMap::from([(OsString::from(SPEC_ENV), OsString::from("secret"))]),
        &fixture.root,
    );
    let response = rejected
        .record_step(step(SmokeAction::EditorSave, SmokeStepState::Started, 0))
        .expect("rejected update response");
    assert_eq!(response.status, SmokeUpdateStatus::Rejected);
    assert_eq!(
        response.diagnostic,
        Some(diagnostic("protocol-failed", "Smoke protocol failed."))
    );
}

#[test]
fn smoke_protocol_rejects_duplicate_out_of_order_and_non_monotonic_steps() {
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment(
            "ordering-token",
            json!({ "actions": ["editor-save", "terminal-sentinel"] }),
        ),
        &fixture.root,
    );

    assert!(protocol
        .record_step(step(
            SmokeAction::TerminalSentinel,
            SmokeStepState::Started,
            0
        ))
        .is_err());
    protocol
        .record_step(step(SmokeAction::EditorSave, SmokeStepState::Started, 2))
        .expect("start first action");
    assert!(protocol
        .record_step(step(SmokeAction::EditorSave, SmokeStepState::Started, 2))
        .is_err());
    assert!(protocol
        .record_step(step(SmokeAction::EditorSave, SmokeStepState::Passed, 1))
        .is_err());
    protocol
        .record_step(step(SmokeAction::EditorSave, SmokeStepState::Passed, 3))
        .expect("pass first action");
}

#[test]
fn smoke_protocol_rejects_durations_beyond_the_node_safe_integer_limit() {
    const ABOVE_NODE_SAFE_INTEGER: u64 = 9_007_199_254_740_992;
    let fixture = Fixture::new();
    let protocol = SmokeProtocol::from_environment(
        &fixture.environment("duration-token", json!({ "actions": ["editor-save"] })),
        &fixture.root,
    );

    assert!(protocol
        .record_step(step(
            SmokeAction::EditorSave,
            SmokeStepState::Started,
            ABOVE_NODE_SAFE_INTEGER,
        ))
        .is_err());

    let empty_fixture = Fixture::new();
    let empty = SmokeProtocol::from_environment(
        &empty_fixture.environment("empty-duration-token", json!({ "actions": [] })),
        &empty_fixture.root,
    );
    assert!(empty
        .complete(complete_passed(ABOVE_NODE_SAFE_INTEGER))
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
    protocol
        .record_step(step(SmokeAction::EditorSave, SmokeStepState::Started, 0))
        .expect("start action");

    for invalid in [
        diagnostic("token-secret", "Smoke action failed."),
        diagnostic("action-failed", "raw command: git status"),
        diagnostic("cleanup-failed", "Process cleanup failed."),
    ] {
        let mut request = step(SmokeAction::EditorSave, SmokeStepState::Failed, 1);
        request.diagnostic = Some(invalid);
        assert!(protocol.record_step(request).is_err());
    }

    let failure = diagnostic("action-timeout", "Smoke action timed out.");
    protocol
        .record_step(RecordStepRequest {
            action: SmokeAction::EditorSave,
            state: SmokeStepState::Failed,
            duration_ms: 1,
            diagnostic: Some(failure.clone()),
        })
        .expect("record action timeout");
    assert!(protocol
        .record_step(step(
            SmokeAction::TerminalSentinel,
            SmokeStepState::Started,
            2
        ))
        .is_err());
    assert!(protocol.complete(complete_passed(2)).is_err());
    protocol
        .complete(CompleteRequest {
            status: SmokeTerminalStatus::Failed,
            failure_phase: Some(FailurePhase::Action),
            duration_ms: 2,
            diagnostic: Some(failure),
        })
        .expect("complete action failure");
    assert!(protocol
        .complete(CompleteRequest {
            status: SmokeTerminalStatus::Failed,
            failure_phase: Some(FailurePhase::Action),
            duration_ms: 2,
            diagnostic: Some(diagnostic("action-timeout", "Smoke action timed out.")),
        })
        .is_err());
}

#[test]
fn smoke_protocol_enforces_passed_pre_action_and_cleanup_terminal_shapes() {
    let fixture = Fixture::new();
    let passed = SmokeProtocol::from_environment(
        &fixture.environment("passed-token", json!({ "actions": ["editor-save"] })),
        &fixture.root,
    );
    assert!(passed.complete(complete_passed(0)).is_err());
    complete_actions(&passed, &[SmokeAction::EditorSave]);
    assert_eq!(
        passed
            .complete(complete_passed(2))
            .expect("complete passed report")
            .status,
        SmokeUpdateStatus::Completed
    );

    let pre_action_fixture = Fixture::new();
    let pre_action = SmokeProtocol::from_environment(
        &pre_action_fixture.environment("pre-action-token", json!({ "actions": ["editor-save"] })),
        &pre_action_fixture.root,
    );
    pre_action
        .complete(CompleteRequest {
            status: SmokeTerminalStatus::Failed,
            failure_phase: Some(FailurePhase::Startup),
            duration_ms: 0,
            diagnostic: Some(diagnostic("startup-failed", "Application startup failed.")),
        })
        .expect("complete startup failure");

    let cleanup_fixture = Fixture::new();
    let cleanup = SmokeProtocol::from_environment(
        &cleanup_fixture.environment("cleanup-token", json!({ "actions": ["editor-save"] })),
        &cleanup_fixture.root,
    );
    complete_actions(&cleanup, &[SmokeAction::EditorSave]);
    cleanup
        .complete(CompleteRequest {
            status: SmokeTerminalStatus::Failed,
            failure_phase: Some(FailurePhase::Cleanup),
            duration_ms: 2,
            diagnostic: Some(diagnostic("cleanup-failed", "Process cleanup failed.")),
        })
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
    complete_actions(&protocol, &[SmokeAction::EditorSave]);
    protocol
        .complete(complete_passed(2))
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
    let barrier = Arc::new(Barrier::new(9));
    let handles = (0..8)
        .map(|_| {
            let protocol = Arc::clone(&protocol);
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                barrier.wait();
                protocol.record_step(step(SmokeAction::EditorSave, SmokeStepState::Started, 0))
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    let successes = handles
        .into_iter()
        .map(|handle| handle.join().expect("join concurrent update"))
        .filter(Result::is_ok)
        .count();

    assert_eq!(successes, 1);
    protocol
        .record_step(step(SmokeAction::EditorSave, SmokeStepState::Passed, 1))
        .expect("finish serialized action");
    protocol
        .complete(complete_passed(2))
        .expect("complete serialized report");
}
