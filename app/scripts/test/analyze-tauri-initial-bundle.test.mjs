import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { analyzeInitialBundle } from '../analyze-tauri-initial-bundle.mjs';

const ENTRY = 'lib/frontend/bundle.js';
const STATIC_CHUNK = 'lib/frontend/chunks/static.js';
const DYNAMIC_CHUNK = 'lib/frontend/chunks/deferred.js';
const ANALYZER_PATH = fileURLToPath(new URL('../analyze-tauri-initial-bundle.mjs', import.meta.url));

function createTempDirectory(testContext) {
    const directory = mkdtempSync(path.join(tmpdir(), 'ride-bundle-analyzer-'));
    testContext.after(() => rmSync(directory, { force: true, recursive: true }));
    return directory;
}

function runAnalyzerCli(args) {
    return spawnSync(process.execPath, [ANALYZER_PATH, ...args], {
        encoding: 'utf8',
        windowsHide: true
    });
}

function createMetafile() {
    return {
        inputs: {},
        outputs: {
            [ENTRY]: {
                bytes: 1_200,
                imports: [
                    { path: STATIC_CHUNK, kind: 'import-statement' },
                    { path: DYNAMIC_CHUNK, kind: 'dynamic-import' }
                ],
                inputs: {
                    'src/frontend/main.js': { bytesInOutput: 150 },
                    'node_modules/@scope/example/index.js': { bytesInOutput: 50 },
                    '../../../node_modules/@vendor/wrapper/node_modules/date-fns/format.js': { bytesInOutput: 400 }
                }
            },
            [STATIC_CHUNK]: {
                bytes: 300,
                imports: [],
                inputs: {
                    'L:/generated/static.js': { bytesInOutput: 100 },
                    'node_modules/date-fns/formatDistance.js': { bytesInOutput: 300 }
                }
            },
            [DYNAMIC_CHUNK]: {
                bytes: 900,
                imports: [],
                inputs: {
                    'node_modules/highlight.js/lib/index.js': { bytesInOutput: 900 }
                }
            }
        }
    };
}

test('reports only the statically reachable initial graph', () => {
    const report = analyzeInitialBundle(createMetafile());

    assert.deepEqual(report.outputs, [ENTRY, STATIC_CHUNK]);
    assert.equal(report.outputs.includes(DYNAMIC_CHUNK), false);
    assert.equal(report.packages['date-fns'], 700);
    assert.equal(report.packages['@scope/example'], 50);
    assert.equal(Object.hasOwn(report.packages, 'highlight.js'), false);
    assert.equal(report.totalInputBytes, 1_000);
    assert.deepEqual(
        { schema: report.schema, version: report.version, entry: report.entry },
        { schema: 'ride.tauri-initial-bundle', version: 1, entry: ENTRY }
    );
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.outputs), true);
    assert.equal(Object.isFrozen(report.packages), true);
});

test('skips external import statements', () => {
    const metafile = createMetafile();
    metafile.outputs[ENTRY].imports.push({
        path: 'react',
        kind: 'import-statement',
        external: true
    });

    const report = analyzeInitialBundle(metafile);

    assert.deepEqual(report.outputs, [ENTRY, STATIC_CHUNK]);
    assert.equal(report.totalOutputBytes, 1_500);
    assert.equal(report.totalInputBytes, 1_000);
    assert.equal(Object.hasOwn(report.packages, 'react'), false);
});

test('rejects a missing entry', () => {
    const metafile = createMetafile();
    delete metafile.outputs[ENTRY];

    assert.throws(() => analyzeInitialBundle(metafile), /entry.*missing/i);
});

test('rejects an import cycle', () => {
    const metafile = createMetafile();
    metafile.outputs[STATIC_CHUNK].imports.push({ path: ENTRY, kind: 'import-statement' });

    assert.throws(() => analyzeInitialBundle(metafile), /cycle/i);
});

test('rejects a statically reachable output outside lib/frontend', () => {
    const metafile = createMetafile();
    const outsideOutput = 'lib/backend/static.js';
    metafile.outputs[ENTRY].imports[0].path = outsideOutput;
    metafile.outputs[outsideOutput] = metafile.outputs[STATIC_CHUNK];

    assert.throws(() => analyzeInitialBundle(metafile), /outside.*lib\/frontend/i);
});

test('rejects unsafe integer byte counts', () => {
    const metafile = createMetafile();
    metafile.outputs[ENTRY].inputs['src/frontend/main.js'].bytesInOutput = Number.MAX_SAFE_INTEGER + 1;

    assert.throws(() => analyzeInitialBundle(metafile), /safe.*integer/i);
});

test('rejects malformed package paths', () => {
    const metafile = createMetafile();
    metafile.outputs[ENTRY].inputs['node_modules/@scope'] = { bytesInOutput: 10 };

    assert.throws(() => analyzeInitialBundle(metafile), /malformed package path/i);
});

test('rejects duplicate logical inputs', () => {
    const metafile = createMetafile();
    metafile.outputs[ENTRY].inputs['./src/frontend/main.js'] = { bytesInOutput: 200 };

    assert.throws(() => analyzeInitialBundle(metafile), /duplicate logical input/i);
});

test('CLI accepts exactly --metadata <path> and emits a JSON report', testContext => {
    const directory = createTempDirectory(testContext);
    const metadataPath = path.join(directory, 'metafile.json');
    writeFileSync(metadataPath, JSON.stringify(createMetafile()), 'utf8');

    const result = runAnalyzerCli(['--metadata', metadataPath]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.outputs, [ENTRY, STATIC_CHUNK]);
    assert.equal(report.totalInputBytes, 1_000);
});

test('CLI rejects extra arguments without emitting a report', testContext => {
    const directory = createTempDirectory(testContext);
    const metadataPath = path.join(directory, 'metafile.json');
    writeFileSync(metadataPath, JSON.stringify(createMetafile()), 'utf8');

    const result = runAnalyzerCli(['--metadata', metadataPath, '--unexpected']);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage:/i);
});

test('CLI rejects malformed JSON or missing metadata without emitting a report', testContext => {
    const directory = createTempDirectory(testContext);
    const malformedPath = path.join(directory, 'malformed.json');
    writeFileSync(malformedPath, '{"outputs":', 'utf8');

    const cases = [
        ['malformed JSON', ['--metadata', malformedPath]],
        ['missing metadata argument', []],
        ['missing metadata file', ['--metadata', path.join(directory, 'missing.json')]]
    ];
    for (const [label, args] of cases) {
        const result = runAnalyzerCli(args);
        assert.notEqual(result.status, 0, label);
        assert.equal(result.stdout, '', label);
    }
});
