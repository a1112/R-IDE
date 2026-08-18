/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/* eslint-disable @typescript-eslint/tslint/config -- JavaScript modules cannot declare TypeScript typedefs. */
/* eslint-disable no-null/no-null -- Smoke protocol fixtures require explicit nulls. */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { SMOKE_ACTIONS } from '../tauri-packaged-smoke-contract.mjs';
import {
  createSmokeRunArtifacts,
  cleanupPackagedSmokeInstances,
  launchPackagedSmokeInstance,
  packagedSmokeLaunchArguments,
  parsePackagedSmokeArguments,
  removeSmokeRunArtifacts,
  runPackagedSmoke,
  validatePackagedSmokeLogs,
} from '../run-tauri-packaged-smoke.mjs';

const digest = 'a'.repeat(64);

const RUST_PLATFORM = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const RUST_ARCH = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];

function transitionSteps({ forwardingStarted = false } = {}) {
  const steps = [];
  for (const [index, action] of SMOKE_ACTIONS.entries()) {
    steps.push({ action, state: 'started', durationMs: index * 2, diagnostic: null });
    if (action === 'second-file-forwarding' && forwardingStarted) {
      break;
    }
    steps.push({ action, state: 'passed', durationMs: index * 2 + 1, diagnostic: null });
  }
  return steps;
}

function progress() {
  const steps = transitionSteps({ forwardingStarted: true });
  return {
    schema: 'ride.tauri-packaged-smoke-progress',
    version: 1,
    specSha256: digest,
    scenario: 'critical-file',
    profile: 'tauri-critical',
    durationMs: steps.at(-1).durationMs,
    steps,
  };
}

function report(overrides = {}) {
  const steps = transitionSteps();
  return {
    schema: 'ride.tauri-packaged-smoke',
    version: 1,
    specSha256: digest,
    scenario: 'critical-file',
    profile: 'tauri-critical',
    status: 'passed',
    failurePhase: null,
    durationMs: steps.at(-1).durationMs,
    diagnostic: null,
    steps,
    ...overrides,
  };
}

function fixtureRun() {
  return {
    workspace: 'C:\\runner\\workspace',
    files: ['first.R', 'second.R'],
    absoluteFiles: ['C:\\runner\\workspace\\first.R', 'C:\\runner\\workspace\\second.R'],
    specPath: 'C:\\runner\\spec.json',
    reportPath: 'C:\\runner\\report.json',
    outputPath: 'C:\\runner\\output.json',
    token: 'raw-token-that-must-never-leak',
    sensitiveValues: ['raw-token-that-must-never-leak'],
    context: {
      specSha256: digest,
      scenario: 'critical-file',
      profile: 'tauri-critical',
      actions: [...SMOKE_ACTIONS],
    },
  };
}

function fixtureDependencies(events, overrides = {}) {
  const run = fixtureRun();
  return {
    verifyProfile: async () => undefined,
    createRun: async () => { events.push('create'); return run; },
    launchInstance: async ({ kind }) => {
      events.push(`launch-${kind}`);
      return { kind, child: { exitCode: null }, identity: { pid: kind === 'first' ? 10 : 20 } };
    },
    waitForForwardingStarted: async () => { events.push('wait-forwarding-started'); return progress(); },
    waitForInstanceExit: async instance => { events.push(`wait-${instance.kind}-exit`); },
    waitForFinalReport: async () => { events.push('wait-final'); return report(); },
    requestGracefulClose: async () => { events.push('graceful-close'); },
    cleanupInstances: async () => { events.push('verify-cleanup'); },
    validateLogs: async () => { events.push('validate-logs'); },
    publishResult: async () => { events.push('publish'); },
    preserveFailure: async () => undefined,
    cleanupRun: async () => { events.push('temp-cleanup'); },
    ...overrides,
  };
}

const options = Object.freeze({ scenario: 'critical-file', timeoutMs: 30_000 });

test('orchestration follows the exact two-instance packaged smoke order', async () => {
  const events = [];
  const result = await runPackagedSmoke(options, fixtureDependencies(events));
  assert.equal(result.status, 'passed');
  assert.deepEqual(events, [
    'create',
    'launch-first',
    'wait-forwarding-started',
    'launch-second',
    'wait-second-exit',
    'wait-final',
    'graceful-close',
    'wait-first-exit',
    'verify-cleanup',
    'validate-logs',
    'publish',
    'temp-cleanup',
  ]);
});

