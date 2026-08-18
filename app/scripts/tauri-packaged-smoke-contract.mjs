/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const SMOKE_SCHEMAS = Object.freeze({
  spec: 'ride.tauri-packaged-smoke-spec',
  report: 'ride.tauri-packaged-smoke',
});

export const SMOKE_SCENARIOS = Object.freeze([
  'critical-file',
  'critical-empty',
  'full-file',
]);

export const SMOKE_ACTIONS = Object.freeze([
  'editor-save',
  'terminal-sentinel',
  'workspace-search',
  'scm-status',
  'packaged-plugin-command',
  'secondary-window',
  'second-file-forwarding',
]);

const SMOKE_PROFILES = Object.freeze(['tauri-critical', 'full']);
const SPEC_KEYS = Object.freeze([
  'schema',
  'version',
  'scenario',
  'profile',
  'workspace',
  'files',
  'actions',
  'tokenSha256',
  'actionTimeoutMs',
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIN_ACTION_TIMEOUT_MS = 1_000;
const MAX_ACTION_TIMEOUT_MS = 300_000;
const REPORT_KEYS = Object.freeze([
  'schema',
  'version',
  'specSha256',
  'scenario',
  'profile',
  'status',
  'durationMs',
  'diagnostic',
  'steps',
]);
const REPORT_CONTEXT_KEYS = Object.freeze(['specSha256', 'scenario', 'profile']);
const TRANSITION_KEYS = Object.freeze(['action', 'state', 'durationMs', 'diagnostic']);
const DIAGNOSTIC_KEYS = Object.freeze(['code', 'message']);
const REPORT_STATUSES = Object.freeze(['passed', 'failed']);
const TRANSITION_STATES = Object.freeze(['started', 'passed', 'failed']);
const MAX_DIAGNOSTIC_CODE_LENGTH = 64;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 256;
const DIAGNOSTIC_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DIAGNOSTIC_WORD = String.raw`[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*`;
const DIAGNOSTIC_CLAUSE = String.raw`${DIAGNOSTIC_WORD}(?: ${DIAGNOSTIC_WORD})*`;
const CANONICAL_DIAGNOSTIC_MESSAGE_PATTERN = new RegExp(
  String.raw`^${DIAGNOSTIC_CLAUSE}(?:(?:,|:) ${DIAGNOSTIC_CLAUSE})*[.!?]?$`,
  'u',
);
const COMMAND_LINE_PREFIX_PATTERN = new RegExp(
  '^(?:command(?: line)?|execut(?:e|ed|ing)|invok(?:e|ed|ing)|launch(?:ed|ing)?'
    + '|run|ran|running|spawn(?:ed|ing)?|start(?:ed|ing)?)(?: |:)',
  'i',
);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, keys, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      fail(`${label} has unexpected field ${key}`);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) {
      fail(`${label} is missing field ${key}`);
    }
  }
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) {
    fail(`${label} is unsupported`);
  }
  return value;
}

function relativePath(value, label, { allowDot = false } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || value.includes('\0')) {
    fail(`${label} must be a non-empty relative path`);
  }
  const slashPath = value.replaceAll('\\', '/');
  if (slashPath.startsWith('/')
    || /^[A-Za-z]:\//.test(slashPath)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(slashPath)) {
    fail(`${label} must be a relative path`);
  }
  const segments = slashPath.split('/');
  if (segments.includes('..')) {
    fail(`${label} must not contain traversal segments`);
  }
  if (segments.some((segment, index) => segment === '' && index !== segments.length - 1)) {
    fail(`${label} must be a canonical relative path`);
  }
  const normalizedSegments = segments.filter(segment => segment !== '' && segment !== '.');
  if (normalizedSegments.length === 0) {
    if (allowDot && segments.every(segment => segment === '' || segment === '.')) {
      return '.';
    }
    fail(`${label} must identify a relative file`);
  }
  return normalizedSegments.join('/');
}

