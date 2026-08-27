/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CODEX_PACKAGING_SCHEMA = 'ride.codex-packaging';
export const CODEX_PACKAGING_VERSION = 1;
export const CODEX_SDK_RUNTIME_FILENAME = 'codex-sdk-runtime.mjs';

const MAX_FILES = 100_000;
const FORBIDDEN_ARTIFACT_PATTERNS = Object.freeze([
  {
    pattern: /(?:^|\/)vendor(?:\/|$)/iu,
    reason: 'native/vendor directory',
  },
  {
    pattern: /(?:^|\/)(?:codex-resources?|managed-codex-runtime|codex-runtimes?|\.ride-codex(?:-runtime)?)(?:\/|$)/iu,
    reason: 'Codex managed/native runtime directory',
  },
  {
    pattern: /(?:^|\/)codex(?:\.(?:exe|cmd|com))?$/iu,
    reason: 'Codex CLI executable',
  },
  {
    pattern: /(?:^|\/)codex-(?:(?:win32|linux|darwin)-)?(?:x64|arm64)(?:\/|$)/iu,
    reason: 'Codex optional native target package',
  },
]);

function normalizeRelative(file) {
  return file.split(path.sep).join('/');
}

function forbiddenReason(file) {
  return FORBIDDEN_ARTIFACT_PATTERNS.find(({ pattern }) => pattern.test(file))?.reason;
}

function walkArtifact(root) {
  const files = [];
  const forbidden = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = normalizeRelative(path.relative(root, absolute));
      if (entry.isSymbolicLink()) {
        forbidden.push({ path: relative, reason: 'symbolic link' });
        continue;
      }
      if (entry.isDirectory()) {
        const reason = forbiddenReason(relative);
        if (reason !== undefined) {
          forbidden.push({ path: relative, reason });
        }
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) {
        forbidden.push({ path: relative, reason: 'non-regular artifact' });
        continue;
      }
      if (files.length >= MAX_FILES) {
        throw new Error(`Codex packaging artifact exceeds the ${MAX_FILES}-file limit.`);
      }
      files.push(relative);
      const reason = forbiddenReason(relative);
      if (reason !== undefined) {
        forbidden.push({ path: relative, reason });
      }
    }
  }
  files.sort();
  forbidden.sort((left, right) => left.path.localeCompare(right.path));
  return { files, forbidden };
}

export function verifyCodexPackaging(root, { requireRuntime = true } = {}) {
  const resolvedRoot = path.resolve(root);
  const stat = fs.lstatSync(resolvedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Codex packaging root must be a regular directory.');
  }
  const { files, forbidden } = walkArtifact(resolvedRoot);
  const missing = requireRuntime && !files.some(file => path.posix.basename(file) === CODEX_SDK_RUNTIME_FILENAME)
    ? [CODEX_SDK_RUNTIME_FILENAME]
    : [];
  return Object.freeze({
    schema: CODEX_PACKAGING_SCHEMA,
    version: CODEX_PACKAGING_VERSION,
    root: resolvedRoot,
    files: Object.freeze(files),
    forbidden: Object.freeze(forbidden.map(entry => Object.freeze(entry))),
    missing: Object.freeze(missing),
  });
}

export function assertCodexPackaging(root, options) {
  const result = verifyCodexPackaging(root, options);
  if (result.missing.length > 0) {
    throw new Error(
      `Missing required Codex packaging artifact: ${result.missing.join(', ')}.`,
    );
  }
  if (result.forbidden.length > 0) {
    const details = result.forbidden
      .map(entry => `${entry.path} (${entry.reason})`)
      .join(', ');
    throw new Error(`Codex packaging contains forbidden native/vendor payload: ${details}.`);
  }
  return result;
}

function parseArguments(argv) {
  const options = { root: path.resolve('applications/browser/lib/backend') };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--root' || index + 1 >= argv.length || argv[index + 1].startsWith('--')) {
      throw new Error('usage: node scripts/verify-codex-packaging.mjs [--root <directory>]');
    }
    options.root = path.resolve(argv[++index]);
  }
  return options;
}

function main(argv) {
  const result = assertCodexPackaging(parseArguments(argv).root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  && path.basename(fileURLToPath(import.meta.url)) === 'verify-codex-packaging.mjs') {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error?.stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