test('graceful close and first-instance natural exit share one phase deadline', async () => {
  const events = [];
  let gracefulBudget;
  await runPackagedSmoke(options, fixtureDependencies(events, {
    now: () => 100,
    requestGracefulClose: async (_instance, { budget }) => {
      gracefulBudget = budget;
    },
    waitForInstanceExit: async (instance, { budget }) => {
      if (instance.kind === 'first') {
        assert.equal(budget, gracefulBudget);
      }
    },
  }));
  assert.equal(gracefulBudget.deadline, 30_100);
});

for (const [label, method, message] of [
  ['phase timeout', 'waitForForwardingStarted', 'forwarding phase timed out'],
  ['early first exit', 'waitForForwardingStarted', 'first instance exited before progress'],
  ['malformed report', 'waitForFinalReport', 'Smoke report schema'],
  ['stale report', 'waitForFinalReport', 'specSha256 must match'],
  ['profile mismatch', 'waitForFinalReport', 'profile must match'],
  ['second instance stays alive', 'waitForInstanceExit', 'second instance exit timed out'],
]) {
  test(`${label} fails closed and force-cleans owned processes`, async () => {
    const events = [];
    const dependencies = fixtureDependencies(events, {
      [method]: async argument => {
        if (method !== 'waitForInstanceExit' || argument.kind === 'second') {
          events.push(method);
          throw new Error(message);
        }
        events.push(`wait-${argument.kind}-exit`);
      },
    });
    await assert.rejects(runPackagedSmoke(options, dependencies), new RegExp(message));
    assert.equal(events.includes('verify-cleanup'), true);
    assert.equal(events.at(-1), 'temp-cleanup');
  });
}

test('sidecar stderr is a functional failure even after a passed report', async () => {
  const events = [];
  await assert.rejects(runPackagedSmoke(options, fixtureDependencies(events, {
    validateLogs: async () => {
      events.push('validate-logs');
      throw new Error('Backend sidecar failed.');
    },
  })), /sidecar failed/i);
  assert.equal(events.includes('publish'), false);
  assert.equal(events.at(-1), 'temp-cleanup');
});

test('cleanup failure rejects an otherwise successful smoke run', async () => {
  const events = [];
  let attempts = 0;
  await assert.rejects(runPackagedSmoke(options, fixtureDependencies(events, {
    cleanupInstances: async () => {
      attempts += 1;
      events.push('verify-cleanup');
      throw new Error('owned descendant survived cleanup');
    },
  })), /owned descendant survived cleanup/);
  assert.equal(events.includes('validate-logs'), false);
  assert.equal(attempts, 2);
  assert.equal(events.at(-1), 'temp-cleanup');
});

test('diagnostics are redacted and temporary cleanup still runs on failure', async () => {
  const events = [];
  const secret = fixtureRun().token;
  await assert.rejects(runPackagedSmoke(options, fixtureDependencies(events, {
    waitForFinalReport: async () => { throw new Error(`failure ${secret}`); },
  })), error => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /\[REDACTED\]/);
    return true;
  });
  assert.equal(events.at(-1), 'temp-cleanup');
});

