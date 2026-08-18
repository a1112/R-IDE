/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/* eslint-disable @typescript-eslint/tslint/config -- JavaScript modules cannot declare TypeScript typedefs. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  generatePackagedSmokePluginInventory,
  selectPackagedSmokePlugin,
} from '../generate-packaged-smoke-plugin.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-packaged-plugin-'));
  temporaryDirectories.push(root);
  const pluginsDirectory = path.join(root, 'plugins');
  const output = path.join(root, 'ride-packaged-plugin-inventory.ts');
  fs.mkdirSync(pluginsDirectory);
  return { root, pluginsDirectory, output };
}

function writePlugin(pluginsDirectory, directoryName, manifest) {
  const extensionDirectory = path.join(pluginsDirectory, directoryName, 'extension');
  fs.mkdirSync(extensionDirectory, { recursive: true });
  fs.writeFileSync(path.join(extensionDirectory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`);
}

test('selects git.refresh only when it is contributed by the canonical unpacked plugin manifest', async () => {
  const { pluginsDirectory } = fixture();
  writePlugin(pluginsDirectory, 'acme.other', {
    publisher: 'acme', name: 'other', version: '1.0.0',
    contributes: { commands: [{ command: 'acme.arbitrary', title: 'Arbitrary' }] },
  });
  writePlugin(pluginsDirectory, 'vscode.git', {
    publisher: 'vscode', name: 'git', version: '1.108.2',
    contributes: { commands: [{ command: 'git.refresh', title: 'Refresh' }] },
  });

  const selected = await selectPackagedSmokePlugin(pluginsDirectory);

  assert.deepEqual(selected, {
    extensionId: 'vscode.git',
    extensionVersion: '1.108.2',
    commandId: 'git.refresh',
    manifestSha256: selected.manifestSha256,
  });
  assert.match(selected.manifestSha256, /^[0-9a-f]{64}$/);
});

test('rejects an arbitrary command and a preferred command absent from its owning manifest', async () => {
  const { pluginsDirectory } = fixture();
  writePlugin(pluginsDirectory, 'acme.other', {
    publisher: 'acme', name: 'other', version: '1.0.0',
    contributes: { commands: [{ command: 'git.refresh', title: 'Impersonated' }] },
  });
  writePlugin(pluginsDirectory, 'vscode.git', {
    publisher: 'vscode', name: 'git', version: '1.108.2',
    contributes: { commands: [{ command: 'git.clone', title: 'Clone' }] },
  });

  await assert.rejects(
    selectPackagedSmokePlugin(pluginsDirectory),
    /no approved zero-argument smoke command exists in the packaged plugin inventory/i,
  );
});

test('generates deterministic TypeScript provenance from the selected plugin manifest', async () => {
  const { pluginsDirectory, output } = fixture();
  writePlugin(pluginsDirectory, 'vscode.git', {
    publisher: 'vscode', name: 'git', version: '1.108.2',
    contributes: { commands: [{ command: 'git.refresh', title: 'Refresh' }] },
  });

  const first = await generatePackagedSmokePluginInventory({ pluginsDirectory, output });
  const firstSource = fs.readFileSync(output, 'utf8');
  const second = await generatePackagedSmokePluginInventory({ pluginsDirectory, output });

  assert.deepEqual(second, first);
  assert.equal(fs.readFileSync(output, 'utf8'), firstSource);
  assert.match(firstSource, /extensionId: 'vscode\.git'/);
  assert.match(firstSource, /extensionVersion: '1\.108\.2'/);
  assert.match(firstSource, /commandId: 'git\.refresh'/);
  assert.match(firstSource, new RegExp(`manifestSha256: '${first.manifestSha256}'`));
  assert.match(firstSource, /generated from the unpacked packaged plugin inventory/i);
});

test('the canonical download and Tauri build paths regenerate the static inventory', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  assert.equal(
    packageJson.scripts['generate:packaged-smoke-plugin'],
    'node scripts/generate-packaged-smoke-plugin.mjs',
  );
  assert.match(packageJson.scripts['download:plugins'], /npm run generate:packaged-smoke-plugin/);
  assert.match(packageJson.scripts['build:tauri'], /^npm run generate:packaged-smoke-plugin/);
});
