/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/* eslint-disable @typescript-eslint/tslint/config -- JavaScript modules cannot declare TypeScript typedefs. */
/* eslint-disable no-null/no-null -- The child-process and smoke JSON protocols require explicit nulls. */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  attachBoundedLogCapture,
  captureProcessIdentity,
  discoverExecutable,
  readCampaignMetadata,
  redactDiagnosticText,
  requestGracefulProcessClose,
  startProcessTreeMonitor,
  terminateMeasuredTree,
} from './measure-tauri-startup.mjs';
import {
  SMOKE_ACTIONS,
  SMOKE_SCENARIOS,
  validateSmokeProgress,
  validateSmokeReport,
  validateSmokeSpec,
} from './tauri-packaged-smoke-contract.mjs';

const SMOKE_ENVIRONMENT_VARIABLES = Object.freeze([
  'RIDE_TAURI_SMOKE_SPEC',
  'RIDE_TAURI_SMOKE_REPORT',
  'RIDE_TAURI_SMOKE_TOKEN',
]);
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
const POLL_MS = 50;
const EXTERNAL_COMMAND_TIMEOUT_MS = 10_000;
const EXTERNAL_COMMAND_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const SIDECAR_FAILURE_PATTERN = /(?:Failed to start backend|Backend process exited before ready|sidecar[^\r\n]*fail)/iu;
const FAILURE_SCHEMA = 'ride.tauri-packaged-smoke-runner-failure';
const OWNER_SCHEMA = 'ride.tauri-packaged-smoke-owner';
const OWNER_FILE = '.ride-tauri-packaged-smoke-owner.json';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function outputStem(output) {
  const extension = path.extname(output);
  return path.basename(output, extension);
}

function failurePointerPath(output) {
  return path.join(path.dirname(output), `${outputStem(output)}.failure.json`);
}

