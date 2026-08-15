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
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('median values must be finite numbers');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3) {
      throw new Error(`invalid ps process row: ${line}`);
    }
    const pid = positiveInteger(fields[0], 'ps pid');
    const ppid = positiveInteger(fields[1], 'ps ppid');
    const rssKiB = positiveInteger(fields[2], 'ps RSS');
    if (pid === 0) {
      throw new Error('ps pid must be positive');
    }
    rows.push({ pid, ppid, rssBytes: rssKiB * 1024 });
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
  return candidates.map((candidate, index) => {
    assertPlainObject(candidate, `PowerShell process row ${index}`);
    const pid = positiveInteger(candidate.ProcessId, 'PowerShell ProcessId');
    const ppid = positiveInteger(candidate.ParentProcessId, 'PowerShell ParentProcessId');
    const rssBytes = positiveInteger(candidate.WorkingSetSize, 'PowerShell WorkingSetSize');
    if (pid === 0) {
      throw new Error('PowerShell ProcessId must be positive');
    }
    return { pid, ppid, rssBytes };
  });
}

export function aggregateProcessTree(rows, rootPid) {
  const verifiedRoot = positiveInteger(rootPid, 'spawned root pid');
  if (!rows.some(row => row.pid === verifiedRoot)) {
    throw new Error(`spawned root process ${verifiedRoot} is absent from the process table`);
  }
  const processIds = new Set([verifiedRoot]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (!processIds.has(row.pid) && processIds.has(row.ppid)) {
        processIds.add(row.pid);
        changed = true;
      }
    }
  }
  const selected = rows.filter(row => processIds.has(row.pid));
  const orderedIds = selected.map(row => row.pid).sort((left, right) => left - right);
  return {
    rootPid: verifiedRoot,
    processIds: orderedIds,
    processCount: orderedIds.length,
    rssBytes: selected.reduce((total, row) => total + row.rssBytes, 0),
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
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.error || result.status !== 0) {
      throw new Error(`PowerShell process query failed: ${result.error?.message ?? result.stderr}`);
    }
    return parseWindowsProcessTable(result.stdout);
  }

  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`ps process query failed: ${result.error?.message ?? result.stderr}`);
  }
  return parsePosixProcessTable(result.stdout);
}

export function sampleProcessTree(rootPid, platform = process.platform) {
  return aggregateProcessTree(readProcessTable(platform), rootPid);
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

async function launchMeasuredProcess({ executable, codeFile, reportPath, cwd }) {
  const child = spawn(executable, [codeFile], {
    cwd,
    detached: process.platform !== 'win32',
    env: { ...process.env, RIDE_STARTUP_REPORT: reportPath },
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return child;
}

async function terminateMeasuredTree(rootPid, platform = process.platform) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) {
    return;
  }
  if (platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(rootPid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  let descendants = [];
  try {
    descendants = aggregateProcessTree(readProcessTable(platform), rootPid).processIds
      .filter(pid => pid !== rootPid)
      .reverse();
  } catch {
    // The root may have already exited. The detached process-group ID remains scoped to this spawn.
  }
  try {
    process.kill(-rootPid, 'SIGTERM');
  } catch {
    for (const pid of descendants) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // A verified descendant may have exited between process-table capture and cleanup.
      }
    }
  }
  await new Promise(resolve => setTimeout(resolve, 250));
  try {
    process.kill(-rootPid, 'SIGKILL');
  } catch {
    for (const pid of descendants) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Cleanup is best effort and remains limited to verified descendants.
      }
    }
  }
}

const defaultMeasurementDependencies = {
  launch: launchMeasuredProcess,
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
  try {
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
    const metrics = dependencies.sample(rootPid);
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
    await dependencies.terminate(rootPid);
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

async function main(argv) {
  const options = parseArguments(argv);
  const executable = options.executable ?? discoverExecutable(options.bundleRoot);
  if (!existingFile(executable)) {
    throw new Error(`Tauri executable does not exist: ${executable}`);
  }

  const rawRuns = [];
  for (let run = 1; run <= options.runs; run++) {
    const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ride-startup-run-'));
    const codeFile = path.join(temporary, `startup-${run}.R`);
    const reportPath = path.join(temporary, 'startup-report.json');
    try {
      await fs.promises.writeFile(codeFile, '# R-IDE startup measurement\n');
      rawRuns.push(await measureOnce({
        executable,
        codeFile,
        reportPath,
        idleMs: options.idleMs,
        timeoutMs: options.timeoutMs,
        pollMs: options.pollMs,
        cwd: applicationRoot,
      }));
    } finally {
      await fs.promises.rm(temporary, { recursive: true, force: true });
    }
  }

  const measurement = {
    schema: MEASUREMENT_SCHEMA,
    version: MEASUREMENT_VERSION,
    platform: process.platform,
    arch: process.arch,
    executable: path.resolve(executable),
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
  process.stdout.write(`${JSON.stringify(measurement, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
