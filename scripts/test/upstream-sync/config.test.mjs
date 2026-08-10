import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadSourceConfig,
  parseOwnedPaths,
  validateSource,
} from '../../lib/upstream-sync/config.mjs';

const validSource = {
  repository: 'https://github.com/eclipse-theia/theia-ide.git',
  branch: 'master',
  commit: 'a868f5b15f2d4f2598125a4f6a98c0d29990b946',
};

test('accepts a complete pinned source and preserves its fields', () => {
  assert.deepEqual(validateSource(validSource), validSource);
});

test('accepts configured HTTPS repositories and ordinary release refs', () => {
  const value = validateSource({ ...validSource, branch: 'release/1.2' });
  assert.equal(value.repository, validSource.repository);
  assert.equal(value.branch, 'release/1.2');
});

test('rejects bare repository names', () => {
  assert.throws(
    () => validateSource({ ...validSource, repository: 'foo' }),
    /repository/i,
  );
});

test('rejects malformed or unsupported repository URLs', () => {
  for (const repository of ['https://', 'https://?invalid', 'ftp://example.com/repo.git']) {
    assert.throws(
      () => validateSource({ ...validSource, repository }),
      /repository/i,
      `expected repository ${repository} to be rejected`,
    );
  }
});

test('accepts explicit local Git paths used by fixture repositories', () => {
  for (const repository of [
    './fixtures/upstream.git',
    '../fixtures/upstream.git',
    'C:\\fixtures\\upstream.git',
    '/tmp/upstream.git',
  ]) {
    assert.equal(validateSource({ ...validSource, repository }).repository, repository);
  }
});

test('rejects malformed Git branch refs', () => {
  for (const branch of ['foo//bar', '.', 'foo.', 'foo.lock', '@']) {
    assert.throws(
      () => validateSource({ ...validSource, branch }),
      /branch/i,
      `expected branch ${branch} to be rejected`,
    );
  }
});

test('rejects forbidden suffixes and control characters in every ref component', () => {
  for (const branch of ['foo.lock/bar', 'foo/bar.lock/baz', 'foo\u007fbar']) {
    assert.throws(
      () => validateSource({ ...validSource, branch }),
      /branch/i,
      `expected branch ${JSON.stringify(branch)} to be rejected`,
    );
  }
  assert.equal(validateSource({ ...validSource, branch: 'release/1.2' }).branch, 'release/1.2');
});

test('normalizes owned paths and removes comments and blank lines', () => {
  assert.deepEqual(
    parseOwnedPaths(`
      # product files

      ./applications\\tauri\\
      applications//browser/pkg.config.js # browser override
      theia-extensions/product/src/browser/ride-workbench-contribution.ts
    `),
    [
      'applications/tauri/',
      'applications/browser/pkg.config.js',
      'theia-extensions/product/src/browser/ride-workbench-contribution.ts',
    ],
  );
});

test('rejects ownership outside the app tree', () => {
  assert.throws(() => parseOwnedPaths('../prototype/'), /must stay inside app\//);
  assert.throws(() => parseOwnedPaths('nested/../../prototype/'), /must stay inside app\//);
});

test('rejects absolute ownership paths on POSIX and Windows', () => {
  assert.throws(() => parseOwnedPaths('/tmp/prototype/'), /must stay inside app\//);
  assert.throws(() => parseOwnedPaths('C:\\\\prototype\\'), /must stay inside app\//);
  assert.throws(() => parseOwnedPaths('\\\\server\\share\\prototype'), /must stay inside app\//);
});

test('rejects duplicate ownership paths after normalization', () => {
  assert.throws(
    () => parseOwnedPaths('applications/tauri/\n./applications//tauri\n'),
    /duplicate owned path/i,
  );
});

test('allows an ownership manifest containing only comments and blanks', () => {
  assert.deepEqual(parseOwnedPaths('   # only a comment\n   \n'), []);
});

test('rejects source metadata with missing fields', () => {
  for (const field of Object.keys(validSource)) {
    const source = { ...validSource };
    delete source[field];
    assert.throws(() => validateSource(source), new RegExp(field));
  }
});

test('rejects malformed commit IDs', () => {
  for (const commit of [
    '',
    'a868f5b',
    'g'.repeat(40),
    'a868f5b15f2d4f2598125a4f6a98c0d29990b94\n',
  ]) {
    assert.throws(() => validateSource({ ...validSource, commit }), /commit/i);
  }
});

test('loads and validates source metadata and ownership entries from a repository root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-config-'));
  try {
    fs.mkdirSync(path.join(root, '.upstream'));
    fs.writeFileSync(
      path.join(root, '.upstream', 'source.json'),
      `${JSON.stringify(validSource)}\n`,
    );
    fs.writeFileSync(
      path.join(root, '.upstream', 'owned-paths.txt'),
      '# product\napplications/tauri/\n',
    );

    assert.deepEqual(loadSourceConfig(root), {
      source: validSource,
      ownedPaths: ['applications/tauri/'],
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
