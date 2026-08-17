/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import fs from 'node:fs';
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

function roleMetrics(rssBytes) {
  return Object.fromEntries(ROLES.map(role => [role, role === 'main'
    ? { processCount: 1, rssBytes }
    : { processCount: 0, rssBytes: 0 }]));
}

function startupRun(targetFileOpenedMs, rssBytes, pid) {
  return {
    startupReport: {
      schema: 'ride.startup-report',
      version: 1,
      platform: 'windows',
      arch: 'x86_64',
      pid,
      milestones: {
        process_started: 0,
        native_window_visible: 100,
        backend_spawned: 120,
        backend_listening: 500,
        frontend_shell_attached: 1_000,
        target_file_opened: targetFileOpenedMs,
        plugins_started: targetFileOpenedMs + 10,
        plugins_ready: targetFileOpenedMs + 20,
      },
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
  fingerprint = 'a'.repeat(64),
  commit = '0123456789abcdef0123456789abcdef01234567',
} = {}) {
  const samples = Array.from(
    { length: runs },
    (_, index) => startupRun(targetFileOpenedMs, rssBytes, 7_300 + index),
  );
  return {
    schema: 'ride.startup-measurement',
    version: 2,
    platform,
    arch,
    executable: 'C:\\Program Files\\R-IDE\\ride-tauri.exe',
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

function legacyBaseline() {
  const targetFileOpenedMs = 5_310;
  const rssBytes = 1_154_154_496;
  return {
    schema: 'ride.startup-measurement',
    version: 1,
    platform: 'win32',
    arch: 'x64',
    executable: 'C:\\historical\\ride-tauri.exe',
    commit: 'd034943b7a6094808b2ffe56eea2b41c3666b613',
    migration: {
      ...HISTORICAL_BASELINE_MIGRATION,
      hostFingerprint: 'a'.repeat(64),
    },
    runs: Array.from(
      { length: 5 },
      (_, index) => startupRun(targetFileOpenedMs, rssBytes, 8_300 + index),
    ).map(run => ({
      startupReport: run.startupReport,
      metrics: {
        processCount: run.metrics.processCount,
        rssBytes: run.metrics.rssBytes,
      },
    })),
    median: { targetFileOpenedMs, rssBytes, processCount: 1 },
  };
}

test('accepts exactly five compatible v2 runs at the fixed gain thresholds', () => {
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

test('rejects missing build identity and non-strict v2 role data', () => {
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
});

test('checked-in historical baseline carries the one-time migration marker', () => {
  const baselinePath = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'applications',
    'tauri',
    'perf',
    'baselines',
    'pre-optimization-windows-x64-d034943.json',
  );
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.deepEqual(
    Object.fromEntries(Object.entries(baseline.migration ?? {}).filter(([key]) => key !== 'hostFingerprint')),
    HISTORICAL_BASELINE_MIGRATION,
  );
  assert.match(baseline.migration.hostFingerprint, /^[0-9a-f]{64}$/);
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
