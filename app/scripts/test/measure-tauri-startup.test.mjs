/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateProcessTree,
  captureProcessIdentity,
  discoverExecutable,
  launchMeasuredProcess,
  measureOnce,
  median,
  parsePosixProcessTable,
  parseStartupReport,
  parseWindowsProcessTable,
  planProcessCleanup,
  runMeasurementCampaign,
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
      },
      {
        pid: 11,
        ppid: 10,
        pgid: 10,
        rssBytes: 1,
        creationTime: 'child-start',
      },
    ], { pid: 10, pgid: 10, creationTime: 'root-start' }),
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
      },
      {
        pid: 11,
        ppid: 10,
        pgid: 10,
        rssBytes: 1_048_576,
        creationTime: 'Sat Aug 15 12:34:57 2026',
      },
      {
        pid: 99,
        ppid: 1,
        pgid: 99,
        rssBytes: 524_288,
        creationTime: 'Sat Aug 15 12:35:00 2026',
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
      },
      {
        pid: 11,
        ppid: 10,
        pgid: null,
        rssBytes: 3_000,
        creationTime: '20260815123457.000000+480',
      },
    ],
  );
});

test('process aggregation includes only verified descendants of the spawned root', () => {
  const rows = [
    { pid: 100, ppid: 1, pgid: 100, rssBytes: 10, creationTime: 'root-start' },
    { pid: 101, ppid: 100, pgid: 100, rssBytes: 20, creationTime: 'child-start' },
    { pid: 102, ppid: 101, pgid: 100, rssBytes: 30, creationTime: 'grandchild-start' },
    { pid: 200, ppid: 1, pgid: 200, rssBytes: 1_000, creationTime: 'other-start' },
    { pid: 201, ppid: 200, pgid: 200, rssBytes: 2_000, creationTime: 'other-child-start' },
  ];
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start' };

  assert.deepEqual(aggregateProcessTree(rows, rootIdentity), {
    rootPid: 100,
    rootIdentity,
    processIds: [100, 101, 102],
    processCount: 3,
    rssBytes: 60,
    processes: [
      { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start', depth: 0 },
      { pid: 101, ppid: 100, pgid: 100, creationTime: 'child-start', depth: 1 },
      { pid: 102, ppid: 101, pgid: 100, creationTime: 'grandchild-start', depth: 2 },
    ],
  });
  assert.throws(
    () => aggregateProcessTree(rows, { ...rootIdentity, creationTime: 'reused-pid' }),
    /does not match its captured identity/,
  );
});

test('cleanup plans a whole tree only while the captured root identity still matches', () => {
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start' };
  const tracked = [
    { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start', depth: 0 },
    { pid: 101, ppid: 100, pgid: 100, creationTime: 'child-start', depth: 1 },
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
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start' };
  const tracked = [
    { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start', depth: 0 },
    { pid: 101, ppid: 100, pgid: 100, creationTime: 'child-start', depth: 1 },
    { pid: 102, ppid: 101, pgid: 100, creationTime: 'grandchild-start', depth: 2 },
  ];
  const current = [
    { pid: 101, ppid: 1, pgid: 101, creationTime: 'reused-child' },
    { pid: 102, ppid: 1, pgid: 100, creationTime: 'grandchild-start' },
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

test('tree termination rechecks identity and never targets a reused root or descendant PID', async () => {
  const rootIdentity = { pid: 100, pgid: null, creationTime: 'root-start' };
  const tracked = [
    { pid: 100, ppid: 1, pgid: null, creationTime: 'root-start', depth: 0 },
    { pid: 101, ppid: 100, pgid: null, creationTime: 'child-start', depth: 1 },
    { pid: 102, ppid: 101, pgid: null, creationTime: 'grandchild-start', depth: 2 },
  ];
  const commands = [];

  await terminateMeasuredTree(rootIdentity, tracked, 'win32', {
    read: () => [
      { pid: 100, ppid: 1, pgid: null, creationTime: 'reused-root' },
      { pid: 101, ppid: 1, pgid: null, creationTime: 'reused-child' },
      { pid: 102, ppid: 1, pgid: null, creationTime: 'grandchild-start' },
    ],
    run: (command, args) => commands.push([command, ...args]),
    delay: async () => undefined,
  });

  assert.deepEqual(commands, [['taskkill.exe', '/PID', '102', '/F']]);
});

test('tree termination uses whole-tree cleanup when the captured root still matches', async () => {
  const rootIdentity = { pid: 100, pgid: null, creationTime: 'root-start' };
  const commands = [];
  await terminateMeasuredTree(rootIdentity, [], 'win32', {
    read: () => [
      { pid: 100, ppid: 1, pgid: null, creationTime: 'root-start' },
    ],
    run: (command, args) => commands.push([command, ...args]),
    delay: async () => undefined,
  });

  assert.deepEqual(commands, [['taskkill.exe', '/PID', '100', '/T', '/F']]);
});

test('POSIX termination signals the verified process group after each identity read', async () => {
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start' };
  const rows = [
    { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start' },
  ];
  const signals = [];
  await terminateMeasuredTree(rootIdentity, [], 'linux', {
    read: () => rows,
    kill: (pid, signal) => signals.push([pid, signal]),
    delay: async () => undefined,
  });

  assert.deepEqual(signals, [[-100, 'SIGTERM'], [-100, 'SIGKILL']]);
});

test('POSIX termination falls back bottom-up to identity-matched tracked descendants', async () => {
  const rootIdentity = { pid: 100, pgid: 100, creationTime: 'root-start' };
  const tracked = [
    { pid: 100, ppid: 1, pgid: 100, creationTime: 'root-start', depth: 0 },
    { pid: 101, ppid: 100, pgid: 100, creationTime: 'child-start', depth: 1 },
    { pid: 102, ppid: 101, pgid: 100, creationTime: 'grandchild-start', depth: 2 },
  ];
  let reads = 0;
  const signals = [];
  await terminateMeasuredTree(rootIdentity, tracked, 'linux', {
    read: () => {
      reads++;
      return reads === 1
        ? [
          { pid: 100, ppid: 1, pgid: 100, creationTime: 'reused-root' },
          { pid: 101, ppid: 1, pgid: 100, creationTime: 'child-start' },
          { pid: 102, ppid: 1, pgid: 100, creationTime: 'grandchild-start' },
        ]
        : [
          { pid: 101, ppid: 1, pgid: 101, creationTime: 'reused-child' },
          { pid: 102, ppid: 1, pgid: 100, creationTime: 'grandchild-start' },
        ];
    },
    kill: (pid, signal) => signals.push([pid, signal]),
    delay: async () => undefined,
  });

  assert.deepEqual(signals, [
    [102, 'SIGTERM'],
    [101, 'SIGTERM'],
    [102, 'SIGKILL'],
  ]);
});

test('POSIX termination never sends a group signal when root is not the detached group leader', async () => {
  const rootIdentity = { pid: 100, pgid: 50, creationTime: 'root-start' };
  const tracked = [
    { pid: 100, ppid: 1, pgid: 50, creationTime: 'root-start', depth: 0 },
    { pid: 101, ppid: 100, pgid: 50, creationTime: 'child-start', depth: 1 },
  ];
  const signals = [];
  await terminateMeasuredTree(rootIdentity, tracked, 'linux', {
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
  const rootIdentity = { pid: 7331, pgid: 7331, creationTime: 'root-start' };
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
        launch: () => ({ pid: 7331 }),
        capture: async pid => {
          assert.equal(pid, 7331);
          return rootIdentity;
        },
        waitForReport: async () => {
          throw new Error('startup report timeout');
        },
        delay: async () => undefined,
        sample: pid => {
          sampled.push(pid);
          return { rootPid: pid, processIds: [pid], processCount: 1, rssBytes: 1 };
        },
        terminate: async (identity, tracked) => {
          terminated.push({ identity, tracked });
        },
      },
    ),
    /startup report timeout/,
  );
  assert.deepEqual(sampled, []);
  assert.deepEqual(terminated, [{ identity: rootIdentity, tracked: [] }]);
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
      launch: () => ({ pid: 7331 }),
      capture: async pid => {
        events.push(`capture:${pid}`);
        return rootIdentity;
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
      terminate: async (identity, tracked) => {
        events.push(`terminate:${identity.pid}:${tracked.length}`);
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
    'idle:30000',
    'sample:7331:root-start',
    'terminate:7331:1',
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
    await once(child, 'exit');
    assert.equal(fs.readFileSync(stdoutLogPath, 'utf8'), 'fixture stdout\n');
    assert.equal(fs.readFileSync(stderrLogPath, 'utf8'), 'fixture stderr\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed campaign atomically preserves diagnostics, report, and unique copied logs', async () => {
  const root = temporaryDirectory('failure-diagnostic');
  const executable = path.join(root, 'R-IDE.exe');
  const output = path.join(root, 'startup-metrics.json');
  touch(executable);
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
    assert.deepEqual(diagnostic.startupReport, startupReport(finalMilestones));
    const stdoutCopy = path.resolve(root, diagnostic.logs.stdout);
    const stderrCopy = path.resolve(root, diagnostic.logs.stderr);
    assert.equal(path.dirname(stdoutCopy), path.dirname(stderrCopy));
    assert.match(path.basename(path.dirname(stdoutCopy)), /^startup-metrics-diagnostics-/);
    assert.equal(fs.readFileSync(stdoutCopy, 'utf8'), 'stdout run 2\n');
    assert.equal(fs.readFileSync(stderrCopy, 'utf8'), 'stderr run 2\n');
    assert.equal(fs.existsSync(output), false);
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

test('successful campaign writes only the measurement artifact', async () => {
  const root = temporaryDirectory('successful-campaign');
  const executable = path.join(root, 'R-IDE');
  const output = path.join(root, 'startup-metrics.json');
  touch(executable);
  fs.writeFileSync(path.join(root, 'startup-metrics.failure.json'), '{"status":"stale"}\n');
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
    assert.equal(fs.readdirSync(root).some(name => name.includes('diagnostics')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
