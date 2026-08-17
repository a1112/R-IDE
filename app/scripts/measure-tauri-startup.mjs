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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIAGNOSTIC_LOG_MAX_BYTES = 1_048_576;
const STREAM_SETTLE_TIMEOUT_MS = 2_000;
const SYNC_COMMAND_TIMEOUT_MS = 10_000;
const SYNC_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const PROC_ENVIRONMENT_MAX_BYTES = 4 * 1024 * 1024;
const SENSITIVE_FRAGMENT_LENGTH = 16;
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

function redactSensitiveFragments(text, sensitiveValues) {
  const fragments = new Set();
  for (const value of sensitiveValues) {
    for (let index = 0; index <= value.length - SENSITIVE_FRAGMENT_LENGTH; index++) {
      fragments.add(value.slice(index, index + SENSITIVE_FRAGMENT_LENGTH));
    }
  }
  if (fragments.size === 0 || text.length < SENSITIVE_FRAGMENT_LENGTH) {
    return text;
  }

  const ranges = [];
  for (let index = 0; index <= text.length - SENSITIVE_FRAGMENT_LENGTH; index++) {
    if (!fragments.has(text.slice(index, index + SENSITIVE_FRAGMENT_LENGTH))) {
      continue;
    }
    const end = index + SENSITIVE_FRAGMENT_LENGTH;
    const previous = ranges.at(-1);
    if (previous && index <= previous.end) {
      previous.end = Math.max(previous.end, end);
    } else {
      ranges.push({ start: index, end });
    }
  }
  if (ranges.length === 0) {
    return text;
  }

  const redacted = [];
  let cursor = 0;
  for (const range of ranges) {
    redacted.push(text.slice(cursor, range.start), '[REDACTED]');
    cursor = range.end;
  }
  redacted.push(text.slice(cursor));
  return redacted.join('');
}

function validateRunId(runId) {
  if (typeof runId !== 'string' || !UUID_PATTERN.test(runId)) {
    throw new Error('startup run id must be a UUID');
  }
  return runId;
}

export function filterSpawnEnvironment(sourceEnvironment, reportPath, runId) {
  const environment = {};
  const sensitiveValues = [];
  for (const [key, value] of Object.entries(sourceEnvironment ?? {})) {
    if (value === undefined) {
      continue;
    }
    const serialized = String(value);
    if (key.toUpperCase() === 'RIDE_STARTUP_RUN_ID' && serialized) {
      sensitiveValues.push(serialized);
    }
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
  if (runId !== undefined) {
    const verifiedRunId = validateRunId(runId);
    // Ordinary Tauri, backend, and plugin descendants inherit this marker.
    // It is measurement provenance, not a defense against a child deliberately
    // clearing or replacing its environment.
    environment.RIDE_STARTUP_RUN_ID = verifiedRunId;
    sensitiveValues.push(verifiedRunId);
  }
  return { environment, sensitiveValues: [...new Set(sensitiveValues)] };
}

export function redactDiagnosticText(text, sensitiveValues = []) {
  const normalizedSensitiveValues = [];
  for (const candidate of sensitiveValues) {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      continue;
    }
    normalizedSensitiveValues.push(candidate);
    for (const line of candidate.split(/\r\n|\n|\r/)) {
      if (line.length > 0 && line.trim().length > 0) {
        normalizedSensitiveValues.push(line, line.trim());
      }
    }
  }
  const uniqueSensitiveValues = [...new Set(normalizedSensitiveValues)]
    .sort((left, right) => right.length - left.length);
  let redacted = redactSensitiveFragments(String(text), uniqueSensitiveValues);
  for (const value of uniqueSensitiveValues) {
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

function renderBoundedLog(
  retained,
  totalBytes,
  maximumBytes,
  sensitiveValues,
  { discardTrailingPartialLine = false } = {},
) {
  let safeRetained = retained;
  if (totalBytes > retained.length) {
    const firstLineEnd = retained.indexOf(0x0A);
    safeRetained = firstLineEnd >= 0
      ? retained.subarray(firstLineEnd + 1)
      : Buffer.alloc(0);
  }
  if (discardTrailingPartialLine && safeRetained.length > 0) {
    const lastLineEnd = safeRetained.lastIndexOf(0x0A);
    safeRetained = lastLineEnd >= 0
      ? safeRetained.subarray(0, lastLineEnd + 1)
      : Buffer.alloc(0);
  }
  const redacted = Buffer.from(redactDiagnosticText(safeRetained.toString('utf8'), sensitiveValues));
  const omittedBytes = Math.max(0, totalBytes - safeRetained.length);
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
    render(sensitiveValues = [], options = {}) {
      return renderBoundedLog(retained, totalBytes, maximumBytes, sensitiveValues, options);
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

function epochFromUtcComponents({
  year,
  month,
  day,
  hour,
  minute,
  second,
  millisecond,
  offsetMinutes,
}) {
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  const normalized = new Date(localEpoch);
  const validComponents = normalized.getUTCFullYear() === year
    && normalized.getUTCMonth() === month - 1
    && normalized.getUTCDate() === day
    && normalized.getUTCHours() === hour
    && normalized.getUTCMinutes() === minute
    && normalized.getUTCSeconds() === second
    && normalized.getUTCMilliseconds() === millisecond;
  if (!validComponents || !Number.isSafeInteger(offsetMinutes)) {
    return null;
  }
  const epoch = localEpoch - (offsetMinutes * 60_000);
  return Number.isSafeInteger(epoch) ? epoch : null;
}

function parseProcessStartedAt(creationTime) {
  const serialized = typeof creationTime === 'string' ? creationTime.trim() : '';
  if (!serialized) {
    return null;
  }
  const dotNet = serialized.match(/^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/);
  if (dotNet) {
    const epoch = Number(dotNet[1]);
    return Number.isSafeInteger(epoch) ? epoch : null;
  }
  const dmtf = serialized.match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/,
  );
  if (dmtf) {
    const [, year, month, day, hour, minute, second, fraction, sign, offset] = dmtf;
    return epochFromUtcComponents({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
      millisecond: Number(fraction.slice(0, 3)),
      offsetMinutes: Number(offset) * (sign === '+' ? 1 : -1),
    });
  }
  const iso = serialized.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (iso) {
    const [, year, month, day, hour, minute, second, fraction = '', zone, sign, offsetHour, offsetMinute]
      = iso;
    const numericOffsetHour = zone === 'Z' ? 0 : Number(offsetHour);
    const numericOffsetMinute = zone === 'Z' ? 0 : Number(offsetMinute);
    if (numericOffsetHour > 23 || numericOffsetMinute > 59) {
      return null;
    }
    return epochFromUtcComponents({
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
      second: Number(second),
      millisecond: Number(fraction.padEnd(3, '0').slice(0, 3) || 0),
      offsetMinutes: zone === 'Z'
        ? 0
        : ((numericOffsetHour * 60) + numericOffsetMinute) * (sign === '+' ? 1 : -1),
    });
  }
  const posix = serialized.match(
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\d{4})$/,
  );
  if (!posix) {
    return null;
  }
  const [, weekday, monthName, day, hour, minute, second, year] = posix;
  const epoch = Date.parse(serialized);
  if (!Number.isSafeInteger(epoch)) {
    return null;
  }
  const parsed = new Date(epoch);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const validComponents = parsed.getFullYear() === Number(year)
    && parsed.getMonth() === months.indexOf(monthName)
    && parsed.getDate() === Number(day)
    && parsed.getHours() === Number(hour)
    && parsed.getMinutes() === Number(minute)
    && parsed.getSeconds() === Number(second)
    && weekdays[parsed.getDay()] === weekday;
  return validComponents ? epoch : null;
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
      continue;
    }
    if (!creationTime) {
      throw new Error('ps lstart must not be empty');
    }
    if (rssKiB > Math.floor(Number.MAX_SAFE_INTEGER / 1024)) {
      throw new Error('ps RSS bytes must be a non-negative safe integer');
    }
    rows.push({
      pid,
      ppid,
      pgid,
      rssBytes: rssKiB * 1024,
      creationTime,
      startedAt: parseProcessStartedAt(creationTime),
    });
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
    return [{
      pid,
      ppid,
      pgid: null,
      rssBytes,
      creationTime,
      startedAt: parseProcessStartedAt(creationTime),
    }];
  });
}

