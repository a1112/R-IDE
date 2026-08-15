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
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  aggregateProcessTree,
  discoverExecutable,
  measureOnce,
  median,
  parsePosixProcessTable,
  parseStartupReport,
  parseWindowsProcessTable,
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
  assert.throws(() => median([]), /at least one/);
});

test('parses POSIX ps and Windows PowerShell process table fixtures', () => {
  assert.deepEqual(
    parsePosixProcessTable(`
       10     1  2048
       11    10  1024
       99     1   512
    `),
    [
      { pid: 10, ppid: 1, rssBytes: 2_097_152 },
      { pid: 11, ppid: 10, rssBytes: 1_048_576 },
      { pid: 99, ppid: 1, rssBytes: 524_288 },
    ],
  );

  assert.deepEqual(
    parseWindowsProcessTable(JSON.stringify([
      { ProcessId: 10, ParentProcessId: 1, WorkingSetSize: 2_000 },
      { ProcessId: 11, ParentProcessId: 10, WorkingSetSize: 3_000 },
    ])),
    [
      { pid: 10, ppid: 1, rssBytes: 2_000 },
      { pid: 11, ppid: 10, rssBytes: 3_000 },
    ],
  );
});

test('process aggregation includes only verified descendants of the spawned root', () => {
  const rows = [
    { pid: 100, ppid: 1, rssBytes: 10 },
    { pid: 101, ppid: 100, rssBytes: 20 },
    { pid: 102, ppid: 101, rssBytes: 30 },
    { pid: 200, ppid: 1, rssBytes: 1_000 },
    { pid: 201, ppid: 200, rssBytes: 2_000 },
  ];

  assert.deepEqual(aggregateProcessTree(rows, 100), {
    rootPid: 100,
    processIds: [100, 101, 102],
    processCount: 3,
    rssBytes: 60,
  });
  assert.throws(() => aggregateProcessTree(rows, 999), /spawned root process 999/);
});

test('measurement timeout always terminates only the process tree it launched', async () => {
  const terminated = [];
  const sampled = [];
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
        waitForReport: async () => {
          throw new Error('startup report timeout');
        },
        delay: async () => undefined,
        sample: pid => {
          sampled.push(pid);
          return { rootPid: pid, processIds: [pid], processCount: 1, rssBytes: 1 };
        },
        terminate: async pid => {
          terminated.push(pid);
        },
      },
    ),
    /startup report timeout/,
  );
  assert.deepEqual(sampled, []);
  assert.deepEqual(terminated, [7331]);
});

test('measurement samples after idle and then rereads the complete final report', async () => {
  const early = startupReport(targetMilestones);
  const final = startupReport(finalMilestones);
  const phases = [];
  const events = [];

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
      waitForReport: async (_reportPath, options) => {
        phases.push(options.phase);
        return options.phase === 'final' ? final : early;
      },
      delay: async milliseconds => {
        events.push(`idle:${milliseconds}`);
      },
      sample: pid => {
        events.push(`sample:${pid}`);
        return { rootPid: pid, processIds: [pid], processCount: 1, rssBytes: 123 };
      },
      terminate: async pid => {
        events.push(`terminate:${pid}`);
      },
      now: (() => {
        let now = 1_000;
        return () => now += 10;
      })(),
    },
  );

  assert.deepEqual(phases, ['target', 'final']);
  assert.deepEqual(events, ['idle:30000', 'sample:7331', 'terminate:7331']);
  assert.equal(result.startupReport, final);
  assert.equal(result.startupReport.milestones.plugins_ready, 60);
});
