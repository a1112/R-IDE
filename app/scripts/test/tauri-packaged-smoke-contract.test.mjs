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
  SMOKE_SCENARIO_REQUIREMENTS,
  SMOKE_SCHEMAS,
  validateSmokeProgress,
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
  const status = overrides.status ?? 'passed';
  return {
    schema: 'ride.tauri-packaged-smoke',
    version: 1,
    specSha256: 'b'.repeat(64),
    scenario: 'critical-file',
    profile: 'tauri-critical',
    status,
    failurePhase: status === 'failed' ? 'action' : null,
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

function smokeProgress(overrides = {}) {
  return {
    schema: 'ride.tauri-packaged-smoke-progress',
    version: 1,
    specSha256: 'b'.repeat(64),
    scenario: 'critical-file',
    profile: 'tauri-critical',
    durationMs: 25,
    steps: [
      transition('editor-save', 'started', 0),
      transition('editor-save', 'passed', 20),
      transition('terminal-sentinel', 'started', 25),
    ],
    ...overrides,
  };
}

function failedSmokeReport(code, message) {
  if (code === 'cleanup-failed') {
    return smokeReport({
      status: 'failed',
      failurePhase: 'cleanup',
      diagnostic: { code, message },
    });
  }
  if (code === 'startup-failed' || code === 'sidecar-failed' || code === 'protocol-failed') {
    return smokeReport({
      status: 'failed',
      failurePhase: code.slice(0, -'-failed'.length),
      durationMs: 0,
      diagnostic: { code, message },
      steps: [],
    });
  }
  const diagnostic = { code, message };
  return smokeReport({
    status: 'failed',
    failurePhase: 'action',
    durationMs: 10,
    diagnostic,
    steps: [
      transition('editor-save', 'started', 0),
      transition('editor-save', 'failed', 10, diagnostic),
    ],
  });
}

function captureValidationError(callback) {
  let caught;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  return caught;
}

const REPORT_CONTEXT = Object.freeze({
  specSha256: 'b'.repeat(64),
  scenario: 'critical-file',
  profile: 'tauri-critical',
  actions: ['editor-save', 'terminal-sentinel'],
});
const DIAGNOSTIC_CATALOG = Object.freeze({
  'startup-failed': 'Application startup failed.',
  'action-failed': 'Smoke action failed.',
  'action-timeout': 'Smoke action timed out.',
  'sidecar-failed': 'Backend sidecar failed.',
  'protocol-failed': 'Smoke protocol failed.',
  'cleanup-failed': 'Process cleanup failed.',
});

test('exports immutable canonical schemas, scenarios, and ordered actions', () => {
  assert.deepEqual(SMOKE_SCHEMAS, {
    spec: 'ride.tauri-packaged-smoke-spec',
    progress: 'ride.tauri-packaged-smoke-progress',
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

test('exports immutable exact requirements for every packaged smoke scenario', () => {
  assert.deepEqual(SMOKE_SCENARIO_REQUIREMENTS, {
    'critical-file': {
      profile: 'tauri-critical',
      fileCount: 2,
      actions: [...SMOKE_ACTIONS],
    },
    'critical-empty': {
      profile: 'tauri-critical',
      fileCount: 0,
      actions: ['terminal-sentinel', 'packaged-plugin-command'],
    },
    'full-file': {
      profile: 'full',
      fileCount: 2,
      actions: [...SMOKE_ACTIONS],
    },
  });
  assert.equal(Object.isFrozen(SMOKE_SCENARIO_REQUIREMENTS), true);
  for (const requirement of Object.values(SMOKE_SCENARIO_REQUIREMENTS)) {
    assert.equal(Object.isFrozen(requirement), true);
    assert.equal(Object.isFrozen(requirement.actions), true);
  }
});

test('binds every smoke scenario to its exact profile, file count, and action contract', () => {
  const valid = [
    smokeSpec(),
    smokeSpec({
      scenario: 'critical-empty',
      files: [],
      actions: ['terminal-sentinel', 'packaged-plugin-command'],
    }),
    smokeSpec({ scenario: 'full-file', profile: 'full' }),
  ];
  valid.forEach(candidate => assert.doesNotThrow(() => validateSmokeSpec(candidate)));

  for (const candidate of [
    smokeSpec({ profile: 'full' }),
    smokeSpec({ files: ['only.R'] }),
    smokeSpec({ actions: ['terminal-sentinel'] }),
    smokeSpec({ scenario: 'critical-empty', files: ['unexpected.R'], actions: ['terminal-sentinel', 'packaged-plugin-command'] }),
    smokeSpec({ scenario: 'critical-empty', files: [], actions: ['terminal-sentinel'] }),
    smokeSpec({ scenario: 'full-file', profile: 'tauri-critical' }),
  ]) {
    assert.throws(() => validateSmokeSpec(candidate), /scenario requirements/i);
  }
});

test('accepts strict progress prefixes ending in started, passed, or failed', () => {
  const failure = {
    code: 'action-timeout',
    message: DIAGNOSTIC_CATALOG['action-timeout'],
  };
  const cases = [
    smokeProgress(),
    smokeProgress({
      durationMs: 20,
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'passed', 20),
      ],
    }),
    smokeProgress({
      durationMs: 30,
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'passed', 20),
        transition('terminal-sentinel', 'started', 25),
        transition('terminal-sentinel', 'passed', 30),
      ],
    }),
    smokeProgress({
      durationMs: 30,
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'passed', 20),
        transition('terminal-sentinel', 'started', 25),
        transition('terminal-sentinel', 'failed', 30, failure),
      ],
    }),
  ];

  for (const input of cases) {
    const progress = validateSmokeProgress(input, REPORT_CONTEXT);
    assert.deepEqual(progress, input);
    assert.notEqual(progress, input);
    assert.equal(Object.isFrozen(progress), true);
    assert.equal(Object.isFrozen(progress.steps), true);
  }
});