export function parseLinuxProcEnvironment(environment, runId) {
  const marker = Buffer.from(`RIDE_STARTUP_RUN_ID=${validateRunId(runId)}`);
  if (!Buffer.isBuffer(environment)) {
    throw new Error('Linux proc environment must be a Buffer');
  }
  if (environment.length === 0) {
    return false;
  }
  if (environment.at(-1) !== 0) {
    throw new Error('Linux proc environment must be NUL-terminated');
  }
  for (let start = 0; start < environment.length;) {
    const end = environment.indexOf(0, start);
    if (end < 0) {
      throw new Error('Linux proc environment must be NUL-terminated');
    }
    if (environment.subarray(start, end).equals(marker)) {
      return true;
    }
    start = end + 1;
  }
  return false;
}

function parseMacOsPsRows(output, label) {
  const rows = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const match = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (!match) {
      throw new Error(`invalid macOS ps ${label} row`);
    }
    const pid = positiveInteger(match[1], 'macOS ps pid');
    if (pid === 0) {
      throw new Error('macOS ps pid must be positive');
    }
    if (rows.has(pid)) {
      throw new Error(`duplicate macOS ps pid ${pid}`);
    }
    rows.set(pid, match[2]);
  }
  return rows;
}

export function parseMacOsProcessEnvironments(
  commandOutput,
  environmentOutput,
  runId,
  stablePids,
) {
  const marker = `RIDE_STARTUP_RUN_ID=${validateRunId(runId)}`;
  const escapedMarker = escapeRegExp(marker);
  const markerToken = new RegExp(`(?:^|\\s)${escapedMarker}(?:\\s|$)`);
  if (!(stablePids instanceof Set)) {
    throw new Error('macOS stable process ids must be a Set');
  }
  const commands = parseMacOsPsRows(commandOutput, 'command');
  const environments = parseMacOsPsRows(environmentOutput, 'environment');
  for (const rawPid of stablePids) {
    const pid = positiveInteger(rawPid, 'macOS stable process pid');
    if (!commands.has(pid) || !environments.has(pid)) {
      throw new Error(`macOS process environment query omitted stable pid ${pid}`);
    }
  }

  const marked = [];
  for (const [pid, environment] of environments) {
    const command = commands.get(pid);
    if (command === undefined) {
      if (markerToken.test(environment)) {
        throw new Error(`macOS process command query omitted marker pid ${pid}`);
      }
      continue;
    }
    let appendedEnvironment;
    if (environment === command) {
      appendedEnvironment = '';
    } else if (environment.startsWith(`${command} `)) {
      appendedEnvironment = environment.slice(command.length + 1);
    } else {
      if (stablePids.has(pid) || markerToken.test(environment)) {
        throw new Error(`macOS process command changed during environment query for pid ${pid}`);
      }
      continue;
    }
    if (markerToken.test(appendedEnvironment)) {
      marked.push(pid);
    }
  }
  return marked.sort((left, right) => left - right);
}

function readBoundedFile(filePath, maximumBytes) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const chunks = [];
    let length = 0;
    while (true) {
      const capacity = Math.min(64 * 1024, maximumBytes + 1 - length);
      if (capacity <= 0) {
        throw new Error('Linux proc environment exceeds the size limit');
      }
      const chunk = Buffer.allocUnsafe(capacity);
      const count = fs.readSync(handle, chunk, 0, capacity, null);
      if (count === 0) {
        return Buffer.concat(chunks, length);
      }
      chunks.push(chunk.subarray(0, count));
      length += count;
      if (length > maximumBytes) {
        throw new Error('Linux proc environment exceeds the size limit');
      }
    }
  } finally {
    fs.closeSync(handle);
  }
}

