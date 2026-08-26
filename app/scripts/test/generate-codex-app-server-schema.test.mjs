import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const appRoot = resolve(import.meta.dirname, '..', '..');
const generator = join(appRoot, 'scripts', 'generate-codex-app-server-schema.mjs');
const generatedRoot = join(appRoot, 'theia-extensions', 'codex', 'src', 'common', 'generated', 'app-server', '0.144.0');
const schemaPath = join(generatedRoot, 'schema.json');
const compatibilityPath = join(appRoot, 'theia-extensions', 'codex', 'src', 'common', 'codex-app-server-compatibility.json');
const methodsPath = join(appRoot, 'theia-extensions', 'codex', 'src', 'common', 'ride-codex-methods.ts');

const EXPECTED_CLIENT_METHODS = [
    'initialize', 'account/read', 'account/login/start', 'account/login/cancel', 'account/logout',
    'account/rateLimits/read', 'model/list', 'modelProvider/capabilities/read', 'thread/list',
    'thread/read', 'thread/start', 'thread/resume', 'thread/archive', 'turn/start', 'turn/steer',
    'turn/interrupt'
];

const REQUIRED_STABLE_STREAMS = [
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
    'thread/tokenUsage/updated'
];

const EXPECTED_CLIENT_NOTIFICATIONS = ['initialized'];
const EXPECTED_SERVER_NOTIFICATIONS = [
    'error', 'account/updated', 'account/login/completed', 'account/rateLimits/updated',
    'model/rerouted', 'model/verification', 'thread/started', 'thread/status/changed',
    'thread/archived', 'thread/tokenUsage/updated', 'turn/started', 'turn/completed',
    'turn/diff/updated', 'turn/plan/updated', 'item/started', 'item/completed',
    'item/agentMessage/delta', 'item/plan/delta', 'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta', 'item/commandExecution/outputDelta',
    'item/fileChange/outputDelta', 'item/fileChange/patchUpdated',
    'serverRequest/resolved', 'warning', 'deprecationNotice'
];
const EXPECTED_SERVER_REQUESTS = [
    'item/commandExecution/requestApproval',
    'item/fileChange/requestApproval'
];

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function readMethods() {
    return readFileSync(methodsPath, 'utf8');
}

