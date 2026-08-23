import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser uses the R-IDE Codex extension without the patched upstream package', async () => {
    const browser = JSON.parse(await readFile('applications/browser/package.json', 'utf8'));
    const root = JSON.parse(await readFile('package.json', 'utf8'));

    assert.equal(browser.dependencies['@theia/ai-codex'], undefined);
    assert.equal(browser.dependencies['theia-ide-codex-ext'], '1.72.100');
    assert.match(root.scripts['build:extensions'], /theia-extensions\/codex/);
    await assert.rejects(access('patches/@theia+ai-codex+1.73.0-next.2.patch'));
});