function defaultLinuxProcessIds() {
  return fs.readdirSync('/proc', { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map(entry => Number(entry.name))
    .filter(pid => Number.isSafeInteger(pid) && pid > 0);
}

export function readLinuxProcEnvironment(
  pid,
  {
    readStatus = filePath => readBoundedFile(filePath, PROC_ENVIRONMENT_MAX_BYTES),
    readFile = filePath => readBoundedFile(filePath, PROC_ENVIRONMENT_MAX_BYTES),
    getuid = () => process.getuid?.(),
  } = {},
) {
  const verifiedPid = positiveInteger(pid, 'Linux proc pid');
  if (verifiedPid === 0) {
    throw new Error('Linux proc pid must be positive');
  }
  const statusPath = `/proc/${verifiedPid}/status`;
  const environmentPath = `/proc/${verifiedPid}/environ`;
  let status;
  try {
    status = readStatus(statusPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') {
      return null;
    }
    throw new Error('Linux proc status query failed');
  }
  const statusText = Buffer.isBuffer(status) ? status.toString('utf8') : status;
  if (typeof statusText !== 'string') {
    throw new Error('Linux proc status query failed');
  }
  const uidLines = statusText.split(/\r?\n/).filter(line => line.startsWith('Uid:'));
  if (uidLines.length !== 1) {
    throw new Error('Linux proc status query failed');
  }
  const uidMatch = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(uidLines[0]);
  if (!uidMatch) {
    throw new Error('Linux proc status query failed');
  }
  const [realUid, effectiveUid] = uidMatch.slice(1, 3).map(value => Number(value));
  const currentUid = getuid();
  if (![currentUid, realUid, effectiveUid].every(
    uid => Number.isSafeInteger(uid) && uid >= 0,
  )) {
    throw new Error('Linux proc status query failed');
  }
  // /proc/<pid>/environ ownership can change for nondumpable same-UID
  // processes. The kernel's status Uid tuple is the ownership source of truth.
  if (realUid !== currentUid && effectiveUid !== currentUid) {
    return null;
  }
  try {
    return readFile(environmentPath);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') {
      return null;
    }
    if (error?.message === 'Linux proc environment exceeds the size limit') {
      throw error;
    }
    throw new Error('Linux proc environment query failed');
  }
}

export function discoverMarkedProcessSnapshot(
  runId,
  platform = process.platform,
  {
    read = readProcessTable,
    listLinuxPids = defaultLinuxProcessIds,
    readLinuxEnvironment = readLinuxProcEnvironment,
    run = (command, args, options) => spawnSync(command, args, options),
  } = {},
) {
  const verifiedRunId = validateRunId(runId);
  if (platform === 'win32') {
    return { rows: read(platform), markedRows: [] };
  }

  const beforeRows = read(platform);
  const beforeByPid = new Map(beforeRows.map(row => [row.pid, row]));
  let markedPids;
  let macCommandOutput;
  let macEnvironmentOutput;
  if (platform === 'linux') {
    markedPids = [];
    const seen = new Set();
    for (const pid of listLinuxPids()) {
      const verifiedPid = positiveInteger(pid, 'Linux proc pid');
      if (verifiedPid === 0 || seen.has(verifiedPid)) {
        throw new Error('Linux proc process list is invalid');
      }
      seen.add(verifiedPid);
      const environment = readLinuxEnvironment(verifiedPid);
      if (environment !== null && parseLinuxProcEnvironment(environment, verifiedRunId)) {
        markedPids.push(verifiedPid);
      }
    }
  } else if (platform === 'darwin') {
    const runMacProcessQuery = args => {
      const result = run('ps', args, {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
        timeout: SYNC_COMMAND_TIMEOUT_MS,
        maxBuffer: SYNC_COMMAND_MAX_BUFFER_BYTES,
      });
      if (result?.error || result?.signal || result?.status !== 0) {
        throw new Error('macOS process environment query failed');
      }
      return result.stdout;
    };
    macCommandOutput = runMacProcessQuery(['ww', '-axo', 'pid=,command=']);
    macEnvironmentOutput = runMacProcessQuery(['eww', '-axo', 'pid=,command=']);
  } else {
    throw new Error(`unsupported marker discovery platform ${platform}`);
  }

  const rows = read(platform);
  const rowsByPid = new Map();
  for (const row of rows) {
    if (rowsByPid.has(row.pid)) {
      throw new Error(`duplicate process-table pid ${row.pid}`);
    }
    rowsByPid.set(row.pid, row);
  }
  if (platform === 'darwin') {
    const stablePids = new Set(rows
      .filter(row => sameProcessIdentity(row, beforeByPid.get(row.pid) ?? {}))
      .map(row => row.pid));
    markedPids = parseMacOsProcessEnvironments(
      macCommandOutput,
      macEnvironmentOutput,
      verifiedRunId,
      stablePids,
    );
  }
  const markedRows = markedPids.map(pid => {
    const before = beforeByPid.get(pid);
    const row = rowsByPid.get(pid);
    if (!before || !row) {
      throw new Error(`marker process ${pid} is missing from the process table`);
    }
    if (!sameProcessIdentity(row, before)) {
      throw new Error(`marker process ${pid} changed identity during discovery`);
    }
    return row;
  });
  return { rows, markedRows };
}

function processIdentity(row) {
  const identity = {
    pid: row.pid,
    pgid: row.pgid,
    creationTime: row.creationTime,
  };
  if (Object.hasOwn(row, 'startedAt')) {
    identity.startedAt = row.startedAt;
  }
  return identity;
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

function comparableStartedAt(processRow) {
  return Number.isSafeInteger(processRow?.startedAt) ? processRow.startedAt : null;
}

function discoverChronologicalDescendants(rows, seeds, rootStartedAt) {
  const discovered = new Map(seeds);
  if (rootStartedAt === null) {
    return discovered;
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (discovered.has(row.pid)) {
        continue;
      }
      const parent = discovered.get(row.ppid);
      const childStartedAt = comparableStartedAt(row);
      if (!parent
          || parent.startedAt === null
          || childStartedAt === null
          || childStartedAt < parent.startedAt
          || childStartedAt < rootStartedAt) {
        continue;
      }
      discovered.set(row.pid, {
        depth: parent.depth + 1,
        startedAt: childStartedAt,
      });
      changed = true;
    }
  }
  return discovered;
}

function chronologicalProcessTree(rows, rootIdentity) {
  const verifiedIdentity = validateProcessIdentity(rootIdentity, 'spawned root identity');
  const verifiedRoot = verifiedIdentity.pid;
  if (!rows.some(row => sameProcessIdentity(row, verifiedIdentity))) {
    throw new Error(`spawned root process ${verifiedRoot} does not match its captured identity`);
  }
  const rootRow = rows.find(row => sameProcessIdentity(row, verifiedIdentity));
  const rootStartedAt = comparableStartedAt(rootRow);
  const discovered = discoverChronologicalDescendants(
    rows,
    new Map([[
      verifiedRoot,
      { depth: 0, startedAt: rootStartedAt },
    ]]),
    rootStartedAt,
  );
  const selected = rows.filter(row => discovered.has(row.pid));
  return {
    verifiedIdentity,
    verifiedRoot,
    selected,
    discovered,
  };
}

export function aggregateProcessTree(rows, rootIdentity) {
  const {
    verifiedIdentity,
    verifiedRoot,
    selected,
    discovered,
  } = chronologicalProcessTree(rows, rootIdentity);
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
        startedAt: comparableStartedAt(row),
        depth: discovered.get(row.pid).depth,
      }))
      .sort((left, right) => left.pid - right.pid),
  };
}

function rawDescendantIds(rows, rootPid) {
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.ppid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  return descendants;
}

