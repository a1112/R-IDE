import assert from 'node:assert/strict';
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
