/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_SMOKE_ACTIONS,
  SMOKE_ACTIONS,
  SMOKE_SCENARIOS,
  SMOKE_SCENARIO_REQUIREMENTS,
  SMOKE_PROTOCOL_VERSION,
  validateSmokeSpec,
} from '../tauri-packaged-smoke-contract.mjs';

test('Codex packaged smoke is an explicit inactive-to-idle-exit scenario', () => {
  assert.deepEqual(SMOKE_SCENARIOS, [
    'critical-file',
    'critical-empty',
    'full-file',
    'backend-retry',
    'codex',
  ]);
  assert.deepEqual(CODEX_SMOKE_ACTIONS, [
    'codex-inactive',
    'codex-activate',
    'codex-stream',
    'codex-command-approval',
    'codex-file-approval',
    'codex-interrupt',
    'codex-recover',
    'codex-idle-exit',
  ]);
  assert.deepEqual(SMOKE_SCENARIO_REQUIREMENTS.codex, {
    profile: 'tauri-critical',
    fileCount: 0,
    actions: CODEX_SMOKE_ACTIONS,
  });
  assert.equal(Object.isFrozen(CODEX_SMOKE_ACTIONS), true);
  assert.equal(Object.isFrozen(SMOKE_SCENARIO_REQUIREMENTS.codex), true);
});

test('Codex smoke spec accepts only the canonical ordered eight-step plan', () => {
  const spec = validateSmokeSpec({
    schema: 'ride.tauri-packaged-smoke-spec',
    version: SMOKE_PROTOCOL_VERSION,
    scenario: 'codex',
    profile: 'tauri-critical',
    workspace: '.',
    files: [],
    actions: [...CODEX_SMOKE_ACTIONS],
    tokenSha256: 'a'.repeat(64),
    actionTimeoutMs: 30_000,
  });
  assert.deepEqual(spec.actions, CODEX_SMOKE_ACTIONS);
  assert.throws(() => validateSmokeSpec({
    ...spec,
    actions: [...CODEX_SMOKE_ACTIONS].reverse(),
  }), /canonical|scenario requirements/i);
});

test('Codex smoke action names are outside the existing file smoke action set', () => {
  assert.equal(CODEX_SMOKE_ACTIONS.some(action => SMOKE_ACTIONS.includes(action)), false);
});