export function planProcessCleanup(
  rows,
  rootIdentity,
  trackedProcesses = [],
  { allowTree = true } = {},
) {
  const verifiedIdentity = validateProcessIdentity(rootIdentity, 'spawned root identity');
  const rootMatches = rows.some(row => sameProcessIdentity(row, verifiedIdentity));
  const currentByPid = new Map(rows.map(row => [row.pid, row]));
  const rootStartedAt = comparableStartedAt(verifiedIdentity);
  const trackedByPid = new Map();
  for (const tracked of trackedProcesses) {
    const current = currentByPid.get(tracked.pid);
    const currentStartedAt = comparableStartedAt(current) ?? comparableStartedAt(tracked);
    if (current
        && sameProcessIdentity(current, tracked)
        && rootStartedAt !== null
        && currentStartedAt !== null
        && currentStartedAt >= rootStartedAt) {
      trackedByPid.set(tracked.pid, {
        pid: current.pid,
        ppid: current.ppid,
        pgid: current.pgid,
        creationTime: current.creationTime,
        startedAt: currentStartedAt,
        depth: tracked.depth ?? 1,
      });
    }
  }
  if (rootMatches) {
    const chronological = chronologicalProcessTree(rows, verifiedIdentity);
    const chronologicalProcesses = chronological.selected.map(processRow => ({
      pid: processRow.pid,
      ppid: processRow.ppid,
      pgid: processRow.pgid,
      creationTime: processRow.creationTime,
      startedAt: comparableStartedAt(processRow),
      depth: chronological.discovered.get(processRow.pid).depth,
    }));
    for (const processRow of chronologicalProcesses) {
      trackedByPid.set(processRow.pid, processRow);
    }
    const selectedProcesses = [...trackedByPid.values()];
    const safeProcessIds = new Set(chronologicalProcesses.map(processRow => processRow.pid));
    const rawProcessIds = rawDescendantIds(rows, verifiedIdentity.pid);
    const chronologyIsComplete = rootStartedAt !== null
      && [...rawProcessIds].every(pid => safeProcessIds.has(pid));
    const processGroupIsComplete = selectedProcesses.every(
      processRow => processRow.pgid === verifiedIdentity.pgid,
    );
    const operatingSystemTreeIsComplete = verifiedIdentity.pgid !== null
      || selectedProcesses.every(processRow => rawProcessIds.has(processRow.pid));
    if (allowTree
        && chronologyIsComplete
        && processGroupIsComplete
        && operatingSystemTreeIsComplete) {
      return {
        mode: 'tree',
        rootPid: verifiedIdentity.pid,
        pgid: verifiedIdentity.pgid,
        processIds: [],
      };
    }
  }
  const processIds = [...trackedByPid.values()]
    .filter(tracked => rootMatches || tracked.pid !== verifiedIdentity.pid)
    .filter(tracked => sameProcessIdentity(currentByPid.get(tracked.pid) ?? {}, tracked))
    .filter(tracked => tracked.pid === verifiedIdentity.pid
      || (rootStartedAt !== null
        && comparableStartedAt(tracked) !== null
        && comparableStartedAt(tracked) >= rootStartedAt))
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
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    timeout: SYNC_COMMAND_TIMEOUT_MS,
    maxBuffer: SYNC_COMMAND_MAX_BUFFER_BYTES,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`ps process query failed: ${result.error?.message ?? result.stderr}`);
  }
  return parsePosixProcessTable(result.stdout);
}

function aggregateMarkedProcessTree(rows, rootIdentity, markedRows) {
  const tree = aggregateProcessTree(rows, rootIdentity);
  const currentByPid = new Map(rows.map(row => [row.pid, row]));
  const rootStartedAt = comparableStartedAt(tree.rootIdentity);
  if (!markedRows.some(row => sameProcessIdentity(row, tree.rootIdentity))) {
    throw new Error('spawned root process is missing its startup run marker');
  }
  const selected = new Map();
  for (const processRow of tree.processes) {
    const current = currentByPid.get(processRow.pid);
    if (!current || !sameProcessIdentity(current, processRow)) {
      throw new Error(`sampled process ${processRow.pid} changed identity`);
    }
    selected.set(trackedProcessKey(current), { row: current, depth: processRow.depth });
  }
  for (const markedRow of markedRows) {
    const current = currentByPid.get(markedRow.pid);
    const startedAt = comparableStartedAt(markedRow);
    if (!current
        || !sameProcessIdentity(current, markedRow)
        || rootStartedAt === null
        || startedAt === null
        || startedAt < rootStartedAt) {
      throw new Error(`marked process ${markedRow.pid} has an unverifiable identity`);
    }
    selected.set(trackedProcessKey(current), {
      row: current,
      depth: tree.processes.find(processRow => processRow.pid === current.pid)?.depth ?? null,
    });
  }

  const processes = [...selected.values()].sort((left, right) => left.row.pid - right.row.pid);
  let rssBytes = 0;
  for (const { row } of processes) {
    const processRssBytes = positiveInteger(row.rssBytes, `process ${row.pid} RSS bytes`);
    if (rssBytes > Number.MAX_SAFE_INTEGER - processRssBytes) {
      throw new Error('aggregate RSS bytes must be a non-negative safe integer');
    }
    rssBytes += processRssBytes;
  }
  return {
    rootPid: tree.rootPid,
    rootIdentity: tree.rootIdentity,
    processIds: processes.map(({ row }) => row.pid),
    processCount: processes.length,
    rssBytes,
    processes: processes.map(({ row, depth }) => ({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      creationTime: row.creationTime,
      startedAt: comparableStartedAt(row),
      depth,
    })),
  };
}

