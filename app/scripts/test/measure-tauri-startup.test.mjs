/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateProcessTree,
  attachBoundedLogCapture,
  captureProcessIdentity,
  createBoundedLogSink,
  discoverExecutable,
  filterSpawnEnvironment,
  launchMeasuredProcess,
  measureOnce,
  median,
  parsePosixProcessTable,
  parseStartupReport,
  parseWindowsProcessTable,
  planProcessCleanup,
  runMeasurementCampaign,
  redactDiagnosticText,
  startProcessTreeMonitor,
  terminateMeasuredTree,
  waitForStartupReport,
} from '../measure-tauri-startup.mjs';

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ride-measure-${label}-`));
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture');
}

function assertNoSensitiveWindows(output, secret, windowLength = 16) {
  for (let index = 0; index <= secret.length - windowLength; index++) {
    assert.equal(
      output.includes(secret.slice(index, index + windowLength)),
      false,
      `secret window at offset ${index} must not be present`,
    );
  }
}

function currentRustTarget() {
  const platforms = { win32: 'windows', darwin: 'macos', linux: 'linux' };
  const architectures = { x64: 'x86_64', arm64: 'aarch64' };
  return {
    platform: platforms[process.platform],
    arch: architectures[process.arch],
  };
}

function startupReport(milestones, overrides = {}) {
  const target = currentRustTarget();
  return {
    schema: 'ride.startup-report',
    version: 1,
    platform: target.platform,
    arch: target.arch,
    pid: 7331,
    milestones,
    ...overrides,
  };
}

const targetMilestones = {
  process_started: 0,
  native_window_visible: 5,
  backend_spawned: 10,
  backend_listening: 20,
  frontend_shell_attached: 30,
  target_file_opened: 42,
};

const finalMilestones = {
  ...targetMilestones,
  plugins_started: 50,
  plugins_ready: 60,
};

test('discovers runnable Windows binary without selecting installers', () => {
  const root = temporaryDirectory('windows');
  try {
    touch(path.join(root, 'release', 'bundle', 'nsis', 'R-IDE_1.0_x64-setup.exe'));
    touch(path.join(root, 'release', 'bundle', 'msi', 'R-IDE_1.0_x64_en-US.msi'));
    const executable = path.join(root, 'release', 'ride-tauri.exe');
    touch(executable);

    assert.equal(discoverExecutable(root, 'win32'), executable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers the macOS app payload rather than a DMG', () => {
  const root = temporaryDirectory('macos');
  try {
    touch(path.join(root, 'release', 'bundle', 'dmg', 'R-IDE_1.0_aarch64.dmg'));
    const executable = path.join(
      root,
      'release',
      'bundle',
      'macos',
      'R-IDE.app',
      'Contents',
      'MacOS',
      'R-IDE',
    );
    touch(executable);

    assert.equal(discoverExecutable(root, 'darwin'), executable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('discovers a runnable Linux release before package archives', () => {
  const root = temporaryDirectory('linux');
  try {
    touch(path.join(root, 'release', 'bundle', 'deb', 'r-ide_1.0_amd64.deb'));
    touch(path.join(root, 'release', 'bundle', 'appimage', 'R-IDE_1.0_amd64.AppImage'));
    const executable = path.join(root, 'release', 'ride-tauri');
    touch(executable);

    assert.equal(discoverExecutable(root, 'linux'), executable);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every synchronous external command has explicit timeout and buffer bounds', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'measure-tauri-startup.mjs'),
    'utf8',
  );
  const boundedCall = (start, end, label) => {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    assert.ok(startIndex >= 0 && endIndex > startIndex, `expected ${label} source block`);
    const block = source.slice(startIndex, endIndex);
    assert.match(block, /timeout:\s*[A-Z0-9_]+|timeout:\s*\d+/, `${label} needs a timeout`);
    assert.match(block, /maxBuffer:\s*[A-Z0-9_]+|maxBuffer:\s*\d+/, `${label} needs maxBuffer`);
    return block;
  };

  boundedCall("spawnSync(\n      'powershell.exe'", 'return parseWindowsProcessTable', 'CIM query');
  const psQuery = boundedCall("spawnSync('ps'", 'return parsePosixProcessTable', 'ps query');
  assert.match(psQuery, /LANG:\s*'C'/);
  assert.match(psQuery, /LC_ALL:\s*'C'/);
  boundedCall('run = (command, args) => spawnSync', 'kill = (pid, signal)', 'taskkill command');
  boundedCall("execFileSync('git'", '}).trim()', 'git revision query');
});

test('owned diagnostics are lstat-checked before reading their ownership sentinel', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'measure-tauri-startup.mjs'),
    'utf8',
  );
  const start = source.indexOf('async function clearPreviousCampaignArtifacts');
  const end = source.indexOf('\nasync function readOptionalStartupReport', start);
  assert.ok(start >= 0 && end > start, 'expected previous campaign cleanup source block');
  const cleanup = source.slice(start, end);
  const lstat = cleanup.indexOf('fs.promises.lstat(candidate)');
  const sentinelRead = cleanup.indexOf('path.join(candidate, DIAGNOSTICS_OWNER_FILE)');
  assert.ok(lstat >= 0 && sentinelRead >= 0, 'expected directory and sentinel checks');
  assert.ok(lstat < sentinelRead, 'lstat must reject symlinks before reading a sentinel');
});

test('startup report parser accepts the strict incremental schema', () => {
  const linuxTarget = { expectedPlatform: 'linux', expectedArch: 'x86_64', phase: 'target' };
  const report = parseStartupReport(JSON.stringify({
    schema: 'ride.startup-report',
    version: 1,
    platform: 'linux',
    arch: 'x86_64',
    pid: 412,
    milestones: {
      process_started: 0,
      native_window_visible: 5,
      backend_spawned: 10,
      backend_listening: 20,
      frontend_shell_attached: 30,
      target_file_opened: 42,
    },
  }), linuxTarget);

  assert.equal(report.milestones.target_file_opened, 42);
  assert.throws(
    () => parseStartupReport(JSON.stringify({ ...report, outputPath: '/tmp/injected' }), linuxTarget),
    /unexpected report field outputPath/,
  );
  assert.throws(
    () => parseStartupReport(JSON.stringify({
      ...report,
      milestones: { process_started: 0, invented: 1 },
    }), linuxTarget),
    /unexpected milestone invented/,
  );
  assert.throws(
    () => parseStartupReport(JSON.stringify({
      ...report,
      milestones: {
        process_started: 10,
        native_window_visible: 9,
        backend_spawned: 12,
        backend_listening: 20,
        frontend_shell_attached: 30,
        target_file_opened: 42,
      },
    }), linuxTarget),
    /not monotonic/,
  );
  assert.throws(() => parseStartupReport('{'), /valid JSON/);
});

test('startup report parser rejects unsupported or mismatched platform and architecture values', () => {
  assert.throws(
    () => parseStartupReport(JSON.stringify(startupReport(targetMilestones, {
      platform: 'not-a-platform'
    }))),
    /unsupported startup report platform/,
  );
  assert.throws(
    () => parseStartupReport(JSON.stringify(startupReport(targetMilestones, {
      arch: 'mips64'
    }))),
    /unsupported startup report architecture/,
  );

  const current = currentRustTarget();
  const otherPlatform = current.platform === 'windows' ? 'linux' : 'windows';
  const otherArch = current.arch === 'x86_64' ? 'aarch64' : 'x86_64';
  assert.throws(
    () => parseStartupReport(JSON.stringify(startupReport(targetMilestones, {
      platform: otherPlatform
    }))),
    /does not match expected/,
  );
  assert.throws(
    () => parseStartupReport(JSON.stringify(startupReport(targetMilestones, {
      arch: otherArch
    }))),
    /does not match expected/,
  );
});

test('target and final report phases require complete canonical milestone prefixes', () => {
  assert.throws(
    () => parseStartupReport(JSON.stringify(startupReport({
      process_started: 0,
      backend_spawned: 10,
      backend_listening: 20,
      frontend_shell_attached: 30,
      target_file_opened: 42,
    }))),
    /canonical milestone prefix/,
  );
  assert.throws(
    () => parseStartupReport(JSON.stringify(startupReport({
      backend_spawned: 10,
      process_started: 0,
      native_window_visible: 5,
      backend_listening: 20,
      frontend_shell_attached: 30,
      target_file_opened: 42,
    }))),
    /canonical milestone prefix/,
  );
  assert.throws(
    () => parseStartupReport(
      JSON.stringify(startupReport(targetMilestones)),
      { phase: 'final' },
    ),
    /complete final milestone sequence/,
  );
  assert.equal(
    parseStartupReport(
      JSON.stringify(startupReport(finalMilestones)),
      { phase: 'final' },
    ).milestones.plugins_ready,
    60,
  );
});

test('report waiter tolerates canonical partial snapshots until the target prefix is complete', async () => {
  const root = temporaryDirectory('incremental-report');
  const reportPath = path.join(root, 'startup.json');
  fs.writeFileSync(reportPath, JSON.stringify(startupReport({ process_started: 0 })));
  const update = setTimeout(() => {
    const replacement = path.join(root, 'startup.next.json');
    fs.writeFileSync(replacement, JSON.stringify(startupReport(targetMilestones)));
    fs.rmSync(reportPath, { force: true });
    fs.renameSync(replacement, reportPath);
  }, 10);
  try {
    const report = await waitForStartupReport(reportPath, { timeoutMs: 1_000, pollMs: 1 });
    assert.equal(report.milestones.target_file_opened, 42);
  } finally {
    clearTimeout(update);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('median handles odd and even samples without mutating input', () => {
  const values = [9, 1, 5, 3];
  assert.equal(median(values), 4);
  assert.deepEqual(values, [9, 1, 5, 3]);
  assert.equal(median([7, 3, 5]), 5);
  assert.equal(median([1, 2]), 1.5);
  assert.throws(() => median([]), /at least one/);
});

test('RSS conversion, aggregation, and median reject unsafe integer arithmetic', () => {
  const unsafeRssKiB = Math.floor(Number.MAX_SAFE_INTEGER / 1024) + 1;
  assert.throws(
    () => parsePosixProcessTable(`10 1 10 ${unsafeRssKiB} Sat Aug 15 12:34:56 2026`),
    /RSS bytes.*safe integer/,
  );
  assert.throws(
    () => aggregateProcessTree([
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        rssBytes: Number.MAX_SAFE_INTEGER,
        creationTime: 'root-start',
        startedAt: 1_000,
      },
      {
        pid: 11,
        ppid: 10,
        pgid: 10,
        rssBytes: 1,
        creationTime: 'child-start',
        startedAt: 1_000,
      },
    ], { pid: 10, pgid: 10, creationTime: 'root-start', startedAt: 1_000 }),
    /aggregate RSS.*safe integer/,
  );
  assert.throws(() => median([Number.MAX_SAFE_INTEGER + 1]), /safe integers/);
  assert.throws(
    () => median([Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER]),
    /safe integer median/,
  );
});

test('parses POSIX ps and Windows PowerShell process table fixtures', () => {
  assert.deepEqual(
    parsePosixProcessTable(`
       10     1    10  2048 Sat Aug 15 12:34:56 2026
       11    10    10  1024 Sat Aug 15 12:34:57 2026
       99     1    99   512 Sat Aug 15 12:35:00 2026
    `),
    [
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        rssBytes: 2_097_152,
        creationTime: 'Sat Aug 15 12:34:56 2026',
        startedAt: Date.parse('Sat Aug 15 12:34:56 2026'),
      },
      {
        pid: 11,
        ppid: 10,
        pgid: 10,
        rssBytes: 1_048_576,
        creationTime: 'Sat Aug 15 12:34:57 2026',
        startedAt: Date.parse('Sat Aug 15 12:34:57 2026'),
      },
      {
        pid: 99,
        ppid: 1,
        pgid: 99,
        rssBytes: 524_288,
        creationTime: 'Sat Aug 15 12:35:00 2026',
        startedAt: Date.parse('Sat Aug 15 12:35:00 2026'),
      },
    ],
  );

  assert.deepEqual(
    parseWindowsProcessTable(JSON.stringify([
      {
        ProcessId: 0,
        ParentProcessId: 0,
        WorkingSetSize: 8_192,
        CreationDate: '20260815120000.000000+480',
      },
      {
        ProcessId: 10,
        ParentProcessId: 1,
        WorkingSetSize: 2_000,
        CreationDate: '20260815123456.000000+480',
      },
      {
        ProcessId: 11,
        ParentProcessId: 10,
        WorkingSetSize: 3_000,
        CreationDate: '20260815123457.000000+480',
      },
    ])),
    [
      {
        pid: 10,
        ppid: 1,
        pgid: null,
        rssBytes: 2_000,
        creationTime: '20260815123456.000000+480',
        startedAt: Date.UTC(2026, 7, 15, 4, 34, 56),
      },
      {
        pid: 11,
        ppid: 10,
        pgid: null,
        rssBytes: 3_000,
        creationTime: '20260815123457.000000+480',
        startedAt: Date.UTC(2026, 7, 15, 4, 34, 57),
      },
    ],
  );
});

test('process table parsers preserve comparable creation chronology and reject malformed clocks', () => {
  const windowsRows = parseWindowsProcessTable(JSON.stringify([
    {
      ProcessId: 10,
      ParentProcessId: 1,
      WorkingSetSize: 1,
      CreationDate: '20260815123456.123456-300',
    },
    {
      ProcessId: 11,
      ParentProcessId: 10,
      WorkingSetSize: 1,
      CreationDate: '/Date(1786765431765)/',
    },
    {
      ProcessId: 12,
      ParentProcessId: 10,
      WorkingSetSize: 1,
      CreationDate: 'not-a-date',
    },
    {
      ProcessId: 13,
      ParentProcessId: 10,
      WorkingSetSize: 1,
      CreationDate: '9999',
    },
    {
      ProcessId: 14,
      ParentProcessId: 10,
      WorkingSetSize: 1,
      CreationDate: '2026-08-15T12:34:56.789+08:00',
    },
    {
      ProcessId: 15,
      ParentProcessId: 10,
      WorkingSetSize: 1,
      CreationDate: '08/15/2026 12:34:56',
    },
    {
      ProcessId: 16,
      ParentProcessId: 10,
      WorkingSetSize: 1,
      CreationDate: '2026-08-15T12:34:56',
    },
  ]));
  assert.equal(windowsRows[0].startedAt, Date.UTC(2026, 7, 15, 17, 34, 56, 123));
  assert.equal(windowsRows[1].startedAt, 1_786_765_431_765);
  assert.equal(windowsRows[2].startedAt, null);
  assert.equal(windowsRows[3].startedAt, null);
  assert.equal(windowsRows[4].startedAt, Date.UTC(2026, 7, 15, 4, 34, 56, 789));
  assert.equal(windowsRows[5].startedAt, null);
  assert.equal(windowsRows[6].startedAt, null);

  const posixRows = parsePosixProcessTable(`
    20 1 20 1 Sat Aug 15 12:34:56 2026
    21 20 20 1 malformed timestamp
    22 20 20 1 2026-08-15
  `);
  assert.equal(posixRows[0].startedAt, Date.parse('Sat Aug 15 12:34:56 2026'));
  assert.equal(posixRows[1].startedAt, null);
  assert.equal(posixRows[2].startedAt, null);

  const malformedCleanupRows = parseWindowsProcessTable(JSON.stringify([
    {
      ProcessId: 100,
      ParentProcessId: 1,
      WorkingSetSize: 1,
      CreationDate: '20260815123456.000000+000',
    },
    {
      ProcessId: 101,
      ParentProcessId: 100,
      WorkingSetSize: 1,
      CreationDate: '9999',
    },
  ]));
  assert.deepEqual(planProcessCleanup(
    malformedCleanupRows,
    {
      pid: 100,
      pgid: null,
      creationTime: malformedCleanupRows[0].creationTime,
      startedAt: malformedCleanupRows[0].startedAt,
    },
  ), {
    mode: 'pids',
    rootPid: 100,
    pgid: null,
    processIds: [100],
  });
});

test('process aggregation includes only verified descendants of the spawned root', () => {
  const rows = [
    { pid: 100, ppid: 1, pgid: 100, rssBytes: 10, creationTime: 'root-start', startedAt: 1_000 },
    { pid: 101, ppid: 100, pgid: 100, rssBytes: 20, creationTime: 'child-start', startedAt: 1_000 },
    { pid: 102, ppid: 101, pgid: 100, rssBytes: 30, creationTime: 'grandchild-start', startedAt: 2_000 },
    { pid: 200, ppid: 1, pgid: 200, rssBytes: 1_000, creationTime: 'other-start', startedAt: 1_000 },
    { pid: 201, ppid: 200, pgid: 200, rssBytes: 2_000, creationTime: 'other-child-start', startedAt: 2_000 },
  ];
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start', startedAt: 1_000 };

  assert.deepEqual(aggregateProcessTree(rows, rootIdentity), {
    rootPid: 100,
    rootIdentity,
    processIds: [100, 101, 102],
    processCount: 3,
    rssBytes: 60,
    processes: [
      { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start', startedAt: 1_000, depth: 0 },
      { pid: 101, ppid: 100, pgid: 100, creationTime: 'child-start', startedAt: 1_000, depth: 1 },
      { pid: 102, ppid: 101, pgid: 100, creationTime: 'grandchild-start', startedAt: 2_000, depth: 2 },
    ],
  });
  assert.throws(
    () => aggregateProcessTree(rows, { ...rootIdentity, creationTime: 'reused-pid' }),
    /does not match its captured identity/,
  );
});

test('process aggregation rejects root-PID reuse edges and validates chronology at every level', () => {
  const rootIdentity = {
    pid: 100,
    pgid: null,
    creationTime: 'root-current',
    startedAt: 1_000,
  };
  const rows = [
    { pid: 100, ppid: 1, pgid: null, rssBytes: 10, creationTime: 'root-current', startedAt: 1_000 },
    { pid: 101, ppid: 100, pgid: null, rssBytes: 20, creationTime: 'old-child', startedAt: 900 },
    { pid: 102, ppid: 100, pgid: null, rssBytes: 30, creationTime: 'equal-child', startedAt: 1_000 },
    { pid: 103, ppid: 102, pgid: null, rssBytes: 40, creationTime: 'valid-grandchild', startedAt: 1_100 },
    { pid: 104, ppid: 103, pgid: null, rssBytes: 50, creationTime: 'older-great-grandchild', startedAt: 1_050 },
    { pid: 105, ppid: 103, pgid: null, rssBytes: 60, creationTime: 'malformed-child', startedAt: null },
    { pid: 106, ppid: 101, pgid: null, rssBytes: 70, creationTime: 'child-of-stale-parent', startedAt: 1_200 },
  ];

  const aggregate = aggregateProcessTree(rows, rootIdentity);
  assert.deepEqual(aggregate.processIds, [100, 102, 103]);
  assert.deepEqual(
    aggregate.processes.map(processRow => [processRow.pid, processRow.depth, processRow.startedAt]),
    [[100, 0, 1_000], [102, 1, 1_000], [103, 2, 1_100]],
  );
});

test('cleanup plans a whole tree only while the captured root identity still matches', () => {
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start', startedAt: 1_000 };
  const tracked = [
    { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start', startedAt: 1_000, depth: 0 },
    { pid: 101, ppid: 100, pgid: 100, creationTime: 'child-start', startedAt: 2_000, depth: 1 },
  ];

  assert.deepEqual(planProcessCleanup(tracked, rootIdentity, tracked), {
    mode: 'tree',
    rootPid: 100,
    pgid: 100,
    processIds: [],
  });
  assert.deepEqual(planProcessCleanup([], rootIdentity, tracked), {
    mode: 'pids',
    rootPid: 100,
    pgid: 100,
    processIds: [],
  });

  const reusedRoot = [
    { pid: 100, ppid: 1, pgid: 100, creationTime: 'reused-root', depth: 0 },
    { pid: 101, ppid: 100, pgid: 100, creationTime: 'child-start', depth: 1 },
  ];
  assert.deepEqual(planProcessCleanup(reusedRoot, rootIdentity, tracked), {
    mode: 'pids',
    rootPid: 100,
    pgid: 100,
    processIds: [101],
  });
});

test('cleanup excludes a tracked descendant whose PID has been reused', () => {
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start', startedAt: 1_000 };
  const tracked = [
    { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start', startedAt: 1_000, depth: 0 },
    { pid: 101, ppid: 100, pgid: 100, creationTime: 'child-start', startedAt: 2_000, depth: 1 },
    { pid: 102, ppid: 101, pgid: 100, creationTime: 'grandchild-start', startedAt: 3_000, depth: 2 },
  ];
  const current = [
    { pid: 101, ppid: 1, pgid: 101, creationTime: 'reused-child', startedAt: 4_000 },
    { pid: 102, ppid: 1, pgid: 100, creationTime: 'grandchild-start', startedAt: 3_000 },
  ];

  assert.deepEqual(planProcessCleanup(current, rootIdentity, tracked).processIds, [102]);
});

test('root identity capture polls briefly until the spawned PID appears', async () => {
  const rows = [
    { pid: 7331, ppid: 1, pgid: 7331, rssBytes: 100, creationTime: 'root-start' },
  ];
  let reads = 0;
  const identity = await captureProcessIdentity(7331, {
    platform: 'linux',
    timeoutMs: 100,
    pollMs: 1,
    read: () => (++reads === 1 ? [] : rows),
    delay: async () => undefined,
    now: (() => {
      let current = 0;
      return () => current += 10;
    })(),
  });

  assert.deepEqual(identity, { pid: 7331, pgid: 7331, creationTime: 'root-start' });
  assert.equal(reads, 2);
});

test('root identity capture always performs one verification read at an exhausted deadline', async () => {
  const identity = await captureProcessIdentity(7331, {
    platform: 'linux',
    timeoutMs: 0,
    pollMs: 1,
    read: () => [
      { pid: 7331, ppid: 1, pgid: 7331, rssBytes: 100, creationTime: 'root-start' },
    ],
    delay: async () => undefined,
    now: (() => {
      let current = 0;
      return () => ++current;
    })(),
  });

  assert.equal(identity.creationTime, 'root-start');
});

test('root identity capture retries a transient process-table query failure', async () => {
  let reads = 0;
  const identity = await captureProcessIdentity(7331, {
    platform: 'linux',
    timeoutMs: 100,
    pollMs: 1,
    read: () => {
      if (++reads === 1) {
        throw new Error('transient ps failure');
      }
      return [
        { pid: 7331, ppid: 1, pgid: 7331, rssBytes: 100, creationTime: 'root-start' },
      ];
    },
    delay: async () => undefined,
    now: (() => {
      let current = 0;
      return () => current += 10;
    })(),
  });

  assert.equal(identity.creationTime, 'root-start');
  assert.equal(reads, 2);
});

test('process tree monitor accumulates identities and releases its timer and exit listener', async () => {
  const child = new EventEmitter();
  child.pid = 100;
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start', startedAt: 1_000 };
  let rows = [
    { pid: 100, ppid: 1, pgid: 100, rssBytes: 10, creationTime: 'root-start', startedAt: 1_000 },
    { pid: 101, ppid: 100, pgid: 100, rssBytes: 20, creationTime: 'backend-start', startedAt: 2_000 },
  ];
  let scheduled;
  let cancelled = false;
  let reads = 0;
  const monitor = startProcessTreeMonitor(rootIdentity, {
    child,
    platform: 'linux',
    read: () => {
      reads++;
      return rows;
    },
    schedule: callback => {
      scheduled = callback;
      return { unref() {} };
    },
    cancel: () => {
      cancelled = true;
    },
  });
  rows = [
    { pid: 101, ppid: 1, pgid: 100, rssBytes: 20, creationTime: 'backend-start', startedAt: 2_000 },
  ];
  scheduled();
  child.emit('exit');

  const tracked = await monitor.stop();
  assert.deepEqual(tracked.map(processRow => processRow.pid), [100, 101]);
  assert.equal(cancelled, true);
  assert.equal(child.listenerCount('exit'), 0);
  const readsAfterStop = reads;
  scheduled();
  assert.equal(reads, readsAfterStop, 'stopped monitor must not poll again');
  assert.deepEqual(await monitor.stop(), tracked, 'stopping the monitor is idempotent');
  assert.equal(reads, readsAfterStop, 'repeated stop must not query the process table');
});

test('process tree monitor never seeds discovery from a missing root PID', async () => {
  const child = new EventEmitter();
  child.pid = 100;
  let rows = [
    { pid: 100, ppid: 1, pgid: null, rssBytes: 10, creationTime: 'root-start', startedAt: 1_000 },
  ];
  let scheduled;
  const monitor = startProcessTreeMonitor(
    { pid: 100, pgid: null, creationTime: 'root-start', startedAt: 1_000 },
    {
      child,
      platform: 'win32',
      read: () => rows,
      schedule: callback => {
        scheduled = callback;
        return { unref() {} };
      },
      cancel: () => undefined,
    },
  );
  rows = [
    { pid: 900, ppid: 100, pgid: null, rssBytes: 20, creationTime: 'unrelated-start', startedAt: 2_000 },
  ];
  scheduled();

  const tracked = await monitor.stop();
  assert.deepEqual(tracked.map(processRow => processRow.pid), [100]);
});

test('process tree monitor follows identity-matched tracked descendants after root exit', async () => {
  const child = new EventEmitter();
  child.pid = 100;
  let rows = [
    { pid: 100, ppid: 1, pgid: null, rssBytes: 10, creationTime: 'root-start', startedAt: 1_000 },
    { pid: 101, ppid: 100, pgid: null, rssBytes: 20, creationTime: 'backend-start', startedAt: 2_000 },
  ];
  let scheduled;
  const monitor = startProcessTreeMonitor(
    { pid: 100, pgid: null, creationTime: 'root-start', startedAt: 1_000 },
    {
      child,
      platform: 'win32',
      read: () => rows,
      schedule: callback => {
        scheduled = callback;
        return { unref() {} };
      },
      cancel: () => undefined,
    },
  );
  rows = [
    { pid: 101, ppid: 1, pgid: null, rssBytes: 20, creationTime: 'backend-start', startedAt: 2_000 },
    { pid: 102, ppid: 101, pgid: null, rssBytes: 30, creationTime: 'worker-start', startedAt: 3_000 },
  ];
  scheduled();

  const tracked = await monitor.stop();
  assert.deepEqual(tracked.map(processRow => processRow.pid), [100, 101, 102]);
});

test('POSIX monitor does not adopt an untracked process from the old root group', async () => {
  const child = new EventEmitter();
  child.pid = 100;
  let rows = [
    { pid: 100, ppid: 1, pgid: 100, rssBytes: 10, creationTime: 'root-start', startedAt: 1_000 },
    { pid: 101, ppid: 100, pgid: 100, rssBytes: 20, creationTime: 'backend-start', startedAt: 2_000 },
  ];
  let scheduled;
  const monitor = startProcessTreeMonitor(
    { pid: 100, pgid: 100, creationTime: 'root-start', startedAt: 1_000 },
    {
      child,
      platform: 'linux',
      read: () => rows,
      schedule: callback => {
        scheduled = callback;
        return { unref() {} };
      },
      cancel: () => undefined,
    },
  );
  rows = [
    { pid: 101, ppid: 1, pgid: 100, rssBytes: 20, creationTime: 'backend-start', startedAt: 2_000 },
    { pid: 102, ppid: 101, pgid: 100, rssBytes: 30, creationTime: 'worker-start', startedAt: 3_000 },
    { pid: 900, ppid: 1, pgid: 100, rssBytes: 40, creationTime: 'unrelated-start', startedAt: 2_000 },
  ];
  scheduled();

  const tracked = await monitor.stop();
  assert.deepEqual(tracked.map(processRow => processRow.pid), [100, 101, 102]);
});

test('process tree monitor never seeds discovery from a reused tracked descendant PID', async () => {
  const child = new EventEmitter();
  child.pid = 100;
  let rows = [
    { pid: 100, ppid: 1, pgid: null, rssBytes: 10, creationTime: 'root-start', startedAt: 1_000 },
    { pid: 101, ppid: 100, pgid: null, rssBytes: 20, creationTime: 'backend-start', startedAt: 2_000 },
  ];
  let scheduled;
  const monitor = startProcessTreeMonitor(
    { pid: 100, pgid: null, creationTime: 'root-start', startedAt: 1_000 },
    {
      child,
      platform: 'win32',
      read: () => rows,
      schedule: callback => {
        scheduled = callback;
        return { unref() {} };
      },
      cancel: () => undefined,
    },
  );
  rows = [
    { pid: 101, ppid: 100, pgid: null, rssBytes: 20, creationTime: 'reused-backend', startedAt: 4_000 },
    { pid: 102, ppid: 101, pgid: null, rssBytes: 30, creationTime: 'untrusted-worker', startedAt: 5_000 },
  ];
  scheduled();

  const tracked = await monitor.stop();
  assert.deepEqual(tracked.map(processRow => processRow.pid), [100, 101]);
  assert.equal(tracked.find(processRow => processRow.pid === 101).creationTime, 'backend-start');
});

test('process tree monitor rejects stale edges and never expands from an unparseable tracked clock', async () => {
  const child = new EventEmitter();
  child.pid = 100;
  const rootIdentity = {
    pid: 100,
    pgid: null,
    creationTime: 'root-current',
    startedAt: 1_000,
  };
  let rows = [
    { pid: 100, ppid: 1, pgid: null, rssBytes: 1, creationTime: 'root-current', startedAt: 1_000 },
    { pid: 101, ppid: 100, pgid: null, rssBytes: 1, creationTime: 'tracked-child', startedAt: 2_000 },
    { pid: 900, ppid: 100, pgid: null, rssBytes: 1, creationTime: 'old-stale-child', startedAt: 900 },
  ];
  let scheduled;
  const monitor = startProcessTreeMonitor(rootIdentity, {
    child,
    platform: 'win32',
    read: () => rows,
    schedule: callback => {
      scheduled = callback;
      return { unref() {} };
    },
    cancel: () => undefined,
  });

  rows = [
    { pid: 101, ppid: 1, pgid: null, rssBytes: 1, creationTime: 'tracked-child', startedAt: null },
    { pid: 102, ppid: 101, pgid: null, rssBytes: 1, creationTime: 'untrusted-grandchild', startedAt: 3_000 },
  ];
  scheduled();

  const tracked = await monitor.stop();
  assert.deepEqual(tracked.map(processRow => processRow.pid), [100, 101]);
  assert.equal(tracked.some(processRow => processRow.pid === 900), false);
  assert.equal(tracked.some(processRow => processRow.pid === 102), false);
});

test('cleanup query failure falls back only to the still-owned child handle', async () => {
  const events = [];
  const child = {
    pid: 100,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      events.push(`child:${signal}`);
      this.killed = true;
      return true;
    },
  };
  await terminateMeasuredTree({
    child,
    rootPid: 100,
    rootIdentity: { pid: 100, pgid: 100, creationTime: 'root-start' },
    trackedProcesses: [
      { pid: 101, ppid: 100, pgid: 100, creationTime: 'backend-start', depth: 1 },
    ],
  }, 'linux', {
    read: () => {
      throw new Error('ps unavailable');
    },
    run: () => events.push('taskkill'),
    kill: () => events.push('bare-pid'),
    delay: async () => undefined,
  });

  assert.deepEqual(events, ['child:SIGTERM', 'child:SIGKILL']);
});

test('process tree monitor refuses to expand after the root PID is reused', async () => {
  const child = new EventEmitter();
  child.pid = 100;
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start' };
  let rows = [
    { pid: 100, ppid: 1, pgid: 100, rssBytes: 10, creationTime: 'root-start' },
  ];
  let scheduled;
  const monitor = startProcessTreeMonitor(rootIdentity, {
    child,
    platform: 'linux',
    read: () => rows,
    schedule: callback => {
      scheduled = callback;
      return { unref() {} };
    },
    cancel: () => undefined,
  });
  rows = [
    { pid: 100, ppid: 1, pgid: 100, rssBytes: 10, creationTime: 'reused-root' },
    { pid: 101, ppid: 100, pgid: 100, rssBytes: 20, creationTime: 'untrusted-backend' },
  ];
  scheduled();

  const tracked = await monitor.stop();
  assert.deepEqual(tracked.map(processRow => processRow.pid), [100]);
});

test('explicit cleanup revalidates identity immediately before every kill', async () => {
  const rootIdentity = { pid: 100, pgid: null, creationTime: 'root-start', startedAt: 1_000 };
  const tracked = [
    { pid: 101, ppid: 100, pgid: null, creationTime: 'backend-start', startedAt: 2_000, depth: 1 },
  ];
  let reads = 0;
  const commands = [];
  await terminateMeasuredTree({
    rootPid: 100,
    rootIdentity,
    trackedProcesses: tracked,
  }, 'win32', {
    read: () => {
      reads++;
      return reads === 1
        ? [{ pid: 101, ppid: 1, pgid: null, creationTime: 'backend-start', startedAt: 2_000 }]
        : [{ pid: 101, ppid: 1, pgid: null, creationTime: 'reused-backend', startedAt: 3_000 }];
    },
    run: (command, args) => commands.push([command, ...args]),
    delay: async () => undefined,
  });

  assert.equal(reads, 2);
  assert.deepEqual(commands, []);
});

test('tree termination rechecks identity and never targets a reused root or descendant PID', async () => {
  const rootIdentity = { pid: 100, pgid: null, creationTime: 'root-start', startedAt: 1_000 };
  const tracked = [
    { pid: 100, ppid: 1, pgid: null, creationTime: 'root-start', startedAt: 1_000, depth: 0 },
    { pid: 101, ppid: 100, pgid: null, creationTime: 'child-start', startedAt: 2_000, depth: 1 },
    { pid: 102, ppid: 101, pgid: null, creationTime: 'grandchild-start', startedAt: 3_000, depth: 2 },
  ];
  const commands = [];

  await terminateMeasuredTree({
    rootPid: rootIdentity.pid,
    rootIdentity,
    trackedProcesses: tracked,
  }, 'win32', {
    read: () => [
      { pid: 100, ppid: 1, pgid: null, creationTime: 'reused-root', startedAt: 4_000 },
      { pid: 101, ppid: 1, pgid: null, creationTime: 'reused-child', startedAt: 4_000 },
      { pid: 102, ppid: 1, pgid: null, creationTime: 'grandchild-start', startedAt: 3_000 },
    ],
    run: (command, args) => commands.push([command, ...args]),
    delay: async () => undefined,
  });

  assert.deepEqual(commands, [['taskkill.exe', '/PID', '102', '/F']]);
});

test('tree termination uses whole-tree cleanup when the captured root still matches', async () => {
  const rootIdentity = { pid: 100, pgid: null, creationTime: 'root-start', startedAt: 1_000 };
  const commands = [];
  await terminateMeasuredTree({
    rootPid: rootIdentity.pid,
    rootIdentity,
  }, 'win32', {
    read: () => [
      { pid: 100, ppid: 1, pgid: null, creationTime: 'root-start', startedAt: 1_000 },
    ],
    run: (command, args) => commands.push([command, ...args]),
    delay: async () => undefined,
  });

  assert.deepEqual(commands, [['taskkill.exe', '/PID', '100', '/T', '/F']]);
});

test('Windows cleanup never lets taskkill tree expansion reach a child older than the root', async () => {
  const rootIdentity = {
    pid: 100,
    pgid: null,
    creationTime: 'root-current',
    startedAt: 1_000,
  };
  const rows = [
    { pid: 100, ppid: 1, pgid: null, rssBytes: 1, creationTime: 'root-current', startedAt: 1_000 },
    { pid: 101, ppid: 100, pgid: null, rssBytes: 1, creationTime: 'stale-child', startedAt: 900 },
    { pid: 102, ppid: 100, pgid: null, rssBytes: 1, creationTime: 'owned-child', startedAt: 1_100 },
    { pid: 103, ppid: 100, pgid: null, rssBytes: 1, creationTime: 'malformed-child', startedAt: null },
  ];
  const commands = [];

  await terminateMeasuredTree({
    rootPid: rootIdentity.pid,
    rootIdentity,
    trackedProcesses: [
      { ...rows[0], depth: 0 },
      { ...rows[2], depth: 1 },
    ],
  }, 'win32', {
    read: () => rows,
    run: (command, args) => commands.push([command, ...args]),
    delay: async () => undefined,
  });

  assert.equal(commands.some(command => command.includes('/T')), false);
  assert.equal(commands.some(command => command.includes('101')), false);
  assert.equal(commands.some(command => command.includes('103')), false);
  assert.deepEqual(commands, [
    ['taskkill.exe', '/PID', '100', '/F'],
    ['taskkill.exe', '/PID', '102', '/F'],
  ]);
});

test('POSIX termination signals the verified process group after each identity read', async () => {
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start', startedAt: 1_000 };
  const rows = [
    { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start', startedAt: 1_000 },
  ];
  const signals = [];
  await terminateMeasuredTree({
    rootPid: rootIdentity.pid,
    rootIdentity,
  }, 'linux', {
    read: () => rows,
    kill: (pid, signal) => signals.push([pid, signal]),
    delay: async () => undefined,
  });

  assert.deepEqual(signals, [[-100, 'SIGTERM'], [-100, 'SIGKILL']]);
});

test('POSIX termination falls back bottom-up to identity-matched tracked descendants', async () => {
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start', startedAt: 1_000 };
  const tracked = [
    { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start', startedAt: 1_000, depth: 0 },
    { pid: 101, ppid: 100, pgid: 100, creationTime: 'child-start', startedAt: 2_000, depth: 1 },
    { pid: 102, ppid: 101, pgid: 100, creationTime: 'grandchild-start', startedAt: 3_000, depth: 2 },
  ];
  let reads = 0;
  const signals = [];
  await terminateMeasuredTree({
    rootPid: rootIdentity.pid,
    rootIdentity,
    trackedProcesses: tracked,
  }, 'linux', {
    read: () => {
      reads++;
      return reads === 1
        ? [
          { pid: 100, ppid: 1, pgid: 100, creationTime: 'reused-root', startedAt: 4_000 },
          { pid: 101, ppid: 1, pgid: 100, creationTime: 'child-start', startedAt: 2_000 },
          { pid: 102, ppid: 1, pgid: 100, creationTime: 'grandchild-start', startedAt: 3_000 },
        ]
        : [
          { pid: 101, ppid: 1, pgid: 101, creationTime: 'reused-child', startedAt: 4_000 },
          { pid: 102, ppid: 1, pgid: 100, creationTime: 'grandchild-start', startedAt: 3_000 },
        ];
    },
    kill: (pid, signal) => signals.push([pid, signal]),
    delay: async () => undefined,
  });

  assert.deepEqual(signals, [
    [102, 'SIGTERM'],
    [102, 'SIGKILL'],
  ]);
});

test('POSIX termination never sends a group signal when root is not the detached group leader', async () => {
  const rootIdentity = { pid: 100, pgid: 50, creationTime: 'root-start', startedAt: 1_000 };
  const tracked = [
    { pid: 100, ppid: 1, pgid: 50, creationTime: 'root-start', startedAt: 1_000, depth: 0 },
    { pid: 101, ppid: 100, pgid: 50, creationTime: 'child-start', startedAt: 2_000, depth: 1 },
  ];
  const signals = [];
  await terminateMeasuredTree({
    rootPid: rootIdentity.pid,
    rootIdentity,
    trackedProcesses: tracked,
  }, 'linux', {
    read: () => tracked,
    kill: (pid, signal) => signals.push([pid, signal]),
    delay: async () => undefined,
  });

  assert.deepEqual(signals, [
    [101, 'SIGTERM'],
    [100, 'SIGTERM'],
    [101, 'SIGKILL'],
    [100, 'SIGKILL'],
  ]);
  assert.equal(signals.some(([pid]) => pid < 0), false);
});

test('measurement timeout always terminates only the process tree it launched', async () => {
  const terminated = [];
  const sampled = [];
  const lifecycle = [];
  const rootIdentity = { pid: 7331, pgid: 7331, creationTime: 'root-start' };
  const child = { pid: 7331 };
  const monitoredBackend = {
    pid: 7442,
    ppid: 7331,
    pgid: 7331,
    creationTime: 'backend-start',
    depth: 1,
  };
  await assert.rejects(
    measureOnce(
      {
        executable: '/fixture/R-IDE',
        codeFile: '/fixture/startup.R',
        reportPath: '/fixture/report.json',
        idleMs: 0,
        timeoutMs: 1,
        pollMs: 1,
        cwd: '/fixture',
      },
      {
        launch: () => child,
        capture: async pid => {
          assert.equal(pid, 7331);
          return rootIdentity;
        },
        startMonitor: () => ({
          stop: async () => {
            lifecycle.push('monitor:stop');
            return [monitoredBackend];
          },
        }),
        waitForReport: async () => {
          throw new Error('startup report timeout');
        },
        delay: async () => undefined,
        sample: pid => {
          sampled.push(pid);
          return { rootPid: pid, processIds: [pid], processCount: 1, rssBytes: 1 };
        },
        terminate: async cleanup => {
          lifecycle.push('terminate');
          terminated.push(cleanup);
        },
      },
    ),
    /startup report timeout/,
  );
  assert.deepEqual(sampled, []);
  assert.deepEqual(lifecycle, ['monitor:stop', 'terminate']);
  assert.deepEqual(terminated, [{
    child,
    rootPid: 7331,
    rootIdentity,
    trackedProcesses: [monitoredBackend],
  }]);
});

test('capture failure safely terminates only the controlled child handle', async () => {
  const events = [];
  const child = {
    pid: 7331,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      events.push(`child:${signal}`);
      this.killed = true;
      this.exitCode = 0;
      return true;
    },
  };

  await assert.rejects(
    measureOnce(
      {
        executable: '/fixture/R-IDE',
        codeFile: '/fixture/startup.R',
        reportPath: '/fixture/report.json',
        idleMs: 0,
        timeoutMs: 1,
        pollMs: 1,
        cwd: '/fixture',
      },
      {
        launch: () => child,
        capture: async () => {
          throw new Error('identity capture failed');
        },
        waitForReport: async () => {
          throw new Error('must not wait for a report');
        },
        delay: async () => undefined,
        sample: () => {
          throw new Error('must not sample');
        },
        terminate: cleanup => terminateMeasuredTree(cleanup, 'win32', {
          read: () => {
            events.push('process-table');
            return [];
          },
          run: () => events.push('taskkill'),
          kill: () => events.push('bare-pid'),
          delay: async () => undefined,
        }),
      },
    ),
    /identity capture failed/,
  );

  assert.deepEqual(events, ['child:SIGTERM']);
});

test('capture failure force-stops a controlled child that ignores graceful termination', async () => {
  const signals = [];
  const child = {
    pid: 7331,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal);
      this.killed = true;
      return true;
    },
  };

  await terminateMeasuredTree({ child, rootPid: 7331 }, 'linux', {
    read: () => {
      throw new Error('identity-less cleanup must not read the process table');
    },
    run: () => {
      throw new Error('identity-less cleanup must not invoke taskkill');
    },
    kill: () => {
      throw new Error('identity-less cleanup must not signal a bare PID');
    },
    delay: async () => undefined,
  });

  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('identity-less cleanup rejects an unrelated or already-finished child handle', async () => {
  const events = [];
  for (const child of [
    {
      pid: 9000,
      killed: false,
      exitCode: null,
      signalCode: null,
      kill: () => events.push('wrong-pid'),
    },
    {
      pid: 7331,
      killed: false,
      exitCode: 0,
      signalCode: null,
      kill: () => events.push('finished'),
    },
  ]) {
    await terminateMeasuredTree({ child, rootPid: 7331 }, 'linux', {
      read: () => events.push('process-table'),
      run: () => events.push('taskkill'),
      kill: () => events.push('bare-pid'),
      delay: async () => undefined,
    });
  }

  assert.deepEqual(events, []);
});

test('measurement samples after idle and then rereads the complete final report', async () => {
  const early = startupReport(targetMilestones);
  const final = startupReport(finalMilestones);
  const phases = [];
  const events = [];
  const rootIdentity = { pid: 7331, pgid: 7331, creationTime: 'root-start' };
  const processes = [
    { pid: 7331, ppid: 1, pgid: 7331, creationTime: 'root-start', depth: 0 },
  ];

  const result = await measureOnce(
    {
      executable: '/fixture/R-IDE',
      codeFile: '/fixture/startup.R',
      reportPath: '/fixture/report.json',
      idleMs: 30_000,
      timeoutMs: 300_000,
      pollMs: 1,
      cwd: '/fixture',
    },
    {
      launch: () => ({
        pid: 7331,
        startupLogCapture: {
          persist: async () => events.push('logs:persist'),
        },
      }),
      capture: async pid => {
        events.push(`capture:${pid}`);
        return rootIdentity;
      },
      startMonitor: () => {
        events.push('monitor:start');
        return {
          stop: async () => {
            events.push('monitor:stop');
            return [];
          },
        };
      },
      waitForReport: async (_reportPath, options) => {
        phases.push(options.phase);
        return options.phase === 'final' ? final : early;
      },
      delay: async milliseconds => {
        events.push(`idle:${milliseconds}`);
      },
      sample: identity => {
        events.push(`sample:${identity.pid}:${identity.creationTime}`);
        return {
          rootPid: identity.pid,
          rootIdentity: identity,
          processIds: [identity.pid],
          processCount: 1,
          rssBytes: 123,
          processes,
        };
      },
      terminate: async cleanup => {
        events.push(`terminate:${cleanup.rootIdentity.pid}:${cleanup.trackedProcesses.length}`);
      },
      now: (() => {
        let now = 1_000;
        return () => now += 10;
      })(),
    },
  );

  assert.deepEqual(phases, ['target', 'final']);
  assert.deepEqual(events, [
    'capture:7331',
    'monitor:start',
    'idle:30000',
    'sample:7331:root-start',
    'monitor:stop',
    'terminate:7331:1',
    'logs:persist',
  ]);
  assert.equal(result.startupReport, final);
  assert.equal(result.startupReport.milestones.plugins_ready, 60);
});

test('measured process stdout and stderr are captured in per-run log files', async () => {
  const root = temporaryDirectory('process-logs');
  const script = path.join(root, 'fixture.cjs');
  const stdoutLogPath = path.join(root, 'stdout.log');
  const stderrLogPath = path.join(root, 'stderr.log');
  fs.writeFileSync(script, [
    "process.stdout.write('fixture stdout\\n');",
    "process.stderr.write('fixture stderr\\n');",
  ].join('\n'));

  try {
    const child = await launchMeasuredProcess({
      executable: process.execPath,
      codeFile: script,
      reportPath: path.join(root, 'report.json'),
      stdoutLogPath,
      stderrLogPath,
      cwd: root,
    });
    const stdoutErrorListenersBeforePersistence = child.stdout.listenerCount('error');
    const stderrErrorListenersBeforePersistence = child.stderr.listenerCount('error');
    await once(child, 'exit');
    await child.startupLogCapture.persist();
    assert.ok(
      stdoutErrorListenersBeforePersistence > 0,
      'stdout errors must be handled before diagnostic persistence begins',
    );
    assert.ok(
      stderrErrorListenersBeforePersistence > 0,
      'stderr errors must be handled before diagnostic persistence begins',
    );
    assert.equal(fs.readFileSync(stdoutLogPath, 'utf8'), 'fixture stdout\n');
    assert.equal(fs.readFileSync(stderrLogPath, 'utf8'), 'fixture stderr\n');
    assert.equal(child.stdout.listenerCount('error'), 0);
    assert.equal(child.stderr.listenerCount('error'), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('bounded log capture exposes a controlled stream-settle seam', async () => {
  const module = await import('../measure-tauri-startup.mjs');
  assert.equal(typeof module.attachBoundedLogCapture, 'function');
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'measure-tauri-startup.mjs'),
    'utf8',
  );
  const start = source.indexOf('export function attachBoundedLogCapture');
  const end = source.indexOf('\nexport async function launchMeasuredProcess', start);
  assert.match(source.slice(start, end), /settleTimeoutMs/);
});

test('bounded log capture destroys timed-out pipes safely and persists idempotently', async () => {
  class ControlledReadable extends EventEmitter {
    readableEnded = false;
    destroyed = false;
    closed = false;
    destroyCalls = 0;
    dataListenersAtDestroy;
    errorListenersAtDestroy;

    write(chunk) {
      this.emit('data', Buffer.from(chunk));
    }

    end() {
      this.readableEnded = true;
      this.emit('end');
      this.closed = true;
      this.emit('close');
    }

    destroy() {
      this.destroyCalls++;
      this.dataListenersAtDestroy = this.listenerCount('data');
      this.errorListenersAtDestroy = this.listenerCount('error');
      this.destroyed = true;
      this.emit('error', new Error('synchronous pipe error'));
      queueMicrotask(() => {
        this.emit('error', new Error('late pipe error'));
        this.closed = true;
        this.emit('close');
      });
    }
  }

  const root = temporaryDirectory('capture-timeout');
  const stdoutLogPath = path.join(root, 'stdout.log');
  const stderrLogPath = path.join(root, 'stderr.log');
  const stdout = new ControlledReadable();
  const stderr = new ControlledReadable();
  const capture = attachBoundedLogCapture(
    { stdout, stderr },
    { stdoutLogPath, stderrLogPath },
    [],
    { settleTimeoutMs: 5 },
  );
  stdout.write('safe complete line\napi_token=unfinished-secret');
  stderr.write('settled stderr\n');
  stderr.end();

  try {
    const firstPersistence = capture.persist();
    assert.strictEqual(capture.persist(), firstPersistence);
    await firstPersistence;

    assert.equal(stdout.destroyCalls, 1);
    assert.equal(stdout.dataListenersAtDestroy, 0, 'business data listener must leave before destroy');
    assert.ok(stdout.errorListenersAtDestroy >= 1, 'safety error listener must cover destroy');
    assert.equal(stdout.listenerCount('data'), 0);
    assert.equal(stdout.listenerCount('error'), 0);
    assert.equal(stdout.closed, true);
    const stdoutDiagnostic = fs.readFileSync(stdoutLogPath, 'utf8');
    assert.match(stdoutDiagnostic, /truncated 27 bytes/);
    assert.match(stdoutDiagnostic, /safe complete line\n$/);
    assert.doesNotMatch(stdoutDiagnostic, /api_token|unfinished-secret/);
    assert.equal(fs.readFileSync(stderrLogPath, 'utf8'), 'settled stderr\n');
    assert.strictEqual(capture.persist(), firstPersistence);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spawn rejection settles bounded captures and persists empty diagnostic logs', async () => {
  const root = temporaryDirectory('spawn-rejection-logs');
  const stdoutLogPath = path.join(root, 'stdout.log');
  const stderrLogPath = path.join(root, 'stderr.log');
  try {
    await assert.rejects(
      launchMeasuredProcess({
        executable: path.join(root, 'missing-executable'),
        codeFile: path.join(root, 'missing-code-file'),
        reportPath: path.join(root, 'report.json'),
        stdoutLogPath,
        stderrLogPath,
        cwd: root,
        sourceEnvironment: { PATH: process.env.PATH },
      }),
      /ENOENT|spawn/i,
    );
    assert.equal(fs.readFileSync(stdoutLogPath, 'utf8'), '');
    assert.equal(fs.readFileSync(stderrLogPath, 'utf8'), '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('spawn environment excludes sensitive keys while preserving required variables', () => {
  const prepared = filterSpawnEnvironment({
    PATH: '/fixture/bin',
    SAFE_SETTING: 'enabled',
    GITHUB_TOKEN: 'token-value',
    DB_PASSWORD: 'password-value',
    API_KEY: 'key-value',
    SESSION_COOKIE: 'cookie-value',
    AUTH_HEADER: 'auth-value',
    XAUTHORITY: '/fixture/.Xauthority',
    RIDE_STARTUP_REPORT: 'stale-report',
  }, '/fixture/current-report.json');

  assert.deepEqual(prepared.environment, {
    PATH: '/fixture/bin',
    SAFE_SETTING: 'enabled',
    XAUTHORITY: '/fixture/.Xauthority',
    RIDE_STARTUP_REPORT: '/fixture/current-report.json',
  });
  assert.deepEqual(new Set(prepared.sensitiveValues), new Set([
    'token-value',
    'password-value',
    'key-value',
    'cookie-value',
    'auth-value',
    '/fixture/.Xauthority',
  ]));
});

test('bounded log sink drains by bytes, keeps the tail, and marks truncation', () => {
  const sink = createBoundedLogSink(128);
  for (let index = 0; index < 40; index++) {
    sink.append(Buffer.from(`chunk-${index}-数据\n`));
  }
  sink.append(Buffer.from('TAIL-END'));
  const output = sink.render([]);

  assert.ok(Buffer.byteLength(output) <= 128);
  assert.match(output, /truncated \d+ bytes/);
  assert.match(output, /TAIL-END$/);
});

test('bounded log redaction drops a partial first line that crosses the truncation boundary', () => {
  const maximumBytes = 1_048_576;
  const secret = `BOUNDARY-SECRET-BEGIN-${'A'.repeat(80)}-CROSSING-SECRET-PAYLOAD-${'B'.repeat(80)}-END`;
  const splitInsideSecret = 8;
  const retainedSecretBytes = Buffer.byteLength(secret) - splitInsideSecret;
  const safeTail = 'z'.repeat(maximumBytes - retainedSecretBytes - 1);
  const sink = createBoundedLogSink();
  sink.append(Buffer.from(`P${secret}\n${safeTail}`));

  const output = sink.render([secret]);

  assert.ok(Buffer.byteLength(output) <= maximumBytes);
  assert.match(output, /truncated \d+ bytes/);
  assertNoSensitiveWindows(output, secret);
  assert.match(output, /z{100}$/);
});

test('bounded log redaction removes every multiline secret window after boundary truncation', () => {
  const maximumBytes = 1_048_576;
  const secret = `${'A'.repeat(40)}\n${'B'.repeat(40)}`;
  const splitInsideSecret = 8;
  const retainedSecretBytes = Buffer.byteLength(secret) - splitInsideSecret;
  const safeTail = 'z'.repeat(maximumBytes - retainedSecretBytes - 1);
  const sink = createBoundedLogSink();
  sink.append(Buffer.from(`P${secret}\n${safeTail}`));

  const output = sink.render([secret]);

  assert.ok(Buffer.byteLength(output) <= maximumBytes);
  assert.match(output, /truncated \d+ bytes/);
  assertNoSensitiveWindows(output, secret);
  assert.match(output, /z{100}$/);
});

test('bounded log redaction preserves an untruncated log without a newline', () => {
  const sink = createBoundedLogSink(128);
  sink.append(Buffer.from('ordinary one-line log tail'));

  assert.equal(sink.render([]), 'ordinary one-line log tail');
});

test('diagnostic redaction covers secret values, assignments, authorization, and cookies', () => {
  const redacted = redactDiagnosticText([
    'raw known-secret',
    'api_token=assignment-secret',
    'Authorization: Bearer authorization-secret',
    'Cookie: session=cookie-secret',
    '[backend] Proxy-Authorization: Bearer prefixed-authorization-secret',
    '2026-08-15 Cookie: session=prefixed-cookie-secret',
  ].join('\n'), ['known-secret']);

  assert.doesNotMatch(
    redacted,
    /known-secret|assignment-secret|authorization-secret|cookie-secret|prefixed-authorization-secret|prefixed-cookie-secret/,
  );
  assert.match(redacted, /raw \[REDACTED\]/);
  assert.match(redacted, /api_token=\[REDACTED\]/);
  assert.match(redacted, /Authorization: \[REDACTED\]/);
  assert.match(redacted, /Cookie: \[REDACTED\]/);
});

test('diagnostic redaction removes partial sensitive-value prefixes, middles, and suffixes', () => {
  const secret = 'BEGIN-PRIVATE-MATERIAL-0123456789-END-PRIVATE-MATERIAL';
  const redacted = redactDiagnosticText([
    `prefix only: ${secret.slice(0, 28)}`,
    `middle only: ${secret.slice(12, 40)}`,
    `suffix only: ${secret.slice(-28)}`,
  ].join('\n'), [secret]);

  assertNoSensitiveWindows(redacted, secret);
  assert.match(redacted, /\[REDACTED\]/);
});

test('failed campaign atomically preserves diagnostics, report, and unique copied logs', async () => {
  const root = temporaryDirectory('failure-diagnostic');
  const executable = path.join(root, 'R-IDE.exe');
  const output = path.join(root, 'startup-metrics.json');
  touch(executable);
  fs.writeFileSync(output, 'STALE-SUCCESS');
  fs.writeFileSync(path.join(root, 'startup-metrics.failure.json'), '{"status":"stale"}\n');
  const staleDiagnostics = path.join(root, 'startup-metrics-diagnostics-old');
  fs.mkdirSync(staleDiagnostics);
  fs.writeFileSync(path.join(staleDiagnostics, 'old.log'), 'STALE-DIAGNOSTIC');
  const similarlyNamedFile = path.join(root, 'startup-metrics-diagnostics-keep.txt');
  fs.writeFileSync(similarlyNamedFile, 'keep file');
  const unrelatedDirectory = path.join(root, 'other-diagnostics-old');
  fs.mkdirSync(unrelatedDirectory);
  const nestedDirectory = path.join(root, 'nested', 'startup-metrics-diagnostics-nested');
  fs.mkdirSync(nestedDirectory, { recursive: true });
  let calls = 0;
  const completedRun = {
    startupReport: startupReport(finalMilestones),
    metrics: { processCount: 1, rssBytes: 100 },
  };
  try {
    await assert.rejects(
      runMeasurementCampaign({
        executable,
        output,
        runs: 2,
        idleMs: 0,
        timeoutMs: 100,
        pollMs: 1,
      }, {
        measure: async options => {
          calls++;
          fs.writeFileSync(options.stdoutLogPath, `stdout run ${calls}\n`);
          fs.writeFileSync(options.stderrLogPath, `stderr run ${calls}\n`);
          if (calls === 2) {
            fs.writeFileSync(options.reportPath, JSON.stringify(startupReport(finalMilestones)));
            throw new Error('fixture startup failed');
          }
          return completedRun;
        },
      }),
      /fixture startup failed/,
    );

    const failurePath = path.join(root, 'startup-metrics.failure.json');
    const diagnostic = JSON.parse(fs.readFileSync(failurePath, 'utf8'));
    assert.equal(diagnostic.status, 'failed');
    assert.equal(diagnostic.error.message, 'fixture startup failed');
    assert.deepEqual(diagnostic.completedRuns, [completedRun]);
    assert.equal(diagnostic.runIndex, 2);
    assert.equal(diagnostic.platform, process.platform);
    assert.equal(diagnostic.arch, process.arch);
    assert.equal(diagnostic.executable, path.resolve(executable));
    assert.equal(diagnostic.output, path.resolve(output));
    assert.match(diagnostic.campaignId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(diagnostic.startupReport, startupReport(finalMilestones));
    assert.equal(path.basename(diagnostic.diagnostics.directory), diagnostic.diagnostics.directory);
    const ownedDiagnostics = path.join(root, diagnostic.diagnostics.directory);
    const owner = JSON.parse(fs.readFileSync(
      path.join(ownedDiagnostics, '.ride-startup-diagnostics-owner.json'),
      'utf8',
    ));
    assert.deepEqual(owner, {
      schema: 'ride.startup-diagnostics-owner',
      version: 1,
      campaignId: diagnostic.campaignId,
      output: path.resolve(output),
    });
    const stdoutCopy = path.resolve(root, diagnostic.logs.stdout);
    const stderrCopy = path.resolve(root, diagnostic.logs.stderr);
    assert.equal(path.dirname(stdoutCopy), path.dirname(stderrCopy));
    assert.equal(path.dirname(stdoutCopy), ownedDiagnostics);
    assert.equal(fs.readFileSync(stdoutCopy, 'utf8'), 'stdout run 2\n');
    assert.equal(fs.readFileSync(stderrCopy, 'utf8'), 'stderr run 2\n');
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.existsSync(staleDiagnostics), true);
    assert.equal(fs.readFileSync(similarlyNamedFile, 'utf8'), 'keep file');
    assert.equal(fs.existsSync(unrelatedDirectory), true);
    assert.equal(fs.existsSync(nestedDirectory), true);
    assert.equal(fs.existsSync(ownedDiagnostics), true);
    assert.deepEqual(
      fs.readdirSync(root).filter(name => name.endsWith('.tmp')),
      [],
      'atomic diagnostic writes must not leave temporary files',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('timeout diagnostic without a report preserves logs and omits report content', async () => {
  const root = temporaryDirectory('timeout-diagnostic');
  const executable = path.join(root, 'R-IDE');
  const output = path.join(root, 'startup-metrics.json');
  touch(executable);
  try {
    await assert.rejects(
      runMeasurementCampaign({
        executable,
        output,
        runs: 1,
        idleMs: 0,
        timeoutMs: 1,
        pollMs: 1,
      }, {
        measure: async options => {
          fs.writeFileSync(options.stderrLogPath, 'timed out while opening\n');
          throw new Error('startup report timeout after 1ms');
        },
      }),
      /startup report timeout/,
    );

    const diagnostic = JSON.parse(fs.readFileSync(
      path.join(root, 'startup-metrics.failure.json'),
      'utf8',
    ));
    assert.equal(diagnostic.error.message, 'startup report timeout after 1ms');
    assert.equal(Object.hasOwn(diagnostic, 'startupReport'), false);
    assert.equal(
      fs.readFileSync(path.resolve(root, diagnostic.logs.stderr), 'utf8'),
      'timed out while opening\n',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('diagnostic records a bounded parse error instead of copying invalid report text', async () => {
  const root = temporaryDirectory('parse-diagnostic');
  const executable = path.join(root, 'R-IDE');
  const output = path.join(root, 'startup-metrics.json');
  touch(executable);
  try {
    await assert.rejects(
      runMeasurementCampaign({
        executable,
        output,
        runs: 1,
        idleMs: 0,
        timeoutMs: 1,
        pollMs: 1,
      }, {
        measure: async options => {
          fs.writeFileSync(options.reportPath, '{not-json');
          throw new Error('startup report is not valid JSON');
        },
      }),
      /not valid JSON/,
    );

    const diagnostic = JSON.parse(fs.readFileSync(
      path.join(root, 'startup-metrics.failure.json'),
      'utf8',
    ));
    assert.equal(diagnostic.startupReport.invalid, true);
    assert.match(diagnostic.startupReport.error, /JSON/);
    assert.doesNotMatch(JSON.stringify(diagnostic), /not-json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failure artifacts bound and redact oversized logs and error messages', async () => {
  const root = temporaryDirectory('bounded-secret-diagnostic');
  const executable = path.join(root, 'R-IDE');
  const output = path.join(root, 'startup-metrics.json');
  const secret = 'fixture-super-secret-value';
  touch(executable);
  try {
    await assert.rejects(
      runMeasurementCampaign({
        executable,
        output,
        runs: 1,
        idleMs: 0,
        timeoutMs: 1,
        pollMs: 1,
      }, {
        environment: {
          PATH: process.env.PATH,
          RIDE_TEST_SECRET: secret,
        },
        measure: async options => {
          fs.writeFileSync(
            options.stdoutLogPath,
            `${'x'.repeat(1_100_000)}\napi_token=${secret}\nTAIL-END`,
          );
          fs.writeFileSync(
            options.stderrLogPath,
            `Authorization: Bearer ${secret}\nCookie: session=${secret}\n`,
          );
          throw new Error(`startup failed with ${secret}`);
        },
      }),
      /fixture-super-secret-value/,
    );

    const diagnosticText = fs.readFileSync(
      path.join(root, 'startup-metrics.failure.json'),
      'utf8',
    );
    const diagnostic = JSON.parse(diagnosticText);
    const stdout = fs.readFileSync(path.resolve(root, diagnostic.logs.stdout));
    const stderr = fs.readFileSync(path.resolve(root, diagnostic.logs.stderr));
    assert.ok(stdout.byteLength <= 1_048_576);
    assert.ok(stderr.byteLength <= 1_048_576);
    assert.match(stdout.toString('utf8'), /truncated \d+ bytes/);
    assert.match(stdout.toString('utf8'), /TAIL-END$/);
    assert.doesNotMatch(`${diagnosticText}\n${stdout}\n${stderr}`, new RegExp(secret));
    assert.doesNotMatch(diagnosticText, /environment|RIDE_TEST_SECRET/);
    assert.match(stderr.toString('utf8'), /Authorization: \[REDACTED\]/);
    assert.match(stderr.toString('utf8'), /Cookie: \[REDACTED\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful campaign writes only the measurement artifact', async () => {
  const root = temporaryDirectory('successful-campaign');
  const executable = path.join(root, 'R-IDE');
  const output = path.join(root, 'startup-metrics.json');
  touch(executable);
  fs.writeFileSync(output, 'STALE-SUCCESS');
  const staleDiagnostics = path.join(root, 'startup-metrics-diagnostics-old');
  fs.mkdirSync(staleDiagnostics);
  fs.writeFileSync(path.join(staleDiagnostics, '.ride-startup-diagnostics-owner.json'), JSON.stringify({
    schema: 'ride.startup-diagnostics-owner',
    version: 1,
    campaignId: 'forged-campaign',
    output: path.resolve(output),
  }));
  fs.writeFileSync(path.join(root, 'startup-metrics.failure.json'), JSON.stringify({
    status: 'failed',
    campaignId: 'claimed-campaign',
    output: path.resolve(output),
    diagnostics: { directory: path.basename(staleDiagnostics) },
  }));
  const similarlyNamedFile = path.join(root, 'startup-metrics-diagnostics-keep.txt');
  fs.writeFileSync(similarlyNamedFile, 'keep file');
  try {
    const measurement = await runMeasurementCampaign({
      executable,
      output,
      runs: 1,
      idleMs: 0,
      timeoutMs: 100,
      pollMs: 1,
    }, {
      measure: async () => ({
        startupReport: startupReport(finalMilestones),
        metrics: { processCount: 1, rssBytes: 100 },
      }),
    });

    assert.equal(measurement.runs.length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), measurement);
    assert.equal(fs.existsSync(path.join(root, 'startup-metrics.failure.json')), false);
    assert.equal(fs.existsSync(staleDiagnostics), true);
    assert.equal(fs.readFileSync(similarlyNamedFile, 'utf8'), 'keep file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('next campaign removes only the diagnostics directory owned by a valid old failure', async () => {
  const root = temporaryDirectory('owned-diagnostic-cleanup');
  const executable = path.join(root, 'R-IDE');
  const output = path.join(root, 'startup-metrics.json');
  touch(executable);
  try {
    await assert.rejects(
      runMeasurementCampaign({
        executable,
        output,
        runs: 1,
        idleMs: 0,
        timeoutMs: 1,
        pollMs: 1,
      }, {
        measure: async options => {
          fs.writeFileSync(options.stderrLogPath, 'owned failure\n');
          throw new Error('owned fixture failure');
        },
      }),
      /owned fixture failure/,
    );
    const oldFailure = JSON.parse(fs.readFileSync(
      path.join(root, 'startup-metrics.failure.json'),
      'utf8',
    ));
    const ownedDirectory = path.join(root, oldFailure.diagnostics.directory);
    assert.equal(fs.existsSync(ownedDirectory), true);

    await runMeasurementCampaign({
      executable,
      output,
      runs: 1,
      idleMs: 0,
      timeoutMs: 1,
      pollMs: 1,
    }, {
      measure: async () => ({
        startupReport: startupReport(finalMilestones),
        metrics: { processCount: 1, rssBytes: 100 },
      }),
    });

    assert.equal(fs.existsSync(ownedDirectory), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('campaign cleanup rejects unsafe diagnostic directory metadata without deleting victims', async () => {
  const campaignId = '123e4567-e89b-42d3-a456-426614174000';
  const probes = [
    ['dot', () => '.'],
    ['dot-dot', () => '..'],
    ['absolute', root => path.join(root, 'absolute-victim')],
    ['forward-separator', () => `startup-metrics-diagnostics-${campaignId}/nested`],
    ['backward-separator', () => `startup-metrics-diagnostics-${campaignId}\\nested`],
    ['wrong-stem', () => `other-diagnostics-${campaignId}`],
    ['invalid-uuid', () => 'startup-metrics-diagnostics-not-a-uuid'],
  ];

  for (const [label, directoryNameFor] of probes) {
    const root = temporaryDirectory(`cleanup-metadata-${label}`);
    const outputDirectory = path.join(root, 'artifacts');
    const executable = path.join(root, 'R-IDE');
    const output = path.join(outputDirectory, 'startup-metrics.json');
    fs.mkdirSync(outputDirectory);
    touch(executable);
    const directoryName = directoryNameFor(root);
    const candidate = path.isAbsolute(directoryName)
      ? directoryName
      : path.resolve(outputDirectory, directoryName);
    fs.mkdirSync(candidate, { recursive: true });
    const candidateVictim = path.join(candidate, `victim-${label}.txt`);
    fs.writeFileSync(candidateVictim, `preserve ${label}`);
    fs.writeFileSync(path.join(candidate, '.ride-startup-diagnostics-owner.json'), JSON.stringify({
      schema: 'ride.startup-diagnostics-owner',
      version: 1,
      campaignId,
      output: path.resolve(output),
    }));
    fs.writeFileSync(output, 'STALE-SUCCESS');
    fs.writeFileSync(path.join(outputDirectory, 'startup-metrics.failure.json'), JSON.stringify({
      status: 'failed',
      campaignId,
      output: path.resolve(output),
      diagnostics: { directory: directoryName },
    }));

    try {
      await runMeasurementCampaign({
        executable,
        output,
        runs: 1,
        idleMs: 0,
        timeoutMs: 1,
        pollMs: 1,
      }, {
        measure: async () => ({
          startupReport: startupReport(finalMilestones),
          metrics: { processCount: 1, rssBytes: 100 },
        }),
      });

      assert.equal(fs.existsSync(output), true, `${label}: measurement output must survive`);
      assert.equal(fs.existsSync(outputDirectory), true, `${label}: output parent must survive`);
      assert.equal(fs.existsSync(executable), true, `${label}: executable must survive`);
      assert.equal(fs.existsSync(candidate), true, `${label}: unowned candidate must survive`);
      assert.equal(
        fs.readFileSync(candidateVictim, 'utf8'),
        `preserve ${label}`,
        `${label}: candidate contents must survive`,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
