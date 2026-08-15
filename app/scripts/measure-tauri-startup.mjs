/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPORT_SCHEMA = 'ride.startup-report';
const REPORT_VERSION = 1;
const MEASUREMENT_SCHEMA = 'ride.startup-measurement';
const MEASUREMENT_VERSION = 1;
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
const RUST_PLATFORMS = new Set(['windows', 'linux', 'macos']);
const RUST_ARCHITECTURES = new Set(['x86_64', 'aarch64']);
const NODE_TO_RUST_PLATFORM = {
  win32: 'windows',
  linux: 'linux',
  darwin: 'macos',
};
const NODE_TO_RUST_ARCHITECTURE = {
  x64: 'x86_64',
  arm64: 'aarch64',
};

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const applicationRoot = path.resolve(scriptDirectory, '..');
const defaultBundleRoot = path.join(
  applicationRoot,
  'applications',
  'tauri',
  'src-tauri',
  'target',
);

function existingFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function walkFiles(directory, predicate, depth = 0) {
  if (depth > 8 || !fs.existsSync(directory)) {
    return [];
  }
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(entryPath, predicate, depth + 1));
    } else if (entry.isFile() && predicate(entryPath)) {
      results.push(entryPath);
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

export function discoverExecutable(bundleRoot = defaultBundleRoot, platform = process.platform) {
  const root = path.resolve(bundleRoot);
  const release = path.join(root, 'release');

  if (platform === 'win32') {
    const preferred = [
      path.join(release, 'ride-tauri.exe'),
      path.join(release, 'R-IDE.exe'),
    ].find(existingFile);
    if (preferred) {
      return preferred;
    }
    const directExecutables = fs.existsSync(release)
      ? fs.readdirSync(release, { withFileTypes: true })
        .filter(entry => entry.isFile()
          && entry.name.toLowerCase().endsWith('.exe')
          && !/(?:setup|install|uninstall)/i.test(entry.name))
        .map(entry => path.join(release, entry.name))
        .sort()
      : [];
    if (directExecutables.length > 0) {
      return directExecutables[0];
    }
  } else if (platform === 'darwin') {
    const macosBundle = path.join(release, 'bundle', 'macos');
    const appPayloads = walkFiles(
      macosBundle,
      candidate => /\.app[\\/]Contents[\\/]MacOS[\\/][^\\/]+$/.test(candidate),
    );
    if (appPayloads.length > 0) {
      return appPayloads[0];
    }
  } else if (platform === 'linux') {
    const preferred = [
      path.join(release, 'ride-tauri'),
      path.join(release, 'R-IDE'),
      path.join(release, 'r-ide'),
    ].find(existingFile);
    if (preferred) {
      return preferred;
    }
    const appImages = walkFiles(
      path.join(release, 'bundle', 'appimage'),
      candidate => candidate.endsWith('.AppImage'),
    );
    if (appImages.length > 0) {
      return appImages[0];
    }
  } else {
    throw new Error(`unsupported desktop platform ${platform}`);
  }

  throw new Error(`could not discover a runnable Tauri executable under ${root}`);
}

function assertPlainObject(value, name) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertExactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(name === 'milestone'
        ? `unexpected milestone ${key}`
        : `unexpected ${name} field ${key}`);
    }
  }
}

function currentRustTarget() {
  const platform = NODE_TO_RUST_PLATFORM[process.platform];
  const arch = NODE_TO_RUST_ARCHITECTURE[process.arch];
  if (!platform || !arch) {
    throw new Error(`unsupported measurement runner ${process.platform}/${process.arch}`);
  }
  return { platform, arch };
}

