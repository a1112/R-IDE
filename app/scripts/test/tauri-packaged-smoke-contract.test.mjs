/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SMOKE_ACTIONS,
  SMOKE_SCENARIOS,
  SMOKE_SCHEMAS,
  validateSmokeReport,
  validateSmokeSpec,
} from '../tauri-packaged-smoke-contract.mjs';

const FILE_ACTIONS = [
  'editor-save',
  'terminal-sentinel',
  'workspace-search',
  'scm-status',
  'packaged-plugin-command',
  'secondary-window',
  'second-file-forwarding',
];

function smokeSpec(overrides = {}) {
  return {
    schema: 'ride.tauri-packaged-smoke-spec',
    version: 1,
    scenario: 'critical-file',
    profile: 'tauri-critical',
    workspace: '.',
    files: ['startup.R', 'forwarded.R'],
    actions: [...FILE_ACTIONS],
    tokenSha256: 'a'.repeat(64),
    actionTimeoutMs: 30_000,
    ...overrides,
  };
}

function transition(action, state, durationMs, diagnostic = null) {
  return { action, state, durationMs, diagnostic };
}

function smokeReport(overrides = {}) {
  return {
    schema: 'ride.tauri-packaged-smoke',
    version: 1,
    specSha256: 'b'.repeat(64),
    scenario: 'critical-file',
    profile: 'tauri-critical',
    status: 'passed',
    durationMs: 80,
    diagnostic: null,
    steps: [
      transition('editor-save', 'started', 0),
      transition('editor-save', 'passed', 20),
      transition('terminal-sentinel', 'started', 25),
      transition('terminal-sentinel', 'passed', 75),
    ],
    ...overrides,
  };
}

const REPORT_CONTEXT = Object.freeze({
  specSha256: 'b'.repeat(64),
  scenario: 'critical-file',
  profile: 'tauri-critical',
});

test('exports immutable canonical schemas, scenarios, and ordered actions', () => {
  assert.deepEqual(SMOKE_SCHEMAS, {
    spec: 'ride.tauri-packaged-smoke-spec',
    report: 'ride.tauri-packaged-smoke',
  });
  assert.deepEqual(SMOKE_SCENARIOS, [
    'critical-file',
    'critical-empty',
    'full-file',
  ]);
  assert.deepEqual(SMOKE_ACTIONS, FILE_ACTIONS);

  assert.equal(Object.isFrozen(SMOKE_SCHEMAS), true);
  assert.equal(Object.isFrozen(SMOKE_SCENARIOS), true);
  assert.equal(Object.isFrozen(SMOKE_ACTIONS), true);
  assert.throws(() => SMOKE_ACTIONS.push('unexpected'), TypeError);
});

test('accepts each exact scenario and returns a normalized copy', () => {
  const cases = [
    ['critical-file', 'tauri-critical', ['workspace\\startup.R'], ['editor-save']],
    ['critical-empty', 'tauri-critical', [], []],
    ['full-file', 'full', ['nested\\startup.R'], [...FILE_ACTIONS]],
  ];

  for (const [scenario, profile, files, actions] of cases) {
    const input = smokeSpec({
      scenario,
      profile,
      workspace: 'smoke\\workspace',
      files,
      actions,
    });
    const actual = validateSmokeSpec(input);

    assert.notEqual(actual, input);
    assert.notEqual(actual.files, input.files);
    assert.notEqual(actual.actions, input.actions);
    assert.equal(actual.scenario, scenario);
    assert.equal(actual.workspace, 'smoke/workspace');
    assert.deepEqual(actual.files, files.map(value => value.replaceAll('\\', '/')));
    assert.deepEqual(actual.actions, actions);
  }
});

test('rejects unknown or missing spec fields', () => {
  assert.throws(
    () => validateSmokeSpec({ ...smokeSpec(), commandLine: 'cmd.exe /c whoami' }),
    /unexpected field commandLine/,
  );

  const missing = smokeSpec();
  delete missing.files;
  assert.throws(() => validateSmokeSpec(missing), /missing field files/);
});

