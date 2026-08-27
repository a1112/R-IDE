import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const backendDirectory = path.join(appDirectory, 'applications', 'browser', 'lib', 'backend');

async function walk(directory, root = directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(absolute, root));
    } else if (entry.isFile()) {
      files.push(path.relative(root, absolute).replaceAll(path.sep, '/'));
    }
  }
  return files;
}

test('SDK runtime output is JavaScript-only', async () => {
  const files = await walk(backendDirectory);
  assert(files.includes('codex-sdk-runtime.mjs'));
  assert.equal(files.some(file => /vendor|codex(?:\.exe)?$|codex-(?:x64|arm64)/i.test(file)), false);

  const runtime = await import(pathToFileURL(path.join(backendDirectory, 'codex-sdk-runtime.mjs')).href);
  const createCodexClient = runtime.createCodexClient ?? runtime.default?.createCodexClient;
  assert.equal(typeof createCodexClient, 'function');
});
