/**
 * This file can be edited to adjust the ESBuild build process.
 * To reset, delete this file and rerun theia build again.
 */
import { browserOptions, watch, __dirname, join } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';
import { copy } from 'esbuild-plugin-copy';
import fs from 'node:fs';
import path from 'node:path';

import esbuild from 'esbuild';

const leanTauriModulePrefixes = [
    '@theia/ai-',
    '@theia/collaboration/',
    '@theia/getting-started/',
    '@theia/memory-inspector/',
    '@theia/metrics/',
    '@theia/mini-browser/',
    '@theia/notebook/',
    '@theia/plugin-dev/',
    '@theia/preview/',
    '@theia/property-view/',
    '@theia/scanoss/',
    '@theia/test/',
    '@theia/vsx-registry/'
];

const leanTauriExtensionNames = [
    '@theia/ai-',
    '@theia/collaboration',
    '@theia/getting-started',
    '@theia/memory-inspector',
    '@theia/metrics',
    '@theia/mini-browser',
    '@theia/notebook',
    '@theia/plugin-dev',
    '@theia/preview',
    '@theia/property-view',
    '@theia/scanoss',
    '@theia/test',
    '@theia/vsx-registry'
];

function shouldFilterLeanTauriRequire(line) {
    return leanTauriModulePrefixes.some(prefix => line.includes(`require('${prefix}`));
}

function shouldFilterLeanTauriExtension(name) {
    return leanTauriExtensionNames.some(prefix => name.startsWith(prefix));
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

patchGeneratedFilesForLeanTauri();

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
    } catch {
        process.exit(1);
    }
}