test('rejects empty progress because snapshots exist only after a recorded transition', () => {
  assert.throws(
    () => validateSmokeProgress(smokeProgress({ durationMs: 0, steps: [] }), REPORT_CONTEXT),
    /progress.*at least one transition/i,
  );
});

test('restricts progress failure diagnostics to action failures', () => {
  for (const code of ['startup-failed', 'sidecar-failed', 'protocol-failed', 'cleanup-failed']) {
    const diagnostic = { code, message: DIAGNOSTIC_CATALOG[code] };
    assert.throws(
      () => validateSmokeProgress(smokeProgress({
        durationMs: 30,
        steps: [
          transition('editor-save', 'started', 0),
          transition('editor-save', 'failed', 30, diagnostic),
        ],
      }), REPORT_CONTEXT),
      /progress.*action-failed.*action-timeout/i,
    );
  }
});

test('requires exact progress fields and rejects terminal reports masquerading as progress', () => {
  assert.throws(
    () => validateSmokeProgress({ ...smokeProgress(), status: 'started' }, REPORT_CONTEXT),
    /progress.*unexpected field/i,
  );
  const missing = smokeProgress();
  delete missing.steps;
  assert.throws(() => validateSmokeProgress(missing, REPORT_CONTEXT), /missing a required field/i);
  assert.throws(
    () => validateSmokeProgress({
      ...smokeReport(),
      schema: 'ride.tauri-packaged-smoke-progress',
    }, REPORT_CONTEXT),
    /progress.*unexpected field/i,
  );
});

test('binds progress identity to the expected report context', () => {
  for (const [field, value] of [
    ['specSha256', 'c'.repeat(64)],
    ['scenario', 'full-file'],
    ['profile', 'full'],
  ]) {
    assert.throws(
      () => validateSmokeProgress(smokeProgress({ [field]: value }), REPORT_CONTEXT),
      new RegExp(`${field}.*match`, 'i'),
    );
  }
});

