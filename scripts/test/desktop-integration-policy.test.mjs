import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = path.join(
  repositoryRoot,
  'app',
  'applications',
  'tauri',
  'src-tauri',
  'tauri.conf.json',
);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const approvedExtensions = [
  'bash',
  'bat',
  'c',
  'cc',
  'cjs',
  'cmd',
  'code-workspace',
  'cpp',
  'cs',
  'css',
  'cts',
  'cxx',
  'fish',
  'go',
  'h',
  'hpp',
  'htm',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'kts',
  'less',
  'mjs',
  'md',
  'markdown',
  'mts',
  'properties',
  'ps1',
  'psm1',
  'py',
  'pyw',
  'qmd',
  'r',
  'rmd',
  'rs',
  'scss',
  'sh',
  'sql',
  'svelte',
  'theia-workspace',
  'toml',
  'ts',
  'tsx',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zsh',
].sort();

test('Tauri registers the approved code and workspace file associations', () => {
  const associations = config.bundle.fileAssociations ?? [];
  const extensions = associations.flatMap(({ ext }) => ext).sort();

  assert.deepEqual(extensions, approvedExtensions);
  assert.ok(associations.length > 0, 'expected at least one file association');
  for (const association of associations) {
    assert.equal(association.role, 'Editor');
    assert.equal(association.rank, 'Alternate');
    assert.notEqual(association.mimeType, 'text/plain');
  }
  assert.ok(!extensions.includes('txt'));
  assert.ok(!extensions.includes('log'));
});

test('the main Tauri window suspends background throttling', () => {
  const mainWindow = config.app.windows.find(({ label }) => label === 'main');

  assert.ok(mainWindow, 'expected a main Tauri window');
  assert.equal(mainWindow.backgroundThrottling, 'suspend');
});