async function importCompiledMethods() {
    const temporary = mkdtempSync(join(tmpdir(), 'ride-codex-methods-'));
    const compiledMethodsPath = join(temporary, 'ride-codex-methods.cjs');
    try {
        const compiled = ts.transpileModule(readMethods(), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022
            },
            fileName: methodsPath,
            reportDiagnostics: true
        });
        const errors = (compiled.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
        assert.deepEqual(errors, [], 'ride-codex-methods.ts must compile without errors');
        writeFileSync(compiledMethodsPath, compiled.outputText);
        return await import(`${pathToFileURL(compiledMethodsPath).href}?test=${Date.now()}`);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

function makeExecutable(path) {
    if (process.platform !== 'win32') chmodSync(path, 0o755);
}

function readQuotedArray(source, name) {
    const match = source.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\] as const;?\\)`));
    assert.ok(match, `${name} must be an immutable const array`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function sha256(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function generatedTypeFiles() {
    const root = join(generatedRoot, 'types');
    const visit = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? visit(path) : [path];
    });
    return visit(root).sort((left, right) => left.localeCompare(right));
}

function generatedMethods(typeName) {
    const source = readFileSync(join(generatedRoot, 'types', `${typeName}.ts`), 'utf8');
    return [...source.matchAll(/"method": "([^"]+)"/g)].map(match => match[1]);
}

function schemaMethods(schema) {
    const methods = new Set();
    const visit = value => {
        if (!value || typeof value !== 'object') return;
        if (value.properties?.method && typeof value.properties.method === 'object') {
            const method = value.properties.method.const ?? value.properties.method.enum?.[0];
            if (typeof method === 'string') methods.add(method);
        }
        for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
    };
    visit(schema);
    return methods;
}

function assertReviewedSubset(reviewed, generated, label) {
    for (const method of reviewed) assert.ok(generated.includes(method), `${label} must contain ${method}`);
}

test('pins stable initialization capabilities and excludes unsafe client methods', () => {
    const source = readMethods();
    assert.match(source, /export const INITIALIZE_CAPABILITIES = Object\.freeze\(\{\s*experimentalApi: false,\s*requestAttestation: false\s*}\)/s);
    const clientMethods = readQuotedArray(source, 'CLIENT_METHODS');
    assert.ok(!clientMethods.includes('thread/shellCommand'));
    assert.ok(!clientMethods.includes('process/exec'));
});

test('keeps generated schema, compatibility matrix, and allowlists in sync', () => {
    assert.ok(existsSync(schemaPath), 'reviewed schema fixture is required');
    const schema = readJson(schemaPath);
    const compatibility = readJson(compatibilityPath);
    const source = readMethods();
    assert.equal(compatibility.codexCliVersion, '0.144.0');
    assert.equal(compatibility.schemaDirectory, 'generated/app-server/0.144.0');
    assert.deepEqual(compatibility.clientNotificationMethods, EXPECTED_CLIENT_NOTIFICATIONS);
    assert.deepEqual(compatibility.clientMethods, EXPECTED_CLIENT_METHODS);
    assert.deepEqual(compatibility.serverNotificationMethods, EXPECTED_SERVER_NOTIFICATIONS);
    assert.deepEqual(compatibility.serverRequestMethods, EXPECTED_SERVER_REQUESTS);
    assert.deepEqual(compatibility.clientNotificationMethods, readQuotedArray(source, 'CLIENT_NOTIFICATION_METHODS'));
    assert.deepEqual(compatibility.clientMethods, readQuotedArray(source, 'CLIENT_METHODS'));
    assert.deepEqual(compatibility.serverNotificationMethods, readQuotedArray(source, 'SERVER_NOTIFICATION_METHODS'));
    assert.deepEqual(compatibility.serverRequestMethods, readQuotedArray(source, 'SERVER_REQUEST_METHODS'));
    const typeFiles = generatedTypeFiles().map(path => ({
        path: path.slice(join(generatedRoot, 'types').length + 1).replaceAll('\\', '/'),
        sha256: sha256(path)
    }));
    const typesSha256 = createHash('sha256').update(typeFiles.map(file => `${file.path}:${file.sha256}\n`).join('')).digest('hex');
    assert.equal(compatibility.schemaSha256, sha256(schemaPath));
    assert.equal(compatibility.typeFileCount, typeFiles.length);
    assert.equal(compatibility.typesSha256, typesSha256);
    assert.ok(schema.$schema, 'schema must be valid JSON Schema');
});

test('generated protocol discriminators independently contain only the reviewed surface', () => {
    const generated = {
        clientRequest: generatedMethods('ClientRequest'),
        clientNotification: generatedMethods('ClientNotification'),
        serverNotification: generatedMethods('ServerNotification'),
        serverRequest: generatedMethods('ServerRequest')
    };
    assertReviewedSubset(EXPECTED_CLIENT_METHODS, generated.clientRequest, 'ClientRequest');
    assertReviewedSubset(EXPECTED_CLIENT_NOTIFICATIONS, generated.clientNotification, 'ClientNotification');
    assertReviewedSubset(EXPECTED_SERVER_NOTIFICATIONS, generated.serverNotification, 'ServerNotification');
    assertReviewedSubset(EXPECTED_SERVER_REQUESTS, generated.serverRequest, 'ServerRequest');
    assert.deepEqual(EXPECTED_SERVER_REQUESTS, ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval']);
    for (const unsafe of ['config/read', 'config/value/write', 'process/outputDelta', 'thread/realtime/started', 'item/mcpToolCall/progress']) {
        assert.ok(!EXPECTED_CLIENT_METHODS.includes(unsafe));
        assert.ok(!EXPECTED_SERVER_NOTIFICATIONS.includes(unsafe));
        assert.ok(!EXPECTED_SERVER_REQUESTS.includes(unsafe));
    }
    const methods = schemaMethods(readJson(schemaPath));
    for (const method of [...EXPECTED_CLIENT_METHODS, ...EXPECTED_CLIENT_NOTIFICATIONS, ...EXPECTED_SERVER_NOTIFICATIONS, ...EXPECTED_SERVER_REQUESTS]) {
        assert.ok(methods.has(method), `schema discriminator must contain ${method}`);
    }
    for (const unsafe of ['process/outputDelta', 'thread/realtime/started', 'item/mcpToolCall/progress']) {
        assert.ok(!EXPECTED_SERVER_NOTIFICATIONS.includes(unsafe), `${unsafe} must remain excluded from review`);
    }
});

test('generated LoginAccountParams supports ephemeral api-key login', () => {
    const login = readFileSync(join(generatedRoot, 'types', 'v2', 'LoginAccountParams.ts'), 'utf8');
    assert.match(login, /\{ "type": "apiKey", apiKey: string, \}/);
});

test('classifies unknown notifications as diagnosable and nonfatal', () => {
    const source = readMethods();
    assert.match(source, /classifyServerNotification\(method: string\).*?kind: 'unknown'.*?fatal: false/s);
});

test('rejects unknown server requests and accepts only reviewed approval families', () => {
    const source = readMethods();
    const requests = readQuotedArray(source, 'SERVER_REQUEST_METHODS');
    assert.equal(requests.length, 2);
    assert.ok(requests.every((method) => /approval/i.test(method)));
    assert.match(source, /classifyServerRequest\(method: string\).*?kind: 'unsupported'/s);
});

test('ordinary fixture validation does not discover or execute Codex', () => {
    const poisonDirectory = mkdtempSync(join(tmpdir(), 'ride-codex-poison-'));
    const poisonCodex = join(poisonDirectory, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    const marker = join(poisonDirectory, 'executed');
    writeFileSync(poisonCodex, process.platform === 'win32' ? `@echo off\r\n> "${marker}" echo executed\r\nexit /b 1\r\n` : `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    makeExecutable(poisonCodex);
    const env = { ...process.env, PATH: `${poisonDirectory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
    const result = spawnSync(process.execPath, [generator, '--check', '--version', '0.144.0'], { cwd: appRoot, encoding: 'utf8', env });
    const wasExecuted = existsSync(marker);
    rmSync(poisonDirectory, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!wasExecuted, 'ordinary fixture validation must not execute Codex');
});

test('a fake Codex version mismatch reaches executable verification', () => {
    const temporary = mkdtempSync(join(tmpdir(), 'ride-codex-version-'));
    const marker = join(temporary, 'verified');
    const executable = join(temporary, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    writeFileSync(executable, process.platform === 'win32'
        ? `@echo off\r\n> "${marker}" echo verified\r\necho codex-cli 0.143.0\r\n`
        : `#!/bin/sh\ntouch '${marker}'\necho 'codex-cli 0.143.0'\n`);
    makeExecutable(executable);
    try {
        const result = spawnSync(process.execPath, [generator, '--check', '--codex', executable, '--version', '0.144.0'], { cwd: appRoot, encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.ok(existsSync(marker), 'the fake executable must be invoked for version verification');
        assert.match(result.stderr, /expected codex-cli 0\.144\.0/i);
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('compiled allowlists expose exact immutable reviewed classifiers', async () => {
    const imported = await importCompiledMethods();
    const methods = imported.default ?? imported;
    assert.ok(Object.isFrozen(methods.INITIALIZE_CAPABILITIES));
    assert.ok(Object.isFrozen(methods.CLIENT_METHODS));
    assert.ok(Object.isFrozen(methods.CLIENT_NOTIFICATION_METHODS));
    assert.ok(Object.isFrozen(methods.SERVER_NOTIFICATION_METHODS));
    assert.ok(Object.isFrozen(methods.SERVER_REQUEST_METHODS));
    assert.deepEqual(methods.INITIALIZE_CAPABILITIES, { experimentalApi: false, requestAttestation: false });
    assert.deepEqual(methods.CLIENT_METHODS, EXPECTED_CLIENT_METHODS);
    assert.deepEqual(methods.CLIENT_NOTIFICATION_METHODS, EXPECTED_CLIENT_NOTIFICATIONS);
    assert.deepEqual(methods.SERVER_NOTIFICATION_METHODS, EXPECTED_SERVER_NOTIFICATIONS);
    assert.deepEqual(methods.SERVER_REQUEST_METHODS, EXPECTED_SERVER_REQUESTS);
    for (const method of EXPECTED_SERVER_NOTIFICATIONS) assert.deepEqual(methods.classifyServerNotification(method), { kind: 'reviewed', fatal: false });
    assert.deepEqual(methods.classifyServerNotification('process/outputDelta'), { kind: 'unknown', fatal: false });
    for (const method of EXPECTED_SERVER_REQUESTS) assert.deepEqual(methods.classifyServerRequest(method), { kind: 'approved' });
    assert.deepEqual(methods.classifyServerRequest('item/tool/requestUserInput'), { kind: 'unsupported' });
});

test('write without an explicit Codex executable is rejected', () => {
    const result = spawnSync(process.execPath, [generator, '--write', '--version', '0.144.0'], { cwd: appRoot, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--write requires explicit --codex/i);
});

test('normalization rejects malformed partial generator output through the production helper', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'ride-codex-normalize-'));
    const source = join(temporary, 'source');
    const destination = join(temporary, 'destination');
    mkdirSync(join(source, 'types'), { recursive: true });
    writeFileSync(join(source, 'types', 'partial.ts'), 'export type Partial = never;\n');
    const generatorModule = await import(`${pathToFileURL(generator).href}?normalize=${Date.now()}`);
    try {
        assert.equal(typeof generatorModule.normalizeGenerated, 'function');
        assert.throws(() => generatorModule.normalizeGenerated(source, destination), /partial or malformed/i);
        assert.ok(!existsSync(join(destination, 'schema.json')));
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('immutable publication creates a missing target and preserves an identical target', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'ride-codex-publish-'));
    const source = join(temporary, 'source');
    const target = join(temporary, 'target');
    mkdirSync(join(source, 'types'), { recursive: true });
    writeFileSync(join(source, 'schema.json'), '{\n  "fixture": "reviewed"\n}\n');
    writeFileSync(join(source, 'types', 'index.ts'), 'reviewed\n');
    const generatorModule = await import(`${pathToFileURL(generator).href}?publish=${Date.now()}`);
    try {
        assert.equal(generatorModule.publishImmutableFixture(source, target), 'published');
        assert.equal(readFileSync(join(target, 'types', 'index.ts'), 'utf8'), 'reviewed\n');
        const targetFile = join(target, 'types', 'index.ts');
        const before = statSync(targetFile, { bigint: true });
        assert.equal(generatorModule.publishImmutableFixture(source, target), 'unchanged');
        const after = statSync(targetFile, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.mtimeNs, before.mtimeNs);
        assert.ok(!readdirSync(temporary).some(name => name.includes('.stage-')));
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
});

test('immutable publication fails closed on an existing different target', async () => {
    const temporary = mkdtempSync(join(tmpdir(), 'ride-codex-publish-'));
    const source = join(temporary, 'source');
    const target = join(temporary, 'target');
    for (const root of [source, target]) {
        mkdirSync(join(root, 'types'), { recursive: true });
        writeFileSync(join(root, 'schema.json'), '{\n  "fixture": "reviewed"\n}\n');
        writeFileSync(join(root, 'types', 'index.ts'), 'reviewed\n');
    }
    const generatorModule = await import(`${pathToFileURL(generator).href}?drift=${Date.now()}`);
    try {
        const targetFile = join(target, 'types', 'index.ts');
        writeFileSync(join(source, 'types', 'index.ts'), 'different\n');
        assert.throws(() => generatorModule.publishImmutableFixture(source, target), /separate protocol-review change\/version is required/i);
        assert.equal(readFileSync(targetFile, 'utf8'), 'reviewed\n');
        assert.ok(!readdirSync(temporary).some(name => name.includes('stage')));
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
});