export function sampleProcessTree(
  rootIdentity,
  platform = process.platform,
  { runId, discover = discoverMarkedProcessSnapshot } = {},
) {
  if (platform === 'win32' || runId === undefined) {
    return aggregateProcessTree(readProcessTable(platform), rootIdentity);
  }
  const snapshot = discover(validateRunId(runId), platform);
  return aggregateMarkedProcessTree(snapshot.rows, rootIdentity, snapshot.markedRows);
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

function captureOwnedProcessGroup(rootIdentity, platform) {
  if (platform === 'win32') {
    return undefined;
  }
  const verifiedIdentity = validateProcessIdentity(rootIdentity, 'spawned root identity');
  const startedAt = comparableStartedAt(verifiedIdentity);
  if (verifiedIdentity.pgid !== verifiedIdentity.pid || startedAt === null) {
    return undefined;
  }
  return {
    pgid: verifiedIdentity.pid,
    rootIdentity: { ...verifiedIdentity },
    startedAt,
  };
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
    intervalMs = 2_000,
    read = readProcessTable,
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel = timer => clearTimeout(timer),
  } = {},
) {
  const tracked = new Map();
  let stopped = false;
  let timer;
  let generation = 0;
  let stopPromise;
  const collect = () => {
    try {
      const rows = read(platform);
      const currentRoot = rows.find(processRow => processRow.pid === rootIdentity.pid);
      let processes;
      if (currentRoot && sameProcessIdentity(currentRoot, rootIdentity)) {
        processes = aggregateProcessTree(rows, rootIdentity).processes;
      } else {
        const currentByPid = new Map(rows.map(processRow => [processRow.pid, processRow]));
        const rootStartedAt = comparableStartedAt(rootIdentity);
        const seeds = new Map();
        for (const trackedProcess of tracked.values()) {
          if (trackedProcess.pid === rootIdentity.pid) {
            continue;
          }
          const currentProcess = currentByPid.get(trackedProcess.pid);
          const currentStartedAt = comparableStartedAt(currentProcess);
          // A non-root entry reaches `tracked` only through an earlier
          // root-matched chronological walk. It may remain a seed after the
          // root exits only while its exact identity and comparable clock
          // still match; an unparseable tracked row is retained but not used.
          if (currentProcess
              && sameProcessIdentity(currentProcess, trackedProcess)
              && rootStartedAt !== null
              && currentStartedAt !== null
              && currentStartedAt >= rootStartedAt) {
            seeds.set(currentProcess.pid, {
              depth: trackedProcess.depth ?? 1,
              startedAt: currentStartedAt,
            });
          }
        }
        const discovered = discoverChronologicalDescendants(rows, seeds, rootStartedAt);
        processes = rows
          .filter(processRow => discovered.has(processRow.pid))
          .map(processRow => ({
            pid: processRow.pid,
            ppid: processRow.ppid,
            pgid: processRow.pgid,
            creationTime: processRow.creationTime,
            startedAt: comparableStartedAt(processRow),
            depth: discovered.get(processRow.pid).depth,
          }));
      }
      for (const processRow of processes) {
        tracked.set(trackedProcessKey(processRow), processRow);
      }
    } catch {
      // A transient query failure or early root exit leaves accumulated identities intact.
    }
  };
  const scheduleNext = () => {
    if (stopped) {
      return;
    }
    const token = ++generation;
    timer = schedule(() => {
      if (stopped || token !== generation) {
        return;
      }
      timer = undefined;
      collect();
      scheduleNext();
    }, intervalMs);
    timer?.unref?.();
  };
  const cancelScheduled = () => {
    generation++;
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
  };
  collect();
  scheduleNext();
  const onRootExit = () => {
    if (stopped) {
      return;
    }
    cancelScheduled();
    collect();
    scheduleNext();
  };
  child?.once?.('exit', onRootExit);
  return {
    async stop() {
      if (!stopPromise) {
        stopped = true;
        cancelScheduled();
        child?.off?.('exit', onRootExit);
        stopPromise = Promise.resolve().then(() => {
          collect();
          return [...tracked.values()].sort((left, right) => left.pid - right.pid);
        });
      }
      return stopPromise;
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

function waitForReadableEnd(stream, timeoutMs = STREAM_SETTLE_TIMEOUT_MS) {
  if (!stream || stream.readableEnded || stream.closed) {
    return Promise.resolve(true);
  }
  return new Promise(resolve => {
    const finish = settled => {
      clearTimeout(timer);
      stream.off('end', onSettled);
      stream.off('close', onSettled);
      resolve(settled);
    };
    const onSettled = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref?.();
    stream.once('end', onSettled);
    stream.once('close', onSettled);
  });
}

function concludeCapturedStream(stream, dataListener, safetyErrorListener, settled) {
  stream.off('data', dataListener);
  if (stream.closed) {
    stream.off('error', safetyErrorListener);
    return;
  }
  const releaseSafetyListener = () => {
    stream.off('close', releaseSafetyListener);
    stream.off('error', safetyErrorListener);
  };
  stream.once('close', releaseSafetyListener);
  if (!settled && !stream.destroyed) {
    try {
      stream.destroy();
    } catch {
      // The safety error listener remains until a later close event.
    }
  }
}

export function attachBoundedLogCapture(
  child,
  { stdoutLogPath, stderrLogPath },
  sensitiveValues,
  { settleTimeoutMs = STREAM_SETTLE_TIMEOUT_MS } = {},
) {
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
        let stdoutSettled = false;
        let stderrSettled = false;
        try {
          [stdoutSettled, stderrSettled] = await Promise.all([
            waitForReadableEnd(child.stdout, settleTimeoutMs),
            waitForReadableEnd(child.stderr, settleTimeoutMs),
          ]);
          concludeCapturedStream(child.stdout, drainStdout, handleStdoutError, stdoutSettled);
          concludeCapturedStream(child.stderr, drainStderr, handleStderrError, stderrSettled);
          await Promise.all([
            fs.promises.writeFile(stdoutLogPath, stdout.render(
              sensitiveValues,
              { discardTrailingPartialLine: !stdoutSettled },
            )),
            fs.promises.writeFile(stderrLogPath, stderr.render(
              sensitiveValues,
              { discardTrailingPartialLine: !stderrSettled },
            )),
          ]);
        } finally {
          child.stdout.off('data', drainStdout);
          child.stderr.off('data', drainStderr);
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
  runId,
  sourceEnvironment = process.env,
}) {
  const preparedEnvironment = filterSpawnEnvironment(
    sourceEnvironment,
    reportPath,
    validateRunId(runId),
  );
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
    ownedGroup,
    trackedProcesses = [],
    containmentVerified = false,
    runId,
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
    cleanupReadAttempts = 3,
    cleanupVerifyAttempts = 3,
    cleanupReadDelayMs = 25,
    discoverMarked = discoverMarkedProcessSnapshot,
  } = {},
) {
  const verifiedRootPid = positiveInteger(rootPid, 'spawned root pid');
  const boundedAttempts = (value, label) => {
    if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
      throw new Error(`${label} must be an integer between 1 and 10`);
    }
    return value;
  };
  const readAttempts = boundedAttempts(cleanupReadAttempts, 'cleanup read attempts');
  const verifyAttempts = boundedAttempts(cleanupVerifyAttempts, 'cleanup verify attempts');
  if (!Number.isSafeInteger(cleanupReadDelayMs) || cleanupReadDelayMs < 0) {
    throw new Error('cleanup read delay must be a non-negative safe integer');
  }
  const markerEnabled = platform !== 'win32' && runId !== undefined;
  const verifiedRunId = markerEnabled ? validateRunId(runId) : undefined;
  let latestMarkedProcesses = [];
  let markerQueryFailed = false;
  const validateMarkedSnapshot = snapshot => {
    if (!snapshot || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.markedRows)) {
      throw new Error('invalid marked process snapshot');
    }
    const seen = new Set();
    for (const markedRow of snapshot.markedRows) {
      validateProcessIdentity(markedRow, 'marked process identity');
      const key = trackedProcessKey(markedRow);
      if (seen.has(key) || !snapshot.rows.some(row => sameProcessIdentity(row, markedRow))) {
        throw new Error('invalid marked process snapshot');
      }
      seen.add(key);
    }
    return snapshot;
  };
  const readWithRetry = async () => {
    let lastError;
    if (markerEnabled) {
      for (let attempt = 1; attempt <= readAttempts; attempt++) {
        try {
          const snapshot = validateMarkedSnapshot(discoverMarked(verifiedRunId, platform));
          latestMarkedProcesses = snapshot.markedRows;
          return snapshot.rows;
        } catch (error) {
          lastError = error;
        }
        if (attempt < readAttempts) {
          await delay(cleanupReadDelayMs);
        }
      }
      // Marker discovery is cooperative provenance. A persistent failure makes
      // the campaign incomplete, but must not skip best-effort cleanup of the
      // independently verified process tree, tracked identities, or owned group.
      markerQueryFailed = true;
    }
    for (let attempt = 1; attempt <= readAttempts; attempt++) {
      try {
        return read(platform);
      } catch (error) {
        lastError = error;
      }
      if (attempt < readAttempts) {
        await delay(cleanupReadDelayMs);
      }
    }
    throw lastError ?? new Error('process-table query failed');
  };
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
  if (platform === 'win32' && containmentVerified !== true) {
    await terminateControlledChild();
    return;
  }
  let trustedRootIdentity;
  if (rootIdentity) {
    try {
      const candidate = validateProcessIdentity(rootIdentity, 'spawned root identity');
      if (candidate.pid === verifiedRootPid) {
        trustedRootIdentity = candidate;
      }
    } catch {
      trustedRootIdentity = undefined;
    }
  }
  if (!trustedRootIdentity) {
    await terminateControlledChild();
    return;
  }
  let trustedOwnedGroup;
  if (platform !== 'win32' && ownedGroup !== undefined) {
    assertPlainObject(ownedGroup, 'owned process group');
    const pgid = positiveInteger(ownedGroup.pgid, 'owned process group pgid');
    const ownerIdentity = validateProcessIdentity(
      ownedGroup.rootIdentity,
      'owned process group root identity',
    );
    const startedAt = comparableStartedAt(ownerIdentity);
    if (pgid === 0
        || pgid !== verifiedRootPid
        || ownerIdentity.pgid !== pgid
        || !sameProcessIdentity(ownerIdentity, trustedRootIdentity)
        || startedAt === null
        || ownedGroup.startedAt !== startedAt) {
      throw new Error('owned process group does not match the captured detached root identity');
    }
    trustedOwnedGroup = {
      pgid,
      rootIdentity: ownerIdentity,
      startedAt,
    };
  }

  let rows;
  try {
    rows = await readWithRetry();
  } catch {
    await terminateControlledChild();
    throw new Error('startup cleanup incomplete: process table could not be verified');
  }
  const allowTree = platform === 'win32'
    || (!markerEnabled
      && trustedRootIdentity.pgid === trustedRootIdentity.pid
      && Number.isSafeInteger(trustedRootIdentity.pgid)
      && trustedRootIdentity.pgid > 0);
  let cleanupTrackedProcesses = mergeTrackedProcesses(
    trackedProcesses,
    latestMarkedProcesses,
  );
  if (rows.some(row => sameProcessIdentity(row, trustedRootIdentity))) {
    const chronological = chronologicalProcessTree(rows, trustedRootIdentity);
    cleanupTrackedProcesses = mergeTrackedProcesses(
      trackedProcesses,
      chronological.selected.map(processRow => ({
        pid: processRow.pid,
        ppid: processRow.ppid,
        pgid: processRow.pgid,
        creationTime: processRow.creationTime,
        startedAt: comparableStartedAt(processRow),
        depth: chronological.discovered.get(processRow.pid).depth,
      })),
    );
  }
  const exactIdentities = new Map();
  const rememberIdentities = processes => {
    for (const processRow of processes) {
      exactIdentities.set(trackedProcessKey(processRow), processRow);
    }
  };
  const rememberSafeDescendants = currentRows => {
    const rootStartedAt = comparableStartedAt(trustedRootIdentity);
    const currentMarkers = latestMarkedProcesses.filter(marked => {
      const current = currentRows.find(row => sameProcessIdentity(row, marked));
      const startedAt = comparableStartedAt(current);
      return current !== undefined
        && rootStartedAt !== null
        && startedAt !== null
        && startedAt >= rootStartedAt;
    });
    cleanupTrackedProcesses = mergeTrackedProcesses(cleanupTrackedProcesses, currentMarkers);
    rememberIdentities(currentMarkers);
    if (!currentRows.some(row => sameProcessIdentity(row, trustedRootIdentity))) {
      return;
    }
    const chronological = chronologicalProcessTree(currentRows, trustedRootIdentity);
    const observedProcesses = chronological.selected.map(processRow => ({
      pid: processRow.pid,
      ppid: processRow.ppid,
      pgid: processRow.pgid,
      creationTime: processRow.creationTime,
      startedAt: comparableStartedAt(processRow),
      depth: chronological.discovered.get(processRow.pid).depth,
    }));
    cleanupTrackedProcesses = mergeTrackedProcesses(cleanupTrackedProcesses, observedProcesses);
    rememberIdentities(observedProcesses);
  };
  rememberIdentities([trustedRootIdentity, ...cleanupTrackedProcesses]);
  const actionFailures = [];
  const recordCommand = (command, args) => {
    try {
      const result = run(command, args);
      if (result?.error || result?.signal || result?.status !== 0) {
        actionFailures.push(`${command} ${args.join(' ')} did not report success`);
      }
    } catch {
      actionFailures.push(`${command} ${args.join(' ')} threw`);
    }
  };
  const recordSignal = (pid, signal) => {
    try {
      if (kill(pid, signal) === false) {
        actionFailures.push(`${signal} ${pid} returned false`);
      }
    } catch {
      actionFailures.push(`${signal} ${pid} threw`);
    }
  };
  const incomplete = reason => new Error(
    `startup cleanup incomplete: ${reason}`
      + (actionFailures.length > 0 ? `; ${actionFailures.join('; ')}` : ''),
  );
  let ownedGroupWasReused = false;
  let ownedGroupHasUntrustedChronology = false;
  let frozenOwnedGroupMembers;
  let frozenOwnedGroupStableMembers;
  let ownedGroupMembershipChanged = false;
  const stableOwnedGroupMemberKey = processRow => (
    `${processRow.pid}\0${processRow.creationTime}`
  );
  const inspectOwnedGroup = currentRows => {
    if (!trustedOwnedGroup) {
      return undefined;
    }
    const leader = currentRows.find(processRow => processRow.pid === trustedOwnedGroup.pgid);
    if (leader !== undefined
        && !sameProcessIdentity(leader, trustedOwnedGroup.rootIdentity)) {
      ownedGroupWasReused = true;
    }
    const allMembers = currentRows.filter(
      processRow => processRow.pgid === trustedOwnedGroup.pgid,
    );
    const eligibleMembers = allMembers.filter(processRow => {
      const startedAt = comparableStartedAt(processRow);
      return startedAt !== null && startedAt >= trustedOwnedGroup.startedAt;
    });
    if (eligibleMembers.length !== allMembers.length) {
      ownedGroupHasUntrustedChronology = true;
    }
    if (frozenOwnedGroupMembers !== undefined
        && allMembers.some(processRow => !frozenOwnedGroupMembers.has(
          trackedProcessKey(processRow),
        ))) {
      ownedGroupMembershipChanged = true;
    }
    if (frozenOwnedGroupStableMembers !== undefined
        && currentRows.some(processRow => (
          frozenOwnedGroupStableMembers.has(stableOwnedGroupMemberKey(processRow))
            && !frozenOwnedGroupMembers.has(trackedProcessKey(processRow))
        ))) {
      ownedGroupMembershipChanged = true;
    }
    return { allMembers, eligibleMembers };
  };
  const freezeOwnedGroupMembers = inspection => {
    if (inspection
        && !ownedGroupWasReused
        && !ownedGroupHasUntrustedChronology) {
      frozenOwnedGroupMembers = new Set(
        inspection.allMembers.map(processRow => trackedProcessKey(processRow)),
      );
      frozenOwnedGroupStableMembers = new Set(
        inspection.allMembers.map(processRow => stableOwnedGroupMemberKey(processRow)),
      );
    }
  };
  const ownedGroupMayBeSignaled = inspection => {
    if (!inspection
        || ownedGroupWasReused
        || ownedGroupHasUntrustedChronology
        || ownedGroupMembershipChanged) {
      return false;
    }
    return inspection.eligibleMembers.length > 0;
  };
  const rememberSafeOwnedGroupMembers = inspection => {
    if (!markerEnabled
        || !inspection
        || ownedGroupWasReused
        || ownedGroupHasUntrustedChronology
        || ownedGroupMembershipChanged) {
      return;
    }
    cleanupTrackedProcesses = mergeTrackedProcesses(
      cleanupTrackedProcesses,
      inspection.eligibleMembers,
    );
    rememberIdentities(inspection.eligibleMembers);
  };
  rememberSafeDescendants(rows);
  const initialOwnedGroupInspection = inspectOwnedGroup(rows);
  rememberSafeOwnedGroupMembers(initialOwnedGroupInspection);
  const readPlan = async allowTreeForRead => {
    const currentRows = await readWithRetry();
    rememberSafeDescendants(currentRows);
    return planProcessCleanup(
      currentRows,
      trustedRootIdentity,
      cleanupTrackedProcesses,
      { allowTree: allowTreeForRead },
    );
  };
  const rootFirst = processIds => processIds.includes(verifiedRootPid)
    ? [verifiedRootPid, ...processIds.filter(pid => pid !== verifiedRootPid)]
    : processIds;
  const initialPlan = planProcessCleanup(
    rows,
    trustedRootIdentity,
    cleanupTrackedProcesses,
    { allowTree },
  );
  if (platform === 'win32') {
    let currentRows;
    try {
      currentRows = await readWithRetry();
      rememberSafeDescendants(currentRows);
    } catch {
      await terminateControlledChild();
      throw incomplete('process table could not be revalidated before taskkill');
    }
    if (currentRows.some(row => sameProcessIdentity(row, trustedRootIdentity))) {
      recordCommand('taskkill.exe', ['/PID', String(verifiedRootPid), '/F']);
    }
  } else {
    const terminateExplicit = async (processIds, signal) => {
      for (const pid of rootFirst(processIds)) {
        let currentPlan;
        try {
          currentPlan = await readPlan(false);
        } catch {
          await terminateControlledChild();
          throw incomplete('process table could not be revalidated before signaling');
        }
        if (currentPlan.processIds.includes(pid)) {
          recordSignal(pid, signal);
        }
      }
    };
    const explicitProcessesOutsideOwnedGroup = currentRows => {
      rememberSafeDescendants(currentRows);
      const inspection = inspectOwnedGroup(currentRows);
      rememberSafeOwnedGroupMembers(inspection);
      const currentByPid = new Map(currentRows.map(processRow => [processRow.pid, processRow]));
      const selected = planProcessCleanup(
        currentRows,
        trustedRootIdentity,
        cleanupTrackedProcesses,
        { allowTree: false },
      ).processIds;
      return markerEnabled
        ? selected
        : selected.filter(pid => currentByPid.get(pid)?.pgid !== trustedOwnedGroup.pgid);
    };
    const signalPlan = async (plan, signal, allowGroup) => {
      if (plan.mode === 'tree') {
        let currentPlan;
        try {
          currentPlan = await readPlan(allowGroup);
        } catch {
          await terminateControlledChild();
          throw incomplete('process table could not be revalidated before group signaling');
        }
        if (currentPlan.mode === 'tree'
            && Number.isSafeInteger(currentPlan.pgid)
            && currentPlan.pgid > 0
            && currentPlan.pgid === currentPlan.rootPid) {
          recordSignal(-currentPlan.pgid, signal);
          return;
        }
        await terminateExplicit(currentPlan.processIds, signal);
        return;
      }
      await terminateExplicit(plan.processIds, signal);
    };
    if (trustedOwnedGroup) {
      let termRows;
      try {
        termRows = await readWithRetry();
      } catch {
        await terminateControlledChild();
        throw incomplete('process table could not be revalidated before owned-group SIGTERM');
      }
      const termInspection = inspectOwnedGroup(termRows);
      rememberSafeOwnedGroupMembers(termInspection);
      freezeOwnedGroupMembers(termInspection);
      if (!markerEnabled && ownedGroupMayBeSignaled(termInspection)) {
        recordSignal(-trustedOwnedGroup.pgid, 'SIGTERM');
      }
      await terminateExplicit(explicitProcessesOutsideOwnedGroup(termRows), 'SIGTERM');
      await delay(250);

      let killRows;
      try {
        killRows = await readWithRetry();
      } catch {
        await terminateControlledChild();
        throw incomplete('process table could not be revalidated before owned-group SIGKILL');
      }
      const killInspection = inspectOwnedGroup(killRows);
      rememberSafeOwnedGroupMembers(killInspection);
      if (!markerEnabled && ownedGroupMayBeSignaled(killInspection)) {
        recordSignal(-trustedOwnedGroup.pgid, 'SIGKILL');
      }
      await terminateExplicit(explicitProcessesOutsideOwnedGroup(killRows), 'SIGKILL');
    } else {
      await signalPlan(initialPlan, 'SIGTERM', allowTree);
      await delay(250);

      try {
        rows = await readWithRetry();
      } catch {
        await terminateControlledChild();
        throw incomplete('process table could not be revalidated after SIGTERM');
      }
      rememberSafeDescendants(rows);
      const finalPlan = planProcessCleanup(rows, trustedRootIdentity, cleanupTrackedProcesses, {
        allowTree: allowTree && initialPlan.mode === 'tree',
      });
      await signalPlan(finalPlan, 'SIGKILL', allowTree && initialPlan.mode === 'tree');
    }
  }

  let survivors = [...exactIdentities.values()];
  let ownedGroupSurvivors = [];
  let markerSurvivors = latestMarkedProcesses;
  for (let attempt = 1; attempt <= verifyAttempts; attempt++) {
    let verificationRows;
    try {
      verificationRows = await readWithRetry();
    } catch {
      await terminateControlledChild();
      throw incomplete('process table could not be read for final verification');
    }
    // A cooperative child can clear the marker between verification rounds.
    // Preserve every exact identity while it is observable so a later marker
    // disappearance cannot turn a surviving process into a false success.
    rememberIdentities(latestMarkedProcesses);
    survivors = [...exactIdentities.values()].filter(identity => verificationRows.some(
      processRow => sameProcessIdentity(processRow, identity),
    ));
    markerSurvivors = latestMarkedProcesses.filter(identity => verificationRows.some(
      processRow => sameProcessIdentity(processRow, identity),
    ));
    ownedGroupSurvivors = inspectOwnedGroup(verificationRows)?.allMembers ?? [];
    if (survivors.length === 0
        && markerSurvivors.length === 0
        && ownedGroupSurvivors.length === 0
        && !markerQueryFailed
        && !ownedGroupWasReused
        && !ownedGroupHasUntrustedChronology
        && !ownedGroupMembershipChanged) {
      return;
    }
    if (attempt < verifyAttempts) {
      await delay(cleanupReadDelayMs);
    }
  }
  if (ownedGroupWasReused) {
    throw incomplete(`owned process group ${trustedOwnedGroup.pgid} was reused`);
  }
  if (ownedGroupHasUntrustedChronology) {
    throw incomplete(`owned process group ${trustedOwnedGroup.pgid} has untrusted member chronology`);
  }
  if (ownedGroupMembershipChanged) {
    throw incomplete(`owned process group ${trustedOwnedGroup.pgid} membership changed after SIGTERM`);
  }
  if (ownedGroupSurvivors.length > 0) {
    throw incomplete(
      `owned process group ${trustedOwnedGroup.pgid} still has members (`
        + `${ownedGroupSurvivors.map(row => row.pid).join(', ')})`,
    );
  }
  if (markerQueryFailed) {
    throw incomplete('startup run marker query could not be verified');
  }
  if (markerSurvivors.length > 0) {
    throw incomplete(
      `startup run marker still has processes (${markerSurvivors.map(row => row.pid).join(', ')})`,
    );
  }
  throw incomplete(`exact process identities still running (${survivors.map(row => row.pid).join(', ')})`);
}

