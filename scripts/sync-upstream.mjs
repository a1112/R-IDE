#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { loadSourceConfig } from './lib/upstream-sync/config.mjs';
import { synchronize } from './lib/upstream-sync/engine.mjs';
import { checkoutDetached, cloneRepository, resolveCommit } from './lib/upstream-sync/git.mjs';
import { runCommand } from './lib/upstream-sync/command.mjs';
import { compareProductTrees, makeReport, trackedProductPaths } from './lib/upstream-sync/report.mjs';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usageError(message) {
  throw new TypeError(message);
}

function parseArgs(argv) {
  if (argv.length === 0) usageError('a subcommand is required (check, sync, or refresh-patches)');
  const command = argv[0];
  if (!['check', 'sync', 'refresh-patches'].includes(command)) usageError(`unknown subcommand: ${command}`);
  const options = { command, root: SCRIPT_ROOT, dryRun: false, json: false };
  const takesValue = new Set(['--root', '--report', '--target']);
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') { options.dryRun = true; continue; }
    if (flag === '--json') { options.json = true; continue; }
    if (!takesValue.has(flag)) usageError(`unknown flag: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) usageError(`${flag} requires a value`);
    if (flag === '--root') options.root = path.resolve(value);
    else if (flag === '--report') options.report = path.resolve(value);
    else options.target = value;
  }
  if (command === 'check' && options.target) usageError('--target is only valid with sync');
  if (command !== 'sync' && options.dryRun) usageError('--dry-run is only valid with sync');
  return options;
}

async function loadPatchFiles(root) {
  const patchRoot = path.join(root, '.upstream', 'patches');
  let names;
  try { names = (await fs.readdir(patchRoot)).filter(name => name.endsWith('.patch')).sort(); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  return Promise.all(names.map(async name => ({ name, contents: await fs.readFile(path.join(patchRoot, name)) })));
}

async function writeSource(root, source, commit) {
  const file = path.join(root, '.upstream', 'source.json');
  await fs.writeFile(file, `${JSON.stringify({ ...source, commit }, null, 2)}\n`, 'utf8');
}

function isOwned(relative, ownedPaths) {
  const normalized = relative.replaceAll('\\', '/');
  return ownedPaths.some(entry => {
    const clean = entry.replace(/[\\/]$/u, '');
    return normalized === clean || normalized.startsWith(`${clean}/`);
  });
}

async function copyProductFile(product, checkout, relative) {
  const source = path.join(product, ...relative.split('/'));
  const destination = path.join(checkout, ...relative.split('/'));
  const stat = await fs.lstat(source);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rm(destination, { recursive: true, force: true });
  if (stat.isSymbolicLink()) await fs.symlink(await fs.readlink(source), destination);
  else await fs.copyFile(source, destination);
}

async function refreshPatches(root, config) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-refresh-patches-'));
  const checkout = path.join(temporary, 'checkout');
  try {
    const repository = /^([A-Za-z][A-Za-z0-9+.-]*:)/u.test(config.source.repository)
      ? config.source.repository
      : path.resolve(root, config.source.repository);
    await cloneRepository(repository, checkout);
    await resolveCommit(checkout, config.source.commit);
    await checkoutDetached(checkout, config.source.commit);
    const product = path.join(root, 'app');
    const tracked = await trackedProductPaths(root);
    const productSet = new Set(tracked.filter(relative => !isOwned(relative, config.ownedPaths)));
    const baseline = (await runCommand('git', ['-C', checkout, 'ls-files', '-z'])).stdout.split('\0').filter(Boolean);
    for (const relative of baseline) {
      if (!isOwned(relative, config.ownedPaths) && !productSet.has(relative)) {
        await fs.rm(path.join(checkout, ...relative.split('/')), { recursive: true, force: true });
      }
    }
    for (const relative of productSet) await copyProductFile(product, checkout, relative);
    await runCommand('git', ['-C', checkout, 'add', '-A']);
    const patch = (await runCommand('git', ['-C', checkout, 'diff', '--cached', '--binary', '--no-ext-diff'])).stdout;
    const patchRoot = path.join(root, '.upstream', 'patches');
    await fs.mkdir(patchRoot, { recursive: true });
    const patchPath = path.join(patchRoot, '0001-upstream.patch');
    let changed = true;
    try { changed = patch !== await fs.readFile(patchPath, 'utf8'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (patch.length > 0) await fs.writeFile(patchPath, patch, 'utf8');
    else {
      await fs.rm(patchPath, { force: true });
      changed = true;
    }
    return { changed, patches: patch.length > 0 ? ['0001-upstream.patch'] : [] };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function run(options) {
  const root = path.resolve(options.root);
  const config = loadSourceConfig(root);
  const product = path.join(root, 'app');
  const patches = await loadPatchFiles(root);
  if (options.command === 'refresh-patches') {
    const result = await refreshPatches(root, config);
    const report = makeReport({ ...result, previousCommit: config.source.commit, targetCommit: config.source.commit, ownedPaths: config.ownedPaths, repository: config.source.repository });
    return { report, exitCode: 0 };
  }

  const target = options.command === 'check' ? config.source.commit : (options.target ?? config.source.branch);
  let diff;
  const syncOptions = {
    repositoryRoot: root,
    product,
    source: config.source,
    target,
    ownedPaths: config.ownedPaths,
    patches,
  };
  if (options.command === 'sync' && !options.dryRun) {
    syncOptions.verifier = async (staged) => {
      diff = await compareProductTrees(root, product, staged);
    };
  } else {
    syncOptions.replaceDestination = async (destination, staged) => {
      diff = await compareProductTrees(root, destination, staged);
    };
  }
  const result = await synchronize(syncOptions);
  if (options.command === 'sync' && !options.dryRun) {
    await writeSource(root, config.source, result.target);
  }
  const report = makeReport({ changed: Boolean(diff?.added?.length || diff?.modified?.length || diff?.deleted?.length || diff?.renamed), previousCommit: config.source.commit, targetCommit: result.target, diff, ownedPaths: config.ownedPaths, patches: patches.map(patch => patch.name), repository: config.source.repository });
  if (options.command === 'check') report.drift = report.changed;
  return { report, exitCode: options.command === 'check' && report.changed ? 1 : 0 };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const { report, exitCode } = await run(options);
  if (options.report) await fs.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (options.json || options.report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    const line = `upstream ${options.command}: changed=${report.changed} ${report.previousCommit} -> ${report.targetCommit}${report.drift ? ' (drift detected)' : ''}\n`;
    (exitCode === 0 ? process.stdout : process.stderr).write(line);
  }
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll('\\', '/')}` || process.argv[1]?.endsWith('sync-upstream.mjs')) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

export { main, parseArgs, refreshPatches };