test('rejects unsupported schema, version, scenario, and profile values without coercion', () => {
  const cases = [
    ['schema', 'ride.tauri-packaged-smoke-spec@1'],
    ['version', '1'],
    ['scenario', 'adhoc'],
    ['profile', 'development'],
  ];

  for (const [field, value] of cases) {
    assert.throws(
      () => validateSmokeSpec(smokeSpec({ [field]: value })),
      new RegExp(field, 'i'),
    );
  }
});

test('requires relative canonical workspace and file paths', () => {
  const accepted = validateSmokeSpec(smokeSpec({
    workspace: 'fixtures\\project',
    files: ['src\\startup.R', '.\\forwarded.R'],
  }));
  assert.equal(accepted.workspace, 'fixtures/project');
  assert.deepEqual(accepted.files, ['src/startup.R', 'forwarded.R']);

  const unsafePaths = [
    'C:\\Users\\runner\\startup.R',
    'C:/Users/runner/startup.R',
    '/tmp/startup.R',
    '\\\\server\\share\\startup.R',
    '../startup.R',
    'nested/../../startup.R',
  ];
  for (const unsafePath of unsafePaths) {
    assert.throws(
      () => validateSmokeSpec(smokeSpec({ workspace: unsafePath })),
      /workspace.*relative|workspace.*traversal/i,
    );
    assert.throws(
      () => validateSmokeSpec(smokeSpec({ files: [unsafePath] })),
      /files\[0\].*relative|files\[0\].*traversal/i,
    );
  }
});

test('rejects empty, duplicate, and non-string file paths', () => {
  const cases = [
    ['', 'forwarded.R'],
    ['startup.R', 'startup.R'],
    ['startup.R', 42],
  ];
  for (const files of cases) {
    assert.throws(() => validateSmokeSpec(smokeSpec({ files })), /files/i);
  }
});

test('requires actions to be known, unique, and in canonical order', () => {
  assert.deepEqual(
    validateSmokeSpec(smokeSpec({ actions: ['editor-save', 'scm-status', 'secondary-window'] })).actions,
    ['editor-save', 'scm-status', 'secondary-window'],
  );
  assert.throws(
    () => validateSmokeSpec(smokeSpec({ actions: ['terminal-sentinel', 'editor-save'] })),
    /canonical order/i,
  );
  assert.throws(
    () => validateSmokeSpec(smokeSpec({ actions: ['editor-save', 'editor-save'] })),
    /duplicate action editor-save/i,
  );
  assert.throws(
    () => validateSmokeSpec(smokeSpec({ actions: ['editor-save', 'arbitrary-command'] })),
    /unsupported action arbitrary-command/i,
  );
});

test('requires a canonical 64-character lowercase token digest', () => {
  for (const tokenSha256 of [
    'a'.repeat(63),
    'a'.repeat(65),
    'A'.repeat(64),
    'g'.repeat(64),
    64,
  ]) {
    assert.throws(
      () => validateSmokeSpec(smokeSpec({ tokenSha256 })),
      /tokenSha256.*64-character.*SHA-256/i,
    );
  }
});

test('requires an action timeout inside the safe integer bounds', () => {
  for (const actionTimeoutMs of [999, 300_001, 30_000.5, '30000', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => validateSmokeSpec(smokeSpec({ actionTimeoutMs })),
      /actionTimeoutMs.*safe integer.*1000.*300000/i,
    );
  }

  assert.equal(validateSmokeSpec(smokeSpec({ actionTimeoutMs: 1_000 })).actionTimeoutMs, 1_000);
  assert.equal(validateSmokeSpec(smokeSpec({ actionTimeoutMs: 300_000 })).actionTimeoutMs, 300_000);
});

test('accepts a completed ordered report and returns a normalized copy', () => {
  const input = smokeReport();
  const report = validateSmokeReport(input, REPORT_CONTEXT);

  assert.equal(report.status, 'passed');
  assert.deepEqual(report, input);
  assert.notEqual(report, input);
  assert.notEqual(report.steps, input.steps);
  assert.notEqual(report.steps[0], input.steps[0]);
});