test('artifact creation keeps raw token only in child environment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-artifacts-'));
  const executable = path.join(root, 'R-IDE.exe');
  fs.writeFileSync(executable, 'fixture');
  try {
    const run = await createSmokeRunArtifacts({
      executable,
      scenario: 'critical-file',
      output: path.join(root, 'result.json'),
      timeoutMs: 30_000,
      sourceEnvironment: { PATH: process.env.PATH ?? '' },
      temporaryRoot: root,
      tokenBytes: Buffer.alloc(32, 7),
    });
    const serializedSpec = fs.readFileSync(run.specPath, 'utf8');
    const parsedSpec = JSON.parse(serializedSpec);
    assert.equal(serializedSpec.includes(run.token), false);
    assert.equal(run.launchArguments.includes(run.token), false);
    assert.equal(run.childEnvironment.RIDE_TAURI_SMOKE_TOKEN, run.token);
    assert.equal(run.childEnvironment.RIDE_TAURI_SMOKE_SPEC, run.specPath);
    assert.equal(run.childEnvironment.RIDE_TAURI_SMOKE_REPORT, run.reportPath);
    assert.equal(parsedSpec.workspace, '.');
    assert.match(parsedSpec.tokenSha256, /^[0-9a-f]{64}$/);
    assert.equal(path.dirname(run.specPath).startsWith(run.workspace), true);
    assert.equal(path.dirname(run.reportPath).startsWith(run.workspace), true);
    assert.deepEqual(run.launchArguments, [run.absoluteFiles[0]]);
    assert.deepEqual(packagedSmokeLaunchArguments(run, 'first'), [run.absoluteFiles[0]]);
    assert.deepEqual(packagedSmokeLaunchArguments(run, 'second'), [run.absoluteFiles[1]]);
    assert.equal(packagedSmokeLaunchArguments(run, 'second').includes(run.token), false);
    assert.throws(() => packagedSmokeLaunchArguments(run, 'third'), /first or second/);
    assert.equal(fs.existsSync(path.join(run.workspace, '.git')), true);
    assert.match(run.runId, /^[0-9a-f-]{36}$/i);
    assert.equal(fs.readFileSync(path.join(run.workspace, '.gitignore'), 'utf8'), (
      '.ride-smoke/\n.ride-smoke-terminal-ok\n'
    ));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('temporary cleanup refuses forged ownership without deleting the target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-forged-cleanup-'));
  const target = path.join(root, 'ride-tauri-smoke-victim');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'victim.txt'), 'preserve');
  try {
    await assert.rejects(removeSmokeRunArtifacts({
      keepWorkspace: false,
      temporaryRoot: root,
      runRoot: target,
      runId: 'forged',
    }), /unowned smoke workspace/);
    assert.equal(fs.readFileSync(path.join(target, 'victim.txt'), 'utf8'), 'preserve');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('core validator rejects malformed, stale, and profile-mismatched final artifacts', async () => {
  for (const [label, override, expected] of [
    ['malformed', { schema: 'not-a-smoke-report' }, /schema/i],
    ['stale', { specSha256: 'b'.repeat(64) }, /specSha256 must match/i],
    ['profile mismatch', { profile: 'full' }, /profile must match/i],
  ]) {
    const events = [];
    await assert.rejects(runPackagedSmoke(options, fixtureDependencies(events, {
      waitForFinalReport: async () => report(override),
    })), expected, label);
    assert.equal(events.includes('verify-cleanup'), true, label);
  }
});

test('authoritative profile mismatch prevents workspace creation and launch', async () => {
  const events = [];
  await assert.rejects(runPackagedSmoke(options, fixtureDependencies(events, {
    verifyProfile: async () => { throw new Error('packaged profile does not match'); },
  })), /profile does not match/);
  assert.deepEqual(events, []);
});

test('artifact creation rejects inherited smoke authority variables', async () => {
  for (const variable of [
    'RIDE_TAURI_SMOKE_SPEC',
    'RIDE_TAURI_SMOKE_REPORT',
    'RIDE_TAURI_SMOKE_TOKEN',
  ]) {
    await assert.rejects(createSmokeRunArtifacts({
      executable: 'C:\\R-IDE.exe',
      scenario: 'critical-file',
      output: 'C:\\result.json',
      timeoutMs: 30_000,
      sourceEnvironment: { [variable]: 'attacker-controlled' },
    }), new RegExp(variable));
  }
  await assert.rejects(createSmokeRunArtifacts({
    executable: 'C:\\R-IDE.exe',
    scenario: 'critical-file',
    output: 'C:\\result.json',
    timeoutMs: 30_000,
    sourceEnvironment: { ride_tauri_smoke_token: 'case-insensitive-attacker' },
  }), /RIDE_TAURI_SMOKE_TOKEN/);
});

test('artifact environment removes inherited CI secrets, retains XAUTHORITY, and tracks redaction values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-environment-'));
  const executable = path.join(root, 'R-IDE.exe');
  fs.writeFileSync(executable, 'fixture');
  const secrets = {
    CI_ACCESS_TOKEN: 'ci-access-token-value-with-enough-entropy',
    DB_PASSWORD: 'database-password-value-with-enough-entropy',
    XAUTHORITY: '/tmp/xauthority-sensitive-desktop-value',
  };
  let run;
  try {
    run = await createSmokeRunArtifacts({
      executable,
      scenario: 'critical-file',
      output: path.join(root, 'result.json'),
      timeoutMs: 30_000,
      keepWorkspace: true,
      sourceEnvironment: { PATH: process.env.PATH ?? '', ...secrets },
    });
    assert.equal(Object.hasOwn(run.childEnvironment, 'CI_ACCESS_TOKEN'), false);
    assert.equal(Object.hasOwn(run.childEnvironment, 'DB_PASSWORD'), false);
    assert.equal(run.childEnvironment.XAUTHORITY, secrets.XAUTHORITY);
    for (const value of Object.values(secrets)) {
      assert.equal(run.sensitiveValues.includes(value), true);
    }
  } finally {
    if (run) {
      fs.rmSync(run.runRoot, { recursive: true, force: true });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeStartupFixture(file, exitCode, linger = false) {
  fs.writeFileSync(file, [
    'const fs = require(\'node:fs\');',
    'const report = {',
    "  schema: 'ride.startup-report', version: 1,",
    `  platform: '${RUST_PLATFORM}', arch: '${RUST_ARCH}', pid: process.pid,`,
    '  milestones: { process_started: 0 },',
    '};',
    'fs.writeFileSync(process.env.RIDE_STARTUP_REPORT, JSON.stringify(report));',
    linger ? 'setInterval(() => undefined, 1000);' : `process.exit(${exitCode});`,
  ].join('\n'));
}

function stalledSpawnChild() {
  const child = new EventEmitter();
  const signals = [];
  let resolveCleanupStarted;
  const cleanupStarted = new Promise(resolve => { resolveCleanupStarted = resolve; });
  Object.assign(child, {
    pid: 7331,
    killed: false,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill(signal) {
      signals.push(signal);
      resolveCleanupStarted();
      if (signal === 'SIGKILL') {
        this.killed = true;
        this.signalCode = signal;
        this.stdout.end();
        this.stderr.end();
        this.emit('exit', null, signal);
      }
      return true;
    },
    cleanupStarted,
    signals,
  });
  return child;
}

test('default launcher bounds a silent spawn and makes late spawn errors inert', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-silent-spawn-'));
  const child = stalledSpawnChild();
  const scheduled = [];
  const cancelled = [];
  const run = {
    executable: 'R-IDE.exe',
    absoluteFiles: ['unused', 'second.R'],
    workspace: root,
    logsDirectory: root,
    timeoutMs: 50,
    childEnvironment: {},
    smokeEnvironment: {},
    sensitiveValues: [],
  };
  const budget = {
    deadline: 50,
    timeoutMs: 50,
    phase: 'second instance launch',
    now: () => 0,
  };
  try {
    const launching = launchPackagedSmokeInstance({ run, kind: 'second', budget }, {
      platform: 'win32',
      spawnProcess: () => child,
      schedule: (callback, milliseconds) => {
        const timer = { callback, milliseconds, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      cancel: timer => cancelled.push(timer),
    });
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].milliseconds, 50);
    scheduled[0].callback();
    await child.cleanupStarted;
    assert.equal(child.listenerCount('spawn'), 0);
    assert.equal(child.listenerCount('error'), 1);
    let lateError;
    try {
      child.emit('error', new Error('late spawn error'));
    } catch (error) {
      lateError = error;
    }
    await assert.rejects(launching, /second instance launch timed out after 50ms/i);
    assert.equal(lateError, undefined);
    assert.equal(child.listenerCount('spawn'), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.deepEqual(cancelled, [scheduled[0]]);
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('late-error guard does not swallow a normal pre-spawn error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-pre-spawn-error-'));
  const child = stalledSpawnChild();
  const scheduled = [];
  const cancelled = [];
  const run = {
    executable: 'R-IDE.exe',
    absoluteFiles: ['unused', 'second.R'],
    workspace: root,
    logsDirectory: root,
    timeoutMs: 50,
    childEnvironment: {},
    smokeEnvironment: {},
    sensitiveValues: [],
  };
  const budget = {
    deadline: 50,
    timeoutMs: 50,
    phase: 'second instance launch',
    now: () => 0,
  };
  try {
    const launching = launchPackagedSmokeInstance({ run, kind: 'second', budget }, {
      platform: 'win32',
      spawnProcess: () => child,
      schedule: (callback, milliseconds) => {
        const timer = { callback, milliseconds, unref() {} };
        scheduled.push(timer);
        return timer;
      },
      cancel: timer => cancelled.push(timer),
    });
    child.emit('error', new Error('pre-spawn failure'));
    await assert.rejects(launching, /pre-spawn failure/);
    scheduled[0].callback();
    await Promise.resolve();
    assert.equal(child.listenerCount('spawn'), 0);
    assert.equal(child.listenerCount('error'), 0);
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('close'), 0);
    assert.deepEqual(cancelled, [scheduled[0]]);
  } finally {
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default launcher accepts a real fast second-instance exit without waiting for identity timeout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-fast-second-'));
  const script = path.join(root, 'second.js');
  writeStartupFixture(script, 0);
  const run = {
    executable: process.execPath,
    absoluteFiles: ['unused', script],
    workspace: root,
    logsDirectory: root,
    timeoutMs: 3_000,
    childEnvironment: { PATH: process.env.PATH ?? '' },
    smokeEnvironment: {},
    sensitiveValues: [],
  };
  const started = Date.now();
  try {
    const instance = await launchPackagedSmokeInstance({ run, kind: 'second' }, {
      capture: async () => new Promise((_, reject) => setTimeout(
        () => reject(new Error('delayed identity capture')),
        2_500,
      )),
    });
    assert.equal(instance.child.exitCode, 0);
    assert.equal(instance.identity, undefined);
    assert.equal(instance.containmentVerified, true);
    assert.ok(Date.now() - started < 1_500);
    await instance.logCapture.persist();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default launcher bounds capture and startup attestation by one 1s phase deadline', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-launch-deadline-'));
  const script = path.join(root, 'second.js');
  writeStartupFixture(script, 0, true);
  let currentTime = 0;
  let captureTimeout;
  let reportTimeout;
  let spawnedPid;
  const run = {
    executable: process.execPath,
    absoluteFiles: ['unused', script],
    workspace: root,
    logsDirectory: root,
    timeoutMs: 1_000,
    childEnvironment: { PATH: process.env.PATH ?? '' },
    smokeEnvironment: {},
    sensitiveValues: [],
  };
  let instance;
  try {
    instance = await launchPackagedSmokeInstance({ run, kind: 'second' }, {
      now: () => currentTime,
      spawnProcess: (executable, arguments_, spawnOptions) => {
        const child = spawn(executable, arguments_, spawnOptions);
        spawnedPid = child.pid;
        currentTime = 400;
        return child;
      },
      capture: async (pid, captureOptions) => {
        captureTimeout = captureOptions.timeoutMs;
        return { pid, ppid: 1, pgid: null, creationTime: 'windows:fixture' };
      },
      waitForReport: async (_file, waitOptions) => {
        reportTimeout = waitOptions.timeoutMs;
        return { pid: spawnedPid };
      },
      startMonitor: () => ({ stop: async () => [] }),
    });
    assert.equal(captureTimeout, 600);
    assert.equal(reportTimeout, 600);
  } finally {
    if (instance && instance.child.exitCode === null) {
      instance.child.kill();
      await new Promise(resolve => instance.child.once('exit', resolve));
      await instance.logCapture.persist();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default launcher fails statically when its 1s phase deadline is exhausted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-launch-expired-'));
  const script = path.join(root, 'second.js');
  writeStartupFixture(script, 0, true);
  let currentTime = 0;
  let captureCalled = false;
  let reportCalled = false;
  const run = {
    executable: process.execPath,
    absoluteFiles: ['unused', script],
    workspace: root,
    logsDirectory: root,
    timeoutMs: 1_000,
    childEnvironment: { PATH: process.env.PATH ?? '' },
    smokeEnvironment: {},
    sensitiveValues: [],
  };
  try {
    await assert.rejects(launchPackagedSmokeInstance({ run, kind: 'second' }, {
      now: () => currentTime,
      spawnProcess: (executable, arguments_, spawnOptions) => {
        const child = spawn(executable, arguments_, spawnOptions);
        currentTime = 1_000;
        return child;
      },
      capture: async () => { captureCalled = true; },
      waitForReport: async () => { reportCalled = true; },
    }), /second instance launch timed out after 1000ms/i);
    assert.equal(captureCalled, false);
    assert.equal(reportCalled, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default launcher filters the actual child environment while retaining desktop authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-launch-environment-'));
  const script = path.join(root, 'second.js');
  writeStartupFixture(script, 0);
  const secret = 'actual-child-ci-secret-value-with-enough-entropy';
  const xauthority = '/tmp/ride-desktop-xauthority';
  let spawnedEnvironment;
  const run = {
    executable: process.execPath,
    absoluteFiles: ['unused', script],
    workspace: root,
    logsDirectory: root,
    timeoutMs: 3_000,
    childEnvironment: {
      PATH: process.env.PATH ?? '',
      CI_ACCESS_TOKEN: secret,
      XAUTHORITY: xauthority,
    },
    smokeEnvironment: { RIDE_TAURI_SMOKE_TOKEN: 'smoke-token-for-child-only' },
    sensitiveValues: [secret],
  };
  try {
    const instance = await launchPackagedSmokeInstance({ run, kind: 'second' }, {
      spawnProcess: (executable, arguments_, spawnOptions) => {
        spawnedEnvironment = spawnOptions.env;
        return spawn(executable, arguments_, spawnOptions);
      },
      capture: async () => new Promise((_, reject) => setTimeout(
        () => reject(new Error('delayed identity capture')),
        2_500,
      )),
    });
    assert.equal(Object.hasOwn(spawnedEnvironment, 'CI_ACCESS_TOKEN'), false);
    assert.equal(spawnedEnvironment.XAUTHORITY, xauthority);
    assert.equal(spawnedEnvironment.RIDE_TAURI_SMOKE_TOKEN, 'smoke-token-for-child-only');
    await instance.logCapture.persist();
    const persistedLogs = [instance.stdoutLogPath, instance.stderrLogPath]
      .map(file => fs.readFileSync(file, 'utf8'))
      .join('\n');
    assert.equal(persistedLogs.includes(secret), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default launcher keeps first-instance identity strict and rejects fast nonzero second exits', async () => {
  for (const [kind, exitCode, expected] of [
    ['first', 0, /first instance exited before identity/i],
    ['second', 7, /second instance failed with exit code 7/i],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `ride-smoke-fast-${kind}-`));
    const script = path.join(root, `${kind}.js`);
    writeStartupFixture(script, exitCode);
    const run = {
      executable: process.execPath,
      absoluteFiles: kind === 'first' ? [script] : ['unused', script],
      workspace: root,
      logsDirectory: root,
      timeoutMs: 3_000,
      childEnvironment: { PATH: process.env.PATH ?? '' },
      smokeEnvironment: {},
      sensitiveValues: [],
    };
    try {
      await assert.rejects(launchPackagedSmokeInstance({ run, kind }, {
        capture: async () => new Promise((_, reject) => setTimeout(
          () => reject(new Error('delayed identity capture')),
          2_500,
        )),
      }), expected);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('default cleanup forwards attested containment, run marker, and tracked identities', async () => {
  const terminated = [];
  const identity = {
    pid: 7331,
    ppid: 1,
    pgid: null,
    creationTime: 'windows:fixture',
  };
  const tracked = [{ ...identity, pid: 7332, ppid: 7331 }];
  await cleanupPackagedSmokeInstances([{
    kind: 'first',
    child: { pid: 7331 },
    identity,
    containmentVerified: true,
    runId: '7f7df1aa-a324-4fd4-b11c-4cc260a94d8f',
    monitor: { stop: async () => tracked },
    cleanupComplete: false,
  }], {
    terminate: async value => terminated.push(value),
  });
  assert.equal(terminated.length, 1);
  assert.equal(terminated[0].containmentVerified, true);
  assert.equal(terminated[0].runId, '7f7df1aa-a324-4fd4-b11c-4cc260a94d8f');
  assert.deepEqual(terminated[0].trackedProcesses, tracked);
});

test('default cleanup reattests marker-owned descendants after a fast POSIX root exit', async () => {
  const runId = '5e77ce9f-3215-4cc4-a2b7-38f3398493ad';
  const descendant = {
    pid: 7442,
    ppid: 1,
    pgid: 7442,
    creationTime: 'linux:200',
    startedAt: 200,
  };
  const terminated = [];
  await cleanupPackagedSmokeInstances([{
    kind: 'second',
    child: { pid: 7441, killed: false, exitCode: 0, signalCode: null },
    identity: undefined,
    containmentVerified: true,
    platform: 'linux',
    runId,
    cleanupComplete: false,
  }], {
    discoverMarked: marker => {
      assert.equal(marker, runId);
      return { rows: [descendant], markedRows: [descendant] };
    },
    terminate: async value => terminated.push(value),
  });
  assert.equal(terminated.length, 1);
  assert.equal(terminated[0].rootPid, descendant.pid);
  assert.equal(terminated[0].rootIdentity, descendant);
  assert.deepEqual(terminated[0].trackedProcesses, [descendant]);
  assert.equal(terminated[0].containmentVerified, true);
  assert.equal(terminated[0].runId, runId);
});

test('default final waiter treats a valid current-run progress snapshot as pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-final-progress-'));
  const reportPath = path.join(root, 'report.json');
  const run = { ...fixtureRun(), reportPath, timeoutMs: 1_000 };
  const first = { child: { exitCode: null, signalCode: null } };
  let publishFinal;
  try {
    fs.writeFileSync(reportPath, JSON.stringify(progress()));
    publishFinal = setTimeout(() => fs.writeFileSync(reportPath, JSON.stringify(report())), 150);
    const { waitForPackagedSmokeFinalReport } = await import('../run-tauri-packaged-smoke.mjs');
    const final = await waitForPackagedSmokeFinalReport({ run, first });
    assert.equal(final.status, 'passed');
  } finally {
    clearTimeout(publishFinal);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default final waiter does not treat an identity-mismatched progress snapshot as pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-stale-progress-'));
  const reportPath = path.join(root, 'report.json');
  const run = { ...fixtureRun(), reportPath, timeoutMs: 1_000 };
  const first = { child: { exitCode: null, signalCode: null } };
  try {
    fs.writeFileSync(reportPath, JSON.stringify({ ...progress(), specSha256: 'b'.repeat(64) }));
    const { waitForPackagedSmokeFinalReport } = await import('../run-tauri-packaged-smoke.mjs');
    await assert.rejects(
      waitForPackagedSmokeFinalReport({ run, first }),
      /Smoke report|specSha256|schema/i,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default natural-exit waiter fails statically when the phase deadline is exhausted', async () => {
  const { waitForPackagedSmokeInstanceExit } = await import('../run-tauri-packaged-smoke.mjs');
  const instance = {
    kind: 'first',
    child: { exitCode: null, signalCode: null },
  };
  const run = { timeoutMs: 1_000 };
  const budget = { deadline: 1_000, timeoutMs: 1_000, now: () => 1_000 };
  await assert.rejects(
    waitForPackagedSmokeInstanceExit(instance, {
      run,
      phase: 'first instance graceful exit',
      budget,
    }),
    /first instance graceful exit timed out after 1000ms/i,
  );
});

test('CLI redacts explicit executable and worktree paths before run creation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-cli-secret-path-'));
  const executable = path.join(root, 'PRIVATE-WORKTREE-MARKER', 'missing-R-IDE.exe');
  try {
    const result = spawnSync(process.execPath, [
      path.resolve(import.meta.dirname, '..', 'run-tauri-packaged-smoke.mjs'),
      '--scenario', 'critical-file',
      '--executable', executable,
      '--output', path.join(root, 'result.json'),
    ], { encoding: 'utf8', timeout: 10_000 });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /PRIVATE-WORKTREE-MARKER|missing-R-IDE/i);
    for (let index = 0; index <= executable.length - 16; index += 1) {
      assert.equal(result.stderr.includes(executable.slice(index, index + 16)), false);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default log validation rejects sidecar failure text without exposing the token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-logs-'));
  const stdoutLogPath = path.join(root, 'stdout.log');
  const stderrLogPath = path.join(root, 'stderr.log');
  fs.writeFileSync(stdoutLogPath, '');
  fs.writeFileSync(stderrLogPath, 'Failed to start backend: exit code 1\n');
  try {
    await assert.rejects(validatePackagedSmokeLogs({
      run: { token: 'secret-value' },
      instances: [{
        stdoutLogPath,
        stderrLogPath,
        logCapture: { persist: async () => undefined },
      }],
    }), error => {
      assert.match(error.message, /Backend sidecar failed/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('successful orchestration removes its real temporary workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-cleanup-'));
  const executable = path.join(root, 'R-IDE.exe');
  const output = path.join(root, 'result.json');
  fs.writeFileSync(executable, 'fixture');
  let runRoot;
  const instance = kind => ({ kind, child: { exitCode: null }, identity: { pid: 10 } });
  try {
    await runPackagedSmoke({
      executable,
      scenario: 'critical-file',
      output,
      timeoutMs: 30_000,
      sourceEnvironment: { PATH: process.env.PATH ?? '' },
    }, {
      verifyProfile: async () => undefined,
      launchInstance: async ({ run, kind }) => {
        runRoot = run.runRoot;
        return instance(kind);
      },
      waitForForwardingStarted: async ({ run }) => ({
        ...progress(),
        specSha256: run.context.specSha256,
      }),
      waitForInstanceExit: async () => undefined,
      waitForFinalReport: async ({ run }) => ({
        ...report(),
        specSha256: run.context.specSha256,
      }),
      requestGracefulClose: async () => undefined,
      cleanupInstances: async () => undefined,
      validateLogs: async () => undefined,
    });
    assert.equal(fs.existsSync(runRoot), false);
    assert.equal(fs.existsSync(output), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed orchestration preserves bounded redacted diagnostics before temporary cleanup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-smoke-failure-'));
  const executable = path.join(root, 'R-IDE.exe');
  const output = path.join(root, 'result.json');
  fs.writeFileSync(executable, 'fixture');
  let runRoot;
  let token;
  const inheritedSecret = 'failure-artifact-ci-secret-value-with-enough-entropy';
  try {
    await assert.rejects(runPackagedSmoke({
      executable,
      scenario: 'critical-file',
      output,
      timeoutMs: 30_000,
      sourceEnvironment: {
        PATH: process.env.PATH ?? '',
        CI_ACCESS_TOKEN: inheritedSecret,
      },
    }, {
      verifyProfile: async () => undefined,
      launchInstance: async ({ run, kind }) => {
        runRoot = run.runRoot;
        token = run.token;
        return { kind, child: { exitCode: null }, identity: { pid: 10 } };
      },
      waitForForwardingStarted: async ({ run }) => ({
        ...progress(),
        specSha256: run.context.specSha256,
      }),
      waitForInstanceExit: async () => undefined,
      waitForFinalReport: async () => {
        throw new Error(`runner failed ${token} inherited ${inheritedSecret}`);
      },
      cleanupInstances: async () => undefined,
    }), /\[REDACTED\]/);
    const pointerPath = path.join(root, 'result.failure.json');
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    const diagnosticsDirectory = path.join(root, pointer.diagnostics.directory);
    const serializedFailure = fs.readFileSync(path.join(diagnosticsDirectory, 'failure.json'), 'utf8');
    assert.equal(serializedFailure.includes(token), false);
    assert.equal(serializedFailure.includes(inheritedSecret), false);
    assert.match(serializedFailure, /\[REDACTED\]/);
    assert.equal(fs.existsSync(runRoot), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI parser accepts only strict packaged smoke options', () => {
  assert.deepEqual(parsePackagedSmokeArguments([
    '--scenario', 'critical-file',
    '--bundle-root', 'bundle',
    '--output', 'smoke.json',
    '--timeout-ms', '45000',
    '--keep-workspace',
  ]), {
    scenario: 'critical-file',
    bundleRoot: path.resolve('bundle'),
    output: path.resolve('smoke.json'),
    timeoutMs: 45_000,
    keepWorkspace: true,
  });
  assert.throws(() => parsePackagedSmokeArguments(['--scenario', 'unknown']), /scenario/i);
  assert.throws(() => parsePackagedSmokeArguments(['--scenario', 'critical-file', '--wat']), /unknown/i);
  assert.throws(() => parsePackagedSmokeArguments(['--scenario', 'critical-file', '--timeout-ms', '0']), /timeout/i);
});

test('package exposes the packaged Tauri smoke command', () => {
  const packageJson = JSON.parse(fs.readFileSync(
    path.resolve(import.meta.dirname, '..', '..', 'package.json'),
    'utf8',
  ));
  assert.equal(
    packageJson.scripts['smoke:tauri-packaged'],
    'node scripts/run-tauri-packaged-smoke.mjs',
  );
});