function strictTimeout(value, label = 'timeout') {
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error(`${label} must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function scenarioDefinition(scenario) {
  if (!SMOKE_SCENARIOS.includes(scenario)) {
    throw new Error(`unsupported packaged smoke scenario ${scenario}`);
  }
  if (scenario === 'critical-empty') {
    return { profile: 'tauri-critical', files: [], actions: [...SMOKE_ACTIONS] };
  }
  return {
    profile: scenario === 'full-file' ? 'full' : 'tauri-critical',
    files: ['first.R', 'second.R'],
    actions: [...SMOKE_ACTIONS],
  };
}

function assertCleanSourceEnvironment(sourceEnvironment) {
  const inheritedNames = new Set(Object.keys(sourceEnvironment).map(name => name.toUpperCase()));
  for (const name of SMOKE_ENVIRONMENT_VARIABLES) {
    if (inheritedNames.has(name)) {
      throw new Error(`refusing inherited ${name}`);
    }
  }
}

async function writeFileAtomically(file, bytes) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, bytes, { flag: 'wx' });
    await fs.promises.rename(temporary, file);
  } finally {
    await fs.promises.rm(temporary, { force: true });
  }
}

function runGit(arguments_, environment) {
  const result = spawnSync('git', arguments_, {
    encoding: 'utf8',
    env: environment,
    windowsHide: true,
    timeout: EXTERNAL_COMMAND_TIMEOUT_MS,
    maxBuffer: EXTERNAL_COMMAND_MAX_BUFFER_BYTES,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error('temporary Git workspace initialization failed');
  }
}

function initializeGitWorkspace(workspace, files, environment) {
  fs.writeFileSync(path.join(workspace, '.gitignore'), '.ride-smoke/\n.ride-smoke-terminal-ok\n');
  runGit(['init', '--quiet', workspace], environment);
  runGit(['-C', workspace, 'add', '--', '.gitignore', ...files], environment);
  runGit([
    '-C', workspace,
    '-c', 'user.name=R-IDE Smoke',
    '-c', 'user.email=smoke@invalid.example',
    'commit', '--quiet', '--no-gpg-sign', '-m', 'Initialize packaged smoke workspace',
  ], environment);
}

export async function createSmokeRunArtifacts({
  executable,
  scenario,
  output,
  timeoutMs,
  keepWorkspace = false,
  sourceEnvironment = process.env,
  temporaryRoot = os.tmpdir(),
  tokenBytes = randomBytes(32),
}) {
  assertCleanSourceEnvironment(sourceEnvironment);
  const definition = scenarioDefinition(scenario);
  const boundedTimeout = strictTimeout(timeoutMs);
  if (!Buffer.isBuffer(tokenBytes) || tokenBytes.length < 32) {
    throw new Error('smoke token must contain at least 256 bits from a cryptographic RNG');
  }
  const token = tokenBytes.toString('hex');
  const ownedTemporaryRoot = await fs.promises.realpath(path.resolve(temporaryRoot));
  const runRoot = await fs.promises.mkdtemp(path.join(ownedTemporaryRoot, 'ride-tauri-smoke-'));
  const runId = randomUUID();
  try {
    await fs.promises.writeFile(path.join(runRoot, OWNER_FILE), `${JSON.stringify({
      schema: OWNER_SCHEMA,
      version: 1,
      runId,
    })}\n`, { flag: 'wx' });
    const workspace = path.join(runRoot, 'workspace');
    const authorityDirectory = path.join(workspace, '.ride-smoke');
    const specPath = path.join(authorityDirectory, 'spec.json');
    const reportPath = path.join(authorityDirectory, 'report.json');
    const logsDirectory = path.join(runRoot, 'logs');
    const absoluteFiles = definition.files.map(file => path.join(workspace, file));
    await fs.promises.mkdir(logsDirectory, { recursive: true });
    await fs.promises.mkdir(authorityDirectory, { recursive: true });
    await Promise.all(absoluteFiles.map((file, index) => fs.promises.writeFile(
      file,
      `# R-IDE packaged smoke ${index + 1}\n`,
      { flag: 'wx' },
    )));
    initializeGitWorkspace(workspace, definition.files, sourceEnvironment);
    const spec = validateSmokeSpec({
      schema: 'ride.tauri-packaged-smoke-spec',
      version: 1,
      scenario,
      profile: definition.profile,
      workspace: '.',
      files: definition.files,
      actions: definition.actions,
      tokenSha256: sha256(token),
      actionTimeoutMs: boundedTimeout,
    });
    const serializedSpec = `${JSON.stringify(spec)}\n`;
    await fs.promises.writeFile(specPath, serializedSpec, { flag: 'wx' });
    const specSha256 = sha256(serializedSpec);
    const childEnvironment = {
      ...sourceEnvironment,
      RIDE_TAURI_SMOKE_SPEC: specPath,
      RIDE_TAURI_SMOKE_REPORT: reportPath,
      RIDE_TAURI_SMOKE_TOKEN: token,
    };
    return {
      executable: path.resolve(executable),
      scenario,
      profile: definition.profile,
      timeoutMs: boundedTimeout,
      keepWorkspace,
      runId,
      temporaryRoot: ownedTemporaryRoot,
      runRoot,
      workspace,
      files: definition.files,
      absoluteFiles,
      specPath,
      reportPath,
      logsDirectory,
      outputPath: path.resolve(output),
      token,
      sensitiveValues: [token, runRoot, path.resolve(executable), path.resolve(output)],
      childEnvironment,
      launchArguments: absoluteFiles.length > 0 ? [absoluteFiles[0]] : [],
      context: {
        specSha256,
        scenario,
        profile: definition.profile,
        actions: definition.actions,
      },
    };
  } catch (error) {
    try {
      await fs.promises.rm(runRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      error.cause ??= cleanupError;
    }
    throw error;
  }
}

export async function removeSmokeRunArtifacts(run) {
  if (run.keepWorkspace) {
    return;
  }
  const temporaryRoot = path.resolve(run.temporaryRoot);
  const runRoot = path.resolve(run.runRoot);
  if (temporaryRoot !== run.temporaryRoot
      || runRoot !== run.runRoot
      || path.dirname(runRoot) !== temporaryRoot
      || !path.basename(runRoot).startsWith('ride-tauri-smoke-')) {
    throw new Error('refusing to remove an unowned smoke workspace');
  }
  let rootStat;
  let ownerStat;
  let owner;
  try {
    [rootStat, ownerStat] = await Promise.all([
      fs.promises.lstat(runRoot),
      fs.promises.lstat(path.join(runRoot, OWNER_FILE)),
    ]);
    owner = JSON.parse(await fs.promises.readFile(path.join(runRoot, OWNER_FILE), 'utf8'));
  } catch {
    throw new Error('refusing to remove an unowned smoke workspace');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || !ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 1_024) {
    throw new Error('refusing to remove an unowned smoke workspace');
  }
  if (owner?.schema !== OWNER_SCHEMA || owner?.version !== 1 || owner?.runId !== run.runId) {
    throw new Error('refusing to remove an unowned smoke workspace');
  }
  await fs.promises.rm(runRoot, { recursive: true, force: true });
}