function stringArray(value, label) {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array`);
  }
  return value;
}

function validateFiles(value) {
  const files = stringArray(value, 'Smoke spec files').map((file, index) => (
    relativePath(file, `Smoke spec files[${index}]`)
  ));
  if (new Set(files).size !== files.length) {
    fail('Smoke spec files must be unique');
  }
  return files;
}

function validateActions(value) {
  const actions = stringArray(value, 'Smoke spec actions');
  const normalized = [];
  const seen = new Set();
  let previousIndex = -1;
  for (const action of actions) {
    const actionIndex = SMOKE_ACTIONS.indexOf(action);
    if (actionIndex < 0) {
      fail(`Smoke spec has unsupported action ${String(action)}`);
    }
    if (seen.has(action)) {
      fail(`Smoke spec has duplicate action ${action}`);
    }
    if (actionIndex <= previousIndex) {
      fail('Smoke spec actions must follow canonical order');
    }
    seen.add(action);
    normalized.push(action);
    previousIndex = actionIndex;
  }
  return normalized;
}

function validateSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${label} must be a canonical 64-character SHA-256 digest`);
  }
  return value;
}

function validateActionTimeout(value) {
  if (!Number.isSafeInteger(value)
    || value < MIN_ACTION_TIMEOUT_MS
    || value > MAX_ACTION_TIMEOUT_MS) {
    fail(`Smoke spec actionTimeoutMs must be a safe integer between ${MIN_ACTION_TIMEOUT_MS} and ${MAX_ACTION_TIMEOUT_MS}`);
  }
  return value;
}

function nonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function validateDiagnostic(value, label) {
  exactKeys(value, DIAGNOSTIC_KEYS, label);
  if (typeof value.code !== 'string'
    || value.code.length > MAX_DIAGNOSTIC_CODE_LENGTH
    || !DIAGNOSTIC_CODE_PATTERN.test(value.code)) {
    fail(`${label} code must be a canonical lowercase identifier of at most ${MAX_DIAGNOSTIC_CODE_LENGTH} characters`);
  }
  if (typeof value.message !== 'string'
    || value.message.length === 0
    || value.message.length > MAX_DIAGNOSTIC_MESSAGE_LENGTH
    || value.message.trim() !== value.message
    || /[\u0000-\u001f\u007f]/.test(value.message)) {
    fail(`${label} message must be a bounded single-line string of at most ${MAX_DIAGNOSTIC_MESSAGE_LENGTH} characters`);
  }
  if (!CANONICAL_DIAGNOSTIC_MESSAGE_PATTERN.test(value.message)
    || COMMAND_LINE_PREFIX_PATTERN.test(value.message)) {
    fail(`${label} message must not contain host paths, environment data, or command lines`);
  }
  return { code: value.code, message: value.message };
}

function validateReportContext(value) {
  exactKeys(value, REPORT_CONTEXT_KEYS, 'Smoke report context');
  return {
    specSha256: validateSha256(value.specSha256, 'Smoke report context specSha256'),
    scenario: enumValue(value.scenario, SMOKE_SCENARIOS, 'Smoke report context scenario'),
    profile: enumValue(value.profile, SMOKE_PROFILES, 'Smoke report context profile'),
  };
}

function validateReportTransitions(value) {
  const transitions = stringArray(value, 'Smoke report steps');
  const normalized = [];
  const seenActions = new Set();
  let pendingAction;
  let previousActionIndex = -1;
  let previousDuration = 0;
  let failed = false;

  for (let index = 0; index < transitions.length; index += 1) {
    const transition = transitions[index];
    const label = `Smoke report transition ${index}`;
    exactKeys(transition, TRANSITION_KEYS, label);
    const actionIndex = SMOKE_ACTIONS.indexOf(transition.action);
    if (actionIndex < 0) {
      fail(`${label} has unsupported action ${String(transition.action)}`);
    }
    const state = enumValue(transition.state, TRANSITION_STATES, `${label} state`);
    const durationMs = nonNegativeSafeInteger(transition.durationMs, `${label} durationMs`);
    if (durationMs < previousDuration) {
      fail(`${label} durationMs must be monotonic`);
    }
    if (failed) {
      fail('Smoke report must not contain a transition after failure');
    }

    let diagnostic = null;
    if (state === 'started') {
      if (pendingAction !== undefined) {
        fail(`Smoke report action ${pendingAction} must complete before another started transition`);
      }
      if (seenActions.has(transition.action)) {
        fail(`Smoke report has duplicate action ${transition.action}`);
      }
      if (actionIndex <= previousActionIndex) {
        fail('Smoke report actions must follow canonical order');
      }
      if (transition.diagnostic !== null) {
        fail('Smoke report started transition diagnostic must be null');
      }
      seenActions.add(transition.action);
      pendingAction = transition.action;
      previousActionIndex = actionIndex;
    } else {
      if (pendingAction !== transition.action) {
        fail(`Smoke report ${state} transition must follow started for ${transition.action}`);
      }
      if (state === 'failed') {
        diagnostic = validateDiagnostic(transition.diagnostic, 'Smoke report failed transition diagnostic');
        failed = true;
      } else if (transition.diagnostic !== null) {
        fail('Smoke report passed transition diagnostic must be null');
      }
      pendingAction = undefined;
    }
    normalized.push({ action: transition.action, state, durationMs, diagnostic });
    previousDuration = durationMs;
  }

  if (pendingAction !== undefined) {
    fail(`Smoke report started transition for ${pendingAction} must complete`);
  }
  return { transitions: normalized, failed, lastDurationMs: previousDuration };
}

