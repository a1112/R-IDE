import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserDirectory = path.join(appDirectory, 'applications', 'browser');

test('Codex profile declares the deferred proxy and delayed feature entry', async () => {
    const profile = JSON.parse(await fs.readFile(path.join(browserDirectory, 'tauri-profile.json'), 'utf8'));
    assert.deepEqual(profile.featureGroups.ai.deferredFrontendModules, [{
        package: 'theia-ide-codex-ext',
        module: 'theia-ide-codex-ext/lib/browser/ride-codex-frontend-module',
        proxy: 'tauri-src/codex-proxy-frontend-module.ts',
        entry: 'tauri-src/codex-feature.ts',
        action: 'codex-activate',
    }]);
});

test('Codex startup source contains the proxy but excludes the delayed runtime', async () => {
    const sourceDirectory = path.join(browserDirectory, 'tauri-src');
    const [proxy, feature] = await Promise.all([
        fs.readFile(path.join(sourceDirectory, 'codex-proxy-frontend-module.ts'), 'utf8'),
        fs.readFile(path.join(sourceDirectory, 'codex-feature.ts'), 'utf8'),
    ]);
    assert.match(proxy, /import\(['"]\.\/codex-feature['"]\)\.then\(module => module\.createCodexFeature\(\)\)/);
    assert.doesNotMatch(proxy, /@openai\/codex-sdk|installer|App Server|app server|child_process|process\./i);
    assert.match(feature, /createCodexFeature/);
});