test('rejects invalid progress order, repetition, continuation after failure, and durations', () => {
  const failure = {
    code: 'action-failed',
    message: DIAGNOSTIC_CATALOG['action-failed'],
  };
  const invalid = [
    smokeProgress({
      durationMs: 1,
      steps: [transition('editor-save', 'passed', 1)],
    }),
    smokeProgress({
      durationMs: 2,
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'passed', 1),
        transition('editor-save', 'started', 2),
      ],
    }),
    smokeProgress({
      durationMs: 3,
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'failed', 1, failure),
        transition('terminal-sentinel', 'started', 3),
      ],
    }),
    smokeProgress({
      durationMs: 10,
      steps: [
        transition('editor-save', 'started', 10),
        transition('editor-save', 'passed', 9),
      ],
    }),
    smokeProgress({
      durationMs: 8,
      steps: [transition('editor-save', 'started', 9)],
    }),
  ];

  for (const value of invalid) {
    assert.throws(
      () => validateSmokeProgress(value, REPORT_CONTEXT),
      /transition|duplicate|failure|duration/i,
    );
  }
});

test('progress validation errors never echo untrusted values', () => {
  const marker = 'PROGRESS_SECRET_ABSOLUTE_PATH';
  const error = captureValidationError(() => validateSmokeProgress({
    ...smokeProgress(),
    [marker]: `C:\\Users\\runner\\${marker}`,
  }, REPORT_CONTEXT));

  assert.doesNotMatch(error.message, new RegExp(marker, 'i'));
});

test('accepts each exact scenario and returns a normalized copy', () => {
  const cases = [
    ['critical-file', 'tauri-critical', ['workspace\\startup.R', 'workspace\\forwarded.R'], [...FILE_ACTIONS]],
    ['critical-empty', 'tauri-critical', [], ['terminal-sentinel', 'packaged-plugin-command']],
    ['full-file', 'full', ['nested\\startup.R', 'nested\\forwarded.R'], [...FILE_ACTIONS]],
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
    /unexpected field at index/,
  );

  const missing = smokeSpec();
  delete missing.files;
  assert.throws(() => validateSmokeSpec(missing), /missing a required field/);
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

test('requires Windows-portable relative workspace and file paths', () => {
  const unsafePaths = [
    'nested/file.R:secret',
    'CON',
    'con.R',
    'Aux.txt',
    'NUL.data',
    'com1.log',
    'LPT9.R',
    'folder./file.R',
    'folder /file.R',
    'nested/file.R.',
    'nested/file.R ',
  ];
  for (const unsafePath of unsafePaths) {
    assert.throws(
      () => validateSmokeSpec(smokeSpec({ workspace: unsafePath })),
      /workspace.*portable|workspace.*relative path/i,
    );
    assert.throws(
      () => validateSmokeSpec(smokeSpec({ files: [unsafePath] })),
      /files\[0\].*portable|files\[0\].*relative path/i,
    );
  }

  assert.throws(
    () => validateSmokeSpec(smokeSpec({ files: ['Startup.R', 'startup.r'] })),
    /files.*case-insensitive.*unique/i,
  );
  assert.deepEqual(validateSmokeSpec(smokeSpec({
    workspace: 'console',
    files: ['com10.R', 'auxiliary.R'],
  })).files, ['com10.R', 'auxiliary.R']);
});

test('rejects every Windows-forbidden filename character in every path segment', () => {
  const forbiddenCharacters = ['<', '>', '"', '|', '?', '*', ':'];

  for (const character of forbiddenCharacters) {
    const unsafePaths = [
      `bad${character}segment/file.R`,
      `nested/file${character}.R`,
    ];
    for (const unsafePath of unsafePaths) {
      assert.throws(
        () => validateSmokeSpec(smokeSpec({ workspace: unsafePath })),
        /workspace.*(?:Windows-portable|relative path)/i,
      );
      assert.throws(
        () => validateSmokeSpec(smokeSpec({ files: [unsafePath] })),
        /files\[0\].*(?:Windows-portable|relative path)/i,
      );
    }
  }
});

test('rejects every ASCII control character in Windows path segments', () => {
  for (let codePoint = 0x00; codePoint <= 0x1f; codePoint += 1) {
    const character = String.fromCodePoint(codePoint);
    const unsafePaths = [
      `bad${character}segment/file.R`,
      `nested/file${character}.R`,
    ];
    for (const unsafePath of unsafePaths) {
      assert.throws(
        () => validateSmokeSpec(smokeSpec({ workspace: unsafePath })),
        /workspace.*Windows-portable/i,
      );
      assert.throws(
        () => validateSmokeSpec(smokeSpec({ files: [unsafePath] })),
        /files\[0\].*Windows-portable/i,
      );
    }
  }
});

test('accepts valid Unicode filenames on Windows-portable paths', () => {
  const spec = validateSmokeSpec(smokeSpec({
    workspace: '数据/项目',
    files: ['分析/启动.R', 'café/数据📊.R'],
  }));

  assert.equal(spec.workspace, '数据/项目');
  assert.deepEqual(spec.files, ['分析/启动.R', 'café/数据📊.R']);
});

test('rejects Windows ordinal-style single-code-point case collisions', () => {
  assert.throws(
    () => validateSmokeSpec(smokeSpec({ files: ['σ.R', 'ς.R'] })),
    /files.*case-insensitive.*unique/i,
  );
  assert.throws(
    () => validateSmokeSpec(smokeSpec({ files: ['nested/σ.R', 'nested/ς.R'] })),
    /files.*case-insensitive.*unique/i,
  );
});

test('preserves expanding uppercase and normalization-distinct Unicode filenames', () => {
  for (const files of [['ß.R', 'SS.R'], ['é.R', 'e\u0301.R']]) {
    assert.deepEqual(validateSmokeSpec(smokeSpec({ files })).files, files);
  }
});

test('requires scenario actions to be complete, known, unique, and in canonical order', () => {
  assert.deepEqual(
    validateSmokeSpec(smokeSpec()).actions,
    [...FILE_ACTIONS],
  );
  assert.throws(
    () => validateSmokeSpec(smokeSpec({ actions: ['editor-save', 'scm-status', 'secondary-window'] })),
    /scenario requirements/i,
  );
  assert.throws(
    () => validateSmokeSpec(smokeSpec({ actions: ['terminal-sentinel', 'editor-save'] })),
    /canonical order/i,
  );
  assert.throws(
    () => validateSmokeSpec(smokeSpec({ actions: ['editor-save', 'editor-save'] })),
    /duplicate action at index/i,
  );
  assert.throws(
    () => validateSmokeSpec(smokeSpec({ actions: ['editor-save', 'arbitrary-command'] })),
    /unsupported action at index/i,
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
    /report.*unexpected field at index/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport({
      steps: [{ ...transition('editor-save', 'started', 0), commandLine: 'git status' }],
    }), REPORT_CONTEXT),
    /transition.*unexpected field at index/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport({
      status: 'failed',
      diagnostic: { code: 'action-failed', message: DIAGNOSTIC_CATALOG['action-failed'], environment: {} },
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'failed', 10, {
          code: 'action-failed',
          message: DIAGNOSTIC_CATALOG['action-failed'],
        }),
      ],
      durationMs: 10,
    }), REPORT_CONTEXT),
    /diagnostic.*unexpected field at index/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport(), { ...REPORT_CONTEXT, commandLine: 'git status' }),
    /context.*unexpected field at index/i,
  );

  const missing = smokeReport();
  delete missing.status;
  assert.throws(() => validateSmokeReport(missing, REPORT_CONTEXT), /missing a required field/i);
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

