import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTheiaModuleDedupePlugin } from '../../app/applications/browser/ride-esbuild-dedupe.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const browserRoot = path.join(repositoryRoot, 'app', 'applications', 'browser');

test('the backend bundle dedupe resolver maps shared Theia modules to browser dependencies', () => {
  let resolver;
  createTheiaModuleDedupePlugin(browserRoot).setup({
    onResolve(_options, callback) {
      resolver = callback;
    },
  });
  assert.equal(typeof resolver, 'function');

  for (const request of [
    '@theia/plugin-ext-vscode/lib/common/plugin-vscode-environment',
    '@theia/process/lib/node/process-manager',
  ]) {
    const result = resolver({ path: request });
    assert.ok(result?.path, `expected a resolved path for ${request}`);
    assert.ok(
      path.normalize(result.path).startsWith(path.join(browserRoot, 'node_modules')),
      `${request} must resolve from the browser workspace dependencies`,
    );
  }
});

test('the frontend bundle contains one shared Theia task protocol module', () => {
  const sourceMapPath = path.join(browserRoot, 'lib', 'frontend', 'bundle.js.map');
  const sourceMap = JSON.parse(fs.readFileSync(sourceMapPath, 'utf8'));
  const taskProtocolSources = sourceMap.sources.filter(source =>
    source.endsWith('/@theia/task/src/common/process/task-protocol.ts'),
  );

  assert.equal(
    taskProtocolSources.length,
    1,
    `expected one task protocol module, found:\n${taskProtocolSources.join('\n')}`,
  );
});

test('the backend bundle loads the Parcel watcher native module', () => {
  const backendBundlePath = path.join(browserRoot, 'lib', 'backend', 'main.js');
  const backendBundle = fs.readFileSync(backendBundlePath, 'utf8');

  assert.doesNotMatch(
    backendBundle,
    /\.exports\s*=\s*["']\.\/native\/watcher\.node["']/,
    'the native watcher path must not be exported as a plain string',
  );
  assert.match(
    backendBundle,
    /require\(["']\.\/native\/watcher\.node["']\)/,
    'the native watcher must be loaded with require()',
  );
});
