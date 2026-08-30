import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyzeBackendInitialBundle } from '../analyze-tauri-backend-initial-bundle.mjs';

const MAIN_ENTRY = 'src-gen/backend/main.js';
const MAIN_OUTPUT = 'lib/backend/main.js';
const SERVER_INPUT = 'src-gen/backend/server.js';
const AI_ROOT = 'node_modules/@theia/ai-ide';
const AI_BACKEND = `${AI_ROOT}/lib/node/backend-module.js`;
const BROWSER_AUTOMATION = `${AI_ROOT}/lib/node/app-tester-agent/browser-automation-impl.js`;
const PUPPETEER_ROOT = `${AI_ROOT}/node_modules/puppeteer-core`;
const PUPPETEER = `${PUPPETEER_ROOT}/lib/index.js`;
const QUICKJS_ROOT = '../../../node_modules/@tootallnate/quickjs-emscripten';
const QUICKJS = `${QUICKJS_ROOT}/dist/index.js`;
const BIDI_ROOT = '../../../node_modules/chromium-bidi';
const BIDI = `${BIDI_ROOT}/lib/index.js`;
const ESPRIMA_ROOT = '../../../node_modules/esprima';
const ESPRIMA = `${ESPRIMA_ROOT}/dist/esprima.js`;
const SCANOSS_ROOT = 'node_modules/scanoss';
const SCANOSS = `${SCANOSS_ROOT}/index.js`;
const SHARED_V1_ROOT = 'node_modules/alpha/node_modules/shared';
const SHARED_V2_ROOT = 'node_modules/beta/node_modules/shared';
const SHARED_V1 = `${SHARED_V1_ROOT}/index.js`;
const SHARED_V2 = `${SHARED_V2_ROOT}/index.js`;
const HOISTED_TSLIB_ROOT = 'node_modules/@theia/vsx-registry/node_modules/tslib';
const HOISTED_TSLIB = `${HOISTED_TSLIB_ROOT}/tslib.es6.mjs`;
const DEEP_PACKAGE_ROOT = '../../../../../node_modules/depth-probe';
const DEEP_PACKAGE = `${DEEP_PACKAGE_ROOT}/index.js`;
const ANALYZER_PATH = fileURLToPath(new URL('../analyze-tauri-backend-initial-bundle.mjs', import.meta.url));

function importRecord(importPath, overrides = {}) {
    return { path: importPath, kind: 'require-call', ...overrides };
}

function inputRecord(imports = []) {
    return { bytes: 1, imports, format: 'cjs' };
}

function createMetafile() {
    const mainInputs = {
        [MAIN_ENTRY]: { bytesInOutput: 100 },
        [SERVER_INPUT]: { bytesInOutput: 200 },
        [AI_BACKEND]: { bytesInOutput: 300 },
        [BROWSER_AUTOMATION]: { bytesInOutput: 400 },
        [PUPPETEER]: { bytesInOutput: 500 },
        [QUICKJS]: { bytesInOutput: 600 },
        [BIDI]: { bytesInOutput: 700 },
        [ESPRIMA]: { bytesInOutput: 800 },
        [SCANOSS]: { bytesInOutput: 25 },
        [SHARED_V1]: { bytesInOutput: 11 },
        [SHARED_V2]: { bytesInOutput: 13 }
    };

    return {
        commandLine: 'node --inspect=C:\\private\\debug.sock --token secret',
        inputs: {
            [MAIN_ENTRY]: inputRecord([
                importRecord('node:perf_hooks', { external: true }),
                importRecord(SERVER_INPUT)
            ]),
            [SERVER_INPUT]: inputRecord([
                importRecord(AI_BACKEND),
                importRecord(SCANOSS),
                importRecord(SHARED_V1),
                importRecord(SHARED_V2)
            ]),
            [AI_BACKEND]: inputRecord([importRecord(BROWSER_AUTOMATION)]),
            [BROWSER_AUTOMATION]: inputRecord([importRecord(PUPPETEER)]),
            [PUPPETEER]: inputRecord([
                importRecord(QUICKJS),
                importRecord(BIDI),
                importRecord(ESPRIMA),
                importRecord(AI_BACKEND)
            ]),
            [QUICKJS]: inputRecord(),
            [BIDI]: inputRecord(),
            [ESPRIMA]: inputRecord(),
            [SCANOSS]: inputRecord([importRecord(QUICKJS), importRecord(ESPRIMA)]),
            [SHARED_V1]: inputRecord(),
            [SHARED_V2]: inputRecord(),
            'node_modules/plugin-only/node_modules/puppeteer-core/index.js': inputRecord()
        },
        outputs: {
            [MAIN_OUTPUT]: {
                entryPoint: MAIN_ENTRY,
                bytes: 5_000,
                imports: [{ path: 'node:fs', kind: 'require-call', external: true }],
                inputs: mainInputs
            },
            'lib/backend/ipc-bootstrap.js': {
                entryPoint: 'node_modules/@theia/core/lib/node/messaging/ipc-bootstrap.js',
                bytes: 90_000,
                imports: [],
                inputs: {
                    'node_modules/ipc-only/index.js': { bytesInOutput: 90_000 }
                }
            },
            'lib/backend/plugin-host.js': {
                entryPoint: 'node_modules/@theia/plugin-ext/lib/hosted/node/plugin-host.js',
                bytes: 99_000,
                imports: [],
                inputs: {
                    'node_modules/plugin-only/node_modules/puppeteer-core/index.js': { bytesInOutput: 99_000 }
                }
            },
            'lib/backend/native/watcher.node': {
                bytes: 88_000,
                imports: [],
                inputs: {
                    'C:/private/build/watcher.node': { bytesInOutput: 88_000 }
                }
            },
            'lib/backend/worker/conoutSocketWorker.js': {
                entryPoint: '../../../node_modules/node-pty/lib/worker/conoutSocketWorker.js',
                bytes: 77_000,
                imports: [],
                inputs: {
                    '../../../node_modules/node-pty/lib/worker/conoutSocketWorker.js': { bytesInOutput: 77_000 }
                }
            }
        }
    };
}