const defaultMeasurementDependencies = {
  launch: launchMeasuredProcess,
  capture: captureProcessIdentity,
  startMonitor: (rootIdentity, { child }) => startProcessTreeMonitor(rootIdentity, { child }),
  waitForReport: waitForStartupReport,
  delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  sample: (rootIdentity, { platform, runId }) => sampleProcessTree(
    rootIdentity,
    platform,
    { runId },
  ),
  terminate: terminateMeasuredTree,
};

export async function measureOnce(options, dependencies = defaultMeasurementDependencies) {
  const now = dependencies.now ?? Date.now;
  const platform = dependencies.platform ?? process.platform;
  const deadline = now() + options.timeoutMs;
  const runId = validateRunId((dependencies.createRunId ?? randomUUID)());
  options.onRunId?.(runId);
  const child = await dependencies.launch({ ...options, runId });
  const rootPid = positiveInteger(child?.pid, 'spawned root pid');
  if (rootPid === 0) {
    throw new Error('spawned root pid must be positive');
  }
  let rootIdentity;
  let ownedGroup;
  let metrics;
  let monitor;
  let monitoredProcesses = [];
  let containmentVerified = false;
  let stopMonitorPromise;
  const stopMonitorOnce = () => {
    if (!stopMonitorPromise) {
      const activeMonitor = monitor;
      monitor = undefined;
      stopMonitorPromise = activeMonitor
        ? Promise.resolve(activeMonitor.stop()).then(processes => {
          monitoredProcesses = mergeTrackedProcesses(monitoredProcesses, processes);
          return monitoredProcesses;
        })
        : Promise.resolve(monitoredProcesses);
    }
    return stopMonitorPromise;
  };
  try {
    rootIdentity = await dependencies.capture(rootPid, {
      platform,
      timeoutMs: Math.min(2_000, Math.max(0, deadline - now())),
      pollMs: Math.min(25, options.pollMs),
    });
    ownedGroup = captureOwnedProcessGroup(rootIdentity, platform);
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
    containmentVerified = true;
    await stopMonitorOnce();
    await dependencies.delay(options.idleMs);
    metrics = dependencies.sample(rootIdentity, { platform, runId });
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
      trackedProcesses = mergeTrackedProcesses(trackedProcesses, await stopMonitorOnce());
    } finally {
      try {
        await dependencies.terminate({
          child,
          rootPid,
          rootIdentity,
          ...(ownedGroup ? { ownedGroup } : {}),
          trackedProcesses,
          containmentVerified,
          runId,
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
  const outputDirectory = path.resolve(path.dirname(resolvedOutput));
  let ownedDiagnostics;
  try {
    const failure = JSON.parse(await fs.promises.readFile(
      failurePathForOutput(resolvedOutput),
      'utf8',
    ));
    const directoryName = failure?.diagnostics?.directory;
    const campaignId = failure?.campaignId;
    const expectedDirectoryName = typeof campaignId === 'string'
      ? `${artifactStem(resolvedOutput)}-diagnostics-${campaignId}`
      : undefined;
    if (failure?.status === 'failed'
        && failure.output === resolvedOutput
        && typeof campaignId === 'string'
        && UUID_PATTERN.test(campaignId)
        && typeof directoryName === 'string'
        && directoryName.length > 0
        && directoryName !== '.'
        && directoryName !== '..'
        && !path.isAbsolute(directoryName)
        && !directoryName.includes('/')
        && !directoryName.includes('\\')
        && path.basename(directoryName) === directoryName
        && directoryName === expectedDirectoryName) {
      const candidate = path.resolve(outputDirectory, directoryName);
      if (path.dirname(candidate) !== outputDirectory) {
        throw new Error('diagnostics ownership path is outside the output directory');
      }
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
          && owner.campaignId === campaignId
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

async function readOptionalStartupReport(reportPath, sensitiveValues) {
  try {
    const serialized = await fs.promises.readFile(reportPath, 'utf8');
    try {
      return parseStartupReport(serialized, { phase: 'incremental' });
    } catch (error) {
      return {
        invalid: true,
        error: redactDiagnosticText(error.message, sensitiveValues),
      };
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
  const startupReport = await readOptionalStartupReport(reportPath, sensitiveValues);
  const portableRelativePath = file => path.relative(outputDirectory, file).replaceAll('\\', '/');
  const diagnostic = {
    status: 'failed',
    error: {
      name: redactDiagnosticText(
        typeof error?.name === 'string' ? error.name : 'Error',
        sensitiveValues,
      ),
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
    let runId;
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
        onRunId: candidate => {
          const verifiedRunId = validateRunId(candidate);
          if (runId !== undefined && runId !== verifiedRunId) {
            throw new Error('measurement reported more than one startup run id');
          }
          runId = verifiedRunId;
        },
      }));
    } catch (error) {
      const runSensitiveValues = [
        ...sensitiveValues,
        ...(runId === undefined ? [] : [runId]),
      ];
      const diagnostic = await preserveFailureDiagnostic({
        options,
        executable,
        campaignId,
        runIndex,
        completedRuns: [...rawRuns],
        error,
        reportPath,
        stdoutLogPath,
        stderrLogPath,
        sensitiveValues: runSensitiveValues,
      });
      const sanitized = new Error(diagnostic.error.message);
      sanitized.name = diagnostic.error.name;
      throw sanitized;
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
