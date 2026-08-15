/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPORT_SCHEMA = 'ride.startup-report';
const REPORT_VERSION = 1;
const MEASUREMENT_SCHEMA = 'ride.startup-measurement';
const MEASUREMENT_VERSION = 1;
const DIAGNOSTICS_OWNER_SCHEMA = 'ride.startup-diagnostics-owner';
const DIAGNOSTICS_OWNER_VERSION = 1;
const DIAGNOSTICS_OWNER_FILE = '.ride-startup-diagnostics-owner.json';
const DIAGNOSTIC_LOG_MAX_BYTES = 1_048_576;
const STREAM_SETTLE_TIMEOUT_MS = 2_000;
const SYNC_COMMAND_TIMEOUT_MS = 10_000;
const SYNC_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const SENSITIVE_ENVIRONMENT_KEY = /(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|COOKIE|AUTH)/i;
const SENSITIVE_DESKTOP_PASSTHROUGH_KEYS = new Set(['XAUTHORITY']);
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function filterSpawnEnvironment(sourceEnvironment, reportPath) {
  const environment = {};
  const sensitiveValues = [];
  for (const [key, value] of Object.entries(sourceEnvironment ?? {})) {
    if (value === undefined) {
      continue;
    }
    const serialized = String(value);
    if (SENSITIVE_ENVIRONMENT_KEY.test(key)) {
      if (serialized) {
        sensitiveValues.push(serialized);
      }
      if (!SENSITIVE_DESKTOP_PASSTHROUGH_KEYS.has(key.toUpperCase())) {
        continue;
      }
    }
    environment[key] = serialized;
  }
  environment.RIDE_STARTUP_REPORT = reportPath;
  return { environment, sensitiveValues: [...new Set(sensitiveValues)] };
}

export function redactDiagnosticText(text, sensitiveValues = []) {
  let redacted = String(text);
  for (const value of [...new Set(sensitiveValues)]
    .filter(candidate => typeof candidate === 'string' && candidate.length > 0)
    .sort((left, right) => right.length - left.length)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(value), 'g'), '[REDACTED]');
  }
  redacted = redacted.replace(
    /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|key|credential|cookie|auth)[A-Za-z0-9_.-]*)\s*=\s*([^\s\r\n]+)/gi,
    '$1=[REDACTED]',
  );
  redacted = redacted.replace(
    /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]*/gi,
    '$1: [REDACTED]',
  );
  return redacted;
}

function tailBuffer(buffer, maximumBytes) {
  if (buffer.length <= maximumBytes) {
    return buffer;
  }
  let start = buffer.length - maximumBytes;
  while (start < buffer.length && (buffer[start] & 0xC0) === 0x80) {
    start++;
  }
  return buffer.subarray(start);
}

function renderBoundedLog(retained, totalBytes, maximumBytes, sensitiveValues) {
  const redacted = Buffer.from(redactDiagnosticText(retained.toString('utf8'), sensitiveValues));
  const omittedBytes = Math.max(0, totalBytes - retained.length);
  if (omittedBytes === 0 && redacted.length <= maximumBytes) {
    return redacted.toString('utf8');
  }
  const marker = Buffer.from(`[... truncated ${omittedBytes + Math.max(0, redacted.length - maximumBytes)} bytes ...]\n`);
  if (marker.length >= maximumBytes) {
    return tailBuffer(marker, maximumBytes).toString('utf8');
  }
  const tail = tailBuffer(redacted, maximumBytes - marker.length);
  return Buffer.concat([marker, tail]).toString('utf8');
}

