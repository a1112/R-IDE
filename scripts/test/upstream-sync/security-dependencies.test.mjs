import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  assert.ok(match, `expected a semantic version, got ${value}`);
  return match.slice(1).map(Number);
}

function atLeast(value, expected) {
  const actual = versionParts(value);
  const minimum = versionParts(expected);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function packageName(selector) {
  const match = /^("?)(@[^/]+\/[^@]+|[^@]+)@/u.exec(selector);
  return match?.[2];
}

function yarnVersions(lockText) {
  const lines = lockText.split(/\r?\n/u);
  const versions = new Map();
  let header;
  let block = [];
  const flush = () => {
    if (!header) return;
    const match = /^\s*version\s+["']([^"']+)["']/mu.exec(block.join('\n'));
    if (!match) return;
    for (const selector of header.slice(0, -1).split(/,\s*/u)) {
      const name = packageName(selector.replace(/^"|"$/gu, ''));
      if (!name) continue;
      if (!versions.has(name)) versions.set(name, new Set());
      versions.get(name).add(match[1]);
    }
  };
  for (const line of lines) {
    if (line && !/^\s/u.test(line) && line.endsWith(':')) {
      flush();
      header = line;
      block = [];
    } else if (header) {
      block.push(line);
    }
  }
  flush();
  return versions;
}

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

test('workspace manifests pin patched direct dependency versions', () => {
  const electron = readJson('app/applications/electron/package.json');
  const electronNext = readJson('app/applications/electron-next/package.json');
  const launcher = readJson('app/theia-extensions/launcher/package.json');
  const updater = readJson('app/theia-extensions/updater/package.json');
  const prototype = readJson('prototype/package.json');

  for (const manifest of [electron, electronNext]) {
    assert.equal(manifest.devDependencies.electron, '42.5.1');
    assert.equal(manifest.devDependencies['electron-builder'], '26.15.3');
    assert.equal(manifest.devDependencies['app-builder-lib'], '26.15.3');
    assert.equal(manifest.devDependencies['js-yaml'], '^3.15.1');
  }
  assert.equal(launcher.dependencies['body-parser'], '^1.20.6');
  assert.equal(updater.dependencies['builder-util-runtime'], '9.7.0');
  assert.equal(prototype.dependencies.vite, '6.4.3');
});

test('Yarn lock does not retain known vulnerable resolved versions', () => {
  const versions = yarnVersions(fs.readFileSync(path.join(ROOT, 'app/yarn.lock'), 'utf8'));
  const checks = {
    '@hono/node-server': value => atLeast(value, '2.0.5'),
    '@tootallnate/once': value => atLeast(value, '2.0.1'),
    'adm-zip': value => atLeast(value, '0.6.0'),
    'app-builder-lib': value => atLeast(value, '26.15.0'),
    axios: value => atLeast(value, '1.18.0'),
    'body-parser': value => versionParts(value)[0] >= 2 || atLeast(value, '1.20.6'),
    'brace-expansion': value => {
      const [major] = versionParts(value);
      return (major === 1 && atLeast(value, '1.1.18'))
        || (major === 2 && atLeast(value, '2.1.4'))
        || major >= 5 && atLeast(value, '5.0.9');
    },
    'builder-util-runtime': value => atLeast(value, '9.7.0'),
    'cross-spawn': value => atLeast(value, '6.0.6'),
    diff: value => versionParts(value)[0] === 4
      || versionParts(value)[0] === 5 && atLeast(value, '5.2.2')
      || versionParts(value)[0] >= 8,
    dompurify: value => atLeast(value, '3.4.13'),
    electron: value => {
      const [major] = versionParts(value);
      return (major === 39 && atLeast(value, '39.8.10'))
        || (major === 42 && atLeast(value, '42.5.1'))
        || major >= 43;
    },
    esbuild: value => versionParts(value)[0] !== 0 || atLeast(value, '0.25.0'),
    'fast-uri': value => versionParts(value)[0] >= 4 || atLeast(value, '3.1.5'),
    'form-data': value => atLeast(value, '4.0.6'),
    hono: value => atLeast(value, '4.12.34'),
    'ip-address': value => atLeast(value, '10.3.1'),
    'js-yaml': value => {
      const [major] = versionParts(value);
      return (major === 3 && atLeast(value, '3.15.1'))
        || (major === 4 && atLeast(value, '4.3.1'))
        || major >= 5;
    },
    'linkify-it': value => atLeast(value, '5.0.2'),
    mermaid: value => atLeast(value, '11.16.1'),
    minimatch: value => {
      const [major] = versionParts(value);
      return (major === 3 && atLeast(value, '3.1.4'))
        || (major === 5 && atLeast(value, '5.1.8'))
        || major >= 9;
    },
    nanoid: value => {
      const [major, minor] = versionParts(value);
      return major >= 4 || (major === 3 && minor === 1 && atLeast(value, '3.1.31'))
        || (major === 3 && minor >= 3 && atLeast(value, '3.3.17'));
    },
    nx: value => atLeast(value, '22.7.7'),
    postcss: value => atLeast(value, '8.5.23'),
    protobufjs: value => atLeast(value, '7.6.5'),
    'serialize-javascript': value => atLeast(value, '7.0.5'),
    'socket.io-parser': value => atLeast(value, '4.2.7'),
    tar: value => versionParts(value)[0] < 7 || atLeast(value, '7.5.21'),
    tmp: value => atLeast(value, '0.2.7'),
    undici: value => {
      const [major] = versionParts(value);
      return (major === 6 && atLeast(value, '6.28.0')) || major >= 7 && atLeast(value, '7.29.0');
    },
    ws: value => versionParts(value)[0] !== 8 || atLeast(value, '8.21.0'),
  };

  for (const [name, predicate] of Object.entries(checks)) {
    const resolved = [...(versions.get(name) ?? [])];
    assert.notEqual(resolved.length, 0, `${name} must be present in app/yarn.lock`);
    for (const version of resolved) {
      assert.equal(predicate(version), true, `${name}@${version} is still vulnerable`);
    }
  }
});

test('prototype lock uses patched Vite, PostCSS, and nanoid versions', () => {
  const lock = readJson('prototype/package-lock.json');
  const packages = lock.packages ?? {};
  assert.ok(atLeast(packages['node_modules/vite']?.version, '6.4.3'));
  assert.ok(atLeast(packages['node_modules/postcss']?.version, '8.5.23'));
  assert.ok(atLeast(packages['node_modules/nanoid']?.version, '3.3.17'));
});
