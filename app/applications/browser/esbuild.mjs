/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun theia build again.
 */
import { browserOptions, watch, __dirname, join } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';
import { copy } from 'esbuild-plugin-copy';
import fs from 'node:fs';
import path from 'node:path';
import { createTheiaModuleDedupePlugin } from './ride-esbuild-dedupe.mjs';

import esbuild from 'esbuild';

const leanTauriModulePrefixes = [
    '@theia/ai-',
    '@theia/bulk-edit/',
    '@theia/callhierarchy/',
    '@theia/console/',
    '@theia/collaboration/',
    '@theia/editor-preview/',
    '@theia/getting-started/',
    '@theia/keymaps/',
    '@theia/memory-inspector/',
    '@theia/metrics/',
    '@theia/mini-browser/',
    '@theia/notebook/',
    '@theia/plugin-dev/',
    '@theia/preview/',
    '@theia/property-view/',
    '@theia/scanoss/',
    '@theia/secondary-window/',
    '@theia/timeline/',
    '@theia/toolbar/',
    '@theia/typehierarchy/',
    '@theia/vsx-registry/'
];

const leanTauriPluginModulePrefixes = [
    '@theia/plugin-ext/',
    '@theia/plugin-ext-vscode/'
];

const leanTauriExtensionNames = [
    '@theia/ai-',
    '@theia/bulk-edit',
    '@theia/callhierarchy',
    '@theia/console',
    '@theia/collaboration',
    '@theia/editor-preview',
    '@theia/getting-started',
    '@theia/keymaps',
    '@theia/memory-inspector',
    '@theia/metrics',
    '@theia/mini-browser',
    '@theia/notebook',
    '@theia/plugin-dev',
    '@theia/preview',
    '@theia/property-view',
    '@theia/scanoss',
    '@theia/secondary-window',
    '@theia/timeline',
    '@theia/toolbar',
    '@theia/typehierarchy',
    '@theia/vsx-registry'
];

const leanTauriPluginExtensionNames = [
    '@theia/plugin-ext',
    '@theia/plugin-ext-vscode'
];

function shouldKeepTauriPlugins() {
    return process.env.RIDE_TAURI_ENABLE_PLUGINS === '1' || process.env.RIDE_TAURI_ENABLE_PLUGINS === 'true';
}

function shouldFilterLeanTauriRequire(line) {
    return leanTauriModulePrefixes.some(prefix => line.includes(`require('${prefix}`))
        || (!shouldKeepTauriPlugins() && leanTauriPluginModulePrefixes.some(prefix => line.includes(`require('${prefix}`)));
}

function shouldFilterLeanTauriExtension(name) {
    return leanTauriExtensionNames.some(prefix => name.startsWith(prefix))
        || (!shouldKeepTauriPlugins() && leanTauriPluginExtensionNames.some(prefix => name.startsWith(prefix)));
}

function patchGeneratedFilesForLeanTauri() {
    const enabled = process.env.RIDE_TAURI_LEAN === '1' || process.env.RIDE_TAURI_LEAN === 'true';
    if (!enabled) {
        return;
    }

    const generatedFiles = [
        path.join(__dirname, 'src-gen', 'frontend', 'index.js'),
        path.join(__dirname, 'src-gen', 'frontend', 'secondary-index.js'),
        path.join(__dirname, 'src-gen', 'backend', 'server.js')
    ];

    for (const file of generatedFiles) {
        if (!fs.existsSync(file)) {
            continue;
        }
        const source = fs.readFileSync(file, 'utf8');
        const filtered = source
            .split('\n')
            .filter(line => !shouldFilterLeanTauriRequire(line))
            .join('\n');
        if (filtered !== source) {
            fs.writeFileSync(file, filtered);
        }
    }

    const backendMain = path.join(__dirname, 'src-gen', 'backend', 'main.js');
    if (fs.existsSync(backendMain)) {
        const source = fs.readFileSync(backendMain, 'utf8');
        const filtered = source
            .replace(/    \{\n        "name": "([^"]+)",\n        "version": "[^"]+"\n    \},?\n/g, (entry, name) => shouldFilterLeanTauriExtension(name) ? '' : entry)
            .replace(/,\n\];/g, '\n];');
        if (filtered !== source) {
            fs.writeFileSync(backendMain, filtered);
        }
    }
}

function patchBuiltFilesForLeanTauri() {
    const enabled = process.env.RIDE_TAURI_LEAN === '1' || process.env.RIDE_TAURI_LEAN === 'true';
    if (!enabled) {
        return;
    }

    const backendBundle = path.join(__dirname, 'lib', 'backend', 'main.js');
    if (!fs.existsSync(backendBundle)) {
        return;
    }

    const source = fs.readFileSync(backendBundle, 'utf8');
    const filtered = source.replace(
        /onNotification\((\w+),\.\.\.(\w+)\)\{this\.target&&this\.target\[\1\]\(\.\.\.\2\)\}/,
        'onNotification($1,...$2){if(!this.target)return;const targetMethod=this.target[$1];typeof targetMethod==="function"?targetMethod.apply(this.target,$2):console.warn(`Ignoring RPC notification without target method: ${$1}`)}'
    );
    if (filtered !== source) {
        fs.writeFileSync(backendBundle, filtered);
    }
}

function patchBuiltParcelWatcherLoad() {
    const backendBundle = path.join(__dirname, 'lib', 'backend', 'main.js');
    if (!fs.existsSync(backendBundle)) {
        return;
    }

    const source = fs.readFileSync(backendBundle, 'utf8');
    const nativeWatcherPathExport = /(\b[\w$]+\.exports)\s*=\s*(["'])\.\/native\/watcher\.node\2/g;
    const patched = source.replace(
        nativeWatcherPathExport,
        '$1=require("./native/watcher.node")'
    );

    if (patched === source && source.includes('./native/watcher.node')
        && !source.includes('require("./native/watcher.node")')) {
        throw new Error('Unable to patch the Parcel watcher native module loader.');
    }
    if (patched !== source) {
        fs.writeFileSync(backendBundle, patched);
    }
}

patchGeneratedFilesForLeanTauri();

// Prevent Inversify service identifiers from being split across duplicate
// @theia package copies in the mixed-version workspace.
browserOptions.plugins.push(createTheiaModuleDedupePlugin(__dirname));
nodeOptions.plugins.push(createTheiaModuleDedupePlugin(__dirname));

// serve favicon from root and inject link tag into index.html
browserOptions.plugins.push(
    copy({
        assets: [{
            from: join(__dirname, 'ico', '**', '*'),
            to: join(__dirname, 'lib', 'frontend')
        }]
    }),
    {
        name: 'favicon-link',
        setup(build) {
            build.onEnd(() => {
                const indexPath = path.join(__dirname, 'lib', 'frontend', 'index.html');
                if (fs.existsSync(indexPath)) {
                    let html = fs.readFileSync(indexPath, 'utf8');
                    if (!html.includes('rel="icon"')) {
                        html = html.replace('</head>', '  <link rel="icon" type="image/x-icon" href="./favicon.ico">\n</head>');
                        fs.writeFileSync(indexPath, html);
                    }
                }
            });
        }
    }
);

const browserContext = await esbuild.context(browserOptions);
const nodeContext = await esbuild.context(nodeOptions);


if (watch) {
    await Promise.all([
        browserContext.watch(),
        nodeContext.watch(),
    ]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
        patchBuiltParcelWatcherLoad();
        patchBuiltFilesForLeanTauri();
    } catch {
        process.exit(1);
    }
}
