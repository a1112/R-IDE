import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('all Theia decompress consumers resolve to the maintained asynchronous adapter', () => {
    const manifest = JSON.parse(read('app/package.json'));
    const adapter = JSON.parse(read('app/vendor/decompress-compat/package.json'));
    assert.equal(manifest.resolutions['**/decompress'], 'file:vendor/decompress-compat');
    assert.equal(adapter.dependencies['@xhmikosr/decompress'], '11.1.4');
    assert.equal(adapter.main, 'index.cjs');
    const lock = read('app/yarn.lock');
    assert.match(lock, /decompress@\^4\.2\.1, "decompress@file:vendor\/decompress-compat":\n  version "1\.0\.0"/);
    assert.match(lock, /"@xhmikosr\/decompress@11\.1\.4":\n  version "11\.1\.4"/);
    assert.doesNotMatch(lock, /resolved "https:\/\/[^\n]*\/decompress\/-\/decompress-4\.2\.1\.tgz/);
    assert.equal(fs.existsSync(path.join(ROOT, 'app/patches/decompress+4.2.1.patch')), false);
    assert.equal(manifest.scripts['test:archive-extraction'], 'node --test scripts/test/archive-extraction.test.mjs');
    const workflow = read('.github/workflows/ci.yml');
    assert.ok(workflow.indexOf('yarn test:archive-extraction') > workflow.indexOf('yarn --frozen-lockfile'));
});
