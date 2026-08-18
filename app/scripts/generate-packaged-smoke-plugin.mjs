/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/* eslint-disable @typescript-eslint/tslint/config -- JavaScript modules cannot declare TypeScript typedefs. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PLUGINS_DIRECTORY = path.join(APP_DIRECTORY, 'plugins');
const DEFAULT_OUTPUT = path.join(
  APP_DIRECTORY,
  'theia-extensions',
  'product',
  'src',
  'browser',
  'ride-packaged-plugin-inventory.ts',
);

// These commands are curated for deterministic, zero-argument, non-interactive execution.
// A candidate is selected only when its owning packaged manifest actually contributes it.
const APPROVED_COMMANDS = Object.freeze([
  Object.freeze({ extensionId: 'vscode.git', commandId: 'git.refresh' }),
]);

function isRecord(value) {
  return typeof value === 'object' && !!value && !Array.isArray(value);
}

function canonicalText(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`${label} is not canonical`);
  }
  return value;
}

function canonicalVersion(value, label) {
  const version = canonicalText(value, label);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`${label} is not canonical`);
  }
  return version;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function canonicalPathStat(fileSystem, candidate, kind, label) {
  let stat;
  try {
    stat = await fileSystem.lstat(candidate);
  } catch {
    throw new Error(`${label} is not canonical`);
  }
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`${label} is not canonical`);
  }
  let resolved;
  try {
    resolved = await fileSystem.realpath(candidate);
  } catch {
    throw new Error(`${label} is not canonical`);
  }
  if (typeof resolved !== 'string') {
    throw new Error(`${label} is not canonical`);
  }
  return path.resolve(resolved);
}

function isCanonicalDirectChild(parent, child, childName) {
  const relative = path.relative(parent, child);
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(relative) === normalize(childName);
}

async function readPluginManifest(pluginsDirectory, pluginsRealPath, entry, fileSystem) {
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) {
    throw new Error(`packaged plugin entry ${entry.name} is not canonical`);
  }
  const pluginDirectory = path.join(pluginsDirectory, entry.name);
  const pluginRealPath = await canonicalPathStat(
    fileSystem,
    pluginDirectory,
    'directory',
    `packaged plugin entry ${entry.name}`,
  );
  if (!isCanonicalDirectChild(pluginsRealPath, pluginRealPath, entry.name)) {
    throw new Error(`packaged plugin entry ${entry.name} is not canonical`);
  }
  const extensionDirectory = path.join(pluginDirectory, 'extension');
  const extensionRealPath = await canonicalPathStat(
    fileSystem,
    extensionDirectory,
    'directory',
    `packaged plugin ${entry.name} extension`,
  );
  if (!isCanonicalDirectChild(pluginRealPath, extensionRealPath, 'extension')) {
    throw new Error(`packaged plugin ${entry.name} extension is not canonical`);
  }
  const manifestPath = path.join(extensionDirectory, 'package.json');
  const manifestRealPath = await canonicalPathStat(
    fileSystem,
    manifestPath,
    'file',
    `packaged plugin manifest ${entry.name}`,
  );
  if (!isCanonicalDirectChild(extensionRealPath, manifestRealPath, 'package.json')) {
    throw new Error(`packaged plugin manifest ${entry.name} is not canonical`);
  }
  let manifest;
  try {
    manifest = JSON.parse(await fileSystem.readFile(manifestRealPath, 'utf8'));
  } catch {
    throw new Error(`packaged plugin manifest ${entry.name} could not be read`);
  }
  if (!isRecord(manifest)) {
    throw new Error(`packaged plugin manifest ${entry.name} is not canonical`);
  }
  const publisher = canonicalText(manifest.publisher, `packaged plugin ${entry.name} publisher`);
  const name = canonicalText(manifest.name, `packaged plugin ${entry.name} name`);
  const extensionVersion = canonicalVersion(manifest.version, `packaged plugin ${entry.name} version`);
  const extensionId = `${publisher}.${name}`;
  if (entry.name.toLowerCase() !== extensionId.toLowerCase()) {
    throw new Error(`packaged plugin ${entry.name} identity is not canonical`);
  }
  const contributed = isRecord(manifest.contributes) && Array.isArray(manifest.contributes.commands)
    ? manifest.contributes.commands
    : [];
  const commands = [];
  for (const contribution of contributed) {
    if (!isRecord(contribution)) {
      throw new Error(`packaged plugin ${extensionId} command contribution is not canonical`);
    }
    commands.push(canonicalText(contribution.command, `packaged plugin ${extensionId} command`));
  }
  commands.sort((left, right) => left.localeCompare(right, 'en'));
  if (new Set(commands).size !== commands.length) {
    throw new Error(`packaged plugin ${extensionId} contains duplicate commands`);
  }
  return { extensionId, extensionVersion, commands };
}

export async function selectPackagedSmokePlugin(
  pluginsDirectory = DEFAULT_PLUGINS_DIRECTORY,
  { fileSystem = fs.promises } = {},
) {
  const pluginsRealPath = await canonicalPathStat(
    fileSystem,
    pluginsDirectory,
    'directory',
    'packaged plugin inventory',
  );
  const entries = await fileSystem.readdir(pluginsDirectory, { withFileTypes: true });
  const manifests = new Map();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const manifest = await readPluginManifest(pluginsDirectory, pluginsRealPath, entry, fileSystem);
    if (manifests.has(manifest.extensionId)) {
      throw new Error(`packaged plugin ${manifest.extensionId} is duplicated`);
    }
    manifests.set(manifest.extensionId, manifest);
  }
  for (const candidate of APPROVED_COMMANDS) {
    const manifest = manifests.get(candidate.extensionId);
    if (manifest?.commands.includes(candidate.commandId)) {
      return Object.freeze({
        ...candidate,
        extensionVersion: manifest.extensionVersion,
        manifestSha256: sha256(canonicalJson(manifest)),
      });
    }
  }
  throw new Error('No approved zero-argument smoke command exists in the packaged plugin inventory.');
}

function quoteTypeScript(value) {
  return `'${value.replace(/\\/gu, '\\\\').replace(/'/gu, "\\'")}'`;
}

export function renderPackagedSmokePluginInventory(selected) {
  return '/********************************************************************************\n'
    + ' * Copyright (C) 2026 R-IDE contributors.\n'
    + ' *\n'
    + ' * SPDX-License-Identifier: MIT\n'
    + ' ********************************************************************************/\n\n'
    + '// Generated from the unpacked packaged plugin inventory. Do not edit manually.\n'
    + 'export const RIDE_SMOKE_PACKAGED_PLUGIN = Object.freeze({\n'
    + `    extensionId: ${quoteTypeScript(selected.extensionId)},\n`
    + `    extensionVersion: ${quoteTypeScript(selected.extensionVersion)},\n`
    + `    commandId: ${quoteTypeScript(selected.commandId)},\n`
    + `    manifestSha256: ${quoteTypeScript(selected.manifestSha256)}\n`
    + '});\n';
}