function createPackageManifests() {
    return [
        { root: AI_ROOT, name: '@theia/ai-ide', version: '1.73.0-next.2' },
        { root: PUPPETEER_ROOT, name: 'puppeteer-core', version: '25.2.1' },
        { root: QUICKJS_ROOT, name: '@tootallnate/quickjs-emscripten', version: '0.23.0' },
        { root: BIDI_ROOT, name: 'chromium-bidi', version: '16.0.1' },
        { root: ESPRIMA_ROOT, name: 'esprima', version: '4.0.1' },
        { root: SCANOSS_ROOT, name: 'scanoss', version: '0.15.7' },
        { root: SHARED_V1_ROOT, name: 'shared', version: '1.0.0' },
        { root: SHARED_V2_ROOT, name: 'shared', version: '2.0.0' }
    ];
}

function analyze(metadata = createMetafile(), packageManifests = createPackageManifests()) {
    return analyzeBackendInitialBundle(metadata, { packageManifests });
}

function packageSummary(report, name) {
    return report.packages.find(candidate => candidate.name === name);
}

function packageCopy(report, name, version) {
    return report.packageCopies.find(candidate => candidate.name === name && candidate.version === version);
}

function createTempDirectory(testContext) {
    const directory = mkdtempSync(path.join(tmpdir(), 'ride-backend-bundle-analyzer-'));
    testContext.after(() => rmSync(directory, { force: true, recursive: true }));
    return directory;
}

function writeJson(filePath, value) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runAnalyzerCli(args) {
    return spawnSync(process.execPath, [ANALYZER_PATH, ...args], {
        encoding: 'utf8',
        windowsHide: true
    });
}

test('reports ownership from only the backend main output', () => {
    const report = analyze();

    assert.deepEqual(
        { schema: report.schema, version: report.version, output: report.output },
        {
            schema: 'ride.tauri-backend-initial-bundle',
            version: 1,
            output: {
                path: MAIN_OUTPUT,
                entryPoint: MAIN_ENTRY,
                bytes: 5_000,
                inputBytes: 3_649,
                inputCount: 11
            }
        }
    );
    assert.equal(packageSummary(report, '@theia/ai-ide').bytes, 700);
    assert.equal(packageSummary(report, 'puppeteer-core').bytes, 500);
    assert.equal(packageSummary(report, 'shared').bytes, 24);
    assert.equal(report.packages.some(candidate => candidate.name === 'ipc-only'), false);
    assert.equal(report.packages.some(candidate => candidate.bytes === 99_000), false);
    assert.equal(report.evidence.browserAutomation.reachableRuntimeBytes, 2_600);
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.packageCopies), true);
});

