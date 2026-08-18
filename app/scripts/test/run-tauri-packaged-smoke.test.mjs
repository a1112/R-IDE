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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SMOKE_ACTIONS } from '../tauri-packaged-smoke-contract.mjs';
import {
  createSmokeRunArtifacts,
  packagedSmokeLaunchArguments,
  parsePackagedSmokeArguments,
  removeSmokeRunArtifacts,
  runPackagedSmoke,
  validatePackagedSmokeLogs,
} from '../run-tauri-packaged-smoke.mjs';

const digest = 'a'.repeat(64);

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
  try {
    await assert.rejects(runPackagedSmoke({
      executable,
      scenario: 'critical-file',
      output,
      timeoutMs: 30_000,
      sourceEnvironment: { PATH: process.env.PATH ?? '' },
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
      waitForFinalReport: async () => { throw new Error(`runner failed ${token}`); },
      cleanupInstances: async () => undefined,
    }), /\[REDACTED\]/);
    const pointerPath = path.join(root, 'result.failure.json');
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
    const diagnosticsDirectory = path.join(root, pointer.diagnostics.directory);
    const serializedFailure = fs.readFileSync(path.join(diagnosticsDirectory, 'failure.json'), 'utf8');
    assert.equal(serializedFailure.includes(token), false);
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