test('binds passed reports to the complete expected action list', () => {
  const expected = { ...REPORT_CONTEXT, actions: ['editor-save', 'terminal-sentinel'] };
  assert.equal(validateSmokeReport(smokeReport(), expected).status, 'passed');

  assert.throws(
    () => validateSmokeReport(smokeReport({
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'passed', 20),
      ],
      durationMs: 20,
    }), expected),
    /expected actions|complete/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport(), {
      ...REPORT_CONTEXT,
      actions: ['editor-save'],
    }),
    /expected actions|unexpected action/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport(), {
      ...REPORT_CONTEXT,
      actions: ['terminal-sentinel', 'editor-save'],
    }),
    /expected actions.*canonical order/i,
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
  const failure = { code: 'action-timeout', message: DIAGNOSTIC_CATALOG['action-timeout'] };
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
    () => validateSmokeReport({
      ...failed,
      status: 'passed',
      failurePhase: null,
      diagnostic: null,
    }, REPORT_CONTEXT),
    /passed report.*failed transition/i,
  );
  assert.throws(
    () => validateSmokeReport(smokeReport({ status: 'failed', diagnostic: failure }), REPORT_CONTEXT),
    /action failure phase.*failed expected action/i,
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

test('enforces explicit canonical failure phases and terminal state shapes', () => {
  assert.equal(validateSmokeReport({
    ...smokeReport(),
    failurePhase: null,
  }, REPORT_CONTEXT).status, 'passed');

  for (const [failurePhase, code] of [
    ['startup', 'startup-failed'],
    ['sidecar', 'sidecar-failed'],
    ['protocol', 'protocol-failed'],
  ]) {
    const report = validateSmokeReport(failedSmokeReport(
      code,
      DIAGNOSTIC_CATALOG[code],
    ), REPORT_CONTEXT);
    assert.equal(report.failurePhase, failurePhase);
    assert.deepEqual(report.steps, []);
  }

  const actionFailure = validateSmokeReport(failedSmokeReport(
    'action-failed',
    DIAGNOSTIC_CATALOG['action-failed'],
  ), REPORT_CONTEXT);
  assert.equal(actionFailure.failurePhase, 'action');
  assert.equal(actionFailure.steps.at(-1).state, 'failed');

  const cleanupFailure = validateSmokeReport(failedSmokeReport(
    'cleanup-failed',
    DIAGNOSTIC_CATALOG['cleanup-failed'],
  ), REPORT_CONTEXT);
  assert.equal(cleanupFailure.failurePhase, 'cleanup');
  assert.equal(cleanupFailure.steps.at(-1).state, 'passed');
});

test('rejects failure phases that do not match their action progress or diagnostic', () => {
  const actionDiagnostic = {
    code: 'action-failed',
    message: DIAGNOSTIC_CATALOG['action-failed'],
  };
  const invalid = [
    { ...smokeReport(), failurePhase: 'action' },
    failedSmokeReport('startup-failed', DIAGNOSTIC_CATALOG['startup-failed']),
    {
      ...failedSmokeReport('protocol-failed', DIAGNOSTIC_CATALOG['protocol-failed']),
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'passed', 1),
      ],
      durationMs: 1,
    },
    {
      ...failedSmokeReport('cleanup-failed', DIAGNOSTIC_CATALOG['cleanup-failed']),
      steps: [
        transition('editor-save', 'started', 0),
        transition('editor-save', 'passed', 1),
      ],
      durationMs: 1,
    },
    {
      ...failedSmokeReport('action-failed', DIAGNOSTIC_CATALOG['action-failed']),
      failurePhase: 'cleanup',
      diagnostic: actionDiagnostic,
    },
    {
      ...failedSmokeReport('action-failed', DIAGNOSTIC_CATALOG['action-failed']),
      failurePhase: 'unknown',
    },
    {
      ...failedSmokeReport('action-failed', DIAGNOSTIC_CATALOG['action-failed']),
      diagnostic: {
        code: 'action-timeout',
        message: DIAGNOSTIC_CATALOG['action-timeout'],
      },
    },
  ];
  invalid[1].failurePhase = 'action';

  for (const candidate of invalid) {
    assert.throws(
      () => validateSmokeReport(candidate, REPORT_CONTEXT),
      /failure phase|failurePhase|terminal state|expected actions|diagnostics/i,
    );
  }
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
  const baseFailure = { code: 'action-failed', message: DIAGNOSTIC_CATALOG['action-failed'] };
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
    { code: 'UPPER_CASE', message: DIAGNOSTIC_CATALOG['action-failed'] },
    { code: `a${'-b'.repeat(32)}`, message: DIAGNOSTIC_CATALOG['action-failed'] },
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
    'git status',
    'git status porcelain',
    'Rscript secret',
    'Rscript.exe secret.R',
    'npm test',
    'whoami',
    'tool.exe argument',
    'Terminal whoami',
    'Editor Rscript secret',
    'Application npm test',
    'Backend TOKEN secret-value',
    'Process API-KEY secret-value',
  ];
  for (const message of unsafeMessages) {
    const diagnostic = { code: 'action-failed', message };
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
      /diagnostic message.*(catalog|code)/i,
    );
  }
});