test('reports edge-cut ownership without charging runtime packages used by another importer', () => {
    const report = analyze();
    const evidence = report.evidence.browserAutomation;

    assert.deepEqual(
        {
            present: evidence.present,
            exclusiveBytes: evidence.exclusiveBytes,
            exclusiveInputCount: evidence.exclusiveInputCount,
            exclusiveRuntimeBytes: evidence.exclusiveRuntimeBytes,
            sharedRuntimeBytes: evidence.sharedRuntimeBytes
        },
        {
            present: true,
            exclusiveBytes: 1_600,
            exclusiveInputCount: 3,
            exclusiveRuntimeBytes: 1_200,
            sharedRuntimeBytes: 1_400
        }
    );
    assert.deepEqual(
        evidence.exclusivePackages.map(candidate => [candidate.name, candidate.bytes]),
        [
            ['@theia/ai-ide', 400],
            ['chromium-bidi', 700],
            ['puppeteer-core', 500]
        ]
    );
    assert.deepEqual(
        evidence.sharedRuntimePackages.map(candidate => [candidate.name, candidate.bytes]),
        [
            ['@tootallnate/quickjs-emscripten', 600],
            ['esprima', 800]
        ]
    );
});

test('reports package versions, duplicate logical copies, and shortest importer chains', () => {
    const report = analyze();
    const puppeteer = packageCopy(report, 'puppeteer-core', '25.2.1');
    const sharedCopies = report.packageCopies.filter(candidate => candidate.name === 'shared');

    assert.deepEqual(packageSummary(report, 'shared'), {
        name: 'shared',
        bytes: 24,
        copyCount: 2,
        versions: ['1.0.0', '2.0.0']
    });
    assert.deepEqual(report.duplicates, [{
        name: 'shared',
        bytes: 24,
        copies: sharedCopies.map(copy => copy.id)
    }]);
    assert.deepEqual(puppeteer.ancestry, ['@theia/ai-ide']);
    assert.deepEqual(puppeteer.importerChain, [
        MAIN_ENTRY,
        SERVER_INPUT,
        '@theia/ai-ide@1.73.0-next.2#1/lib/node/backend-module.js',
        '@theia/ai-ide@1.73.0-next.2#1/lib/node/app-tester-agent/browser-automation-impl.js',
        'puppeteer-core@25.2.1#1/lib/index.js'
    ]);
});

test('rejects a missing or duplicate backend main output', () => {
    const missing = createMetafile();
    delete missing.outputs[MAIN_OUTPUT];
    assert.throws(() => analyze(missing), /backend main output.*missing/i);

    const duplicate = createMetafile();
    duplicate.outputs['lib/backend/main-copy.js'] = structuredClone(duplicate.outputs[MAIN_OUTPUT]);
    assert.throws(() => analyze(duplicate), /duplicate backend main output/i);
});

test('rejects missing, duplicate, or external package manifest records', () => {
    const missing = createPackageManifests().filter(record => record.name !== 'puppeteer-core');
    assert.throws(() => analyze(createMetafile(), missing), /missing package manifest.*puppeteer-core/i);

    const duplicate = createPackageManifests();
    duplicate.push({ ...duplicate[0] });
    assert.throws(() => analyze(createMetafile(), duplicate), /duplicate package manifest root/i);

    const external = createPackageManifests();
    external.push({ root: 'node_modules/not-bundled', name: 'not-bundled', version: '1.0.0' });
    assert.throws(() => analyze(createMetafile(), external), /external package manifest record/i);
});

test('rejects contradictory external imports to bundled inputs', () => {
    const metafile = createMetafile();
    metafile.inputs[SERVER_INPUT].imports[0].external = true;

    assert.throws(() => analyze(metafile), /external import.*bundled input/i);
});

test('rejects cyclic package ancestry and malformed records', () => {
    const cyclic = createMetafile();
    const cyclicInput = 'node_modules/repeat/node_modules/repeat/index.js';
    cyclic.inputs[cyclicInput] = inputRecord();
    cyclic.inputs[SERVER_INPUT].imports.push(importRecord(cyclicInput));
    cyclic.outputs[MAIN_OUTPUT].inputs[cyclicInput] = { bytesInOutput: 1 };
    const cyclicManifests = createPackageManifests();
    cyclicManifests.push({
        root: 'node_modules/repeat/node_modules/repeat',
        name: 'repeat',
        version: '1.0.0'
    });
    assert.throws(() => analyze(cyclic, cyclicManifests), /cyclic package ancestry/i);

    const malformed = createMetafile();
    malformed.outputs[MAIN_OUTPUT].inputs['node_modules/@broken'] = { bytesInOutput: 1 };
    malformed.inputs['node_modules/@broken'] = inputRecord();
    assert.throws(() => analyze(malformed), /malformed package path/i);
});