export function createBoundedLogSink(maximumBytes = DIAGNOSTIC_LOG_MAX_BYTES) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 64) {
    throw new Error('bounded log size must be a safe integer of at least 64 bytes');
  }
  let retained = Buffer.alloc(0);
  let totalBytes = 0;
  return {
    append(chunk) {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes = Math.min(Number.MAX_SAFE_INTEGER, totalBytes + next.length);
      retained = next.length >= maximumBytes
        ? tailBuffer(next, maximumBytes)
        : tailBuffer(Buffer.concat([retained, next]), maximumBytes);
    },
    render(sensitiveValues = []) {
      return renderBoundedLog(retained, totalBytes, maximumBytes, sensitiveValues);
    },
  };
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
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: SYNC_COMMAND_TIMEOUT_MS,
        maxBuffer: SYNC_COMMAND_MAX_BUFFER_BYTES,
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`PowerShell process query failed: ${result.error?.message ?? result.stderr}`);
    }
    return parseWindowsProcessTable(result.stdout);
  }

  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,lstart='], {
    encoding: 'utf8',
    timeout: SYNC_COMMAND_TIMEOUT_MS,
    maxBuffer: SYNC_COMMAND_MAX_BUFFER_BYTES,
  });
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

function trackedProcessKey(processRow) {
  return `${processRow.pid}\0${processRow.pgid ?? ''}\0${processRow.creationTime}`;
}

function mergeTrackedProcesses(...collections) {
  const merged = new Map();
  for (const collection of collections) {
    for (const processRow of collection ?? []) {
      merged.set(trackedProcessKey(processRow), processRow);
    }
  }
  return [...merged.values()].sort((left, right) => left.pid - right.pid);
}

export function startProcessTreeMonitor(
  rootIdentity,
  {
    child,
    platform = process.platform,
    intervalMs = 50,
    read = readProcessTable,
    schedule = (callback, milliseconds) => setInterval(callback, milliseconds),
    cancel = timer => clearInterval(timer),
  } = {},
) {
  const tracked = new Map();
  let stopped = false;
  const poll = () => {
    if (stopped) {
      return;
    }
    try {
      const rows = read(platform);
      const currentRoot = rows.find(processRow => processRow.pid === rootIdentity.pid);
      if (currentRoot && !sameProcessIdentity(currentRoot, rootIdentity)) {
        return;
      }
      let processes;
      if (currentRoot) {
        processes = aggregateProcessTree(rows, rootIdentity).processes;
      } else if (platform === 'win32') {
        const depths = new Map([[rootIdentity.pid, 0]]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const processRow of rows) {
            if (!depths.has(processRow.pid) && depths.has(processRow.ppid)) {
              depths.set(processRow.pid, depths.get(processRow.ppid) + 1);
              changed = true;
            }
          }
        }
        processes = rows
          .filter(processRow => depths.has(processRow.pid))
          .map(processRow => ({
            pid: processRow.pid,
            ppid: processRow.ppid,
            pgid: processRow.pgid,
            creationTime: processRow.creationTime,
            depth: depths.get(processRow.pid),
          }));
      } else if (rootIdentity.pgid === rootIdentity.pid && rootIdentity.pgid > 0) {
        processes = rows
          .filter(processRow => processRow.pgid === rootIdentity.pgid)
          .map(processRow => ({
            pid: processRow.pid,
            ppid: processRow.ppid,
            pgid: processRow.pgid,
            creationTime: processRow.creationTime,
            depth: tracked.get(trackedProcessKey(processRow))?.depth ?? 1,
          }));
      } else {
        processes = [];
      }
      for (const processRow of processes) {
        tracked.set(trackedProcessKey(processRow), processRow);
      }
    } catch {
      // A transient query failure or early root exit leaves accumulated identities intact.
    }
  };
  poll();
  const timer = schedule(poll, intervalMs);
  timer?.unref?.();
  const onRootExit = () => poll();
  child?.once?.('exit', onRootExit);
  return {
    async stop() {
      if (!stopped) {
        poll();
        stopped = true;
        cancel(timer);
        child?.off?.('exit', onRootExit);
      }
      return [...tracked.values()].sort((left, right) => left.pid - right.pid);
    },
  };
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

function waitForReadableEnd(stream) {
  if (!stream || stream.readableEnded || stream.destroyed) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      stream.off('end', finish);
      stream.off('close', finish);
      stream.off('error', finish);
      resolve();
    };
    const timer = setTimeout(finish, STREAM_SETTLE_TIMEOUT_MS);
    timer.unref?.();
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
}

