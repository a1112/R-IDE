import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const CLASSIC_ENTRY_NAMES = ['secondary-window', 'editor.worker', 'plugin-worker'];
const TAURI_CRITICAL_FRONTEND_ALIASES = [{
    request: 'date-fns',
    replacement: 'tauri-src/date-fns-bridge.ts',
    source: 'built-in date-fns bridge',
}, {
    request: 'date-fns/locale',
    replacement: 'tauri-src/date-fns-locales-bridge.ts',
    source: 'built-in date-fns locale bridge',
}];
const DATE_FNS_IMPORT_CONTRACT = {
    '@theia/ai-chat-ui/lib/browser/chat-date-utils.js': {
        'date-fns': ['formatDistance'],
        'date-fns/locale': ['enUS', 'nls.locale'],
    },
    '@theia/ai-ide/lib/browser/ai-configuration/token-usage-configuration-widget.js': {
        'date-fns': ['formatDistanceToNow'],
    },
};
const DATE_FNS_BROAD_REQUESTS = new Set(['date-fns', 'date-fns/locale']);

function normalizeBuildPath(value) {
    return value.replaceAll('\\', '/');
}

function packageImporterPath(input) {
    const normalized = normalizeBuildPath(input);
    if (normalized.startsWith('node_modules/')) {
        return normalized.slice('node_modules/'.length);
    }
    const marker = '/node_modules/';
    const markerIndex = normalized.lastIndexOf(marker);
    return markerIndex >= 0 ? normalized.slice(markerIndex + marker.length) : normalized;
}

function resolveBuildInput(baseDirectory, input) {
    const candidates = path.isAbsolute(input)
        ? [input]
        : [path.resolve(baseDirectory, input), path.resolve(input)];
    return candidates.find(candidate => fs.existsSync(candidate)) ?? candidates[0];
}

