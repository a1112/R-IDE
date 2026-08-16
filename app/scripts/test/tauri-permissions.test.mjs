// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauriDirectory = path.join(appDirectory, 'applications', 'tauri', 'src-tauri');
const productDirectory = path.join(appDirectory, 'theia-extensions', 'product', 'src', 'browser');

function invokedCommands(source) {
  const invokeNames = new Set(['invoke']);
  const coreImportPattern = /import\s*{([^}]*)}\s*from\s*['"]@tauri-apps\/api\/core['"]/g;
  for (const match of source.matchAll(coreImportPattern)) {
    for (const specifier of match[1].split(',')) {
      const invokeImport = /^\s*invoke(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier);
      if (invokeImport) {
        invokeNames.add(invokeImport[1] ?? 'invoke');
      }
    }
  }

  const commands = [];
  for (const invokeName of invokeNames) {
    const escapedName = invokeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callPattern = new RegExp(
      `(?<![\\w$])${escapedName}(?:<[^>]+>)?\\s*\\(\\s*['"]([^'"]+)['"]`,
      'g'
    );
    commands.push(...[...source.matchAll(callPattern)].map(match => match[1]));
  }
  return commands;
}

function auditedCommands(sources, expectedCommands) {
  const commands = [...new Set(sources.flatMap(invokedCommands))].sort();
  const expected = new Set(expectedCommands);
  const unauthorized = commands.filter(command => !expected.has(command));
  if (unauthorized.length > 0) {
    throw new Error(`Unaudited Tauri commands: ${unauthorized.join(', ')}`);
  }
  assert.deepEqual(commands, expectedCommands);
  return commands;
}

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await sourceFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      result.push(entryPath);
    }
  }
  return result;
}

function parseCommandPermissions(source) {
  const result = new Map();
  for (const match of source.matchAll(/\[\[permission\]\]([\s\S]*?)(?=\[\[permission\]\]|$)/g)) {
    const block = match[1];
    const identifier = /\bidentifier\s*=\s*"([^"]+)"/.exec(block)?.[1];
    const allow = /\bcommands\.allow\s*=\s*\[([^\]]*)\]/.exec(block)?.[1]
      .match(/"([^"]+)"/g)
      ?.map(value => value.slice(1, -1)) ?? [];
    if (identifier) {
      result.set(identifier, allow);
    }
  }
  return result;
}

test('remote Tauri frontend receives only audited per-command permissions', async () => {
  const frontendSources = await sourceFiles(productDirectory);
  const sources = await Promise.all(frontendSources.map(source => readFile(source, 'utf8')));
  const commands = auditedCommands(sources, [
    'ride_frontend_ready',
    'ride_performance_snapshot',
    'ride_plugin_directories',
    'ride_record_startup_milestone',
    'ride_show_main_menu',
    'ride_start_window_drag',
    'ride_window_control'
  ]);

  const permissionSource = await readFile(path.join(tauriDirectory, 'permissions', 'ride-frontend.toml'), 'utf8');
  const permissions = parseCommandPermissions(permissionSource);
  const expectedIdentifiers = commands.map(command => `allow-${command.replaceAll('_', '-')}`);

  assert.deepEqual([...permissions.keys()].sort(), expectedIdentifiers);
  for (const command of commands) {
    assert.deepEqual(permissions.get(`allow-${command.replaceAll('_', '-')}`), [command]);
  }

  const capability = JSON.parse(await readFile(path.join(tauriDirectory, 'capabilities', 'default.json'), 'utf8'));
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.local, false);
  assert.deepEqual(capability.remote?.urls, ['http://127.0.0.1:3000']);
  assert.deepEqual(
    capability.permissions.filter(permission => !permission.startsWith('core:event:')).sort(),
    expectedIdentifiers
  );
  assert.deepEqual(
    capability.permissions.filter(permission => permission.startsWith('core:event:')).sort(),
    ['core:event:allow-listen', 'core:event:allow-unlisten']
  );
  assert.equal(capability.permissions.some(permission => /(?:^|:)default$|allow-all/.test(permission)), false);

  const frontendGenerator = await readFile(
    path.join(appDirectory, 'applications', 'tauri', 'copy-frontend.js'),
    'utf8'
  );
  const bootstrapMatch = /const tauriBootstrapScript = `([\s\S]*?)`;\r?\n\r?\nfs\.writeFileSync\(path\.join\(tauriFrontendDir, 'bootstrap\.js'\)/.exec(frontendGenerator);
  assert.ok(bootstrapMatch, 'expected the generated local bootstrap source');
  const localBootstrap = bootstrapMatch[1];
  assert.deepEqual(invokedCommands(localBootstrap), []);
  assert.equal(/\blisten\(\s*['"]/.test(localBootstrap), false);
});

test('rejects unauthorized literal commands invoked through an imported alias', () => {
  const aliasedInvokeFixture = `
    import { invoke as hiddenInvoke, isTauri } from '@tauri-apps/api/core';
    this.invoke('ride_frontend_ready');
    hiddenInvoke('ride_unauthorized');
  `;

  assert.throws(
    () => auditedCommands([aliasedInvokeFixture], ['ride_frontend_ready']),
    /ride_unauthorized/
  );
});