function attachBoundedLogCapture(child, { stdoutLogPath, stderrLogPath }, sensitiveValues) {
  const stdout = createBoundedLogSink();
  const stderr = createBoundedLogSink();
  const drainStdout = chunk => stdout.append(chunk);
  const drainStderr = chunk => stderr.append(chunk);
  // Pipe streams may fail before the measurement reaches its finally block.
  // Keep an error listener installed for their full capture lifetime so an
  // early stream error cannot become an uncaught exception.
  const handleStdoutError = () => undefined;
  const handleStderrError = () => undefined;
  child.stdout.on('data', drainStdout);
  child.stderr.on('data', drainStderr);
  child.stdout.on('error', handleStdoutError);
  child.stderr.on('error', handleStderrError);
  let persistence;
  return {
    persist() {
      persistence ??= (async () => {
        try {
          await Promise.all([waitForReadableEnd(child.stdout), waitForReadableEnd(child.stderr)]);
          await Promise.all([
            fs.promises.writeFile(stdoutLogPath, stdout.render(sensitiveValues)),
            fs.promises.writeFile(stderrLogPath, stderr.render(sensitiveValues)),
          ]);
        } finally {
          child.stdout.off('data', drainStdout);
          child.stderr.off('data', drainStderr);
          child.stdout.off('error', handleStdoutError);
          child.stderr.off('error', handleStderrError);
        }
      })();
      return persistence;
    },
  };
}

export async function launchMeasuredProcess({
  executable,
  codeFile,
  reportPath,
  stdoutLogPath,
  stderrLogPath,
  cwd,
  sourceEnvironment = process.env,
}) {
  const preparedEnvironment = filterSpawnEnvironment(sourceEnvironment, reportPath);
  const child = spawn(executable, [codeFile], {
    cwd,
    detached: process.platform !== 'win32',
    env: preparedEnvironment.environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.startupLogCapture = attachBoundedLogCapture(
    child,
    { stdoutLogPath, stderrLogPath },
    preparedEnvironment.sensitiveValues,
  );
  try {
    await new Promise((resolve, reject) => {
      const removeLaunchListeners = () => {
        child.off('spawn', onSpawn);
        child.off('error', onError);
      };
      const onSpawn = () => {
        removeLaunchListeners();
        resolve();
      };
      const onError = error => {
        removeLaunchListeners();
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  } catch (error) {
    try {
      await child.startupLogCapture.persist();
    } catch (persistenceError) {
      error.cause ??= persistenceError;
    }
    throw error;
  }
  return child;
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
      timeout: SYNC_COMMAND_TIMEOUT_MS,
      maxBuffer: SYNC_COMMAND_MAX_BUFFER_BYTES,
    }),
    kill = (pid, signal) => process.kill(pid, signal),
    delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const verifiedRootPid = positiveInteger(rootPid, 'spawned root pid');
  const terminateControlledChild = async () => {
    const controlledChildIsRunning = child?.pid === verifiedRootPid
      && child.killed === false
      && child.exitCode === null
      && child.signalCode === null
      && typeof child.kill === 'function';
    if (!controlledChildIsRunning) {
      return;
    }
    try {
      child.kill('SIGTERM');
    } catch {
      return;
    }
    await delay(250);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The controlled child may exit during the grace period.
      }
    }
  };
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
    await terminateControlledChild();
    return;
  }

  let rows;
  try {
    rows = read(platform);
  } catch {
    await terminateControlledChild();
    return;
  }
  const allowTree = platform === 'win32'
    || (rootIdentity.pgid === rootIdentity.pid
      && Number.isSafeInteger(rootIdentity.pgid)
      && rootIdentity.pgid > 0);
  const initialPlan = planProcessCleanup(rows, rootIdentity, trackedProcesses, { allowTree });
  if (platform === 'win32') {
    const terminateExplicit = async processIds => {
      for (const pid of processIds) {
        let currentPlan;
        try {
          currentPlan = planProcessCleanup(read(platform), rootIdentity, trackedProcesses, {
            allowTree: false,
          });
        } catch {
          await terminateControlledChild();
          return false;
        }
        if (currentPlan.processIds.includes(pid)) {
          run('taskkill.exe', ['/PID', String(pid), '/F']);
        }
      }
      return true;
    };
    if (initialPlan.mode === 'tree') {
      let currentPlan;
      try {
        currentPlan = planProcessCleanup(read(platform), rootIdentity, trackedProcesses, {
          allowTree: true,
        });
      } catch {
        await terminateControlledChild();
        return;
      }
      if (currentPlan.mode === 'tree') {
        run('taskkill.exe', ['/PID', String(currentPlan.rootPid), '/T', '/F']);
      } else {
        await terminateExplicit(currentPlan.processIds);
      }
    } else {
      await terminateExplicit(initialPlan.processIds);
    }
    return;
  }

  const terminateExplicit = async (processIds, signal) => {
    for (const pid of processIds) {
      let currentPlan;
      try {
        currentPlan = planProcessCleanup(read(platform), rootIdentity, trackedProcesses, {
          allowTree: false,
        });
      } catch {
        await terminateControlledChild();
        return false;
      }
      if (currentPlan.processIds.includes(pid)) {
        try {
          kill(pid, signal);
        } catch {
          // A verified descendant may exit between revalidation and the signal.
        }
      }
    }
    return true;
  };
  const signalPlan = async (plan, signal, allowGroup) => {
    if (plan.mode === 'tree') {
      let currentPlan;
      try {
        currentPlan = planProcessCleanup(read(platform), rootIdentity, trackedProcesses, {
          allowTree: allowGroup,
        });
      } catch {
        await terminateControlledChild();
        return false;
      }
      if (currentPlan.mode === 'tree'
          && Number.isSafeInteger(currentPlan.pgid)
          && currentPlan.pgid > 0
          && currentPlan.pgid === currentPlan.rootPid) {
        try {
          kill(-currentPlan.pgid, signal);
        } catch {
          // The verified root may exit between revalidation and the group signal.
        }
        return true;
      }
      return terminateExplicit(currentPlan.processIds, signal);
    }
    return terminateExplicit(plan.processIds, signal);
  };
  await signalPlan(initialPlan, 'SIGTERM', allowTree);
  await delay(250);

  try {
    rows = read(platform);
  } catch {
    await terminateControlledChild();
    return;
  }
  const finalPlan = planProcessCleanup(rows, rootIdentity, trackedProcesses, {
    allowTree: allowTree && initialPlan.mode === 'tree',
  });
  await signalPlan(finalPlan, 'SIGKILL', allowTree && initialPlan.mode === 'tree');
}

