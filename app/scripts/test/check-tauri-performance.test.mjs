/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  compareTauriPerformance,
  HISTORICAL_BASELINE_MIGRATION,
} from '../check-tauri-performance.mjs';

const ROLES = [
  'main',
  'backend',
  'pluginHost',
  'webviewRenderer',
  'webviewGpu',
  'webviewUtility',
  'terminal',
  'other',
];
const HISTORICAL_BASELINE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'applications',
  'tauri',
  'perf',
  'baselines',
  'pre-optimization-windows-x64-d034943.json',
);

function roleMetrics(rssBytes) {
  return Object.fromEntries(ROLES.map(role => [role, role === 'main'
    ? { processCount: 1, rssBytes }
    : { processCount: 0, rssBytes: 0 }]));
}

function startupRun(targetFileOpenedMs, rssBytes, pid, startupMode = 'rust-gateway') {
  const milestones = startupMode === 'rust-gateway'
    ? {
      process_started: 0,
      gateway_listening: 50,
      native_window_visible: 100,
      frontend_request_started: 60,
      frontend_bundle_loaded: 800,
      backend_spawned: 20,
      backend_listening: 500,
      rpc_connected: 600,
      frontend_shell_attached: 1_000,
      target_file_opened: targetFileOpenedMs,
      plugins_started: targetFileOpenedMs + 10,
      plugins_ready: targetFileOpenedMs + 20,
    }
    : {
      process_started: 0,
      native_window_visible: 100,
      backend_spawned: 120,
      backend_listening: 500,
      frontend_shell_attached: 1_000,
      target_file_opened: targetFileOpenedMs,
      plugins_started: targetFileOpenedMs + 10,
      plugins_ready: targetFileOpenedMs + 20,
    };
  return {
    startupReport: {
      schema: 'ride.startup-report',
      version: 2,
      platform: 'windows',
      arch: 'x86_64',
      pid,
      startupMode,
      milestones,
    },
    metrics: {
      rootPid: pid,
      rootIdentity: {
        pid,
        pgid: null,
        creationTime: `fixture-${pid}`,
        startedAt: 1_000 + pid,
      },
      processIds: [pid],
      processCount: 1,
      rssBytes,
      roles: roleMetrics(rssBytes),
      processes: [{
        pid,
        ppid: 1,
        pgid: null,
        creationTime: `fixture-${pid}`,
        startedAt: 1_000 + pid,
        depth: 0,
      }],
    },
  };
}

function measurement({
  targetFileOpenedMs,
  rssBytes,
  runs = 5,
  platform = 'win32',
  arch = 'x64',
  fingerprint = HISTORICAL_BASELINE_MIGRATION.hostFingerprint,
  commit = '0123456789abcdef0123456789abcdef01234567',
  startupMode = 'rust-gateway',
} = {}) {
  const samples = Array.from(
    { length: runs },
    (_, index) => startupRun(targetFileOpenedMs, rssBytes, 7_300 + index, startupMode),
  );
  return {
    schema: 'ride.startup-measurement',
    version: 3,
    startupMode,
    platform,
    arch,
    build: {
      commit,
      profile: 'tauri-critical',
      profileSha256: 'b'.repeat(64),
      pluginManifestSha256: 'c'.repeat(64),
      pluginCount: 69,
    },
    host: { platform, arch, fingerprint },
    runs: samples,
    median: {
      targetFileOpenedMs,
      rssBytes,
      processCount: 1,
      roles: roleMetrics(rssBytes),
    },
  };
}

