/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const MEASUREMENT_SCHEMA = 'ride.startup-measurement';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const PROFILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
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
const MILESTONES = [
  'process_started',
  'native_window_visible',
  'backend_spawned',
  'backend_listening',
  'frontend_shell_attached',
  'target_file_opened',
  'plugins_started',
  'plugins_ready',
];
const NODE_TO_REPORT_PLATFORM = { win32: 'windows', darwin: 'macos', linux: 'linux' };
const NODE_TO_REPORT_ARCH = { x64: 'x86_64', arm64: 'aarch64' };

export const HISTORICAL_BASELINE_MIGRATION = Object.freeze({
  schema: 'ride.startup-measurement-v1-baseline-migration',
  version: 1,
  id: 'pre-optimization-windows-x64-d034943',
  commit: 'd034943b7a6094808b2ffe56eea2b41c3666b613',
  hostFingerprint: 'c9d29a9892dd025c849e37d6217666e51451ce32c3c3a57390aa8d2dd1f98c37',
  measurementSha256: '4be0515d823807c82d4d4e8c70319e503d98a17230c3e740be14c2322d38e004',
});

function fail(message) {
  throw new Error(message);
}

function plainObject(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, label) {
  plainObject(value, label);
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      fail(`${label} has unexpected field ${key}`);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      fail(`${label} is missing field ${key}`);
    }
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function legacyMeasurementSha256(measurement) {
  const contents = Object.fromEntries(
    Object.entries(measurement).filter(([key]) => key !== 'migration'),
  );
  return createHash('sha256').update(canonicalJson(contents)).digest('hex');
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value, label) {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) {
    fail(`${label} must be positive`);
  }
  return parsed;
}

function safeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    fail(`${label} must be a non-negative safe number`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function median(values) {
  const sorted = values.map((value, index) => safeNumber(value, `median value ${index}`))
    .sort((left, right) => left - right);
  if (sorted.length === 0) {
    fail('median requires at least one value');
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateBuild(build, label) {
  exactKeys(build, [
    'commit',
    'profile',
    'profileSha256',
    'pluginManifestSha256',
    'pluginCount',
  ], `${label} build`);
  if (!COMMIT_PATTERN.test(build.commit)) {
    fail(`${label} build commit must be a canonical 40-character SHA-1`);
  }
  if (!PROFILE_PATTERN.test(build.profile)) {
    fail(`${label} build profile must be canonical`);
  }
  for (const field of ['profileSha256', 'pluginManifestSha256']) {
    if (!SHA256_PATTERN.test(build[field])) {
      fail(`${label} build ${field} must be a canonical SHA-256`);
    }
  }
  positiveInteger(build.pluginCount, `${label} build pluginCount`);
}

function validateHost(host, measurement, label) {
  exactKeys(host, ['platform', 'arch', 'fingerprint'], `${label} host`);
  if (host.platform !== measurement.platform || host.arch !== measurement.arch) {
    fail(`${label} host platform and architecture must match its measurement`);
  }
  if (!SHA256_PATTERN.test(host.fingerprint)) {
    fail(`${label} host fingerprint must be a canonical SHA-256`);
  }
}

function validateRoles(roles, label, expectedCount, expectedRss) {
  exactKeys(roles, ROLES, `${label} roles`);
  let processCount = 0;
  let rssBytes = 0;
  for (const role of ROLES) {
    exactKeys(roles[role], ['processCount', 'rssBytes'], `${label} ${role}`);
    processCount += nonNegativeInteger(roles[role].processCount, `${label} ${role} processCount`);
    rssBytes += nonNegativeInteger(roles[role].rssBytes, `${label} ${role} rssBytes`);
    if (!Number.isSafeInteger(processCount) || !Number.isSafeInteger(rssBytes)) {
      fail(`${label} role totals must be safe integers`);
    }
  }
  if (processCount !== expectedCount || rssBytes !== expectedRss) {
    fail(`${label} role totals do not match processCount and rssBytes`);
  }
}

function validateStartupReport(report, measurement, label) {
  exactKeys(report, ['schema', 'version', 'platform', 'arch', 'pid', 'milestones'], `${label} startup report`);
  if (report.schema !== 'ride.startup-report' || report.version !== 1) {
    fail(`${label} startup report must use ride.startup-report@1`);
  }
  if (report.platform !== NODE_TO_REPORT_PLATFORM[measurement.platform]
      || report.arch !== NODE_TO_REPORT_ARCH[measurement.arch]) {
    fail(`${label} startup report platform or architecture is incompatible`);
  }
  positiveInteger(report.pid, `${label} startup report pid`);
  exactKeys(report.milestones, MILESTONES, `${label} milestones`);
  let previous = -1;
  for (const milestone of MILESTONES) {
    const value = nonNegativeInteger(report.milestones[milestone], `${label} ${milestone}`);
    if (value < previous) {
      fail(`${label} milestones must be monotonic`);
    }
    previous = value;
  }
}

function validateProcessIdentity(identity, label) {
  exactKeys(identity, ['pid', 'pgid', 'creationTime', 'startedAt'], label);
  positiveInteger(identity.pid, `${label} pid`);
  if (identity.pgid !== null) {
    positiveInteger(identity.pgid, `${label} pgid`);
  }
  nonEmptyString(identity.creationTime, `${label} creationTime`);
  safeNumber(identity.startedAt, `${label} startedAt`);
}

function validateV2Run(run, measurement, index) {
  const label = `candidate run ${index + 1}`;
  exactKeys(run, ['startupReport', 'metrics'], label);
  validateStartupReport(run.startupReport, measurement, label);
  exactKeys(run.metrics, [
    'rootPid',
    'rootIdentity',
    'processIds',
    'processCount',
    'rssBytes',
    'roles',
    'processes',
  ], `${label} metrics`);
  const rootPid = positiveInteger(run.metrics.rootPid, `${label} rootPid`);
  const processCount = positiveInteger(run.metrics.processCount, `${label} processCount`);
  const rssBytes = nonNegativeInteger(run.metrics.rssBytes, `${label} rssBytes`);
  validateProcessIdentity(run.metrics.rootIdentity, `${label} rootIdentity`);
  if (run.metrics.rootIdentity.pid !== rootPid || run.startupReport.pid !== rootPid) {
    fail(`${label} root identity does not match its startup report`);
  }
  if (!Array.isArray(run.metrics.processIds)
      || !Array.isArray(run.metrics.processes)
      || run.metrics.processIds.length !== processCount
      || run.metrics.processes.length !== processCount) {
    fail(`${label} process arrays must match processCount`);
  }
  const ids = run.metrics.processIds.map((pid, processIndex) => (
    positiveInteger(pid, `${label} processIds[${processIndex}]`)
  ));
  if (new Set(ids).size !== ids.length || !ids.includes(rootPid)) {
    fail(`${label} processIds must be unique and contain the root`);
  }
  for (const [processIndex, processRow] of run.metrics.processes.entries()) {
    exactKeys(
      processRow,
      ['pid', 'ppid', 'pgid', 'creationTime', 'startedAt', 'depth'],
      `${label} process ${processIndex}`,
    );
    positiveInteger(processRow.pid, `${label} process ${processIndex} pid`);
    nonNegativeInteger(processRow.ppid, `${label} process ${processIndex} ppid`);
    if (processRow.pgid !== null) {
      positiveInteger(processRow.pgid, `${label} process ${processIndex} pgid`);
    }
    nonEmptyString(processRow.creationTime, `${label} process ${processIndex} creationTime`);
    safeNumber(processRow.startedAt, `${label} process ${processIndex} startedAt`);
    if (processRow.depth !== null) {
      nonNegativeInteger(processRow.depth, `${label} process ${processIndex} depth`);
    }
  }
  validateRoles(run.metrics.roles, `${label} metrics`, processCount, rssBytes);
}

function validateReportedMedians(measurement, label) {
  exactKeys(measurement.median, [
    'targetFileOpenedMs',
    'rssBytes',
    'processCount',
    'roles',
  ], `${label} median`);
  const expected = {
    targetFileOpenedMs: median(measurement.runs.map(run => (
      run.startupReport.milestones.target_file_opened
    ))),
    rssBytes: median(measurement.runs.map(run => run.metrics.rssBytes)),
    processCount: median(measurement.runs.map(run => run.metrics.processCount)),
  };
  for (const [field, value] of Object.entries(expected)) {
    safeNumber(measurement.median[field], `${label} median ${field}`);
    if (measurement.median[field] !== value) {
      fail(`${label} reported median ${field} does not match its runs`);
    }
  }
  exactKeys(measurement.median.roles, ROLES, `${label} median roles`);
  for (const role of ROLES) {
    exactKeys(
      measurement.median.roles[role],
      ['processCount', 'rssBytes'],
      `${label} median ${role}`,
    );
    for (const field of ['processCount', 'rssBytes']) {
      const expectedRoleMedian = median(measurement.runs.map(run => run.metrics.roles[role][field]));
      if (measurement.median.roles[role][field] !== expectedRoleMedian) {
        fail(`${label} reported median ${role} ${field} does not match its runs`);
      }
    }
  }
  return expected;
}

function validateV2Measurement(measurement, label, { exactlyFive }) {
  exactKeys(measurement, [
    'schema',
    'version',
    'platform',
    'arch',
    'build',
    'host',
    'runs',
    'median',
  ], label);
  if (measurement.schema !== MEASUREMENT_SCHEMA || measurement.version !== 2) {
    fail(`${label} must use ${MEASUREMENT_SCHEMA}@2`);
  }
  nonEmptyString(measurement.platform, `${label} platform`);
  nonEmptyString(measurement.arch, `${label} architecture`);
  validateBuild(measurement.build, label);
  validateHost(measurement.host, measurement, label);
  if (!Array.isArray(measurement.runs)) {
    fail(`${label} runs must be an array`);
  }
  if (exactlyFive && measurement.runs.length !== 5) {
    fail('candidate must contain exactly 5 runs');
  }
  if (measurement.runs.length === 0) {
    fail(`${label} must contain runs`);
  }
  measurement.runs.forEach((run, index) => validateV2Run(run, measurement, index));
  return {
    measurement,
    hostFingerprint: measurement.host.fingerprint,
    medians: validateReportedMedians(measurement, label),
  };
}

function validateMigration(migration) {
  exactKeys(
    migration,
    Object.keys(HISTORICAL_BASELINE_MIGRATION),
    'historical d034943 migration marker',
  );
  for (const [key, value] of Object.entries(HISTORICAL_BASELINE_MIGRATION)) {
    if (migration[key] !== value) {
      fail('baseline v1 requires the explicit historical d034943 migration marker');
    }
  }
}

function validateLegacyBaseline(measurement) {
  validateMigration(measurement?.migration);
  exactKeys(measurement, [
    'schema',
    'version',
    'platform',
    'arch',
    'commit',
    'migration',
    'runs',
    'median',
  ], 'baseline');
  if (measurement.schema !== MEASUREMENT_SCHEMA || measurement.version !== 1) {
    fail(`baseline must use ${MEASUREMENT_SCHEMA}@2`);
  }
  if (measurement.commit !== HISTORICAL_BASELINE_MIGRATION.commit) {
    fail('baseline v1 commit does not match the historical d034943 migration marker');
  }
  if (!Array.isArray(measurement.runs) || measurement.runs.length !== 5) {
    fail('historical d034943 baseline must contain exactly 5 runs');
  }
  for (const [index, run] of measurement.runs.entries()) {
    const label = `baseline run ${index + 1}`;
    exactKeys(run, ['startupReport', 'metrics'], label);
    validateStartupReport(run.startupReport, measurement, `baseline run ${index + 1}`);
    exactKeys(run.metrics, [
      'rootPid',
      'rootIdentity',
      'processIds',
      'processCount',
      'rssBytes',
      'processes',
    ], `${label} metrics`);
    const rootPid = positiveInteger(run.metrics.rootPid, `${label} rootPid`);
    const processCount = positiveInteger(run.metrics.processCount, `${label} processCount`);
    nonNegativeInteger(run.metrics.rssBytes, `${label} rssBytes`);
    validateProcessIdentity(run.metrics.rootIdentity, `${label} rootIdentity`);
    if (run.metrics.rootIdentity.pid !== rootPid || run.startupReport.pid !== rootPid) {
      fail(`${label} root identity does not match its startup report`);
    }
    if (!Array.isArray(run.metrics.processIds)
        || !Array.isArray(run.metrics.processes)
        || run.metrics.processIds.length !== processCount
        || run.metrics.processes.length !== processCount) {
      fail(`${label} process arrays must match processCount`);
    }
    const processIds = run.metrics.processIds.map((pid, processIndex) => (
      positiveInteger(pid, `${label} processIds[${processIndex}]`)
    ));
    if (new Set(processIds).size !== processIds.length || !processIds.includes(rootPid)) {
      fail(`${label} processIds must be unique and contain the root`);
    }
    for (const [processIndex, processRow] of run.metrics.processes.entries()) {
      exactKeys(
        processRow,
        ['pid', 'ppid', 'pgid', 'creationTime', 'startedAt', 'depth'],
        `${label} process ${processIndex}`,
      );
      positiveInteger(processRow.pid, `${label} process ${processIndex} pid`);
      nonNegativeInteger(processRow.ppid, `${label} process ${processIndex} ppid`);
      if (processRow.pgid !== null) {
        positiveInteger(processRow.pgid, `${label} process ${processIndex} pgid`);
      }
      nonEmptyString(processRow.creationTime, `${label} process ${processIndex} creationTime`);
      safeNumber(processRow.startedAt, `${label} process ${processIndex} startedAt`);
      if (processRow.depth !== null) {
        nonNegativeInteger(processRow.depth, `${label} process ${processIndex} depth`);
      }
    }
  }
  exactKeys(
    measurement.median,
    ['targetFileOpenedMs', 'rssBytes', 'processCount'],
    'baseline median',
  );
  const medians = {
    targetFileOpenedMs: median(measurement.runs.map(run => (
      run.startupReport.milestones.target_file_opened
    ))),
    rssBytes: median(measurement.runs.map(run => run.metrics.rssBytes)),
    processCount: median(measurement.runs.map(run => run.metrics.processCount)),
  };
  for (const [field, expected] of Object.entries(medians)) {
    if (measurement.median[field] !== expected) {
      fail(`baseline reported median ${field} does not match its runs`);
    }
  }
  if (legacyMeasurementSha256(measurement)
      !== HISTORICAL_BASELINE_MIGRATION.measurementSha256) {
    fail('historical d034943 baseline contents do not match the fixed measurement digest');
  }
  return {
    measurement,
    hostFingerprint: measurement.migration.hostFingerprint,
    medians,
  };
}

function validateBaseline(measurement) {
  if (measurement?.version === 1) {
    return validateLegacyBaseline(measurement);
  }
  return validateV2Measurement(measurement, 'baseline', { exactlyFive: false });
}

function validateGain(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    fail(`${label} must be an integer from 0 through 100`);
  }
  return value;
}

function gainTarget(baseline, gain) {
  return Number((BigInt(baseline) * BigInt(100 - gain)) / 100n);
}

export function compareTauriPerformance(
  baselineMeasurement,
  candidateMeasurement,
  { minStartupGain = 30, minMemoryGain = 10 } = {},
) {
  const startupGain = validateGain(minStartupGain, 'minimum startup gain');
  const memoryGain = validateGain(minMemoryGain, 'minimum memory gain');
  const baseline = validateBaseline(baselineMeasurement);
  const candidate = validateV2Measurement(candidateMeasurement, 'candidate', { exactlyFive: true });
  if (baseline.measurement.platform !== candidate.measurement.platform) {
    fail('baseline and candidate platform are incompatible');
  }
  if (baseline.measurement.arch !== candidate.measurement.arch) {
    fail('baseline and candidate architecture are incompatible');
  }
  if (baseline.hostFingerprint !== candidate.hostFingerprint) {
    fail('baseline and candidate host fingerprint are incompatible');
  }
  if (baseline.measurement.version === 2) {
    for (const field of [
      'profile',
      'profileSha256',
      'pluginManifestSha256',
      'pluginCount',
    ]) {
      if (baseline.measurement.build[field] !== candidate.measurement.build[field]) {
        fail(`baseline and candidate build ${field} are incompatible`);
      }
    }
  }

  const startupTarget = gainTarget(baseline.medians.targetFileOpenedMs, startupGain);
  const memoryTarget = gainTarget(baseline.medians.rssBytes, memoryGain);
  const startupActual = candidate.medians.targetFileOpenedMs;
  const memoryActual = candidate.medians.rssBytes;
  const failures = [];
  if (startupActual > startupTarget) {
    failures.push(
      `startup: actual ${startupActual} ms, target ${startupTarget} ms, delta +${startupActual - startupTarget} ms`,
    );
  }
  if (memoryActual > memoryTarget) {
    failures.push(
      `memory: actual ${memoryActual} bytes, target ${memoryTarget} bytes, delta +${memoryActual - memoryTarget} bytes`,
    );
  }
  if (failures.length > 0) {
    fail(`Tauri performance targets failed:\n${failures.join('\n')}`);
  }
  return {
    runs: candidate.measurement.runs.length,
    startup: {
      actual: startupActual,
      target: startupTarget,
      delta: startupActual - startupTarget,
    },
    memory: {
      actual: memoryActual,
      target: memoryTarget,
      delta: memoryActual - memoryTarget,
    },
  };
}

function readMeasurement(filePath, label) {
  const resolved = path.resolve(filePath);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_ARTIFACT_BYTES) {
    fail(`${label} must be a bounded regular JSON file`);
  }
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function parseArguments(argv) {
  const options = { minStartupGain: 30, minMemoryGain: 10 };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument.startsWith('--') || value === undefined) {
      fail(`expected --option value, received ${argument}`);
    }
    index++;
    if (argument === '--baseline') {
      options.baseline = value;
    } else if (argument === '--candidate') {
      options.candidate = value;
    } else if (argument === '--min-startup-gain') {
      options.minStartupGain = Number(value);
    } else if (argument === '--min-memory-gain') {
      options.minMemoryGain = Number(value);
    } else {
      fail(`unsupported option ${argument}`);
    }
  }
  if (!options.baseline || !options.candidate) {
    fail('--baseline and --candidate are required');
  }
  return options;
}

function main(argv) {
  const options = parseArguments(argv);
  const result = compareTauriPerformance(
    readMeasurement(options.baseline, 'baseline'),
    readMeasurement(options.candidate, 'candidate'),
    options,
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
