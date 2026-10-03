import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import test from 'node:test';

const appRequire = createRequire(new URL('../../app/package.json', import.meta.url));
const browserRequire = createRequire(new URL('../../app/applications/browser/package.json', import.meta.url));
const decompress = appRequire('decompress');
const tar = browserRequire('tar');
const tarStream = appRequire('tar-stream');
const AdmZip = appRequire('adm-zip');

async function archive(entries) {
  const pack = tarStream.pack();
  for (const [header, data = 'fixture'] of entries) {
    await new Promise((resolve, reject) => pack.entry({ mode: 0o644, ...header }, data, error => error ? reject(error) : resolve()));
  }
  pack.finalize();
  const chunks = [];
  for await (const chunk of pack) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function fixture(action) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rbox-ride-archive-test-'));
  const output = path.join(root, 'output');
  const sentinel = path.join(root, 'sentinel.txt');
  await fs.mkdir(output); await fs.writeFile(sentinel, 'unchanged');
  try { await action({ root, output, sentinel }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('maintained decompressor preserves ordinary archive extraction API', () => fixture(async ({ output }) => {
  const bytes = await archive([[{ name: 'extension/package.json' }, '{"name":"fixture"}']]);
  await decompress(bytes, output);
  assert.equal(await fs.readFile(path.join(output, 'extension/package.json'), 'utf8'), '{"name":"fixture"}');
}));

test('maintained decompressor still installs ordinary ZIP/VSIX plugin payloads', () => fixture(async ({ output }) => {
  const zip = new AdmZip(); zip.addFile('extension/package.json', Buffer.from('{"name":"zip-fixture"}'));
  await decompress(zip.toBuffer(), output);
  assert.equal(await fs.readFile(path.join(output, 'extension/package.json'), 'utf8'), '{"name":"zip-fixture"}');
}));

for (const type of ['link', 'symlink']) {
  test(`decompress rejects an archive ${type} to a fixture outside its output`, () => fixture(async ({ output, sentinel }) => {
    const bytes = await archive([[{ name: 'linked-sentinel', type, linkname: sentinel }, '']]);
    await assert.rejects(decompress(bytes, output));
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
    assert.equal(await fs.stat(path.join(output, 'linked-sentinel')).then(() => true, () => false), false);
  }));
}

test('decompress rejects parent traversal and never writes the sibling fixture', () => fixture(async ({ root, output }) => {
  const bytes = await archive([[{ name: '../escaped.txt' }, 'escape']]);
  await assert.rejects(decompress(bytes, output));
  assert.equal(await fs.stat(path.join(root, 'escaped.txt')).then(() => true, () => false), false);
}));

test('decompress refuses writes through an existing directory junction/symlink', () => fixture(async ({ root, output, sentinel }) => {
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(output, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  const bytes = await archive([[{ name: 'nested/escaped.txt' }, 'escape']]);
  await assert.rejects(decompress(bytes, output));
  assert.equal(await fs.stat(path.join(outside, 'escaped.txt')).then(() => true, () => false), false);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
}));

test('tar ordinary extraction works and parent paths cannot escape', () => fixture(async ({ root, output }) => {
  await pipeline(Readable.from(await archive([[{ name: 'ordinary.txt' }, 'ordinary']])), tar.x({ cwd: output, strict: true }));
  assert.equal(await fs.readFile(path.join(output, 'ordinary.txt'), 'utf8'), 'ordinary');
  await assert.rejects(pipeline(Readable.from(await archive([[{ name: '../escaped.txt' }, 'escape']])), tar.x({ cwd: output, strict: true })));
  assert.equal(await fs.stat(path.join(root, 'escaped.txt')).then(() => true, () => false), false);
}));

test('tar rejects archive links that escape its extraction root', () => fixture(async ({ output, sentinel }) => {
  const bytes = await archive([[{ name: 'linked-sentinel', type: 'link', linkname: sentinel }, '']]);
  await assert.rejects(pipeline(Readable.from(bytes), tar.x({ cwd: output, strict: true })));
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  assert.equal(await fs.stat(path.join(output, 'linked-sentinel')).then(() => true, () => false), false);
}));

test('tar refuses writes through an existing directory junction/symlink', () => fixture(async ({ root, output }) => {
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(output, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(pipeline(Readable.from(await archive([[{ name: 'nested/escaped.txt' }, 'escape']])), tar.x({ cwd: output, strict: true })));
  assert.equal(await fs.stat(path.join(outside, 'escaped.txt')).then(() => true, () => false), false);
}));