export async function generatePackagedSmokePluginInventory({
  pluginsDirectory = DEFAULT_PLUGINS_DIRECTORY,
  output = DEFAULT_OUTPUT,
} = {}) {
  const selected = await selectPackagedSmokePlugin(pluginsDirectory);
  const source = renderPackagedSmokePluginInventory(selected);
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  let current;
  try {
    current = await fs.promises.readFile(output, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  if (current?.replaceAll('\r\n', '\n') !== source) {
    const temporary = `${output}.tmp-${process.pid}`;
    await fs.promises.writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
    try {
      await fs.promises.rename(temporary, output);
    } catch (error) {
      await fs.promises.rm(temporary, { force: true });
      throw error;
    }
  }
  return selected;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if ((name !== '--plugins-dir' && name !== '--output') || value === undefined) {
      throw new Error('Usage: generate-packaged-smoke-plugin.mjs [--plugins-dir PATH] [--output PATH]');
    }
    options[name === '--plugins-dir' ? 'pluginsDirectory' : 'output'] = path.resolve(value);
  }
  return options;
}

async function main() {
  const selected = await generatePackagedSmokePluginInventory(parseArguments(process.argv.slice(2)));
  console.log(`Generated packaged smoke command ${selected.extensionId}/${selected.commandId}.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => {
    console.error(`Packaged smoke plugin generation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
