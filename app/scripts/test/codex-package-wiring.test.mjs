import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(testDirectory, '../..');
const repositoryDirectory = path.resolve(appDirectory, '..');
const appPath = (...segments) => path.join(appDirectory, ...segments);
const repositoryPath = (...segments) => path.join(repositoryDirectory, ...segments);

test('browser uses the R-IDE Codex extension without the patched upstream package', async () => {
    const browser = JSON.parse(await readFile(appPath('applications', 'browser', 'package.json'), 'utf8'));
    const root = JSON.parse(await readFile(appPath('package.json'), 'utf8'));

    assert.equal(browser.dependencies['@theia/ai-codex'], undefined);
    assert.equal(browser.dependencies['theia-ide-codex-ext'], '1.72.100');
    assert.match(root.scripts['build:extensions'], /theia-extensions\/codex/);
    await assert.rejects(access(appPath('patches', '@theia+ai-codex+1.73.0-next.2.patch')));
});

test('lockfile omits the obsolete browser Codex package selector', async () => {
    const lockfile = await readFile(appPath('yarn.lock'), 'utf8');

    assert.equal(lockfile.includes('"@theia/ai-codex@1.73.0-next.2":'), false);
});

test('CI runs the Codex package wiring test in its policy test step', async () => {
    const workflow = await readFile(repositoryPath('.github', 'workflows', 'ci.yml'), 'utf8');
    const policyStepIndex = workflow.indexOf('- name: Run synchronization and policy tests');
    const nextStepIndex = workflow.indexOf('\n      - name:', policyStepIndex + 1);

    assert.notEqual(policyStepIndex, -1, 'CI must define the synchronization and policy test step');
    const policyStep = workflow.slice(policyStepIndex, nextStepIndex);
    assert.match(policyStep, /^\s+app\/scripts\/test\/codex-package-wiring\.test\.mjs\s*$/m);
});

test('Codex extension exposes the workspace Theia update scripts', async () => {
    const codexPackage = JSON.parse(
        await readFile(appPath('theia-extensions', 'codex', 'package.json'), 'utf8'),
    );

    assert.equal(codexPackage.scripts['update:theia'], 'ts-node ../../scripts/update-theia-version.ts');
    assert.equal(codexPackage.scripts['update:next'], 'ts-node ../../scripts/update-theia-version.ts next');
});