test('requires exact report, transition, diagnostic, and context keys', () => {
  assert.throws(
    () => validateSmokeReport({ ...smokeReport(), executablePath: 'R-IDE.exe' }, REPORT_CONTEXT),
    /report.*unexpected field executablePath/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport({
      steps: [{ ...transition('editor-save', 'started', 0), commandLine: 'git status' }],
    }), REPORT_CONTEXT),
    /transition.*unexpected field commandLine/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport({
      status: 'failed',
      diagnostic: { code: 'action-failed', message: 'Action failed', environment: {} },
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'failed', 10, { code: 'action-failed', message: 'Action failed' }),
      ],
      durationMs: 10,
    }), REPORT_CONTEXT),
    /diagnostic.*unexpected field environment/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport(), { ...REPORT_CONTEXT, commandLine: 'git status' }),
    /context.*unexpected field commandLine/i,
  );

  const missing = smokeReport();
  delete missing.status;
  assert.throws(() => validateSmokeReport(missing, REPORT_CONTEXT), /missing field status/i);
});

test('requires report identity to match the expected spec digest, scenario, and profile', () => {
  const cases = [
    ['specSha256', 'c'.repeat(64)],
    ['scenario', 'full-file'],
    ['profile', 'full'],
  ];
  for (const [field, value] of cases) {
    assert.throws(
      () => validateSmokeReport(smokeReport({ [field]: value }), REPORT_CONTEXT),
      new RegExp(`${field}.*match`, 'i'),
    );
  }

  assert.throws(
    () => validateSmokeReport(smokeReport(), { ...REPORT_CONTEXT, specSha256: 'not-a-digest' }),
    /context specSha256.*64-character.*SHA-256/i,
  );
});

test('requires each action to transition from started to exactly one terminal state', () => {
  const invalidSteps = [
    [transition('editor-save', 'passed', 1)],
    [transition('editor-save', 'started', 0), transition('editor-save', 'started', 1)],
    [transition('editor-save', 'started', 0)],
    [
      transition('editor-save', 'started', 0),
      transition('editor-save', 'passed', 1),
      transition('editor-save', 'started', 2),
      transition('editor-save', 'passed', 3),
    ],
    [
      transition('terminal-sentinel', 'started', 0),
      transition('terminal-sentinel', 'passed', 1),
      transition('editor-save', 'started', 2),
      transition('editor-save', 'passed', 3),
    ],
  ];

  for (const steps of invalidSteps) {
    assert.throws(
      () => validateSmokeReport(smokeReport({ steps, durationMs: 10 }), REPORT_CONTEXT),
      /transition|started|complete|canonical order|duplicate/i,
    );
  }
});

test('stops at the first failed transition and matches the single report completion status', () => {
  const failure = { code: 'terminal-timeout', message: 'Terminal action timed out' };
  const failed = smokeReport({
    status: 'failed',
    durationMs: 40,
    diagnostic: failure,
    steps: [
      transition('editor-save', 'started', 0),
      transition('editor-save', 'passed', 10),
      transition('terminal-sentinel', 'started', 15),
      transition('terminal-sentinel', 'failed', 40, failure),
    ],
  });
  assert.equal(validateSmokeReport(failed, REPORT_CONTEXT).status, 'failed');

  assert.throws(
    () => validateSmokeReport({ ...failed, status: 'passed', diagnostic: null }, REPORT_CONTEXT),
    /passed report.*failed transition/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport({ status: 'failed', diagnostic: failure }), REPORT_CONTEXT),
    /failed report.*failed transition/i,
  );
  assert.throws(
    () => validateSmokeReport({
      ...failed,
      durationMs: 50,
      steps: [...failed.steps, transition('workspace-search', 'started', 50)],
    }, REPORT_CONTEXT),
    /transition after failure/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport({ status: 'started' }), REPORT_CONTEXT),
    /status.*passed or failed/i,
  );
});

