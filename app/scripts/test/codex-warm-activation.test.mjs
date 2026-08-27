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
  CODEX_WARM_ACTIVATION_SCHEMA,
  compareCodexWarmActivation,
  validateCodexWarmActivation,
} from '../check-tauri-performance.mjs';

function measurement(initializedMs = [620, 700, 760, 810, 900]) {
  return {
    schema: CODEX_WARM_ACTIVATION_SCHEMA,
    version: 1,
    platform: 'win32',
    arch: 'x64',
    build: {
      commit: '0123456789abcdef0123456789abcdef01234567',
      profile: 'tauri-critical',
    },
    samples: initializedMs.map((initialized, index) => ({
      panelShellMs: 80 + index,
      runtimeResolvedMs: 140 + index,
      processSpawnedMs: 360 + index,
      initializedMs: initialized,
      handshakeMs: 260 + index,
      idleRssBytes: 50_000 + index,
    })),
  };
}

test('Codex warm activation computes nearest-rank p95 and enforces the 1.5s budget', () => {
  const result = compareCodexWarmActivation(measurement());
  assert.equal(result.p95.initializedMs, 900);
  assert.equal(result.p95.handshakeMs, 264);
  assert.equal(result.targets.initializedMs, 1_500);
  assert.equal(result.targets.handshakeMs, 5_000);
  assert.deepEqual(validateCodexWarmActivation(measurement()).percentiles, result.p95);
});

test('Codex warm activation rejects a slow p95 or a broken stage order', () => {
  assert.throws(
    () => compareCodexWarmActivation(measurement([600, 800, 1_000, 1_600, 1_700])),
    /warm activation.*1,?500|initializedMs/i,
  );
  assert.throws(
    () => validateCodexWarmActivation({
      ...measurement(),
      samples: measurement().samples.map(sample => ({
        ...sample,
        runtimeResolvedMs: sample.panelShellMs - 1,
      })),
    }),
    /monotonic|stage order/i,
  );
});

test('Codex warm activation has a bounded handshake and does not accept empty samples', () => {
  assert.throws(() => compareCodexWarmActivation({
    ...measurement([6_000, 6_000, 6_000, 6_000, 6_000]),
    samples: measurement([6_000, 6_000, 6_000, 6_000, 6_000]).samples
      .map(sample => ({ ...sample, handshakeMs: 5_001 })),
  }), /handshake.*5,?000/i);
  assert.throws(() => validateCodexWarmActivation({ ...measurement(), samples: [] }), /samples/i);
});