export function parseStartupReport(
  serialized,
  {
    expectedPlatform = currentRustTarget().platform,
    expectedArch = currentRustTarget().arch,
    phase = 'target',
  } = {},
) {
  let report;
  try {
    report = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`startup report is not valid JSON: ${error.message}`);
  }
  assertPlainObject(report, 'startup report');
  assertExactKeys(
    report,
    new Set(['schema', 'version', 'platform', 'arch', 'pid', 'milestones']),
    'report',
  );
  if (report.schema !== REPORT_SCHEMA || report.version !== REPORT_VERSION) {
    throw new Error(`unsupported startup report schema ${report.schema}@${report.version}`);
  }
  if (!RUST_PLATFORMS.has(report.platform)) {
    throw new Error(`unsupported startup report platform ${report.platform}`);
  }
  if (!RUST_ARCHITECTURES.has(report.arch)) {
    throw new Error(`unsupported startup report architecture ${report.arch}`);
  }
  if (!RUST_PLATFORMS.has(expectedPlatform) || !RUST_ARCHITECTURES.has(expectedArch)) {
    throw new Error(`unsupported expected startup target ${expectedPlatform}/${expectedArch}`);
  }
  if (report.platform !== expectedPlatform) {
    throw new Error(
      `startup report platform ${report.platform} does not match expected ${expectedPlatform}`,
    );
  }
  if (report.arch !== expectedArch) {
    throw new Error(`startup report architecture ${report.arch} does not match expected ${expectedArch}`);
  }
  if (!Number.isSafeInteger(report.pid) || report.pid <= 0) {
    throw new Error('startup report pid must be a positive safe integer');
  }
  assertPlainObject(report.milestones, 'startup report milestones');
  assertExactKeys(report.milestones, new Set(MILESTONES), 'milestone');
  if (phase !== 'incremental' && phase !== 'target' && phase !== 'final') {
    throw new Error(`unsupported startup report phase ${phase}`);
  }
  const milestoneKeys = Object.keys(report.milestones);
  const expectedPrefix = MILESTONES.slice(0, milestoneKeys.length);
  const requiredPrefixLength = phase === 'incremental' ? 1 : 6;
  if (milestoneKeys.length < requiredPrefixLength
      || milestoneKeys.some((milestone, index) => milestone !== expectedPrefix[index])) {
    throw new Error(phase === 'incremental'
      ? 'startup report must contain a non-empty canonical milestone prefix'
      : 'startup report must contain the canonical milestone prefix through target_file_opened');
  }
  if (phase === 'final' && milestoneKeys.length !== MILESTONES.length) {
    throw new Error('startup report must contain the complete final milestone sequence');
  }

  let latest = -1;
  for (const milestone of milestoneKeys) {
    const elapsed = report.milestones[milestone];
    if (!Number.isSafeInteger(elapsed) || elapsed < 0) {
      throw new Error(`milestone ${milestone} must be a non-negative safe integer`);
    }
    if (elapsed < latest) {
      throw new Error(`startup milestone ${milestone} is not monotonic`);
    }
    latest = elapsed;
  }
  return report;
}

export function median(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('median requires at least one value');
  }
  if (values.some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('median values must be non-negative safe integers');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  const exactSum = BigInt(sorted[middle - 1]) + BigInt(sorted[middle]);
  if (exactSum % 2n !== 0n) {
    if (exactSum > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('even samples do not have an exactly representable safe integer median');
    }
    return Number(exactSum) / 2;
  }
  return Number(exactSum / 2n);
}

function positiveInteger(value, name) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

export function parsePosixProcessTable(output) {
  const rows = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) {
      throw new Error(`invalid ps process row: ${line}`);
    }
    const pid = positiveInteger(match[1], 'ps pid');
    const ppid = positiveInteger(match[2], 'ps ppid');
    const pgid = positiveInteger(match[3], 'ps pgid');
    const rssKiB = positiveInteger(match[4], 'ps RSS');
    const creationTime = match[5].trim();
    if (pid === 0) {
      throw new Error('ps pid must be positive');
    }
    if (pgid === 0) {
      throw new Error('ps pgid must be positive');
    }
    if (!creationTime) {
      throw new Error('ps lstart must not be empty');
    }
    if (rssKiB > Math.floor(Number.MAX_SAFE_INTEGER / 1024)) {
      throw new Error('ps RSS bytes must be a non-negative safe integer');
    }
    rows.push({ pid, ppid, pgid, rssBytes: rssKiB * 1024, creationTime });
  }
  return rows;
}