function waitForSpawn(child) {
  return new Promise((resolve, reject) => {
    const clear = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    const onSpawn = () => { clear(); resolve(); };
    const onError = error => { clear(); reject(error); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export function packagedSmokeLaunchArguments(run, kind) {
  if (!['first', 'second'].includes(kind)) {
    throw new Error('packaged smoke instance kind must be first or second');
  }
  const fileIndex = kind === 'first' ? 0 : 1;
  return run.absoluteFiles[fileIndex] === undefined ? [] : [run.absoluteFiles[fileIndex]];
}

async function launchDefaultInstance({ run, kind }) {
  const launchArguments = packagedSmokeLaunchArguments(run, kind);
  const child = spawn(run.executable, launchArguments, {
    cwd: run.workspace,
    detached: process.platform !== 'win32',
    env: run.childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutLogPath = path.join(run.logsDirectory, `${kind}-stdout.log`);
  const stderrLogPath = path.join(run.logsDirectory, `${kind}-stderr.log`);
  const logCapture = attachBoundedLogCapture(
    child,
    { stdoutLogPath, stderrLogPath },
    run.sensitiveValues,
  );
  try {
    await waitForSpawn(child);
    const identity = await captureProcessIdentity(child.pid);
    const monitor = startProcessTreeMonitor(identity, { child });
    return {
      kind,
      child,
      identity,
      monitor,
      logCapture,
      stdoutLogPath,
      stderrLogPath,
      cleanupComplete: false,
    };
  } catch (error) {
    try {
      child.kill();
      await logCapture.persist();
    } catch (cleanupError) {
      error.cause ??= cleanupError;
    }
    throw error;
  }
}

function childHasExited(instance) {
  return instance.child.exitCode !== null || instance.child.signalCode !== null;
}

function childExitDescription(instance) {
  return instance.child.signalCode === null
    ? `exit code ${instance.child.exitCode}`
    : `signal ${instance.child.signalCode}`;
}

async function waitForJsonArtifact({
  run,
  first,
  phase,
  validate,
  accept,
}) {
  const deadline = Date.now() + run.timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const value = JSON.parse(await fs.promises.readFile(run.reportPath, 'utf8'));
      const validated = validate(value, run.context);
      if (accept(validated)) {
        return validated;
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    if (childHasExited(first)) {
      throw new Error(`first instance exited before ${phase}: ${childExitDescription(first)}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${phase} timed out after ${run.timeoutMs}ms`);
}

async function waitForForwardingStartedDefault({ run, first }) {
  return waitForJsonArtifact({
    run,
    first,
    phase: 'second-file-forwarding started progress',
    validate: validateSmokeProgress,
    accept: progress => {
      const final = progress.steps.at(-1);
      return final?.action === 'second-file-forwarding' && final.state === 'started';
    },
  });
}

async function waitForFinalReportDefault({ run, first }) {
  const final = await waitForJsonArtifact({
    run,
    first,
    phase: 'final smoke report',
    validate: validateSmokeReport,
    accept: () => true,
  });
  if (final.status !== 'passed') {
    throw new Error(final.diagnostic.message);
  }
  return final;
}

async function waitForInstanceExitDefault(instance, { run, phase }) {
  if (!childHasExited(instance)) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clear();
        reject(new Error(`${phase} timed out after ${run.timeoutMs}ms`));
      }, run.timeoutMs);
      timer.unref?.();
      const clear = () => {
        clearTimeout(timer);
        instance.child.off('exit', onExit);
        instance.child.off('error', onError);
      };
      const onExit = () => { clear(); resolve(); };
      const onError = error => { clear(); reject(error); };
      instance.child.once('exit', onExit);
      instance.child.once('error', onError);
    });
  }
  if (instance.child.exitCode !== 0) {
    throw new Error(`${instance.kind} instance failed with ${childExitDescription(instance)}`);
  }
}

async function cleanupDefaultInstances(instances) {
  const failures = [];
  for (const instance of [...instances].reverse()) {
    if (instance.cleanupComplete) {
      continue;
    }
    try {
      const trackedProcesses = await instance.monitor?.stop() ?? [];
      await terminateMeasuredTree({
        child: instance.child,
        rootPid: instance.identity.pid,
        rootIdentity: instance.identity,
        trackedProcesses,
      });
      instance.cleanupComplete = true;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error('owned process cleanup failed', { cause: failures[0] });
  }
}

export async function validatePackagedSmokeLogs({ run, instances }) {
  for (const instance of instances) {
    await instance.logCapture.persist();
    const [stdout, stderr] = await Promise.all([
      fs.promises.readFile(instance.stdoutLogPath, 'utf8'),
      fs.promises.readFile(instance.stderrLogPath, 'utf8'),
    ]);
    if (stdout.includes(run.token) || stderr.includes(run.token)) {
      throw new Error('smoke authority token reached captured logs');
    }
    if (SIDECAR_FAILURE_PATTERN.test(stderr)) {
      throw new Error('Backend sidecar failed.');
    }
  }
}

async function preserveFailureArtifacts({ run, instances, error, report }) {
  await Promise.all(instances.map(instance => instance.logCapture?.persist()));
  const failureId = randomUUID();
  const directoryName = `${outputStem(run.outputPath)}-diagnostics-${failureId}`;
  const directory = path.join(path.dirname(run.outputPath), directoryName);
  await fs.promises.mkdir(directory, { recursive: false });
  const copiedLogs = [];
  for (const name of [
    'first-stdout.log',
    'first-stderr.log',
    'second-stdout.log',
    'second-stderr.log',
  ]) {
    const source = path.join(run.logsDirectory, name);
    try {
      const stat = await fs.promises.lstat(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) {
        continue;
      }
      const bytes = await fs.promises.readFile(source);
      await writeFileAtomically(path.join(directory, name), bytes);
      copiedLogs.push(name);
    } catch (readError) {
      if (readError?.code !== 'ENOENT') {
        throw readError;
      }
    }
  }
  const message = redactDiagnosticText(error.message, run.sensitiveValues)
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .trim()
    .slice(0, 256) || 'Packaged smoke failed.';
  const artifact = {
    schema: FAILURE_SCHEMA,
    version: 1,
    status: 'failed',
    diagnostic: { message },
    logs: copiedLogs,
    report: report ?? null,
  };
  await writeFileAtomically(
    path.join(directory, 'failure.json'),
    `${JSON.stringify(artifact, null, 2)}\n`,
  );
  await writeFileAtomically(failurePointerPath(run.outputPath), `${JSON.stringify({
    schema: FAILURE_SCHEMA,
    version: 1,
    status: 'failed',
    diagnostics: { directory: directoryName },
  }, null, 2)}\n`);
}

function defaultDependencies(options) {
  return {
    verifyProfile: async () => {
      const definition = scenarioDefinition(options.scenario);
      const metadata = await readCampaignMetadata({ options, executable: options.executable });
      if (metadata.build.profile !== definition.profile) {
        throw new Error('packaged profile does not match the requested smoke scenario');
      }
    },
    createRun: () => createSmokeRunArtifacts(options),
    launchInstance: launchDefaultInstance,
    waitForForwardingStarted: waitForForwardingStartedDefault,
    waitForInstanceExit: waitForInstanceExitDefault,
    waitForFinalReport: waitForFinalReportDefault,
    requestGracefulClose: instance => requestGracefulProcessClose(instance.identity),
    cleanupInstances: cleanupDefaultInstances,
    validateLogs: validatePackagedSmokeLogs,
    publishResult: ({ run, report }) => writeFileAtomically(
      run.outputPath,
      `${JSON.stringify(report, null, 2)}\n`,
    ).then(() => fs.promises.rm(failurePointerPath(run.outputPath), { force: true })),
    preserveFailure: preserveFailureArtifacts,
    cleanupRun: async run => {
      await removeSmokeRunArtifacts(run);
    },
  };
}

function errorWithRedactedMessage(error, sensitiveValues) {
  const redacted = new Error(redactDiagnosticText(
    typeof error?.message === 'string' ? error.message : String(error),
    sensitiveValues,
  ));
  redacted.name = typeof error?.name === 'string' ? error.name : 'Error';
  return redacted;
}

export async function runPackagedSmoke(options, injectedDependencies) {
  const dependencies = {
    ...defaultDependencies(options),
    ...injectedDependencies,
  };
  let run;
  const instances = [];
  let cleanupComplete = false;
  let failure;
  let finalReport;
  try {
    await dependencies.verifyProfile(options);
    run = await dependencies.createRun(options);
    const first = await dependencies.launchInstance({ run, kind: 'first' });
    instances.push(first);
    const progress = validateSmokeProgress(
      await dependencies.waitForForwardingStarted({ run, first }),
      run.context,
    );
    const forwarding = progress.steps.at(-1);
    if (forwarding.action !== 'second-file-forwarding' || forwarding.state !== 'started') {
      throw new Error('second-file-forwarding started progress was not observed');
    }
    const second = await dependencies.launchInstance({ run, kind: 'second' });
    instances.push(second);
    await dependencies.waitForInstanceExit(second, {
      run,
      phase: 'second instance exit',
    });
    finalReport = validateSmokeReport(
      await dependencies.waitForFinalReport({ run, first }),
      run.context,
    );
    if (finalReport.status !== 'passed') {
      throw new Error(finalReport.diagnostic.message);
    }
    await dependencies.requestGracefulClose(first, { run });
    await dependencies.waitForInstanceExit(first, {
      run,
      phase: 'first instance graceful exit',
    });
    await dependencies.cleanupInstances(instances, { run });
    cleanupComplete = true;
    await dependencies.validateLogs({ run, instances });
    await dependencies.publishResult({ run, report: finalReport });
  } catch (error) {
    failure = error;
  } finally {
    if (instances.length > 0 && !cleanupComplete) {
      try {
        await dependencies.cleanupInstances(instances, { run });
        cleanupComplete = true;
      } catch (cleanupError) {
        failure ??= cleanupError;
      }
    }
    if (run !== undefined) {
      if (failure !== undefined) {
        try {
          await dependencies.preserveFailure({
            run,
            instances,
            error: errorWithRedactedMessage(failure, run.sensitiveValues),
            report: finalReport,
          });
        } catch (preservationError) {
          failure = preservationError;
        }
      }
      try {
        await dependencies.cleanupRun(run);
      } catch (cleanupError) {
        failure ??= cleanupError;
      }
    }
  }
  if (failure !== undefined) {
    throw errorWithRedactedMessage(failure, run?.sensitiveValues ?? []);
  }
  return finalReport;
}

export function parsePackagedSmokeArguments(argv) {
  const parsed = { timeoutMs: 30_000, keepWorkspace: false };
  const valued = new Map([
    ['--bundle-root', 'bundleRoot'],
    ['--executable', 'executable'],
    ['--scenario', 'scenario'],
    ['--output', 'output'],
    ['--timeout-ms', 'timeoutMs'],
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--keep-workspace') {
      if (seen.has(option)) {
        throw new Error(`duplicate option ${option}`);
      }
      seen.add(option);
      parsed.keepWorkspace = true;
      continue;
    }
    const key = valued.get(option);
    if (key === undefined) {
      throw new Error(`unknown packaged smoke option ${option}`);
    }
    if (seen.has(option) || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error(`invalid value for ${option}`);
    }
    seen.add(option);
    const value = argv[++index];
    parsed[key] = key === 'timeoutMs' ? Number(value) : value;
  }
  if (!SMOKE_SCENARIOS.includes(parsed.scenario)) {
    throw new Error('scenario must be critical-file, critical-empty, or full-file');
  }
  parsed.timeoutMs = strictTimeout(parsed.timeoutMs, 'timeout-ms');
  if (parsed.bundleRoot !== undefined && parsed.executable !== undefined) {
    throw new Error('--bundle-root and --executable are mutually exclusive');
  }
  for (const key of ['bundleRoot', 'executable', 'output']) {
    if (parsed[key] !== undefined) {
      parsed[key] = path.resolve(parsed[key]);
    }
  }
  parsed.output ??= path.resolve('tauri-packaged-smoke.json');
  return parsed;
}

async function main(argv) {
  const options = parsePackagedSmokeArguments(argv);
  const executable = options.executable ?? discoverExecutable(options.bundleRoot);
  const stat = await fs.promises.stat(executable);
  if (!stat.isFile()) {
    throw new Error('packaged Tauri executable is not a file');
  }
  const report = await runPackagedSmoke({
    ...options,
    executable,
    sourceEnvironment: process.env,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${redactDiagnosticText(error?.stack ?? String(error))}\n`);
    process.exitCode = 1;
  });
}
