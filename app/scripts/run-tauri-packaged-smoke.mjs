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
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  attachBoundedLogCapture,
  captureProcessIdentity,
  discoverMarkedProcessSnapshot,
  discoverExecutable,
  filterSpawnEnvironment,
  readCampaignMetadata,
  redactDiagnosticText,
  requestGracefulProcessClose,
  startProcessTreeMonitor,
  terminateMeasuredTree,
  waitForStartupReport,
} from './measure-tauri-startup.mjs';
import {
  SMOKE_SCENARIOS,
  SMOKE_SCENARIO_REQUIREMENTS,
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
const MAX_FAILURE_ENTRIES = 8;
const MAX_FAILURE_DETAIL_LENGTH = 192;
const MAX_FAILURE_MESSAGE_LENGTH = 1_024;
const FAILURE_CATALOG = Object.freeze({
  primary: 'primary failure',
  'process-cleanup': 'process cleanup failure (owned processes may remain)',
  'diagnostic-preservation': 'diagnostic preservation failure',
  'workspace-cleanup': 'temporary workspace cleanup failure',
});
const failureEntriesSymbol = Symbol('packagedSmokeFailureEntries');
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(scriptDirectory, '..');

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

function createPhaseBudget(timeoutMs, phase, now = Date.now) {
  return {
    deadline: now() + timeoutMs,
    timeoutMs,
    phase,
    now,
  };
}

function remainingPhaseBudget(budget, phase = budget.phase) {
  const remainingMs = Math.floor(budget.deadline - budget.now());
  if (remainingMs <= 0) {
    throw new Error(`${phase} timed out after ${budget.timeoutMs}ms`);
  }
  return remainingMs;
}

function scenarioDefinition(scenario) {
  const requirement = SMOKE_SCENARIO_REQUIREMENTS[scenario];
  if (requirement === undefined) {
    throw new Error(`unsupported packaged smoke scenario ${scenario}`);
  }
  return {
    profile: requirement.profile,
    files: requirement.fileCount === 0 ? [] : ['first.R', 'second.R'],
    actions: [...requirement.actions],
  };
}

function assertRunMatchesScenario(run, scenario) {
  const definition = scenarioDefinition(scenario);
  const matches = run?.context?.scenario === scenario
    && run.context.profile === definition.profile
    && Array.isArray(run.context.actions)
    && run.context.actions.length === definition.actions.length
    && run.context.actions.every((action, index) => action === definition.actions[index])
    && Array.isArray(run.files)
    && run.files.length === definition.files.length
    && run.files.every((file, index) => file === definition.files[index])
    && Array.isArray(run.absoluteFiles)
    && run.absoluteFiles.length === definition.files.length;
  if (!matches) {
    throw new Error('packaged smoke run does not match the requested scenario');
  }
  return definition;
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
    const preparedSourceEnvironment = filterSpawnEnvironment(
      sourceEnvironment,
      path.join(authorityDirectory, 'startup-unused.json'),
    );
    initializeGitWorkspace(workspace, definition.files, preparedSourceEnvironment.environment);
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
    const smokeEnvironment = {
      RIDE_TAURI_SMOKE_SPEC: specPath,
      RIDE_TAURI_SMOKE_REPORT: reportPath,
      RIDE_TAURI_SMOKE_TOKEN: token,
    };
    const childEnvironment = {
      ...preparedSourceEnvironment.environment,
      ...smokeEnvironment,
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
      sensitiveValues: [...new Set([
        ...preparedSourceEnvironment.sensitiveValues,
        token,
        runRoot,
        path.resolve(executable),
        path.resolve(output),
      ])],
      childEnvironment,
      smokeEnvironment,
      launchArguments: absoluteFiles.length > 0 ? [absoluteFiles[0]] : [],
      context: {
        specSha256,
        scenario,
        profile: definition.profile,
        actions: definition.actions,
      },
    };
  } catch (error) {
    const failures = [];
    appendFailure(failures, 'primary', error);
    try {
      await fs.promises.rm(runRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      appendFailure(failures, 'workspace-cleanup', cleanupError);
    }
    throw aggregatePackagedSmokeFailures(failures, [runRoot, token, executable, output]);
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

function waitForSpawn(
  child,
  budget,
  {
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel = scheduledTimer => clearTimeout(scheduledTimer),
    lateErrorGuard,
  } = {},
) {
  const remainingMs = remainingPhaseBudget(budget);
  let timer;
  let settled = false;
  let resolveSpawn;
  let rejectSpawn;
  const settle = (complete, value, beforeSettle) => {
    if (settled) {
      return;
    }
    beforeSettle?.();
    settled = true;
    complete(value);
  };
  const onSpawn = () => settle(resolveSpawn);
  const onError = error => settle(rejectSpawn, error, lateErrorGuard?.activate);
  const waiting = new Promise((resolve, reject) => {
    resolveSpawn = resolve;
    rejectSpawn = reject;
    child.once('spawn', onSpawn);
    child.once('error', onError);
    timer = schedule(
      () => settle(
        reject,
        new Error(`${budget.phase} timed out after ${budget.timeoutMs}ms`),
        lateErrorGuard?.activate,
      ),
      remainingMs,
    );
    timer?.unref?.();
  });
  return waiting.finally(() => {
    child.off('spawn', onSpawn);
    child.off('error', onError);
    if (timer !== undefined) {
      cancel(timer);
    }
  });
}

function createLateSpawnErrorGuard(child) {
  let active = false;
  const consumeLateError = () => undefined;
  const release = () => {
    if (!active) {
      return;
    }
    active = false;
    child.off('error', consumeLateError);
    child.off('exit', release);
    child.off('close', release);
  };
  const activate = () => {
    if (active) {
      return;
    }
    active = true;
    child.on('error', consumeLateError);
    child.once('exit', release);
    child.once('close', release);
    if (child.exitCode !== null || child.signalCode !== null) {
      release();
    }
  };
  return { activate, release };
}

function observeChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ type: 'exit', code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ type: 'exit', code, signal }));
  });
}

