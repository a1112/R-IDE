// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const path = require('node:path');

const requireFromTauriWorkspace = createRequire(path.join(__dirname, 'package.json'));

function resolveTauriCliPath() {
  return requireFromTauriWorkspace.resolve('@tauri-apps/cli/tauri.js');
}

function runTauriCli(args = process.argv.slice(2), spawn = spawnSync) {
  const result = spawn(process.execPath, [resolveTauriCliPath(), ...args], { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  return typeof result.status === 'number' ? result.status : 1;
}

if (require.main === module) {
  process.exitCode = runTauriCli();
}

module.exports = { resolveTauriCliPath, runTauriCli };