function sortedValues(values) {
    return [...values].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function isNlsLocaleLookup(expression) {
    return ts.isPropertyAccessExpression(expression)
        && !expression.questionDotToken
        && expression.name.text === 'locale'
        && ts.isPropertyAccessExpression(expression.expression)
        && !expression.expression.questionDotToken
        && expression.expression.name.text === 'nls';
}

function auditDateFnsSource(source, importer, requestContract) {
    const sourceFile = ts.createSourceFile(importer, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    if (sourceFile.parseDiagnostics.length > 0) {
        throw new Error(`Date-fns importer ${importer} has invalid JavaScript syntax.`);
    }
    const bindingsByRequest = new Map();
    const bindingsByName = new Map();
    const collectBindings = node => {
        if (ts.isCallExpression(node)
            && ts.isIdentifier(node.expression)
            && node.expression.text === 'require'
            && node.arguments.length === 1
            && ts.isStringLiteral(node.arguments[0])
            && DATE_FNS_BROAD_REQUESTS.has(node.arguments[0].text)) {
            const request = node.arguments[0].text;
            const declaration = node.parent;
            if (!ts.isVariableDeclaration(declaration)
                || declaration.initializer !== node
                || !ts.isIdentifier(declaration.name)) {
                throw new Error(`Date-fns importer ${importer} must bind ${request} through one namespace require.`);
            }
            if (bindingsByRequest.has(request)) {
                throw new Error(`Date-fns importer ${importer} has duplicate namespace requires for ${request}.`);
            }
            const binding = declaration.name.text;
            bindingsByRequest.set(request, binding);
            bindingsByName.set(binding, request);
        }
        ts.forEachChild(node, collectBindings);
    };
    collectBindings(sourceFile);

    const expectedRequests = sortedValues(Object.keys(requestContract));
    const actualRequests = sortedValues(bindingsByRequest.keys());
    if (JSON.stringify(actualRequests) !== JSON.stringify(expectedRequests)) {
        throw new Error(`Date-fns importer ${importer} namespace requests changed: expected ${expectedRequests.join(', ')}, received ${actualRequests.join(', ')}.`);
    }

    const uses = new Map(expectedRequests.map(request => [request, new Set()]));
    const auditUses = node => {
        if (ts.isIdentifier(node) && bindingsByName.has(node.text)) {
            const request = bindingsByName.get(node.text);
            const declaration = node.parent;
            if (ts.isVariableDeclaration(declaration) && declaration.name === node) {
                // The namespace binding declaration itself is not a use.
            } else if (ts.isPropertyAccessExpression(declaration) && declaration.name === node) {
                // An identifier used as another object's property name is not the namespace binding.
            } else if (ts.isPropertyAccessExpression(declaration) && declaration.expression === node) {
                if (declaration.questionDotToken) {
                    throw new Error(`Date-fns importer ${importer} uses unsupported optional access on ${request}.`);
                }
                const property = declaration.name.text;
                if (!requestContract[request].includes(property)) {
                    throw new Error(`Date-fns importer ${importer} uses unsupported ${request} property ${property}.`);
                }
                uses.get(request).add(property);
            } else if (ts.isElementAccessExpression(declaration) && declaration.expression === node) {
                const argument = declaration.argumentExpression;
                if (request !== 'date-fns/locale' || declaration.questionDotToken || !isNlsLocaleLookup(argument)) {
                    throw new Error(`Date-fns importer ${importer} rejects bracket notation ${node.text}[${argument?.getText(sourceFile) ?? ''}] for ${request}.`);
                }
                uses.get(request).add('nls.locale');
            } else {
                throw new Error(`Date-fns importer ${importer} uses the ${request} namespace outside an allowed property access.`);
            }
        }
        ts.forEachChild(node, auditUses);
    };
    auditUses(sourceFile);

    for (const request of expectedRequests) {
        const expectedUses = sortedValues(requestContract[request]);
        const actualUses = sortedValues(uses.get(request));
        if (JSON.stringify(actualUses) !== JSON.stringify(expectedUses)) {
            throw new Error(`Date-fns importer ${importer} property contract changed for ${request}: expected ${expectedUses.join(', ')}, received ${actualUses.join(', ')}.`);
        }
    }
}

export function auditDateFnsBridgeContract(metafile, baseDirectory) {
    if (!metafile?.inputs || typeof metafile.inputs !== 'object') {
        throw new Error('Date-fns importer contract requires a complete frontend-main metafile.');
    }
    const actual = [];
    const inputByImporter = new Map();
    for (const [input, detail] of Object.entries(metafile.inputs)) {
        for (const imported of detail.imports ?? []) {
            if (!DATE_FNS_BROAD_REQUESTS.has(imported.original)) {
                continue;
            }
            const importer = packageImporterPath(input);
            actual.push(`${importer} -> ${imported.original}`);
            inputByImporter.set(importer, input);
        }
    }
    const expected = Object.entries(DATE_FNS_IMPORT_CONTRACT).flatMap(([importer, requests]) =>
        Object.keys(requests).map(request => `${importer} -> ${request}`)
    );
    const sortedActual = sortedValues(actual);
    const sortedExpected = sortedValues(expected);
    if (JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)) {
        const unexpected = sortedActual.filter(record => !sortedExpected.includes(record));
        const missing = sortedExpected.filter(record => !sortedActual.includes(record));
        throw new Error(`Unexpected date-fns importer contract: unexpected ${unexpected.join(', ') || '<none>'}; missing ${missing.join(', ') || '<none>'}.`);
    }
    for (const [importer, requestContract] of Object.entries(DATE_FNS_IMPORT_CONTRACT)) {
        const input = inputByImporter.get(importer);
        const sourcePath = resolveBuildInput(baseDirectory, input);
        auditDateFnsSource(fs.readFileSync(sourcePath, 'utf8'), importer, requestContract);
    }
}

function exactFrontendAliases(profileManifest, baseDirectory) {
    if (profileManifest?.profile !== 'tauri-critical') {
        return {};
    }
    const aliases = {};
    const sources = new Map();
    const addAlias = (request, replacement, source) => {
        if (Object.hasOwn(aliases, request)) {
            throw new Error(`Duplicate exact frontend alias request "${request}": ${sources.get(request)} conflicts with ${source}.`);
        }
        aliases[request] = path.resolve(baseDirectory, replacement);
        sources.set(request, source);
    };
    for (const alias of TAURI_CRITICAL_FRONTEND_ALIASES) {
        addAlias(alias.request, alias.replacement, alias.source);
    }
    const featureGroups = Object.entries(profileManifest.featureGroups ?? {})
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    for (const [groupName, group] of featureGroups) {
        for (const deferred of group.deferredFrontendModules ?? []) {
            addAlias(
                deferred.module,
                deferred.proxy,
                `feature group "${groupName}" module "${deferred.module}" proxy "${deferred.proxy}"`,
            );
        }
    }
    return aliases;
}

function createDateFnsImportContractPlugin(baseDirectory) {
    return {
        name: 'ride-tauri-date-fns-import-contract',
        setup(build) {
            build.onEnd(result => {
                if (result.errors.length === 0) {
                    auditDateFnsBridgeContract(result.metafile, baseDirectory);
                }
            });
        },
    };
}

function createDeferredFrontendAliasPlugin(aliases) {
    const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = new RegExp(`^(?:${Object.keys(aliases).map(escapeRegex).join('|')})$`);
    return {
        name: 'ride-tauri-deferred-frontend-alias',
        setup(build) {
            build.onResolve({ filter }, args => {
                const replacement = aliases[args.path];
                return replacement ? { path: replacement } : undefined;
            });
        }
    };
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

    const aliases = exactFrontendAliases(profileManifest, baseDirectory);
    const auditDateFnsImports = profileManifest?.profile === 'tauri-critical' && browserOptions.metafile === true;
    const main = {
        ...browserOptions,
        preserveSymlinks: true,
        entryPoints: { bundle: entryPoints.bundle },
        format: 'esm',
        splitting: true,
        chunkNames: 'chunks/[name]-[hash]',
        plugins: [
            ...(Object.keys(aliases).length > 0 ? [createDeferredFrontendAliasPlugin(aliases)] : []),
            ...(auditDateFnsImports ? [createDateFnsImportContractPlugin(baseDirectory)] : []),
            ...(browserOptions.plugins ?? []),
            createModuleScriptPlugin(baseDirectory, browserOptions.outdir),
        ],
    };
    const classic = CLASSIC_ENTRY_NAMES.map(name => ({
        ...browserOptions,
        preserveSymlinks: true,
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