test('accepts every exact diagnostic code and message mapping', () => {
  for (const [code, message] of Object.entries(DIAGNOSTIC_CATALOG)) {
    const report = validateSmokeReport(failedSmokeReport(code, message), REPORT_CONTEXT);
    assert.equal(report.diagnostic.message, message);
  }
});

test('rejects details and non-exact variants of every diagnostic catalog message', () => {
  for (const [code, message] of Object.entries(DIAGNOSTIC_CATALOG)) {
    const variants = [
      `Unexpected ${message}`,
      `${message} secret details`,
      message.toLowerCase(),
      message.slice(0, -1),
      `${message.slice(0, -1)}!`,
      message.replace(' ', '\u00a0'),
      ` ${message}`,
      `${message} `,
    ];
    for (const variant of variants) {
      const diagnostic = { code, message: variant };
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
        /diagnostic message/i,
      );
    }
  }
});

test('rejects unknown diagnostic codes and mismatched catalog pairs', () => {
  const unknown = {
    code: 'token-secret-value',
    message: DIAGNOSTIC_CATALOG['action-failed'],
  };
  const mismatched = {
    code: 'action-failed',
    message: DIAGNOSTIC_CATALOG['cleanup-failed'],
  };
  for (const diagnostic of [unknown, mismatched]) {
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
      /diagnostic (code|message|catalog)/i,
    );
  }
});