test('rejects duplicate logical inputs and unsafe byte counts', () => {
    const duplicate = createMetafile();
    duplicate.outputs[MAIN_OUTPUT].inputs[`./${MAIN_ENTRY}`] = { bytesInOutput: 1 };
    assert.throws(() => analyze(duplicate), /duplicate logical input/i);

    const unsafe = createMetafile();
    unsafe.outputs[MAIN_OUTPUT].inputs[PUPPETEER].bytesInOutput = Number.MAX_SAFE_INTEGER + 1;
    assert.throws(() => analyze(unsafe), /safe integer/i);
});

test('report never exposes absolute paths or metadata command lines', () => {
    const metafile = createMetafile();
    const absoluteInput = 'C:/private/workspace/generated/native.node';
    metafile.inputs[absoluteInput] = inputRecord();
    metafile.inputs[SERVER_INPUT].imports.push(importRecord(absoluteInput));
    metafile.outputs[MAIN_OUTPUT].inputs[absoluteInput] = { bytesInOutput: 5 };

    const serialized = JSON.stringify(analyze(metafile));

    assert.doesNotMatch(serialized, /C:\/private|private\\workspace|--inspect|--token|secret/i);
});

test('CLI resolves package manifests from the backend metadata location', testContext => {
    const directory = createTempDirectory(testContext);
    const browserDirectory = path.join(directory, 'app', 'applications', 'browser');
    const metadataPath = path.join(browserDirectory, 'lib', 'metadata', 'backend.json');
    const buildId = 'fixture-build';
    const metafile = createMetafile();
    metafile.inputs[SERVER_INPUT].imports.push(importRecord(HOISTED_TSLIB), importRecord(DEEP_PACKAGE));
    metafile.inputs[HOISTED_TSLIB] = inputRecord();
    metafile.inputs[DEEP_PACKAGE] = inputRecord();
    metafile.outputs[MAIN_OUTPUT].inputs[HOISTED_TSLIB] = { bytesInOutput: 17 };
    metafile.outputs[MAIN_OUTPUT].inputs[DEEP_PACKAGE] = { bytesInOutput: 19 };
    const metadata = {
        schema: 'ride.esbuild-metafile@1',
        target: 'backend',
        buildId,
        metafile
    };
    writeJson(metadataPath, metadata);

    const fixtureManifests = [
        ...createPackageManifests(),
        { root: HOISTED_TSLIB_ROOT, name: 'tslib', version: '2.8.1' },
        { root: DEEP_PACKAGE_ROOT, name: 'depth-probe', version: '2.0.0' }
    ];
    const logicalBuildDirectory = path.join(
        browserDirectory,
        '.ride-tauri-profile',
        'builds',
        buildId
    );
    for (const manifest of fixtureManifests.filter(candidate => candidate.root !== HOISTED_TSLIB_ROOT)) {
        let manifestRoot;
        if (manifest.root.startsWith('../')) {
            manifestRoot = path.resolve(logicalBuildDirectory, manifest.root);
        } else {
            manifestRoot = path.join(browserDirectory, manifest.root);
        }
        writeJson(path.join(manifestRoot, 'package.json'), {
            name: manifest.name,
            version: manifest.version
        });
    }
    writeJson(path.join(browserDirectory, 'node_modules', 'tslib', 'package.json'), {
        name: 'tslib',
        version: '2.8.1'
    });
    writeJson(path.join(browserDirectory, 'node_modules', '@theia', 'vsx-registry', 'package.json'), {
        name: '@theia/vsx-registry',
        version: '1.73.0-next.2'
    });
    writeJson(path.join(browserDirectory, 'node_modules', 'depth-probe', 'package.json'), {
        name: 'depth-probe',
        version: '1.0.0'
    });

    const result = runAnalyzerCli(['--metadata', metadataPath]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.equal(packageSummary(report, 'puppeteer-core').bytes, 500);
    assert.deepEqual(packageSummary(report, 'tslib').versions, ['2.8.1']);
    assert.deepEqual(packageSummary(report, 'depth-probe').versions, ['2.0.0']);
    assert.doesNotMatch(result.stdout, new RegExp(directory.replaceAll('\\', '\\\\'), 'i'));
    assert.doesNotMatch(result.stdout, /--inspect|--token|secret/i);
});

test('CLI rejects malformed invocation without emitting a report', testContext => {
    const directory = createTempDirectory(testContext);
    const malformedPath = path.join(directory, 'malformed.json');
    writeFileSync(malformedPath, '{"metafile":', 'utf8');

    for (const args of [[], ['--metadata', malformedPath, '--unexpected'], ['--metadata', malformedPath]]) {
        const result = runAnalyzerCli(args);
        assert.notEqual(result.status, 0);
        assert.equal(result.stdout, '');
    }
});
