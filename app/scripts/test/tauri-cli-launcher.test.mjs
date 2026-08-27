// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const launcher = require(path.join(appDirectory, 'applications', 'tauri', 'run-tauri-cli.js'));
const tauriPackage = JSON.parse(fs.readFileSync(path.join(appDirectory, 'applications', 'tauri', 'package.json'), 'utf8'));

test('Tauri workspace uses the portable CLI launcher', () => {
  assert.equal(tauriPackage.scripts.tauri, 'node run-tauri-cli.js');
});

test('portable CLI launcher resolves the hoisted Tauri CLI', () => {
  const cliPath = launcher.resolveTauriCliPath();

  assert.match(cliPath, /[\\/]@tauri-apps[\\/]cli[\\/]tauri\.js$/);
  assert.equal(fs.existsSync(cliPath), true);
});

test('portable CLI launcher forwards arguments and inherits stdio', () => {
  let invocation;
  const status = launcher.runTauriCli(['build', '--debug'], (...args) => {
    invocation = args;
    return { status: 0 };
  });

  assert.equal(status, 0);
  assert.deepEqual(invocation[0], process.execPath);
  assert.deepEqual(invocation[1].slice(1), ['build', '--debug']);
  assert.deepEqual(invocation[2], { stdio: 'inherit' });
});