export function parseWindowsProcessTable(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch (error) {
    throw new Error(`PowerShell process table is not valid JSON: ${error.message}`);
  }
  const candidates = Array.isArray(payload) ? payload : [payload];
  return candidates.flatMap((candidate, index) => {
    assertPlainObject(candidate, `PowerShell process row ${index}`);
    const pid = positiveInteger(candidate.ProcessId, 'PowerShell ProcessId');
    if (pid === 0) {
      return [];
    }
    const ppid = positiveInteger(candidate.ParentProcessId, 'PowerShell ParentProcessId');
    const rssBytes = positiveInteger(candidate.WorkingSetSize, 'PowerShell WorkingSetSize');
    const creationTime = candidate.CreationDate;
    if (typeof creationTime !== 'string' || !creationTime.trim()) {
      throw new Error('PowerShell CreationDate must be a non-empty string');
    }
    return [{ pid, ppid, pgid: null, rssBytes, creationTime }];
  });
}

function processIdentity(row) {
  return {
    pid: row.pid,
    pgid: row.pgid,
    creationTime: row.creationTime,
  };
}

function sameProcessIdentity(row, identity) {
  return row.pid === identity.pid
    && row.pgid === identity.pgid
    && row.creationTime === identity.creationTime;
}

function validateProcessIdentity(identity, name = 'process identity') {
  assertPlainObject(identity, name);
  const pid = positiveInteger(identity.pid, `${name} pid`);
  if (pid === 0) {
    throw new Error(`${name} pid must be positive`);
  }
  if (identity.pgid !== null) {
    const pgid = positiveInteger(identity.pgid, `${name} pgid`);
    if (pgid === 0) {
      throw new Error(`${name} pgid must be positive`);
    }
  }
  if (typeof identity.creationTime !== 'string' || !identity.creationTime) {
    throw new Error(`${name} creation time must be a non-empty string`);
  }
  return identity;
}

export function aggregateProcessTree(rows, rootIdentity) {
  const verifiedIdentity = validateProcessIdentity(rootIdentity, 'spawned root identity');
  const verifiedRoot = verifiedIdentity.pid;
  if (!rows.some(row => sameProcessIdentity(row, verifiedIdentity))) {
    throw new Error(`spawned root process ${verifiedRoot} does not match its captured identity`);
  }
  const depths = new Map([[verifiedRoot, 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!depths.has(row.pid) && depths.has(row.ppid)) {
        depths.set(row.pid, depths.get(row.ppid) + 1);
        changed = true;
      }
    }
  }
  const selected = rows.filter(row => depths.has(row.pid));
  const orderedIds = selected.map(row => row.pid).sort((left, right) => left - right);
  let rssBytes = 0;
  for (const row of selected) {
    const processRssBytes = positiveInteger(row.rssBytes, `process ${row.pid} RSS bytes`);
    if (rssBytes > Number.MAX_SAFE_INTEGER - processRssBytes) {
      throw new Error('aggregate RSS bytes must be a non-negative safe integer');
    }
    rssBytes += processRssBytes;
  }
  return {
    rootPid: verifiedRoot,
    rootIdentity: { ...verifiedIdentity },
    processIds: orderedIds,
    processCount: orderedIds.length,
    rssBytes,
    processes: selected
      .map(row => ({
        pid: row.pid,
        ppid: row.ppid,
        pgid: row.pgid,
        creationTime: row.creationTime,
        depth: depths.get(row.pid),
      }))
      .sort((left, right) => left.pid - right.pid),
  };
}