export function validateSmokeSpec(value) {
  exactKeys(value, SPEC_KEYS, 'Smoke spec');
  if (value.schema !== SMOKE_SCHEMAS.spec) {
    fail(`Smoke spec schema must be ${SMOKE_SCHEMAS.spec}`);
  }
  if (value.version !== 1) {
    fail('Smoke spec version must be 1');
  }

  return {
    schema: value.schema,
    version: value.version,
    scenario: enumValue(value.scenario, SMOKE_SCENARIOS, 'Smoke spec scenario'),
    profile: enumValue(value.profile, SMOKE_PROFILES, 'Smoke spec profile'),
    workspace: relativePath(value.workspace, 'Smoke spec workspace', { allowDot: true }),
    files: validateFiles(value.files),
    actions: validateActions(value.actions),
    tokenSha256: validateSha256(value.tokenSha256, 'Smoke spec tokenSha256'),
    actionTimeoutMs: validateActionTimeout(value.actionTimeoutMs),
  };
}

export function validateSmokeReport(value, expected) {
  exactKeys(value, REPORT_KEYS, 'Smoke report');
  const context = validateReportContext(expected);
  if (value.schema !== SMOKE_SCHEMAS.report) {
    fail(`Smoke report schema must be ${SMOKE_SCHEMAS.report}`);
  }
  if (value.version !== 1) {
    fail('Smoke report version must be 1');
  }

  const specSha256 = validateSha256(value.specSha256, 'Smoke report specSha256');
  const scenario = enumValue(value.scenario, SMOKE_SCENARIOS, 'Smoke report scenario');
  const profile = enumValue(value.profile, SMOKE_PROFILES, 'Smoke report profile');
  for (const [field, actual] of Object.entries({ specSha256, scenario, profile })) {
    if (actual !== context[field]) {
      fail(`Smoke report ${field} must match the expected context`);
    }
  }

  if (!REPORT_STATUSES.includes(value.status)) {
    fail('Smoke report status must be passed or failed');
  }
  const status = value.status;
  const durationMs = nonNegativeSafeInteger(value.durationMs, 'Smoke report durationMs');
  let diagnostic = null;
  if (status === 'passed') {
    if (value.diagnostic !== null) {
      fail('Smoke report passed report diagnostic must be null');
    }
  } else {
    diagnostic = validateDiagnostic(value.diagnostic, 'Smoke report failed report diagnostic');
  }
  const { transitions, failed, lastDurationMs } = validateReportTransitions(value.steps);
  if (durationMs < lastDurationMs) {
    fail('Smoke report durationMs must not precede its final transition');
  }

  if (status === 'passed') {
    if (failed) {
      fail('Smoke report passed report must not contain a failed transition');
    }
  } else {
    if (!failed) {
      fail('Smoke report failed report must contain a failed transition');
    }
  }

  return {
    schema: value.schema,
    version: value.version,
    specSha256,
    scenario,
    profile,
    status,
    durationMs,
    diagnostic,
    steps: transitions,
  };
}