function fixtureMedian(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function rustGatewayMeasurementV4({
  targetSamples = [2_200, 2_200, 2_200, 2_200, 2_200],
  windowSamples = [800, 800, 800, 800, 800],
  rssSamples = [1_030, 1_030, 1_030, 1_030, 1_030],
  ...options
} = {}) {
  assert.equal(targetSamples.length, 5);
  assert.equal(windowSamples.length, 5);
  assert.equal(rssSamples.length, 5);
  const value = measurement({
    targetFileOpenedMs: targetSamples[0],
    rssBytes: rssSamples[0],
    ...options,
  });
  value.version = 4;
  value.runs = targetSamples.map((targetFileOpenedMs, index) => {
    const run = startupRun(targetFileOpenedMs, rssSamples[index], 7_300 + index);
    run.startupReport.milestones.native_window_visible = windowSamples[index];
    return run;
  });
  value.median = {
    targetFileOpenedMs: fixtureMedian(targetSamples),
    nativeWindowVisibleMs: fixtureMedian(windowSamples),
    rssBytes: fixtureMedian(rssSamples),
    processCount: 1,
    roles: roleMetrics(fixtureMedian(rssSamples)),
  };
  value.diagnostics = {
    frontendBackendOverlapMs: {
      runs: [440, 440, 440, 440, 440],
      median: 440,
    },
  };
  return value;
}

function existingV2Measurement(options = {}) {
  const value = measurement(options);
  value.version = 2;
  delete value.startupMode;
  for (const run of value.runs) {
    const targetFileOpenedMs = run.startupReport.milestones.target_file_opened;
    run.startupReport.version = 1;
    delete run.startupReport.startupMode;
    run.startupReport.milestones = {
      process_started: 0,
      native_window_visible: 100,
      backend_spawned: 120,
      backend_listening: 500,
      frontend_shell_attached: 1_000,
      target_file_opened: targetFileOpenedMs,
      plugins_started: targetFileOpenedMs + 10,
      plugins_ready: targetFileOpenedMs + 20,
    };
  }
  return value;
}

function legacyBaseline() {
  return JSON.parse(fs.readFileSync(HISTORICAL_BASELINE_PATH, 'utf8'));
}

test('accepts exactly five compatible v3 rust-gateway runs at the fixed gain thresholds', () => {
  const baseline = measurement({ targetFileOpenedMs: 5_310, rssBytes: 1_154_154_496 });
  const candidate = measurement({ targetFileOpenedMs: 3_717, rssBytes: 1_038_739_046 });

  assert.deepEqual(compareTauriPerformance(baseline, candidate, {
    minStartupGain: 30,
    minMemoryGain: 10,
  }), {
    runs: 5,
    startup: {
      actual: 3_717,
      target: 3_717,
      delta: 0,
    },
    memory: {
      actual: 1_038_739_046,
      target: 1_038_739_046,
      delta: 0,
    },
  });
});

test('rust-gateway policy accepts all absolute boundaries and reports overlap diagnostically', () => {
  const baseline = measurement({ targetFileOpenedMs: 1_000, rssBytes: 1_000 });
  const candidate = rustGatewayMeasurementV4({
    targetSamples: [1_800, 2_100, 2_200, 2_300, 3_000],
    windowSamples: [700, 750, 800, 810, 820],
    rssSamples: [1_030, 1_030, 1_030, 1_030, 1_030],
  });

  const result = compareTauriPerformance(baseline, candidate, {
    policy: 'rust-gateway',
    maxStartupMedianMs: 2_200,
    maxStartupSlowestMs: 3_000,
    maxWindowMedianMs: 800,
    maxMemoryRegressionPercent: 3,
  });

  assert.deepEqual(result, {
    policy: 'rust-gateway',
    runs: 5,
    startupMedian: { actual: 2_200, target: 2_200, delta: 0 },
    startupSlowest: { actual: 3_000, target: 3_000, delta: 0 },
    windowMedian: { actual: 800, target: 800, delta: 0 },
    memory: { actual: 1_030, target: 1_030, delta: 0 },
    diagnostics: {
      frontendBackendOverlapMs: {
        runs: [440, 440, 440, 440, 440],
        median: 440,
      },
    },
  });
});

test('rust-gateway policy absolute limits replace historical gain defaults', () => {
  const baseline = measurement({ targetFileOpenedMs: 1_000, rssBytes: 1_000 });
  const candidate = rustGatewayMeasurementV4({
    targetSamples: [2_000, 2_000, 2_000, 2_000, 2_000],
    windowSamples: [700, 700, 700, 700, 700],
    rssSamples: [1_030, 1_030, 1_030, 1_030, 1_030],
  });

  assert.throws(
    () => compareTauriPerformance(baseline, candidate),
    /performance targets failed/i,
  );
  assert.equal(compareTauriPerformance(baseline, candidate, {
    policy: 'rust-gateway',
  }).policy, 'rust-gateway');
});

test('rust-gateway policy rejects each absolute startup, window, and memory limit', () => {
  const baseline = measurement({ targetFileOpenedMs: 1_000, rssBytes: 1_000 });
  const cases = [
    ['startup median', {
      targetSamples: [2_201, 2_201, 2_201, 2_201, 2_201],
    }, /startup median.*actual 2201.*target 2200.*delta \+1/i],
    ['startup slowest', {
      targetSamples: [2_000, 2_100, 2_200, 2_300, 3_001],
    }, /startup slowest.*actual 3001.*target 3000.*delta \+1/i],
    ['window median', {
      windowSamples: [801, 801, 801, 801, 801],
    }, /window median.*actual 801.*target 800.*delta \+1/i],
    ['memory', {
      rssSamples: [1_031, 1_031, 1_031, 1_031, 1_031],
    }, /memory.*actual 1031.*target 1030.*delta \+1/i],
  ];
  for (const [label, samples, expected] of cases) {
    assert.throws(
      () => compareTauriPerformance(
        baseline,
        rustGatewayMeasurementV4(samples),
        { policy: 'rust-gateway' },
      ),
      expected,
      label,
    );
  }
});

test('rust-gateway policy validates absolute options as bounded safe integers', () => {
  const baseline = measurement({ targetFileOpenedMs: 1_000, rssBytes: 1_000 });
  const candidate = rustGatewayMeasurementV4();
  for (const [field, value] of [
    ['maxStartupMedianMs', Number.NaN],
    ['maxStartupSlowestMs', Number.MAX_SAFE_INTEGER + 1],
    ['maxWindowMedianMs', -1],
    ['maxMemoryRegressionPercent', 101],
  ]) {
    assert.throws(
      () => compareTauriPerformance(baseline, candidate, {
        policy: 'rust-gateway',
        [field]: value,
      }),
      /safe integer|0 through 100/i,
      field,
    );
  }
  assert.throws(
    () => compareTauriPerformance(baseline, candidate, { policy: 'unknown' }),
    /unsupported performance policy unknown/i,
  );
});

test('strict v4 diagnostics must exactly match safe per-run overlap values', () => {
  const baseline = measurement({ targetFileOpenedMs: 1_000, rssBytes: 1_000 });
  const mutations = [
    diagnostics => { diagnostics.frontendBackendOverlapMs.runs[0] = -1; },
    diagnostics => { diagnostics.frontendBackendOverlapMs.median = 439; },
    diagnostics => { diagnostics.unexpected = true; },
  ];
  for (const mutate of mutations) {
    const candidate = rustGatewayMeasurementV4();
    mutate(candidate.diagnostics);
    assert.throws(
      () => compareTauriPerformance(baseline, candidate, { policy: 'rust-gateway' }),
      /overlap|unexpected field|safe integer/i,
    );
  }
});

test('strict v4 overlap median must be a non-negative safe number', () => {
  const baseline = measurement({ targetFileOpenedMs: 1_000, rssBytes: 1_000 });
  const candidate = rustGatewayMeasurementV4();
  candidate.diagnostics.frontendBackendOverlapMs.median = Number.MAX_VALUE;

  assert.throws(
    () => compareTauriPerformance(baseline, candidate, { policy: 'rust-gateway' }),
    /overlap median.*safe number/i,
  );
});

test('rust-gateway CLI accepts absolute gate options and emits policy diagnostics', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-performance-policy-'));
  const baselinePath = path.join(directory, 'baseline.json');
  const candidatePath = path.join(directory, 'candidate.json');
  try {
    fs.writeFileSync(
      baselinePath,
      JSON.stringify(measurement({ targetFileOpenedMs: 1_000, rssBytes: 1_000 })),
    );
    fs.writeFileSync(candidatePath, JSON.stringify(rustGatewayMeasurementV4()));
    const result = spawnSync(process.execPath, [
      path.resolve(import.meta.dirname, '..', 'check-tauri-performance.mjs'),
      '--baseline', baselinePath,
      '--candidate', candidatePath,
      '--policy', 'rust-gateway',
      '--max-startup-median-ms', '2200',
      '--max-startup-slowest-ms', '3000',
      '--max-window-median-ms', '800',
      '--max-memory-regression-percent', '3',
    ], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.policy, 'rust-gateway');
    assert.equal(output.diagnostics.frontendBackendOverlapMs.median, 440);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts an existing v2 baseline with a v3 rust-gateway candidate', () => {
  const baseline = existingV2Measurement({
    targetFileOpenedMs: 5_310,
    rssBytes: 1_154_154_496,
  });
  const candidate = measurement({ targetFileOpenedMs: 3_717, rssBytes: 1_038_739_046 });

  assert.equal(compareTauriPerformance(baseline, candidate, {
    minStartupGain: 30,
    minMemoryGain: 10,
  }).runs, 5);
});

test('rejects legacy and mixed-mode optimized candidates', () => {
  const baseline = measurement({ targetFileOpenedMs: 5_310, rssBytes: 1_154_154_496 });
  for (const startupMode of ['legacy-explicit', 'legacy-fallback']) {
    assert.throws(
      () => compareTauriPerformance(
        baseline,
        measurement({
          targetFileOpenedMs: 3_000,
          rssBytes: 900_000_000,
          startupMode,
        }),
        { minStartupGain: 30, minMemoryGain: 10 },
      ),
      new RegExp(`candidate.*${startupMode}`, 'i'),
    );
  }

  const mixed = measurement({ targetFileOpenedMs: 3_000, rssBytes: 900_000_000 });
  mixed.runs[1] = startupRun(3_000, 900_000_000, 7_301, 'legacy-fallback');
  assert.throws(
    () => compareTauriPerformance(
      baseline,
      mixed,
      { minStartupGain: 30, minMemoryGain: 10 },
    ),
    /mixed effective startup modes|does not match.*startupMode/i,
  );
});

test('requires exactly five candidate runs', () => {
  const baseline = measurement({ targetFileOpenedMs: 5_310, rssBytes: 1_154_154_496 });
  for (const runs of [4, 6]) {
    assert.throws(
      () => compareTauriPerformance(
        baseline,
        measurement({ targetFileOpenedMs: 3_000, rssBytes: 900_000_000, runs }),
        { minStartupGain: 30, minMemoryGain: 10 },
      ),
      /candidate must contain exactly 5 runs/,
    );
  }
});

test('rejects incompatible platform, architecture, and host identity', () => {
  const baseline = measurement({ targetFileOpenedMs: 5_310, rssBytes: 1_154_154_496 });
  const cases = [
    ['platform', { platform: 'linux' }],
    ['architecture', { arch: 'arm64' }],
    ['host fingerprint', { fingerprint: 'd'.repeat(64) }],
  ];
  for (const [label, overrides] of cases) {
    assert.throws(
      () => compareTauriPerformance(
        baseline,
        measurement({ targetFileOpenedMs: 3_000, rssBytes: 900_000_000, ...overrides }),
        { minStartupGain: 30, minMemoryGain: 10 },
      ),
      new RegExp(label, 'i'),
    );
  }
});

test('requires matching modern build contracts while allowing the candidate commit to change', () => {
  const baseline = measurement({
    targetFileOpenedMs: 5_310,
    rssBytes: 1_154_154_496,
    commit: '1'.repeat(40),
  });
  const compatible = measurement({
    targetFileOpenedMs: 3_717,
    rssBytes: 1_038_739_046,
    commit: '2'.repeat(40),
  });
  assert.equal(compareTauriPerformance(baseline, compatible, {
    minStartupGain: 30,
    minMemoryGain: 10,
  }).runs, 5);

  const incompatible = [
    ['profile', 'full'],
    ['profileSha256', 'd'.repeat(64)],
    ['pluginManifestSha256', 'e'.repeat(64)],
    ['pluginCount', 70],
  ];
  for (const [field, value] of incompatible) {
    const candidate = structuredClone(compatible);
    candidate.build[field] = value;
    assert.throws(
      () => compareTauriPerformance(baseline, candidate, {
        minStartupGain: 30,
        minMemoryGain: 10,
      }),
      new RegExp(`build.*${field}|${field}.*build`, 'i'),
    );
  }
});

test('rejects missing build identity and non-strict modern role data', () => {
  const baseline = measurement({ targetFileOpenedMs: 5_310, rssBytes: 1_154_154_496 });
  const missingBuild = measurement({ targetFileOpenedMs: 3_000, rssBytes: 900_000_000 });
  delete missingBuild.build;
  assert.throws(
    () => compareTauriPerformance(baseline, missingBuild, {
      minStartupGain: 30,
      minMemoryGain: 10,
    }),
    /candidate.*build|build.*candidate/,
  );

  const missingRole = measurement({ targetFileOpenedMs: 3_000, rssBytes: 900_000_000 });
  delete missingRole.runs[0].metrics.roles.webviewGpu;
  assert.throws(
    () => compareTauriPerformance(baseline, missingRole, {
      minStartupGain: 30,
      minMemoryGain: 10,
    }),
    /webviewGpu/,
  );
});

test('strict v3 schema rejects persisted executable paths', () => {
  const baseline = measurement({ targetFileOpenedMs: 5_310, rssBytes: 1_154_154_496 });
  const candidate = measurement({ targetFileOpenedMs: 3_717, rssBytes: 1_038_739_046 });
  candidate.executable = 'C:\\sensitive\\ride-tauri.exe';
  assert.throws(
    () => compareTauriPerformance(baseline, candidate, {
      minStartupGain: 30,
      minMemoryGain: 10,
    }),
    /unexpected field executable/,
  );
});

test('rejects unsafe run values and medians that do not match the five runs', () => {
  const baseline = measurement({ targetFileOpenedMs: 5_310, rssBytes: 1_154_154_496 });
  for (const unsafe of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const candidate = measurement({ targetFileOpenedMs: 3_000, rssBytes: 900_000_000 });
    candidate.runs[0].metrics.rssBytes = unsafe;
    assert.throws(
      () => compareTauriPerformance(baseline, candidate, {
        minStartupGain: 30,
        minMemoryGain: 10,
      }),
      /safe integer/,
    );
  }

  const staleMedian = measurement({ targetFileOpenedMs: 3_000, rssBytes: 900_000_000 });
  staleMedian.median.targetFileOpenedMs = 2_999;
  assert.throws(
    () => compareTauriPerformance(baseline, staleMedian, {
      minStartupGain: 30,
      minMemoryGain: 10,
    }),
    /reported median.*does not match/i,
  );
});

test('threshold failures report actual, target, and signed delta for both metrics', () => {
  const baseline = measurement({ targetFileOpenedMs: 5_310, rssBytes: 1_154_154_496 });
  const candidate = measurement({ targetFileOpenedMs: 3_800, rssBytes: 1_050_000_000 });
  assert.throws(
    () => compareTauriPerformance(baseline, candidate, {
      minStartupGain: 30,
      minMemoryGain: 10,
    }),
    error => {
      assert.match(error.message, /startup.*actual 3800.*target 3717.*delta \+83/i);
      assert.match(error.message, /memory.*actual 1050000000.*target 1038739046.*delta \+11260954/i);
      return true;
    },
  );
});

test('accepts v1 only with the explicit historical d034943 migration marker', () => {
  const baseline = legacyBaseline();
  const candidate = measurement({ targetFileOpenedMs: 3_717, rssBytes: 1_038_739_046 });
  assert.equal(compareTauriPerformance(baseline, candidate, {
    minStartupGain: 30,
    minMemoryGain: 10,
  }).runs, 5);

  const unmarked = legacyBaseline();
  delete unmarked.migration;
  assert.throws(
    () => compareTauriPerformance(unmarked, candidate, {
      minStartupGain: 30,
      minMemoryGain: 10,
    }),
    /historical d034943 migration marker/,
  );

  const wrongMarker = legacyBaseline();
  wrongMarker.migration.id = 'some-other-baseline';
  assert.throws(
    () => compareTauriPerformance(wrongMarker, candidate, {
      minStartupGain: 30,
      minMemoryGain: 10,
    }),
    /historical d034943 migration marker/,
  );

  const tamperedFingerprint = 'f'.repeat(64);
  const tamperedMarker = legacyBaseline();
  tamperedMarker.migration.hostFingerprint = tamperedFingerprint;
  const matchingTamperedCandidate = measurement({
    targetFileOpenedMs: 3_717,
    rssBytes: 1_038_739_046,
    fingerprint: tamperedFingerprint,
  });
  assert.throws(
    () => compareTauriPerformance(tamperedMarker, matchingTamperedCandidate, {
      minStartupGain: 30,
      minMemoryGain: 10,
    }),
    /historical d034943 migration marker/,
  );
});

test('historical migration binds the exact strict legacy measurement contents', () => {
  assert.equal(
    HISTORICAL_BASELINE_MIGRATION.measurementSha256,
    '4be0515d823807c82d4d4e8c70319e503d98a17230c3e740be14c2322d38e004',
  );
  const candidate = measurement({ targetFileOpenedMs: 3_717, rssBytes: 1_038_739_046 });
  const mutations = [
    ['run contents', baseline => { baseline.runs[0].startupReport.milestones.plugins_ready += 1; }],
    ['median', baseline => { baseline.median.processCount += 1; }],
    ['timestamp', baseline => { baseline.runs[0].metrics.rootIdentity.startedAt += 1; }],
    ['extra field', baseline => { baseline.unexpected = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const baseline = legacyBaseline();
    mutate(baseline);
    assert.throws(
      () => compareTauriPerformance(baseline, candidate, {
        minStartupGain: 30,
        minMemoryGain: 10,
      }),
      /historical.*(?:digest|contents)|unexpected field|reported median/i,
      label,
    );
  }
});

test('checked-in historical baseline carries the one-time migration marker', () => {
  const baseline = legacyBaseline();
  assert.deepEqual(baseline.migration, HISTORICAL_BASELINE_MIGRATION);
  assert.equal(Object.hasOwn(baseline, 'executable'), false);
  assert.doesNotMatch(JSON.stringify(baseline), /ride-open-with-startup-target|"commandLine"/i);
});

test('package script pins the historical baseline and required gains', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'package.json',
  ), 'utf8'));
  assert.equal(
    packageJson.scripts['check:tauri-performance'],
    'node scripts/check-tauri-performance.mjs --baseline applications/tauri/perf/baselines/pre-optimization-windows-x64-d034943.json --min-startup-gain 30 --min-memory-gain 10',
  );
});
