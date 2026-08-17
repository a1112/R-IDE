/**
 * Custom build hooks shared by the tracked browser app and generated Tauri
 * profile targets. Profile selection happens before Theia generation, so this
 * file never edits generated source files or removes modules by string match.
 */
import { browserOptions, watch, __dirname, join } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';
import { copy } from 'esbuild-plugin-copy';
import fs from 'node:fs';
import path from 'node:path';
import { createTheiaModuleDedupePlugin } from './ride-esbuild-dedupe.mjs';
import {
    buildAllowedTheiaPackageSet,
    createTauriProfileAuditPlugin,
    loadTauriProfileManifest,
} from './tauri-esbuild-profile-audit.mjs';
import {
    createTauriBrowserBuildPlans,
} from './tauri-src/esbuild-deferred.mjs';

import esbuild from 'esbuild';

const profileManifest = await loadTauriProfileManifest(__dirname);
if (profileManifest) {
    const allowedPackages = buildAllowedTheiaPackageSet(profileManifest);
    browserOptions.metafile = true;
    nodeOptions.metafile = true;
    browserOptions.plugins.unshift(createTauriProfileAuditPlugin({
        baseDirectory: __dirname,
        allowedPackages,
    }));
    nodeOptions.plugins.unshift(createTauriProfileAuditPlugin({
        baseDirectory: __dirname,
        allowedPackages,
    }));
}

function patchBuiltRpcNotificationTarget() {
    const backendBundle = path.join(__dirname, 'lib', 'backend', 'main.js');
    if (!fs.existsSync(backendBundle)) {
        return;
    }

    const source = fs.readFileSync(backendBundle, 'utf8');
    const patched = source.replace(
        /onNotification\((\w+),\.\.\.(\w+)\)\{this\.target&&this\.target\[\1\]\(\.\.\.\2\)\}/,
        'onNotification($1,...$2){if(!this.target)return;const targetMethod=this.target[$1];typeof targetMethod==="function"?targetMethod.apply(this.target,$2):console.warn(`Ignoring RPC notification without target method: ${$1}`)}'
    );
    if (patched !== source) {
        fs.writeFileSync(backendBundle, patched);
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

// Prevent Inversify service identifiers from being split across duplicate
// @theia package copies in the mixed-version workspace. createRequire resolves
// upward from an isolated profile target on every supported platform.
browserOptions.plugins.push(createTheiaModuleDedupePlugin(__dirname));
nodeOptions.plugins.push(createTheiaModuleDedupePlugin(__dirname));

// Serve the favicon from the root and inject its link into generated HTML.
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

const browserBuildPlans = profileManifest
    ? createTauriBrowserBuildPlans(browserOptions, profileManifest, __dirname)
    : { main: browserOptions, classic: [] };
const browserContexts = [];
for (const options of [browserBuildPlans.main, ...browserBuildPlans.classic]) {
    browserContexts.push(await esbuild.context(options));
}
const nodeContext = await esbuild.context(nodeOptions);

if (watch) {
    await Promise.all([
        ...browserContexts.map(context => context.watch()),
        nodeContext.watch(),
    ]);
} else {
    try {
        for (const browserContext of browserContexts) {
            await browserContext.rebuild();
            await browserContext.dispose();
        }
        await nodeContext.rebuild();
        await nodeContext.dispose();
        patchBuiltParcelWatcherLoad();
        patchBuiltRpcNotificationTarget();
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}