export function packagedSmokeLaunchArguments(run, kind) {
  if (!['first', 'second'].includes(kind)) {
    throw new Error('packaged smoke instance kind must be first or second');
  }
  const fileIndex = kind === 'first' ? 0 : 1;
  return run.absoluteFiles[fileIndex] === undefined ? [] : [run.absoluteFiles[fileIndex]];
}

export async function launchPackagedSmokeInstance(
  { run, kind, budget },
  {
    spawnProcess = spawn,
    capture = captureProcessIdentity,
    waitForReport = waitForStartupReport,
    startMonitor = startProcessTreeMonitor,
    createRunId = randomUUID,
    platform = process.platform,
    now = Date.now,
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel = timer => clearTimeout(timer),
  } = {},
) {
  const launchBudget = budget ?? createPhaseBudget(
    run.timeoutMs,
    `${kind} instance launch`,
    now,
  );
  const launchArguments = packagedSmokeLaunchArguments(run, kind);
  const runId = createRunId();
  const startupReportPath = path.join(run.logsDirectory, `${kind}-startup-report.json`);
  const preparedEnvironment = filterSpawnEnvironment(
    run.childEnvironment,
    startupReportPath,
    runId,
  );
  const sensitiveValues = [...new Set([
    ...run.sensitiveValues,
    ...preparedEnvironment.sensitiveValues,
  ])];
  const child = spawnProcess(run.executable, launchArguments, {
    cwd: run.workspace,
    detached: platform !== 'win32',
    env: { ...preparedEnvironment.environment, ...run.smokeEnvironment },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdoutLogPath = path.join(run.logsDirectory, `${kind}-stdout.log`);
  const stderrLogPath = path.join(run.logsDirectory, `${kind}-stderr.log`);
  const logCapture = attachBoundedLogCapture(
    child,
    { stdoutLogPath, stderrLogPath },
    sensitiveValues,
  );
  const instance = {
    kind,
    child,
    identity: undefined,
    monitor: undefined,
    logCapture,
    stdoutLogPath,
    stderrLogPath,
    startupReportPath,
    runId,
    platform,
    containmentVerified: false,
    cleanupComplete: false,
  };
  const lateErrorGuard = createLateSpawnErrorGuard(child);
  try {
    const exitObservation = observeChildExit(child);
    await waitForSpawn(child, launchBudget, { schedule, cancel, lateErrorGuard });
    const remainingMs = remainingPhaseBudget(launchBudget);
    const identityObservation = Promise.resolve()
      .then(() => capture(child.pid, {
        platform,
        timeoutMs: Math.min(2_000, remainingMs),
        pollMs: Math.min(25, remainingMs),
      }))
      .then(
        identity => ({ type: 'identity', identity }),
        error => ({ type: 'identity-error', error }),
      );
    const reportObservation = waitForReport(startupReportPath, {
      timeoutMs: remainingMs,
      pollMs: Math.min(10, remainingMs),
      phase: 'process',
    }).then(
      report => ({ report }),
      error => ({ error }),
    );
    const attestContainment = async () => {
      const observation = await reportObservation;
      if (observation.error) {
        throw observation.error;
      }
      const { report } = observation;
      if (report.pid !== child.pid) {
        throw new Error(`${kind} startup report pid does not match the spawned process`);
      }
      instance.containmentVerified = true;
    };
    const firstObservation = await Promise.race([identityObservation, exitObservation]);
    if (firstObservation.type === 'exit') {
      await attestContainment();
      if (firstObservation.code !== 0) {
        throw new Error(`${kind} instance failed with exit code ${firstObservation.code}`);
      }
      if (kind === 'first') {
        throw new Error('first instance exited before identity capture');
      }
      return instance;
    }
    if (firstObservation.type === 'identity-error') {
      throw firstObservation.error;
    }
    instance.identity = firstObservation.identity;
    instance.monitor = startMonitor(instance.identity, { child });
    await attestContainment();
    return instance;
  } catch (error) {
    const failures = [];
    appendFailure(failures, 'primary', error);
    try {
      await cleanupPackagedSmokeInstances([instance]);
    } catch (cleanupError) {
      appendFailure(failures, 'process-cleanup', cleanupError);
    }
    try {
      await logCapture.persist();
    } catch (preservationError) {
      appendFailure(failures, 'diagnostic-preservation', preservationError);
    } finally {
      lateErrorGuard.release();
    }
    throw aggregatePackagedSmokeFailures(failures, run.sensitiveValues);
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
  budget,
  now = Date.now,
  delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
}) {
  const waitBudget = budget ?? createPhaseBudget(run.timeoutMs, phase, now);
  while (true) {
    remainingPhaseBudget(waitBudget);
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
    await delay(Math.min(POLL_MS, remainingPhaseBudget(waitBudget)));
  }
}

async function waitForForwardingStartedDefault({ run, first, budget }) {
  return waitForJsonArtifact({
    run,
    first,
    phase: 'second-file-forwarding started progress',
    validate: validateSmokeProgress,
    accept: progress => {
      const final = progress.steps.at(-1);
      return final?.action === 'second-file-forwarding' && final.state === 'started';
    },
    budget,
  });
}

export async function waitForPackagedSmokeFinalReport({ run, first, budget }) {
  const final = await waitForJsonArtifact({
    run,
    first,
    phase: 'final smoke report',
    validate: (value, context) => {
      try {
        return validateSmokeReport(value, context);
      } catch (reportError) {
        try {
          validateSmokeProgress(value, context);
          return undefined;
        } catch {
          throw reportError;
        }
      }
    },
    accept: candidate => candidate !== undefined,
    budget,
  });
  if (final.status !== 'passed') {
    throw new Error(final.diagnostic.message);
  }
  return final;
}

export async function waitForPackagedSmokeInstanceExit(instance, { run, phase, budget }) {
  if (!childHasExited(instance)) {
    const waitBudget = budget ?? createPhaseBudget(run.timeoutMs, phase);
    const remainingMs = remainingPhaseBudget(waitBudget, phase);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clear();
        reject(new Error(`${phase} timed out after ${waitBudget.timeoutMs}ms`));
      }, remainingMs);
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

export async function cleanupPackagedSmokeInstances(
  instances,
  {
    terminate = terminateMeasuredTree,
    discoverMarked = discoverMarkedProcessSnapshot,
  } = {},
) {
  const failures = [];
  for (const instance of [...instances].reverse()) {
    if (instance.cleanupComplete) {
      continue;
    }
    try {
      const trackedProcesses = await instance.monitor?.stop() ?? [];
      let rootIdentity = instance.identity;
      let cleanupTrackedProcesses = trackedProcesses;
      if (!rootIdentity
          && instance.containmentVerified
          && instance.platform !== 'win32') {
        const snapshot = discoverMarked(instance.runId, instance.platform);
        rootIdentity = snapshot.markedRows.find(row => row.pid === instance.child.pid)
          ?? snapshot.markedRows[0];
        cleanupTrackedProcesses = snapshot.markedRows;
        if (!rootIdentity) {
          instance.cleanupComplete = true;
          continue;
        }
      }
      await terminate({
        child: instance.child,
        rootPid: rootIdentity?.pid ?? instance.child.pid,
        rootIdentity,
        trackedProcesses: cleanupTrackedProcesses,
        containmentVerified: instance.containmentVerified,
        runId: instance.runId,
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
    .slice(0, MAX_FAILURE_MESSAGE_LENGTH) || 'Packaged smoke failed.';
  const categories = Array.isArray(error.failureCategories)
    ? error.failureCategories.filter(category => Object.hasOwn(FAILURE_CATALOG, category))
    : ['primary'];
  const artifact = {
    schema: FAILURE_SCHEMA,
    version: 1,
    status: 'failed',
    diagnostic: { message, categories: [...new Set(categories)] },
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
    now: Date.now,
    verifyProfile: async () => {
      const definition = scenarioDefinition(options.scenario);
      const metadata = await readCampaignMetadata({ options, executable: options.executable });
      if (metadata.build.profile !== definition.profile) {
        throw new Error('packaged profile does not match the requested smoke scenario');
      }
    },
    createRun: () => createSmokeRunArtifacts(options),
    launchInstance: launchPackagedSmokeInstance,
    waitForForwardingStarted: waitForForwardingStartedDefault,
    waitForInstanceExit: waitForPackagedSmokeInstanceExit,
    waitForFinalReport: waitForPackagedSmokeFinalReport,
    requestGracefulClose: (instance, { budget }) => requestGracefulProcessClose(
      instance.identity,
      instance.platform ?? process.platform,
      {
        timeoutMs: remainingPhaseBudget(budget),
        now: budget.now,
      },
    ),
    cleanupInstances: cleanupPackagedSmokeInstances,
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

function appendFailure(failures, category, error) {
  const nested = error?.[failureEntriesSymbol];
  const entries = Array.isArray(nested) && nested.length > 0
    ? nested
    : [{ category, error }];
  for (const entry of entries) {
    if (failures.length >= MAX_FAILURE_ENTRIES) {
      break;
    }
    failures.push({
      category: Object.hasOwn(FAILURE_CATALOG, entry.category) ? entry.category : category,
      error: entry.error,
    });
  }
}

function boundedErrorDetails(error, sensitiveValues) {
  const pending = [error];
  const seen = new Set();
  const details = [];
  while (pending.length > 0 && seen.size < MAX_FAILURE_ENTRIES) {
    const current = pending.shift();
    if (current !== null && (typeof current === 'object' || typeof current === 'function')) {
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
    }
    let rawMessage;
    try {
      rawMessage = typeof current?.message === 'string' ? current.message : String(current);
    } catch {
      rawMessage = 'unrenderable error';
    }
    const detail = redactDiagnosticText(rawMessage, sensitiveValues)
      .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
      .trim()
      .slice(0, MAX_FAILURE_DETAIL_LENGTH);
    if (detail && !details.includes(detail)) {
      details.push(detail);
    }
    if (current !== null && (typeof current === 'object' || typeof current === 'function')) {
      if (current.cause !== undefined) {
        pending.push(current.cause);
      }
      if (Array.isArray(current.errors)) {
        pending.push(...current.errors.slice(0, MAX_FAILURE_ENTRIES - pending.length));
      }
    }
  }
  return details;
}

export function aggregatePackagedSmokeFailures(failures, sensitiveValues = []) {
  const normalized = failures.slice(0, MAX_FAILURE_ENTRIES).map(entry => ({
    category: Object.hasOwn(FAILURE_CATALOG, entry.category) ? entry.category : 'primary',
    error: entry.error,
  }));
  const categories = [...new Set(normalized.map(({ category }) => category))];
  const summary = categories.map(category => FAILURE_CATALOG[category]).join('; ')
    || FAILURE_CATALOG.primary;
  const details = normalized.flatMap(({ category, error }) => {
    const rendered = boundedErrorDetails(error, sensitiveValues);
    return rendered.length > 0 ? [`${FAILURE_CATALOG[category]}: ${rendered.join(' <- ')}`] : [];
  });
  const message = `${summary}${details.length > 0 ? `. ${details.join('; ')}` : ''}`
    .slice(0, MAX_FAILURE_MESSAGE_LENGTH);
  const sanitizedErrors = normalized.map(({ error }) => {
    const rendered = boundedErrorDetails(error, sensitiveValues).join(' <- ')
      .slice(0, MAX_FAILURE_DETAIL_LENGTH) || 'Packaged smoke failed.';
    const sanitized = new Error(rendered);
    return sanitized;
  });
  const aggregate = new AggregateError(sanitizedErrors, message);
  aggregate.name = 'PackagedSmokeFailure';
  Object.defineProperty(aggregate, 'failureCategories', {
    value: Object.freeze(categories),
    enumerable: true,
  });
  Object.defineProperty(aggregate, failureEntriesSymbol, {
    value: Object.freeze(normalized.map((entry, index) => Object.freeze({
      category: entry.category,
      error: sanitizedErrors[index],
    }))),
  });
  return aggregate;
}

export async function runPackagedSmoke(options, injectedDependencies) {
  const dependencies = {
    ...defaultDependencies(options),
    ...injectedDependencies,
  };
  let run;
  const instances = [];
  let cleanupComplete = false;
  const failures = [];
  let finalReport;
  const now = dependencies.now ?? Date.now;
  const phaseBudget = phase => createPhaseBudget(
    run?.timeoutMs ?? options.timeoutMs,
    phase,
    now,
  );
  try {
    await dependencies.verifyProfile(options);
    run = await dependencies.createRun(options);
    const definition = assertRunMatchesScenario(run, options.scenario);
    const first = await dependencies.launchInstance({
      run,
      kind: 'first',
      budget: phaseBudget('first instance launch'),
    });
    instances.push(first);
    if (definition.actions.includes('second-file-forwarding')) {
      const progress = validateSmokeProgress(
        await dependencies.waitForForwardingStarted({
          run,
          first,
          budget: phaseBudget('second-file-forwarding started progress'),
        }),
        run.context,
      );
      const forwarding = progress.steps.at(-1);
      if (forwarding.action !== 'second-file-forwarding' || forwarding.state !== 'started') {
        throw new Error('second-file-forwarding started progress was not observed');
      }
      const second = await dependencies.launchInstance({
        run,
        kind: 'second',
        budget: phaseBudget('second instance launch'),
      });
      instances.push(second);
      await dependencies.waitForInstanceExit(second, {
        run,
        phase: 'second instance exit',
        budget: phaseBudget('second instance exit'),
      });
    }
    finalReport = validateSmokeReport(
      await dependencies.waitForFinalReport({
        run,
        first,
        budget: phaseBudget('final smoke report'),
      }),
      run.context,
    );
    if (finalReport.status !== 'passed') {
      throw new Error(finalReport.diagnostic.message);
    }
    const gracefulBudget = phaseBudget('first instance graceful exit');
    await dependencies.requestGracefulClose(first, { run, budget: gracefulBudget });
    await dependencies.waitForInstanceExit(first, {
      run,
      phase: 'first instance graceful exit',
      budget: gracefulBudget,
    });
    try {
      await dependencies.cleanupInstances(instances, { run });
    } catch (cleanupError) {
      const cleanupFailures = [];
      appendFailure(cleanupFailures, 'process-cleanup', cleanupError);
      throw aggregatePackagedSmokeFailures(cleanupFailures, run.sensitiveValues);
    }
    cleanupComplete = true;
    await dependencies.validateLogs({ run, instances });
    await dependencies.publishResult({ run, report: finalReport });
  } catch (error) {
    appendFailure(failures, 'primary', error);
  } finally {
    if (instances.length > 0 && !cleanupComplete) {
      try {
        await dependencies.cleanupInstances(instances, { run });
        cleanupComplete = true;
      } catch (cleanupError) {
        appendFailure(failures, 'process-cleanup', cleanupError);
      }
    }
    if (run !== undefined) {
      if (failures.length > 0) {
        try {
          await dependencies.preserveFailure({
            run,
            instances,
            error: aggregatePackagedSmokeFailures(failures, run.sensitiveValues),
            report: finalReport,
          });
        } catch (preservationError) {
          appendFailure(failures, 'diagnostic-preservation', preservationError);
        }
      }
      try {
        await dependencies.cleanupRun(run);
      } catch (cleanupError) {
        appendFailure(failures, 'workspace-cleanup', cleanupError);
      }
    }
  }
  if (failures.length > 0) {
    throw aggregatePackagedSmokeFailures(failures, run?.sensitiveValues ?? []);
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
      throw new Error('unknown packaged smoke option');
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

function cliSensitivePaths(argv) {
  const sensitivePaths = [applicationRoot, scriptDirectory];
  const pathOptions = new Set(['--bundle-root', '--executable', '--output']);
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (!pathOptions.has(argv[index]) || argv[index + 1].startsWith('--')) {
      continue;
    }
    const resolved = path.resolve(argv[index + 1]);
    sensitivePaths.push(resolved, path.dirname(resolved));
    index += 1;
  }
  return [...new Set(sensitivePaths)];
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
  const cliArguments = process.argv.slice(2);
  main(cliArguments).catch(error => {
    process.stderr.write(`${redactDiagnosticText(
      error?.stack ?? String(error),
      cliSensitivePaths(cliArguments),
    )}\n`);
    process.exitCode = 1;
  });
}