test('deep-freezes every normalized spec and report structure', () => {
  const spec = validateSmokeSpec(smokeSpec());
  const report = validateSmokeReport(failedSmokeReport(
    'action-failed',
    DIAGNOSTIC_CATALOG['action-failed'],
  ), REPORT_CONTEXT);

  for (const value of [
    spec,
    spec.files,
    spec.actions,
    report,
    report.steps,
    report.steps[0],
    report.steps.at(-1).diagnostic,
    report.diagnostic,
  ]) {
    assert.equal(Object.isFrozen(value), true);
  }

  assert.throws(() => { spec.workspace = 'other'; }, TypeError);
  assert.throws(() => spec.files.push('other.R'), TypeError);
  assert.throws(() => { spec.actions[0] = 'terminal-sentinel'; }, TypeError);
  assert.throws(() => { report.status = 'passed'; }, TypeError);
  assert.throws(() => report.steps.push(transition('terminal-sentinel', 'started', 11)), TypeError);
  assert.throws(() => { report.steps[0].state = 'passed'; }, TypeError);
  assert.throws(() => { report.diagnostic.message = 'Smoke action timed out.'; }, TypeError);
  assert.throws(() => { report.steps.at(-1).diagnostic.code = 'action-timeout'; }, TypeError);
});

test('never echoes untrusted field names, action values, or path values in errors', () => {
  const fieldMarker = 'FIELD_TOKEN_SECRET_VALUE';
  const actionMarker = 'action-token-secret-value';
  const pathMarker = 'path-token-secret-value';
  const errors = [
    captureValidationError(() => validateSmokeSpec({
      ...smokeSpec(),
      [fieldMarker]: true,
    })),
    captureValidationError(() => validateSmokeSpec(smokeSpec({ actions: [actionMarker] }))),
    captureValidationError(() => validateSmokeSpec(smokeSpec({
      files: [`${pathMarker}/../startup.R`],
    }))),
    captureValidationError(() => validateSmokeReport({
      ...smokeReport(),
      [fieldMarker]: true,
    }, REPORT_CONTEXT)),
    captureValidationError(() => validateSmokeReport(smokeReport({
      steps: [transition(actionMarker, 'started', 0)],
      durationMs: 0,
    }), REPORT_CONTEXT)),
    captureValidationError(() => validateSmokeReport(smokeReport(), {
      ...REPORT_CONTEXT,
      actions: [actionMarker],
    })),
    captureValidationError(() => validateSmokeReport(failedSmokeReport(
      'action-failed',
      DIAGNOSTIC_CATALOG['action-failed'],
    ), {
      ...REPORT_CONTEXT,
      [fieldMarker]: true,
    })),
  ];

  for (const error of errors) {
    for (const marker of [fieldMarker, actionMarker, pathMarker]) {
      assert.doesNotMatch(error.message, new RegExp(marker, 'i'));
    }
  }
});