test('requires safe monotonic transition and completion durations', () => {
  const cases = [
    smokeReport({ steps: [transition('editor-save', 'started', -1)] }),
    smokeReport({ steps: [transition('editor-save', 'started', 0.5)] }),
    smokeReport({ steps: [transition('editor-save', 'started', Number.MAX_SAFE_INTEGER + 1)] }),
    smokeReport({
      steps: [
        transition('editor-save', 'started', 10),
        transition('editor-save', 'passed', 9),
      ],
    }),
    smokeReport({ durationMs: 74 }),
  ];
  for (const candidate of cases) {
    assert.throws(
      () => validateSmokeReport(candidate, REPORT_CONTEXT),
      /durationMs.*safe|monotonic|report durationMs/i,
    );
  }
});

test('requires bounded canonical diagnostics only for failures', () => {
  const baseFailure = { code: 'action-failed', message: 'Action failed safely' };
  const failedReport = (diagnostic, stepDiagnostic = diagnostic) => smokeReport({
    status: 'failed',
    durationMs: 10,
    diagnostic,
    steps: [
      transition('editor-save', 'started', 0),
      transition('editor-save', 'failed', 10, stepDiagnostic),
    ],
  });

  assert.throws(
    () => validateSmokeReport(smokeReport({ diagnostic: baseFailure }), REPORT_CONTEXT),
    /passed report diagnostic must be null/i,
  );
  assert.throws(
    () => validateSmokeReport(failedReport(null), REPORT_CONTEXT),
    /failed report diagnostic/i,
  );
  assert.throws(
    () => validateSmokeReport(failedReport(baseFailure, null), REPORT_CONTEXT),
    /failed transition diagnostic/i,
  );

  const invalidDiagnostics = [
    { code: 'UPPER_CASE', message: 'Action failed' },
    { code: `a${'-b'.repeat(32)}`, message: 'Action failed' },
    { code: 'action-failed', message: '' },
    { code: 'action-failed', message: 'x'.repeat(257) },
    { code: 'action-failed', message: 'Line one\nLine two' },
  ];
  for (const diagnostic of invalidDiagnostics) {
    assert.throws(
      () => validateSmokeReport(failedReport(diagnostic), REPORT_CONTEXT),
      /diagnostic (code|message)/i,
    );
  }
});

test('rejects host paths, environment data, and command lines in diagnostic messages', () => {
  const unsafeMessages = [
    'Failed at C:\\Users\\runner\\workspace',
    'Failed at /home/runner/workspace',
    'Failed at \\\\server\\share',
    'Failed at "/home/runner/secret"',
    'Failed at "\\Users\\runner\\secret"',
    'Observed TOKEN=secret-value',
    'Observed TOKEN = secret-value',
    'Observed $HOME value',
    'Observed %PATH% value',
    'Executed cmd.exe /c whoami',
    'Executed powershell -Command Get-ChildItem',
    'Executed bash -lc pwd',
    'Executed git status --porcelain',
    'Executed Rscript.exe secret.R',
    'Failed at `/home/runner/secret`',
    'Failed at `C:\\Users\\runner\\secret`',
    'Observed TOKEN   =   secret-value',
    'Running git status',
    'Ran Rscript secret.R',
    'Executing git status',
    'Invoked git status',
    'Invoking git status',
  ];
  for (const message of unsafeMessages) {
    const diagnostic = { code: 'unsafe-diagnostic', message };
    assert.throws(
      () => validateSmokeReport(smokeReport({
        status: 'failed',
        durationMs: 10,
        diagnostic,
        steps: [
          transition('editor-save', 'started', 0),
          transition('editor-save', 'failed', 10, diagnostic),
        ],
      }), REPORT_CONTEXT),
      /diagnostic message.*host paths, environment data, or command lines/i,
    );
  }
});

test('accepts canonical bounded human-readable diagnostic messages', () => {
  const safeMessages = [
    'Terminal action timed out',
    'Plugin command was not registered',
    'R-IDE workspace search returned no matching result',
    'Editor save failed: resource was unavailable',
    'Cleanup failed, owned process remained.',
  ];
  for (const message of safeMessages) {
    const diagnostic = { code: 'safe-diagnostic', message };
    const report = validateSmokeReport(smokeReport({
      status: 'failed',
      durationMs: 10,
      diagnostic,
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'failed', 10, diagnostic),
      ],
    }), REPORT_CONTEXT);
    assert.equal(report.diagnostic.message, message);
  }
});