const defaultMeasurementDependencies = {
  launch: launchMeasuredProcess,
  capture: captureProcessIdentity,
  startMonitor: (rootIdentity, { child }) => startProcessTreeMonitor(rootIdentity, { child }),
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
  let monitor;
  try {
    rootIdentity = await dependencies.capture(rootPid, {
      timeoutMs: Math.min(2_000, Math.max(0, deadline - now())),
      pollMs: Math.min(25, options.pollMs),
    });
    monitor = await dependencies.startMonitor(rootIdentity, { child });
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
    let trackedProcesses = metrics?.processes ?? [];
    try {
      if (monitor) {
        trackedProcesses = mergeTrackedProcesses(trackedProcesses, await monitor.stop());
      }
    } finally {
      try {
        await dependencies.terminate({
          child,
          rootPid,
          rootIdentity,
          trackedProcesses,
        });
      } finally {
        await child.startupLogCapture?.persist();
      }
    }
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
      timeout: SYNC_COMMAND_TIMEOUT_MS,
      maxBuffer: SYNC_COMMAND_MAX_BUFFER_BYTES,
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
  let ownedDiagnostics;
  try {
    const failure = JSON.parse(await fs.promises.readFile(
      failurePathForOutput(resolvedOutput),
      'utf8',
    ));
    const directoryName = failure?.diagnostics?.directory;
    if (failure?.status === 'failed'
        && failure.output === resolvedOutput
        && typeof failure.campaignId === 'string'
        && failure.campaignId.length > 0
        && typeof directoryName === 'string'
        && directoryName.length > 0
        && path.basename(directoryName) === directoryName) {
      const candidate = path.join(outputDirectory, directoryName);
      const candidateStat = await fs.promises.lstat(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        throw new Error('diagnostics ownership path is not a real directory');
      }
      const owner = JSON.parse(await fs.promises.readFile(
        path.join(candidate, DIAGNOSTICS_OWNER_FILE),
        'utf8',
      ));
      if (owner?.schema === DIAGNOSTICS_OWNER_SCHEMA
          && owner.version === DIAGNOSTICS_OWNER_VERSION
          && owner.campaignId === failure.campaignId
          && owner.output === resolvedOutput) {
        ownedDiagnostics = candidate;
      }
    }
  } catch {
    // Missing, malformed, or unowned diagnostics are intentionally preserved.
  }

  await Promise.all([
    fs.promises.rm(resolvedOutput, { force: true }),
    fs.promises.rm(failurePathForOutput(resolvedOutput), { force: true }),
  ]);
  if (ownedDiagnostics) {
    await fs.promises.rm(ownedDiagnostics, { recursive: true, force: true });
  }
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

async function readBoundedLogFile(logPath, sensitiveValues) {
  const handle = await fs.promises.open(logPath, 'r');
  try {
    const stat = await handle.stat();
    const retainedBytes = Math.min(stat.size, DIAGNOSTIC_LOG_MAX_BYTES);
    const retained = Buffer.alloc(retainedBytes);
    if (retainedBytes > 0) {
      await handle.read(retained, 0, retainedBytes, stat.size - retainedBytes);
    }
    return renderBoundedLog(
      retained,
      stat.size,
      DIAGNOSTIC_LOG_MAX_BYTES,
      sensitiveValues,
    );
  } finally {
    await handle.close();
  }
}

async function preserveFailureDiagnostic({
  options,
  executable,
  campaignId,
  runIndex,
  completedRuns,
  error,
  reportPath,
  stdoutLogPath,
  stderrLogPath,
  sensitiveValues,
}) {
  const outputDirectory = path.dirname(options.output);
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const diagnosticsDirectory = path.join(
    outputDirectory,
    `${artifactStem(options.output)}-diagnostics-${campaignId}`,
  );
  await fs.promises.mkdir(diagnosticsDirectory);
  const resolvedOutput = path.resolve(options.output);
  await writeJsonAtomically(path.join(diagnosticsDirectory, DIAGNOSTICS_OWNER_FILE), {
    schema: DIAGNOSTICS_OWNER_SCHEMA,
    version: DIAGNOSTICS_OWNER_VERSION,
    campaignId,
    output: resolvedOutput,
  });
  const copiedStdout = path.join(diagnosticsDirectory, 'stdout.log');
  const copiedStderr = path.join(diagnosticsDirectory, 'stderr.log');
  const [boundedStdout, boundedStderr] = await Promise.all([
    readBoundedLogFile(stdoutLogPath, sensitiveValues),
    readBoundedLogFile(stderrLogPath, sensitiveValues),
  ]);
  await Promise.all([
    fs.promises.writeFile(copiedStdout, boundedStdout),
    fs.promises.writeFile(copiedStderr, boundedStderr),
  ]);
  const startupReport = await readOptionalStartupReport(reportPath);
  const portableRelativePath = file => path.relative(outputDirectory, file).replaceAll('\\', '/');
  const diagnostic = {
    status: 'failed',
    error: {
      name: typeof error?.name === 'string' ? error.name : 'Error',
      message: redactDiagnosticText(
        typeof error?.message === 'string' ? error.message : String(error),
        sensitiveValues,
      ),
    },
    completedRuns,
    platform: process.platform,
    arch: process.arch,
    executable: path.resolve(executable),
    output: resolvedOutput,
    campaignId,
    runIndex,
    diagnostics: {
      directory: path.basename(diagnosticsDirectory),
    },
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
  { measure = measureOnce, environment = process.env } = {},
) {
  const executable = path.resolve(options.executable);
  const campaignId = randomUUID();
  const { sensitiveValues } = filterSpawnEnvironment(environment, 'diagnostic-redaction');
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
        sourceEnvironment: environment,
      }));
    } catch (error) {
      await preserveFailureDiagnostic({
        options,
        executable,
        campaignId,
        runIndex,
        completedRuns: [...rawRuns],
        error,
        reportPath,
        stdoutLogPath,
        stderrLogPath,
        sensitiveValues,
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
