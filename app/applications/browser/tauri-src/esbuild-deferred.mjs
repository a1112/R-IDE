import fs from 'node:fs';
import path from 'node:path';

const CLASSIC_ENTRY_NAMES = ['secondary-window', 'editor.worker', 'plugin-worker'];

function deferredFrontendAliases(profileManifest, baseDirectory) {
    if (profileManifest?.profile !== 'tauri-critical') {
        return {};
    }
    const aliases = {};
    for (const group of Object.values(profileManifest.featureGroups ?? {})) {
        for (const deferred of group.deferredFrontendModules ?? []) {
            aliases[deferred.module] = path.resolve(baseDirectory, deferred.proxy);
        }
    }
    return aliases;
}

function createModuleScriptPlugin(baseDirectory, outdir) {
    const indexPath = path.join(path.resolve(baseDirectory, outdir), 'index.html');
    return {
        name: 'ride-tauri-module-script',
        setup(build) {
            build.onEnd(async result => {
                if (result.errors.length > 0) {
                    return;
                }
                const source = await fs.promises.readFile(indexPath, 'utf8');
                const patched = ensureModuleScript(source);
                if (patched !== source) {
                    await fs.promises.writeFile(indexPath, patched);
                }
            });
        }
    };
}

export function createTauriBrowserBuildPlans(browserOptions, profileManifest, baseDirectory) {
    const entryPoints = browserOptions?.entryPoints;
    if (!entryPoints || Array.isArray(entryPoints) || typeof entryPoints !== 'object') {
        throw new Error('Tauri browser build requires named esbuild entry points.');
    }
    if (!entryPoints.bundle) {
        throw new Error('Tauri browser build requires the main bundle entry.');
    }
    for (const name of CLASSIC_ENTRY_NAMES) {
        if (!entryPoints[name]) {
            throw new Error(`Tauri browser build requires the classic "${name}" entry.`);
        }
    }

    const aliases = deferredFrontendAliases(profileManifest, baseDirectory);
    const main = {
        ...browserOptions,
        entryPoints: { bundle: entryPoints.bundle },
        format: 'esm',
        splitting: true,
        chunkNames: 'chunks/[name]-[hash]',
        plugins: [
            ...(browserOptions.plugins ?? []),
            createModuleScriptPlugin(baseDirectory, browserOptions.outdir),
        ],
    };
    if (Object.keys(aliases).length > 0 || browserOptions.alias) {
        main.alias = { ...(browserOptions.alias ?? {}), ...aliases };
    }

    const classic = CLASSIC_ENTRY_NAMES.map(name => ({
        ...browserOptions,
        entryPoints: { [name]: entryPoints[name] },
        format: 'iife',
        splitting: false,
    }));
    return { main, classic };
}

export function ensureModuleScript(html) {
    const bundleScript = /<script\s+type=["'](?:text\/javascript|module)["']\s+src=["']\.\/bundle\.js["']\s+charset=["']utf-8["']><\/script>/g;
    const matches = html.match(bundleScript) ?? [];
    if (matches.length === 0) {
        throw new Error('Generated frontend HTML is missing the bundle script.');
    }
    if (matches.length !== 1) {
        throw new Error('Generated frontend HTML must contain exactly one bundle script.');
    }
    return html.replace(bundleScript, '<script type="module" src="./bundle.js" charset="utf-8"></script>');
}
