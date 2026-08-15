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
} from '../measure-tauri-startup.mjs';

function temporaryDirectory(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ride-measure-${label}-`));
}

function touch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'fixture');
}

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
  const report = parseStartupReport(JSON.stringify({
    schema: 'ride.startup-report',
    version: 1,
    platform: 'linux',
    arch: 'x86_64',
    pid: 412,
    milestones: {
      process_started: 0,
      backend_spawned: 10,
      backend_listening: 20,
      frontend_shell_attached: 30,
      target_file_opened: 42,
    },
  }));

  assert.equal(report.milestones.target_file_opened, 42);
  assert.throws(
    () => parseStartupReport(JSON.stringify({ ...report, outputPath: '/tmp/injected' })),
    /unexpected report field outputPath/,
  );
  assert.throws(
    () => parseStartupReport(JSON.stringify({
      ...report,
      milestones: { process_started: 0, invented: 1 },
    })),
    /unexpected milestone invented/,
  );
  assert.throws(
    () => parseStartupReport(JSON.stringify({
      ...report,
      milestones: { process_started: 10, backend_spawned: 9 },
    })),
    /not monotonic/,
  );
  assert.throws(() => parseStartupReport('{'), /valid JSON/);
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