export function planProcessCleanup(
  rows,
  rootIdentity,
  trackedProcesses = [],
  { allowTree = true } = {},
) {
  const verifiedIdentity = validateProcessIdentity(rootIdentity, 'spawned root identity');
  const rootMatches = rows.some(row => sameProcessIdentity(row, verifiedIdentity));
  if (rootMatches && allowTree) {
    return {
      mode: 'tree',
      rootPid: verifiedIdentity.pid,
      pgid: verifiedIdentity.pgid,
      processIds: [],
    };
  }

  const currentByPid = new Map(rows.map(row => [row.pid, row]));
  const trackedByPid = new Map(trackedProcesses.map(tracked => [tracked.pid, tracked]));
  if (rootMatches && !trackedByPid.has(verifiedIdentity.pid)) {
    trackedByPid.set(verifiedIdentity.pid, { ...verifiedIdentity, depth: 0 });
  }
  const processIds = [...trackedByPid.values()]
    .filter(tracked => rootMatches || tracked.pid !== verifiedIdentity.pid)
    .filter(tracked => sameProcessIdentity(currentByPid.get(tracked.pid) ?? {}, tracked))
    .sort((left, right) => (right.depth ?? 0) - (left.depth ?? 0))
    .map(tracked => tracked.pid);
  return {
    mode: 'pids',
    rootPid: verifiedIdentity.pid,
    pgid: verifiedIdentity.pgid,
    processIds,
  };
}

function readProcessTable(platform = process.platform) {
  if (platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CreationDate | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`PowerShell process query failed: ${result.error?.message ?? result.stderr}`);
    }
    return parseWindowsProcessTable(result.stdout);
  }

  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,lstart='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`ps process query failed: ${result.error?.message ?? result.stderr}`);
  }
  return parsePosixProcessTable(result.stdout);
}

export function sampleProcessTree(rootIdentity, platform = process.platform) {
  return aggregateProcessTree(readProcessTable(platform), rootIdentity);
}

export async function captureProcessIdentity(
  rootPid,
  {
    platform = process.platform,
    timeoutMs = 2_000,
    pollMs = 25,
    read = readProcessTable,
    delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now = Date.now,
  } = {},
) {
  const verifiedRoot = positiveInteger(rootPid, 'spawned root pid');
  if (verifiedRoot === 0) {
    throw new Error('spawned root pid must be positive');
  }
  const deadline = now() + timeoutMs;
  let lastReadError;
  while (true) {
    try {
      const row = read(platform).find(candidate => candidate.pid === verifiedRoot);
      if (row) {
        return validateProcessIdentity(processIdentity(row), 'spawned root identity');
      }
      lastReadError = undefined;
    } catch (error) {
      lastReadError = error;
    }
    if (now() > deadline) {
      break;
    }
    await delay(pollMs);
  }
  throw new Error(
    `spawned root process ${verifiedRoot} did not appear in the process table`
      + (lastReadError ? `: ${lastReadError.message}` : ''),
  );
}

