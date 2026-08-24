import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const appRoot = resolve(import.meta.dirname, '..', '..');
const generator = join(appRoot, 'scripts', 'generate-codex-app-server-schema.mjs');
const generatedRoot = join(appRoot, 'theia-extensions', 'codex', 'src', 'common', 'generated', 'app-server', '0.144.0');
const schemaPath = join(generatedRoot, 'schema.json');
const compatibilityPath = join(appRoot, 'theia-extensions', 'codex', 'src', 'common', 'codex-app-server-compatibility.json');
const methodsPath = join(appRoot, 'theia-extensions', 'codex', 'src', 'common', 'ride-codex-methods.ts');

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function readMethods() {
    return readFileSync(methodsPath, 'utf8');
}

function readQuotedArray(source, name) {
    const match = source.match(new RegExp(`export const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\] as const;?\\)`));
    assert.ok(match, `${name} must be an immutable const array`);
    return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
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
    assert.deepEqual(compatibility.clientNotificationMethods, readQuotedArray(source, 'CLIENT_NOTIFICATION_METHODS'));
    assert.deepEqual(compatibility.clientMethods, readQuotedArray(source, 'CLIENT_METHODS'));
    assert.deepEqual(compatibility.serverNotificationMethods, readQuotedArray(source, 'SERVER_NOTIFICATION_METHODS'));
    assert.deepEqual(compatibility.serverRequestMethods, readQuotedArray(source, 'SERVER_REQUEST_METHODS'));
    assert.equal(compatibility.schemaSha256.length, 64);
    assert.ok(schema.$schema, 'schema must be valid JSON Schema');
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
    const env = { ...process.env, PATH: `${poisonDirectory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
    const result = spawnSync(process.execPath, [generator, '--check', '--version', '0.144.0'], { cwd: appRoot, encoding: 'utf8', env });
    const wasExecuted = existsSync(marker);
    rmSync(poisonDirectory, { recursive: true, force: true });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!wasExecuted, 'ordinary fixture validation must not execute Codex');
});

test('write and check reject mismatched Codex versions without generating fixtures', () => {
    for (const mode of ['--write', '--check']) {
        const result = spawnSync(process.execPath, [generator, mode, '--codex', process.execPath, '--version', '0.144.1'], { cwd: appRoot, encoding: 'utf8' });
        assert.notEqual(result.status, 0);
        assert.match(`${result.stdout}\n${result.stderr}`, /version/i);
    }
});
