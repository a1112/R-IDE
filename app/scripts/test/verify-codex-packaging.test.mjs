/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertCodexPackaging,
  verifyCodexPackaging,
} from '../verify-codex-packaging.mjs';

async function fixtureArtifact() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-codex-packaging-'));
  await fs.mkdir(path.join(root, 'chunks'), { recursive: true });
  await fs.writeFile(path.join(root, 'main.js'), 'export {}\n');
  await fs.writeFile(path.join(root, 'codex-sdk-runtime.mjs'), 'export function createCodexClient() {}\n');
  await fs.writeFile(path.join(root, 'chunks', 'runtime.js'), 'export {}\n');
  return root;
}

test('packaging verifier accepts the JavaScript-only Codex SDK runtime', async t => {
  const root = await fixtureArtifact();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const result = verifyCodexPackaging(root);
  assert.deepEqual(result.forbidden, []);
  assert.deepEqual(result.missing, []);
  assert.equal(result.files.some(file => file.endsWith('codex-sdk-runtime.mjs')), true);
  assert.deepEqual(assertCodexPackaging(root), result);
});

test('packaging verifier rejects native, vendor, and managed Codex payloads case-insensitively', async t => {
  const root = await fixtureArtifact();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'CoDeX-Win32-x64', 'VeNdOr'), { recursive: true });
  await fs.writeFile(path.join(root, 'CoDeX-Win32-x64', 'VeNdOr', 'codex.EXE'), 'native\n');
  await fs.mkdir(path.join(root, 'CoDeX-Resources'), { recursive: true });
  await fs.writeFile(path.join(root, 'CoDeX-Resources', 'manifest.json'), '{}\n');
  await fs.mkdir(path.join(root, 'managed-codex-runtime', 'v-0.144.0'), { recursive: true });
  await fs.writeFile(path.join(root, 'managed-codex-runtime', 'v-0.144.0', 'pointer.json'), '{}\n');

  const result = verifyCodexPackaging(root);
  assert.ok(result.forbidden.length >= 4);
  assert.equal(result.forbidden.some(entry => /codex\.exe$/iu.test(entry.path)), true);
  assert.equal(result.forbidden.some(entry => /codex-resources/iu.test(entry.path)), true);
  assert.equal(result.forbidden.some(entry => /managed-codex-runtime/iu.test(entry.path)), true);
  assert.throws(() => assertCodexPackaging(root), /forbidden native\/vendor/i);
});

test('packaging verifier reports a missing runtime without traversing outside the artifact root', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-codex-packaging-missing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.js'), 'export {}\n');

  const result = verifyCodexPackaging(root);
  assert.deepEqual(result.missing, ['codex-sdk-runtime.mjs']);
  assert.throws(() => assertCodexPackaging(root), /missing required Codex packaging artifact/i);
});