export async function waitForStartupReport(
  reportPath,
  {
    timeoutMs = 300_000,
    pollMs = 100,
    phase = 'target',
    expectedPlatform,
    expectedArch,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const serialized = await fs.promises.readFile(reportPath, 'utf8');
      const report = parseStartupReport(serialized, {
        expectedPlatform,
        expectedArch,
        phase: 'incremental',
      });
      const milestoneCount = Object.keys(report.milestones).length;
      if (phase === 'target') {
        if (milestoneCount >= 6) {
          return parseStartupReport(serialized, {
            expectedPlatform,
            expectedArch,
            phase: 'target',
          });
        }
        await new Promise(resolve => setTimeout(resolve, pollMs));
        continue;
      }
      if (phase !== 'final') {
        throw new Error(`unsupported startup report phase ${phase}`);
      }
      if (milestoneCount === MILESTONES.length) {
        return parseStartupReport(serialized, {
          expectedPlatform,
          expectedArch,
          phase: 'final',
        });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`startup report timeout after ${timeoutMs}ms: ${reportPath}`);
}

export async function launchMeasuredProcess({
  executable,
  codeFile,
  reportPath,
  stdoutLogPath,
  stderrLogPath,
  cwd,
}) {
  const stdoutDescriptor = fs.openSync(stdoutLogPath, 'a');
  const stderrDescriptor = fs.openSync(stderrLogPath, 'a');
  let child;
  try {
    child = spawn(executable, [codeFile], {
      cwd,
      detached: process.platform !== 'win32',
      env: { ...process.env, RIDE_STARTUP_REPORT: reportPath },
      stdio: ['ignore', stdoutDescriptor, stderrDescriptor],
      windowsHide: true,
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return child;
  } finally {
    fs.closeSync(stdoutDescriptor);
    fs.closeSync(stderrDescriptor);
  }
}

export async function terminateMeasuredTree(
  {
    child,
    rootPid,
    rootIdentity,
    trackedProcesses = [],
  },
  platform = process.platform,
  {
    read = readProcessTable,
    run = (command, args) => spawnSync(command, args, {
      stdio: 'ignore',
      windowsHide: true,
    }),
    kill = (pid, signal) => process.kill(pid, signal),
    delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const verifiedRootPid = positiveInteger(rootPid, 'spawned root pid');
  const controlledChildIsRunning = child?.pid === verifiedRootPid
    && child.killed === false
    && child.exitCode === null
    && child.signalCode === null
    && typeof child.kill === 'function';
  let trustedRootIdentity = false;
  if (rootIdentity) {
    try {
      trustedRootIdentity = validateProcessIdentity(rootIdentity, 'spawned root identity').pid
        === verifiedRootPid;
    } catch {
      trustedRootIdentity = false;
    }
  }
  if (!trustedRootIdentity) {
    if (controlledChildIsRunning) {
      try {
        child.kill('SIGTERM');
      } catch {
        // The controlled child may exit immediately before its handle is signalled.
      }
      await delay(250);
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          // The controlled child may exit during the grace period.
        }
      }
    }
    return;
  }

  let rows;
  try {
    rows = read(platform);
  } catch {
    return;
  }
  const allowTree = platform === 'win32'
    || (rootIdentity.pgid === rootIdentity.pid
      && Number.isSafeInteger(rootIdentity.pgid)
      && rootIdentity.pgid > 0);
  const initialPlan = planProcessCleanup(rows, rootIdentity, trackedProcesses, { allowTree });
  if (platform === 'win32') {
    if (initialPlan.mode === 'tree') {
      run('taskkill.exe', ['/PID', String(initialPlan.rootPid), '/T', '/F']);
    } else {
      for (const pid of initialPlan.processIds) {
        run('taskkill.exe', ['/PID', String(pid), '/F']);
      }
    }
    return;
  }

  const signalPlan = (plan, signal) => {
    if (plan.mode === 'tree') {
      if (!Number.isSafeInteger(plan.pgid)
          || plan.pgid <= 0
          || plan.pgid !== plan.rootPid) {
        return;
      }
      try {
        kill(-plan.pgid, signal);
      } catch {
        // The verified root may exit between the process-table read and the signal.
      }
      return;
    }
    for (const pid of plan.processIds) {
      try {
        kill(pid, signal);
      } catch {
        // A verified descendant may exit between the process-table read and the signal.
      }
    }
  };
  signalPlan(initialPlan, 'SIGTERM');
  await delay(250);

  try {
    rows = read(platform);
  } catch {
    return;
  }
  const finalPlan = planProcessCleanup(rows, rootIdentity, trackedProcesses, {
    allowTree: allowTree && initialPlan.mode === 'tree',
  });
  signalPlan(finalPlan, 'SIGKILL');
}

const defaultMeasurementDependencies = {
  launch: launchMeasuredProcess,
  capture: captureProcessIdentity,
  waitForReport: waitForStartupReport,
  delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  sample: sampleProcessTree,
  terminate: terminateMeasuredTree,
};

export async function measureOnce(options, dependencies = defaultMeasurementDependencies) {
  const now = dependencies.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const child = await dependencies.launch(options);
  const rootPid = positiveInteger(child?.pid, 'spawned root pid');
  if (rootPid === 0) {
    throw new Error('spawned root pid must be positive');
  }
  let rootIdentity;
  let metrics;
  try {
    rootIdentity = await dependencies.capture(rootPid, {
      timeoutMs: Math.min(2_000, Math.max(0, deadline - now())),
      pollMs: Math.min(25, options.pollMs),
    });
    const startupReport = await dependencies.waitForReport(options.reportPath, {
      timeoutMs: Math.max(0, deadline - now()),
      pollMs: options.pollMs,
      phase: 'target',
      expectedPlatform: options.expectedPlatform,
      expectedArch: options.expectedArch,
    });
    if (startupReport.pid !== rootPid) {
      throw new Error(
        `startup report pid ${startupReport.pid} does not match spawned root pid ${rootPid}`,
      );
    }
    await dependencies.delay(options.idleMs);
    metrics = dependencies.sample(rootIdentity);
    const finalStartupReport = await dependencies.waitForReport(options.reportPath, {
      timeoutMs: Math.max(0, deadline - now()),
      pollMs: options.pollMs,
      phase: 'final',
      expectedPlatform: options.expectedPlatform,
      expectedArch: options.expectedArch,
    });
    if (finalStartupReport.pid !== rootPid) {
      throw new Error(
        `final startup report pid ${finalStartupReport.pid} does not match spawned root pid ${rootPid}`,
      );
    }
    return { startupReport: finalStartupReport, metrics };
  } finally {
    await dependencies.terminate({
      child,
      rootPid,
      rootIdentity,
      trackedProcesses: metrics?.processes ?? [],
    });
  }
}

function parseArguments(argv) {
  const options = {
    bundleRoot: defaultBundleRoot,
    executable: undefined,
    runs: 5,
    idleMs: 30_000,
    timeoutMs: 300_000,
    pollMs: 100,
    output: path.join(
      defaultBundleRoot,
      'release',
      'bundle',
      `startup-metrics-${process.platform}-${process.arch}.json`,
    ),
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (!argument.startsWith('--') || value === undefined) {
      throw new Error(`expected --option value, received ${argument}`);
    }
    index++;
    switch (argument) {
      case '--bundle-root': options.bundleRoot = path.resolve(value); break;
      case '--executable': options.executable = path.resolve(value); break;
      case '--runs': options.runs = positiveInteger(value, '--runs'); break;
      case '--idle-ms': options.idleMs = positiveInteger(value, '--idle-ms'); break;
      case '--timeout-ms': options.timeoutMs = positiveInteger(value, '--timeout-ms'); break;
      case '--poll-ms': options.pollMs = positiveInteger(value, '--poll-ms'); break;
      case '--output': options.output = path.resolve(value); break;
      default: throw new Error(`unsupported option ${argument}`);
    }
  }
  if (options.runs < 1) {
    throw new Error('--runs must be at least 1');
  }
  if (options.pollMs < 1) {
    throw new Error('--poll-ms must be at least 1');
  }
  return options;
}

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: path.resolve(applicationRoot, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

async function writeJsonAtomically(output, value) {
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const temporary = path.join(
    path.dirname(output),
    `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    await fs.promises.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await fs.promises.rename(temporary, output);
  } catch (error) {
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
}

function artifactStem(output) {
  const extension = path.extname(output);
  return path.basename(output, extension);
}

function failurePathForOutput(output) {
  return path.join(path.dirname(output), `${artifactStem(output)}.failure.json`);
}

async function clearPreviousCampaignArtifacts(output) {
  const resolvedOutput = path.resolve(output);
  const outputDirectory = path.dirname(resolvedOutput);
  const diagnosticsPrefix = `${artifactStem(resolvedOutput)}-diagnostics-`;
  await Promise.all([
    fs.promises.rm(resolvedOutput, { force: true }),
    fs.promises.rm(failurePathForOutput(resolvedOutput), { force: true }),
  ]);

  let entries;
  try {
    entries = await fs.promises.readdir(outputDirectory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  const staleDiagnostics = entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(diagnosticsPrefix))
    .map(entry => path.resolve(outputDirectory, entry.name));
  for (const stalePath of staleDiagnostics) {
    if (path.dirname(stalePath) !== outputDirectory) {
      throw new Error(`refusing to remove diagnostics outside ${outputDirectory}`);
    }
  }
  await Promise.all(staleDiagnostics.map(stalePath => fs.promises.rm(stalePath, {
    recursive: true,
    force: true,
  })));
}

async function readOptionalStartupReport(reportPath) {
  try {
    const serialized = await fs.promises.readFile(reportPath, 'utf8');
    try {
      return JSON.parse(serialized);
    } catch (error) {
      return { invalid: true, error: error.message };
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

async function preserveFailureDiagnostic({
  options,
  executable,
  runIndex,
  completedRuns,
  error,
  reportPath,
  stdoutLogPath,
  stderrLogPath,
}) {
  const outputDirectory = path.dirname(options.output);
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const diagnosticsDirectory = await fs.promises.mkdtemp(path.join(
    outputDirectory,
    `${artifactStem(options.output)}-diagnostics-`,
  ));
  const copiedStdout = path.join(diagnosticsDirectory, 'stdout.log');
  const copiedStderr = path.join(diagnosticsDirectory, 'stderr.log');
  await fs.promises.copyFile(stdoutLogPath, copiedStdout);
  await fs.promises.copyFile(stderrLogPath, copiedStderr);
  const startupReport = await readOptionalStartupReport(reportPath);
  const portableRelativePath = file => path.relative(outputDirectory, file).replaceAll('\\', '/');
  const diagnostic = {
    status: 'failed',
    error: {
      name: typeof error?.name === 'string' ? error.name : 'Error',
      message: typeof error?.message === 'string' ? error.message : String(error),
    },
    completedRuns,
    platform: process.platform,
    arch: process.arch,
    executable: path.resolve(executable),
    runIndex,
    logs: {
      stdout: portableRelativePath(copiedStdout),
      stderr: portableRelativePath(copiedStderr),
    },
    ...(startupReport === undefined ? {} : { startupReport }),
  };
  await writeJsonAtomically(failurePathForOutput(options.output), diagnostic);
  return diagnostic;
}

export async function runMeasurementCampaign(
  options,
  { measure = measureOnce } = {},
) {
  const executable = path.resolve(options.executable);
  await clearPreviousCampaignArtifacts(options.output);
  const rawRuns = [];
  for (let runIndex = 1; runIndex <= options.runs; runIndex++) {
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-startup-run-'));
    const codeFile = path.join(temporary, `startup-${runIndex}.R`);
    const reportPath = path.join(temporary, 'startup-report.json');
    const stdoutLogPath = path.join(temporary, 'stdout.log');
    const stderrLogPath = path.join(temporary, 'stderr.log');
    try {
      await Promise.all([
        fs.promises.writeFile(codeFile, '# R-IDE startup measurement\n'),
        fs.promises.writeFile(stdoutLogPath, ''),
        fs.promises.writeFile(stderrLogPath, ''),
      ]);
      rawRuns.push(await measure({
        executable,
        codeFile,
        reportPath,
        stdoutLogPath,
        stderrLogPath,
        idleMs: options.idleMs,
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs,
        cwd: applicationRoot,
      }));
    } catch (error) {
      await preserveFailureDiagnostic({
        options,
        executable,
        runIndex,
        completedRuns: [...rawRuns],
        error,
        reportPath,
        stdoutLogPath,
        stderrLogPath,
      });
      throw error;
    } finally {
      await fs.promises.rm(temporary, { recursive: true, force: true });
    }
  }

  const measurement = {
    schema: MEASUREMENT_SCHEMA,
    version: MEASUREMENT_VERSION,
    platform: process.platform,
    arch: process.arch,
    executable,
    commit: currentCommit(),
    runs: rawRuns,
    median: {
      targetFileOpenedMs: median(
        rawRuns.map(run => run.startupReport.milestones.target_file_opened),
      ),
      rssBytes: median(rawRuns.map(run => run.metrics.rssBytes)),
      processCount: median(rawRuns.map(run => run.metrics.processCount)),
    },
  };
  await writeJsonAtomically(options.output, measurement);
  await fs.promises.rm(failurePathForOutput(options.output), { force: true });
  return measurement;
}

async function main(argv) {
  const options = parseArguments(argv);
  const executable = options.executable ?? discoverExecutable(options.bundleRoot);
  if (!existingFile(executable)) {
    throw new Error(`Tauri executable does not exist: ${executable}`);
  }

  const measurement = await runMeasurementCampaign({ ...options, executable });
  process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
