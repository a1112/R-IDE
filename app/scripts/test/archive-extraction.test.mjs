import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const APP = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
// A compact isolated dependency installation can exercise the identical package
// without installing the full IDE. Normal CI uses the application installation.
const require = createRequire(path.join(process.env.RIDE_ARCHIVE_TEST_ROOT || APP, 'package.json'));
const decompress = require('decompress');
const fixtures = JSON.parse(await fs.readFile(new URL('./fixtures/archive-extraction.json', import.meta.url), 'utf8'));
const metadata = '{"publisher":"ride","name":"sample","version":"1.0.0"}';
const entries = [
    { path: 'extension/package.json', data: metadata },
    { path: 'extension/bin/tool', data: '#!/bin/sh\nexit 0\n', mode: 0o755 }
];

// Fixture writer only: extraction always runs through the installed adapter.
function tarArchive(records) {
    const blocks = [];
    for (const record of records) {
        const data = Buffer.from(record.data || '');
        const header = Buffer.alloc(512);
        const octal = (value, offset, size) => header.write(value.toString(8).padStart(size - 1, '0') + '\0', offset, size);
        assert.ok(Buffer.byteLength(record.path) < 100, 'test path fits a USTAR header');
        header.write(record.path, 0, 100);
        octal(record.mode ?? 0o644, 100, 8);
        octal(0, 108, 8);
        octal(0, 116, 8);
        octal(data.length, 124, 12);
        octal(1704067200, 136, 12);
        header.fill(32, 148, 156);
        header.write(record.type || '0', 156, 1);
        if (record.linkname) header.write(record.linkname, 157, 100);
        header.write('ustar\0', 257, 6);
        header.write('00', 263, 2);
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
        blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
    }
    return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

async function temporary(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ride-extract-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    return root;
}

const formats = {
    tar: tarArchive(entries),
    tgz: gzipSync(tarArchive(entries)),
    zip: Buffer.from(fixtures.zip, 'base64'),
    tbz2: Buffer.from(fixtures.tbz2, 'base64')
};

test('CommonJS callers receive a callable adapter and asynchronous rejections', async () => {
    assert.equal(typeof decompress, 'function');
    assert.equal(require('decompress/package.json').name, '@r-ide/decompress-compat');
    assert.equal(require('decompress/package.json').dependencies['@xhmikosr/decompress'], '11.1.4');
    const promise = decompress(42);
    assert.ok(promise instanceof Promise);
    await assert.rejects(promise, { name: 'TypeError', message: 'Input file required' });
    const sentinel = new Error('plugin failure');
    await assert.rejects(decompress(Buffer.alloc(0), { plugins: [() => Promise.reject(sentinel)] }), error => error === sentinel);
    await assert.rejects(decompress(Buffer.alloc(0), { plugins: [() => { throw sentinel; }] }), error => error === sentinel);
});

test('dynamic import failures reject the returned Promise', async t => {
    const root = await temporary(t);
    const copy = path.join(root, 'adapter.cjs');
    await fs.copyFile(require.resolve('decompress'), copy);
    const withoutDependencies = require(copy);
    const result = withoutDependencies(Buffer.alloc(0));
    assert.ok(result instanceof Promise);
    await assert.rejects(result, { code: 'ERR_MODULE_NOT_FOUND' });
});

for (const [format, archive] of Object.entries(formats)) {
    test(`${format}: Buffer and filename inputs preserve Theia entry metadata and extraction`, async t => {
        const root = await temporary(t);
        const input = path.join(root, `input.${format}`);
        await fs.writeFile(input, archive);
        const listed = await decompress(archive);
        assert.deepEqual(listed.map(entry => entry.path), entries.map(entry => entry.path));
        for (const entry of listed) {
            assert.ok(Buffer.isBuffer(entry.data));
            assert.ok(entry.mtime instanceof Date);
            assert.equal(typeof entry.mode, 'number');
            assert.equal(entry.type, 'file');
        }
        // This is the filter-only overload used to inspect VSIX identities.
        const inspected = await decompress(input, { filter: entry => entry.path === 'extension/package.json' });
        assert.equal(inspected.length, 1);
        assert.equal(inspected[0].data.toString(), metadata);
        assert.deepEqual(await fs.readdir(root), [`input.${format}`]);
        const output = path.join(root, 'out');
        const extracted = await decompress(input, output);
        assert.deepEqual(extracted.map(entry => entry.path), listed.map(entry => entry.path));
        assert.equal(await fs.readFile(path.join(output, 'extension/package.json'), 'utf8'), metadata);
        if (process.platform !== 'win32') {
            assert.equal((await fs.stat(path.join(output, 'extension/bin/tool'))).mode & 0o777, 0o755 & ~process.umask());
        }
    });
}

test('strip, filter, map, empty plugins, and concurrent calls retain the Promise API', async t => {
    const root = await temporary(t);
    const [mapped, empty] = await Promise.all([
        decompress(formats.tar, root, {
            strip: 1,
            filter: entry => entry.path === 'package.json',
            map: entry => ({ ...entry, path: 'renamed.json' })
        }),
        decompress(formats.tar, { plugins: [] })
    ]);
    assert.deepEqual(mapped.map(entry => entry.path), ['renamed.json']);
    assert.equal(await fs.readFile(path.join(root, 'renamed.json'), 'utf8'), metadata);
    assert.deepEqual(empty, []);
});

for (const [format, pluginName] of Object.entries({ tar: 'decompress-tar', tgz: 'decompress-targz', zip: 'decompress-unzip' })) {
    test(`Theia remote's legacy ${format} plugin works through the maintained extractor`, async t => {
        const root = await temporary(t);
        const plugin = require(pluginName)();
        const extracted = await decompress(formats[format], root, { plugins: [plugin] });
        assert.deepEqual(extracted.map(entry => entry.path), entries.map(entry => entry.path));
        assert.equal(await fs.readFile(path.join(root, 'extension/package.json'), 'utf8'), metadata);
    });
}

test('parent traversal cannot write outside the extraction directory', async t => {
    const root = await temporary(t);
    const output = path.join(root, 'out');
    await assert.rejects(decompress(tarArchive([{ path: '../escaped', data: 'unsafe' }]), output), /Refusing|Invalid|invalid|outside/);
    await assert.rejects(fs.stat(path.join(root, 'escaped')), { code: 'ENOENT' });
});

test('absolute archive paths cannot overwrite an outside file', async t => {
    const root = await temporary(t);
    const outside = path.join(root, 'sentinel');
    await fs.writeFile(outside, 'original');
    // Parsers may reject or root-normalize absolute names. Neither may escape.
    try {
        await decompress(tarArchive([{ path: outside, data: 'unsafe' }]), path.join(root, 'out'));
    } catch (error) {
        assert.match(error.message, /Refusing|Invalid|invalid|absolute|outside/);
    }
    assert.equal(await fs.readFile(outside, 'utf8'), 'original');
});

test('duplicate destinations are rejected before any extraction', async t => {
    const root = await temporary(t);
    await assert.rejects(decompress(tarArchive([
        { path: 'same', data: 'first' }, { path: 'same', data: 'second' }
    ]), root), /duplicate entry path/);
    assert.deepEqual(await fs.readdir(root), []);
});

test('legitimate hardlinks and internal symlinks keep their targets', { skip: process.platform === 'win32' }, async t => {
    const root = await temporary(t);
    await decompress(tarArchive([
        { path: 'target', data: 'safe' },
        { path: 'soft', type: '2', linkname: 'target' },
        { path: 'hard', type: '1', linkname: 'target' }
    ]), root);
    assert.equal(await fs.readFile(path.join(root, 'soft'), 'utf8'), 'safe');
    assert.equal(await fs.readFile(path.join(root, 'hard'), 'utf8'), 'safe');
});

test('sibling-prefix paths and pre-existing symlinks cannot redirect writes', { skip: process.platform === 'win32' }, async t => {
    const root = await temporary(t);
    const output = path.join(root, 'out');
    const sibling = path.join(root, 'out-sibling');
    await fs.mkdir(output);
    await fs.mkdir(sibling);
    await fs.writeFile(path.join(sibling, 'sentinel'), 'original');
    await fs.symlink(sibling, path.join(output, 'redirect'));
    await assert.rejects(decompress(tarArchive([{ path: 'redirect/sentinel', data: 'unsafe' }]), output), /Refusing/);
    await fs.symlink(path.join(sibling, 'sentinel'), path.join(output, 'direct'));
    await assert.rejects(decompress(tarArchive([{ path: 'direct', data: 'unsafe' }]), output), /symlink/);
    assert.equal(await fs.readFile(path.join(sibling, 'sentinel'), 'utf8'), 'original');
});

for (const legacyPlugin of [false, true]) {
    test(`GHSA-hrh2-vp3x-79xf: reject a symlink chain before a later write (${legacyPlugin ? 'legacy tar plugin' : 'default plugins'})`, { skip: process.platform === 'win32' }, async t => {
        const root = await temporary(t);
        const output = path.join(root, 'out');
        await fs.writeFile(path.join(root, 'secret.txt'), 'original');
        const options = legacyPlugin ? { plugins: [require('decompress-tar')()] } : undefined;
        // Lexically a/../secret.txt is inside out; a -> . makes the OS resolve
        // it to root/secret.txt. See the upstream advisory's symlink-chain PoC.
        await assert.rejects(decompress(tarArchive([
            { path: 'a', type: '2', linkname: '.' },
            { path: 'b', type: '2', linkname: 'a/../secret.txt' }
        ]), output, options), /Refusing/);
        await assert.rejects(fs.lstat(path.join(output, 'b')), { code: 'ENOENT' });
        // A second archive must not follow a dangerous link left by the first.
        await decompress(tarArchive([{ path: 'b', data: 'inside only' }]), output, options);
        assert.equal(await fs.readFile(path.join(root, 'secret.txt'), 'utf8'), 'original');
        assert.equal(await fs.readFile(path.join(output, 'b'), 'utf8'), 'inside only');
    });
}

test('link targets cannot point outside or relocate an escaping symlink inode', { skip: process.platform === 'win32' }, async t => {
    const root = await temporary(t);
    const output = path.join(root, 'out');
    await fs.writeFile(path.join(root, 'secret'), 'original');
    for (const type of ['1', '2']) {
        await assert.rejects(decompress(tarArchive([{ path: `outside-${type}`, type, linkname: '../secret' }]), output), /Refusing/);
    }
    await assert.rejects(decompress(tarArchive([
        { path: 'target', data: 'safe' },
        { path: 'dir/soft', type: '2', linkname: '../target' },
        { path: 'relocated', type: '1', linkname: 'dir/soft' }
    ]), output), /hardlink to a symlink/);
    assert.equal(await fs.readFile(path.join(root, 'secret'), 'utf8'), 'original');
});

test('an entry following an escaping directory symlink cannot write outside', { skip: process.platform === 'win32' }, async t => {
    const root = await temporary(t);
    const output = path.join(root, 'out');
    await fs.writeFile(path.join(root, 'sentinel'), 'original');
    await assert.rejects(decompress(tarArchive([
        { path: 'a', type: '2', linkname: '.' },
        { path: 'b', type: '2', linkname: 'a/..' },
        { path: 'b/sentinel', data: 'unsafe' }
    ]), output));
    assert.equal(await fs.readFile(path.join(root, 'sentinel'), 'utf8'), 'original');
});

for (const legacyPlugin of [false, true]) {
    test(`malicious VSIX/ZIP paths and symlink chains are blocked (${legacyPlugin ? 'legacy unzip plugin' : 'default plugins'})`, { skip: process.platform === 'win32' }, async t => {
        const root = await temporary(t);
        const output = path.join(root, 'out');
        const options = legacyPlugin ? { plugins: [require('decompress-unzip')()] } : undefined;
        await assert.rejects(decompress(Buffer.from(fixtures.zipTraversal, 'base64'), output, options), /invalid relative path|Refusing/);
        await assert.rejects(fs.stat(path.join(root, 'escaped')), { code: 'ENOENT' });
        await fs.writeFile(path.join(root, 'secret.txt'), 'original');
        await assert.rejects(decompress(Buffer.from(fixtures.zipSymlinkChain, 'base64'), output, options), /Refusing/);
        await assert.rejects(fs.lstat(path.join(output, 'b')), { code: 'ENOENT' });
        assert.equal(await fs.readFile(path.join(root, 'secret.txt'), 'utf8'), 'original');
    });
}

test('archive mode bits cannot create setuid or setgid executables', { skip: process.platform === 'win32' }, async t => {
    const root = await temporary(t);
    await decompress(tarArchive([{ path: 'tool', data: '#!/bin/sh\n', mode: 0o6755 }]), root);
    assert.equal((await fs.stat(path.join(root, 'tool'))).mode & 0o7777, 0o755 & ~process.umask());
});
