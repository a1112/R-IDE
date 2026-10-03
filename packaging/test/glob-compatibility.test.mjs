import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(new URL('../../app/package.json', import.meta.url));
test('patched brace-expansion preserves callable and named CommonJS APIs', () => {
  const expand = require('brace-expansion');
  assert.equal(typeof expand, 'function');
  assert.equal(expand.expand, expand);
  assert.deepEqual(expand('file.{js,ts}'), ['file.js', 'file.ts']);
});
test('legacy minimatch still expands alternatives used by lint and file globs', () => {
  const requireEslint = createRequire(require.resolve('@eslint/eslintrc/package.json'));
  const minimatch = requireEslint('minimatch');
  assert.equal(minimatch('file.ts', '*.{js,ts}'), true);
  assert.equal(minimatch('file.txt', '*.{js,ts}'), false);
});
