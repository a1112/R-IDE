import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createTauriBrowserBuildPlans } from '../../applications/browser/tauri-src/esbuild-deferred.mjs';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const browserDirectory = path.join(appDirectory, 'applications', 'browser');
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

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

test('Codex startup sources contain only inert activation and command proxies', async () => {
    const sourceDirectory = path.join(browserDirectory, 'tauri-src');
    const extensionDirectory = path.join(appDirectory, 'theia-extensions', 'codex', 'src', 'browser');
    const [proxy, feature, frontend, bindings] = await Promise.all([
        fs.readFile(path.join(sourceDirectory, 'codex-proxy-frontend-module.ts'), 'utf8'),
        fs.readFile(path.join(sourceDirectory, 'codex-feature.ts'), 'utf8'),
        fs.readFile(path.join(extensionDirectory, 'ride-codex-frontend-module.ts'), 'utf8'),
        fs.readFile(path.join(extensionDirectory, 'ride-codex-chat-agent-proxy.ts'), 'utf8'),
    ]);
    assert.match(proxy, /import\(['"]\.\/codex-feature['"]\)\.then\(module => module\.createCodexFeature\(container!\)\)/);
    assert.match(feature, /createCodexFeature/);
    for (const source of [proxy, feature, frontend, bindings]) {
        assert.doesNotMatch(
            source,
            /@openai\/codex-sdk|codex[- ]installer|CodexAppServerClient|codex[- ]process|child_process|node:process|process\./i,
        );
    }
    assert.match(proxy, /bindRideCodexFrontend\(bind,/);
    assert.match(frontend, /bindRideCodexFrontend\(bind,/);
    assert.match(bindings, /bind\(CommandContribution\)\.toService\(RideCodexChatAgentProxy\)/);
    assert.match(bindings, /bind\(FrontendApplicationContribution\)\.toService\(RideCodexActivation\)/);
});

test('minimal critical build keeps Codex feature code out of the initial bundle inputs', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-codex-deferred-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const entryPoints = {
        bundle: path.join(directory, 'bundle-entry.mjs'),
        'secondary-window': path.join(directory, 'secondary-window.mjs'),
        'editor.worker': path.join(directory, 'editor-worker.mjs'),
        'plugin-worker': path.join(directory, 'plugin-worker.mjs'),
    };
    const dateFnsImporters = [
        path.join(browserDirectory, 'node_modules', '@theia', 'ai-chat-ui', 'lib', 'browser', 'chat-date-utils.js'),
        path.join(browserDirectory, 'node_modules', '@theia', 'ai-ide', 'lib', 'browser', 'ai-configuration', 'token-usage-configuration-widget.js'),
    ];
    const relativeImport = file => {
        const nativeRelative = path.relative(directory, file);
        if (path.isAbsolute(nativeRelative)) {
            return nativeRelative.replaceAll('\\', '/');
        }
        const relative = nativeRelative.replaceAll('\\', '/');
        return relative.startsWith('.') ? relative : `./${relative}`;
    };
    await Promise.all([
        fs.writeFile(entryPoints.bundle, [
            "import 'theia-ide-codex-ext/lib/browser/ride-codex-frontend-module';",
            ...dateFnsImporters.map(file => `import ${JSON.stringify(relativeImport(file))};`),
        ].join('\n')),
        fs.writeFile(entryPoints['secondary-window'], 'export {};\n'),
        fs.writeFile(entryPoints['editor.worker'], 'export {};\n'),
        fs.writeFile(entryPoints['plugin-worker'], 'export {};\n'),
    ]);
    const outdir = path.join(directory, 'out');
    await fs.mkdir(outdir, { recursive: true });
    await fs.writeFile(
        path.join(outdir, 'index.html'),
        '<script type="text/javascript" src="./bundle.js" charset="utf-8"></script>',
    );
    const plans = createTauriBrowserBuildPlans({
        entryPoints,
        outdir,
        bundle: true,
        packages: 'external',
        write: true,
        metafile: true,
        logLevel: 'silent',
    }, {
        profile: 'tauri-critical',
        featureGroups: {
            ai: {
                deferredFrontendModules: [{
                    module: 'theia-ide-codex-ext/lib/browser/ride-codex-frontend-module',
                    proxy: 'tauri-src/codex-proxy-frontend-module.ts',
                }],
            },
        },
    }, browserDirectory);

    const result = await esbuild.build(plans.main);
    const outputs = Object.entries(result.metafile.outputs);
    const initial = outputs.find(([output]) => path.basename(output) === 'bundle.js');
    assert.ok(initial, 'the critical build must emit bundle.js');
    const initialInputs = Object.keys(initial[1].inputs).join('\n');
    assert.match(initialInputs, /codex-proxy-frontend-module\.ts/);
    assert.doesNotMatch(
        initialInputs,
        /codex-feature\.ts|@openai\/codex-sdk|codex[- ]installer|CodexAppServerClient|app-server|codex[- ]process|child_process/i,
    );
    const delayed = outputs.find(([output, metadata]) =>
        /[\\/]chunks[\\/]/.test(output) && Object.keys(metadata.inputs).some(input => /codex-feature\.ts$/.test(input))
    );
    assert.ok(delayed, 'codex-feature.ts must remain in a separate delayed chunk');
});
