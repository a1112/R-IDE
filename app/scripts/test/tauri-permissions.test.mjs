// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tauriDirectory = path.join(appDirectory, 'applications', 'tauri', 'src-tauri');
const productDirectory = path.join(appDirectory, 'theia-extensions', 'product', 'src', 'browser');
const require = createRequire(import.meta.url);
const {
  assertRequiredRegularFiles,
  assertSymlinkFreeTree,
  canonicalDigest,
  copyRegularTree,
  publishDirectoryAtomic,
  rewriteDesktopHtml,
  validatePackagedProfileAssets,
} = require('../../applications/tauri/copy-build-tree.js');

function invokedCommands(source) {
  const invokeNames = new Set(['invoke']);
  const coreImportPattern = /import\s*{([^}]*)}\s*from\s*['"]@tauri-apps\/api\/core['"]/g;
  for (const match of source.matchAll(coreImportPattern)) {
    for (const specifier of match[1].split(',')) {
      const invokeImport = /^\s*invoke(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*$/.exec(specifier);
      if (invokeImport) {
        invokeNames.add(invokeImport[1] ?? 'invoke');
      }
    }
  }

  const commands = [];
  for (const invokeName of invokeNames) {
    const escapedName = invokeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const callPattern = new RegExp(
      `(?<![\\w$])${escapedName}(?:<[^>]+>)?\\s*\\(\\s*['"]([^'"]+)['"]`,
      'g'
    );
    commands.push(...[...source.matchAll(callPattern)].map(match => match[1]));
  }
  return commands;
}

function auditedCommands(sources, expectedCommands) {
  const commands = [...new Set(sources.flatMap(invokedCommands))].sort();
  const expected = new Set(expectedCommands);
  const unauthorized = commands.filter(command => !expected.has(command));
  if (unauthorized.length > 0) {
    throw new Error(`Unaudited Tauri commands: ${unauthorized.join(', ')}`);
  }
  assert.deepEqual(commands, expectedCommands);
  return commands;
}

async function sourceFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...await sourceFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      result.push(entryPath);
    }
  }
  return result;
}

function parseCommandPermissions(source) {
  const result = new Map();
  for (const match of source.matchAll(/\[\[permission\]\]([\s\S]*?)(?=\[\[permission\]\]|$)/g)) {
    const block = match[1];
    const identifier = /\bidentifier\s*=\s*"([^"]+)"/.exec(block)?.[1];
    const allow = /\bcommands\.allow\s*=\s*\[([^\]]*)\]/.exec(block)?.[1]
      .match(/"([^"]+)"/g)
      ?.map(value => value.slice(1, -1)) ?? [];
    if (identifier) {
      result.set(identifier, allow);
    }
  }
  return result;
}

test('remote Tauri frontend receives only audited per-command permissions', async () => {
  const frontendSources = await sourceFiles(productDirectory);
  const sources = await Promise.all(frontendSources.map(source => readFile(source, 'utf8')));
  const commands = auditedCommands(sources, [
    'ride_frontend_ready',
    'ride_performance_snapshot',
    'ride_plugin_directories',
    'ride_record_startup_milestone',
    'ride_show_main_menu',
    'ride_smoke_complete',
    'ride_smoke_plan',
    'ride_smoke_record_step',
    'ride_start_window_drag',
    'ride_window_control'
  ]);

  const permissionSource = await readFile(path.join(tauriDirectory, 'permissions', 'ride-frontend.toml'), 'utf8');
  const permissions = parseCommandPermissions(permissionSource);
  const expectedIdentifiers = commands.map(command => `allow-${command.replaceAll('_', '-')}`);

  assert.deepEqual([...permissions.keys()].sort(), expectedIdentifiers);
  for (const command of commands) {
    assert.deepEqual(permissions.get(`allow-${command.replaceAll('_', '-')}`), [command]);
  }

  const capability = JSON.parse(await readFile(path.join(tauriDirectory, 'capabilities', 'default.json'), 'utf8'));
  assert.deepEqual(capability.windows, ['main', 'theia-secondary-*']);
  assert.equal(capability.local, false);
  assert.deepEqual(capability.remote?.urls, ['http://127.0.0.1:3000']);
  assert.deepEqual(
    capability.permissions.filter(permission => !permission.startsWith('core:event:')).sort(),
    expectedIdentifiers
  );
  assert.deepEqual(
    capability.permissions.filter(permission => permission.startsWith('core:event:')).sort(),
    ['core:event:allow-listen', 'core:event:allow-unlisten']
  );
  assert.equal(capability.permissions.some(permission => /(?:^|:)default$|allow-all/.test(permission)), false);

  const frontendGenerator = await readFile(
    path.join(appDirectory, 'applications', 'tauri', 'copy-frontend.js'),
    'utf8'
  );
  const bootstrapMatch = /const tauriBootstrapScript = `([\s\S]*?)`;\r?\n/.exec(frontendGenerator);
  assert.ok(bootstrapMatch, 'expected the generated local bootstrap source');
  const localBootstrap = bootstrapMatch[1];
  assert.deepEqual(invokedCommands(localBootstrap), []);
  assert.equal(/\blisten\(\s*['"]/.test(localBootstrap), false);
});

test('rejects unauthorized literal commands invoked through an imported alias', () => {
  const aliasedInvokeFixture = `
    import { invoke as hiddenInvoke, isTauri } from '@tauri-apps/api/core';
    this.invoke('ride_frontend_ready');
    hiddenInvoke('ride_unauthorized');
  `;

  assert.throws(
    () => auditedCommands([aliasedInvokeFixture], ['ride_frontend_ready']),
    /ride_unauthorized/
  );
});

test('Tauri build copy recursively publishes profile chunks and omits source maps by default', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-tauri-copy-'));
  try {
    const source = path.join(fixture, 'source');
    const target = path.join(fixture, 'browser-frontend');
    fs.mkdirSync(path.join(source, 'chunks'), { recursive: true });
    for (const file of ['index.html', 'bundle.js', 'bundle.css', 'ride-tauri-profile.json']) {
      fs.writeFileSync(path.join(source, file), file);
    }
    fs.writeFileSync(path.join(source, 'chunks', 'secondary-window-feature-ABC123.js'), 'feature');
    fs.writeFileSync(path.join(source, 'chunks', 'secondary-window-feature-ABC123.js.map'), 'map');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'old-build.txt'), 'old');

    assertRequiredRegularFiles(source, ['index.html', 'bundle.js', 'bundle.css']);
    publishDirectoryAtomic(target, staging => copyRegularTree(source, staging));

    assert.equal(fs.readFileSync(path.join(target, 'ride-tauri-profile.json'), 'utf8'), 'ride-tauri-profile.json');
    assert.equal(fs.readFileSync(path.join(target, 'chunks', 'secondary-window-feature-ABC123.js'), 'utf8'), 'feature');
    assert.equal(fs.existsSync(path.join(target, 'chunks', 'secondary-window-feature-ABC123.js.map')), false);
    assert.equal(fs.existsSync(path.join(target, 'old-build.txt')), false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Tauri build copy preserves its previous target on failure and only opts into source maps explicitly', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-tauri-copy-'));
  try {
    const source = path.join(fixture, 'source');
    const target = path.join(fixture, 'target');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'bundle.js'), 'bundle');
    fs.writeFileSync(path.join(source, 'bundle.js.map'), 'map');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'known-good.txt'), 'good');

    assert.throws(
      () => publishDirectoryAtomic(target, staging => {
        copyRegularTree(source, staging, { includeSourceMaps: true });
        throw new Error('simulated copy failure');
      }),
      /simulated copy failure/,
    );
    assert.equal(fs.readFileSync(path.join(target, 'known-good.txt'), 'utf8'), 'good');

    publishDirectoryAtomic(target, staging => copyRegularTree(source, staging, { includeSourceMaps: true }));
    assert.equal(fs.readFileSync(path.join(target, 'bundle.js.map'), 'utf8'), 'map');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Tauri atomic publisher restores the previous target when installation rename fails', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-tauri-copy-'));
  try {
    const target = path.join(fixture, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'known-good.txt'), 'good');
    let renameCalls = 0;
    const renameSync = (source, destination) => {
      renameCalls++;
      if (renameCalls === 2) {
        const error = new Error('simulated install rename failure');
        error.code = 'EIO';
        throw error;
      }
      fs.renameSync(source, destination);
    };

    assert.throws(
      () => publishDirectoryAtomic(target, staging => {
        fs.writeFileSync(path.join(staging, 'new-build.txt'), 'new');
      }, { renameSync }),
      /simulated install rename failure/,
    );
    assert.equal(renameCalls, 3);
    assert.equal(fs.readFileSync(path.join(target, 'known-good.txt'), 'utf8'), 'good');
    assert.equal(fs.existsSync(path.join(target, 'new-build.txt')), false);
    assert.deepEqual(fs.readdirSync(fixture), ['target']);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Tauri atomic publisher reports successful installation when old-backup cleanup is delayed', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-tauri-copy-'));
  try {
    const target = path.join(fixture, 'target');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'old.txt'), 'old');
    const warnings = [];
    assert.doesNotThrow(() => publishDirectoryAtomic(target, staging => {
      fs.writeFileSync(path.join(staging, 'new.txt'), 'new');
    }, {
      rmSync() {
        const error = new Error('simulated locked backup');
        error.code = 'EIO';
        throw error;
      },
      onCleanupError(message) {
        warnings.push(message);
      },
    }));
    assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(target, 'old.txt')), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not remove old backup/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('desktop HTML rewrite preserves module scripts and rejects remaining inline scripts', () => {
  const source = `<!doctype html><html><head>
    <script>if (document.head) { document.head.dataset.favicon = 'unused'; }</script>
  </head><body><script type="module" src="./bundle.js" charset="utf-8"></script></body></html>`;
  const html = rewriteDesktopHtml(source);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /<script type="text\/javascript" src="\.\/ride-bootstrap\.js"/);
  assert.match(html, /<script type="module" src="\.\/bundle\.js" charset="utf-8"><\/script>/);
  assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc=)[^>]*>/);
  assert.throws(
    () => rewriteDesktopHtml('<html><head></head><body><script src="./bundle.js"></script><script>alert(1)</script></body></html>'),
    /inline script/,
  );
  assert.throws(
    () => rewriteDesktopHtml('<html><head></head><body><script src="./bundle.js"></script><script data-src="later.js"></script></body></html>'),
    /inline script/,
  );
  assert.throws(
    () => rewriteDesktopHtml('<html><head></head><body><script src="./bundle.js"></script><script>alert(1)</script ></body></html>'),
    /inline script/,
  );
  assert.throws(
    () => rewriteDesktopHtml('<html><head></head><body><script src="./bundle.js"></script><script>alert(1)</script\t\n bar></body></html>'),
    /inline script/,
  );
});

test('packaged profile validation rejects invalid identity, mismatch, and missing deferred chunks', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-tauri-profile-'));
  try {
    const frontend = path.join(fixture, 'frontend');
    const backend = path.join(fixture, 'backend');
    fs.mkdirSync(path.join(frontend, 'chunks'), { recursive: true });
    fs.mkdirSync(backend);
    const manifest = {
      schema: 'ride.tauri-profile',
      version: 1,
      commit: 'a'.repeat(40),
      buildId: 'build-1',
      profile: 'tauri-critical',
      sourceIdentity: { commit: 'a'.repeat(40), clean: true },
      roots: ['@theia/core'],
      extensions: ['@theia/core'],
      packages: [],
      featureGroups: {
        'secondary-window': {
          deferredFrontendModules: [{ entry: 'tauri-src/secondary-window-feature.ts' }],
        },
      },
    };
    manifest.digest = canonicalDigest({
      schema: 'ride.tauri-frontend-profile@2',
      profile: manifest.profile,
      roots: manifest.roots,
      extensions: manifest.extensions,
      packages: manifest.packages,
      featureGroups: manifest.featureGroups,
    });
    const writeManifests = (frontendManifest, backendManifest = frontendManifest) => {
      fs.writeFileSync(path.join(frontend, 'ride-tauri-profile.json'), JSON.stringify(frontendManifest));
      fs.writeFileSync(path.join(backend, 'ride-tauri-profile.json'), JSON.stringify(backendManifest));
    };
    fs.writeFileSync(path.join(frontend, 'chunks', 'secondary-window-feature-ABC123.js'), 'feature');
    writeManifests(manifest);
    assert.equal(validatePackagedProfileAssets(frontend, backend).chunks.length, 1);

    writeManifests({ ...manifest, digest: '' });
    assert.throws(() => validatePackagedProfileAssets(frontend, backend), /Invalid packaged profile identity/);

    writeManifests({ ...manifest, roots: ['@theia/tampered'] });
    assert.throws(() => validatePackagedProfileAssets(frontend, backend), /digest mismatch/);

    writeManifests(manifest, { ...manifest, buildId: 'build-2' });
    assert.throws(() => validatePackagedProfileAssets(frontend, backend), /identities do not match/);

    writeManifests(manifest);
    fs.rmSync(path.join(frontend, 'chunks', 'secondary-window-feature-ABC123.js'));
    assert.throws(() => validatePackagedProfileAssets(frontend, backend), /Missing packaged deferred feature chunk/);

    const emptyFeatures = { ...manifest, featureGroups: {} };
    emptyFeatures.digest = canonicalDigest({
      schema: 'ride.tauri-frontend-profile@2',
      profile: emptyFeatures.profile,
      roots: emptyFeatures.roots,
      extensions: emptyFeatures.extensions,
      packages: emptyFeatures.packages,
      featureGroups: emptyFeatures.featureGroups,
    });
    writeManifests(emptyFeatures);
    assert.throws(() => validatePackagedProfileAssets(frontend, backend), /does not contain a validated deferred feature/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('Tauri build copy rejects traversal requirements and source links or reparse points', () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-tauri-copy-'));
  try {
    const source = path.join(fixture, 'source');
    const external = path.join(fixture, 'external');
    const target = path.join(fixture, 'target');
    fs.mkdirSync(source);
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'payload.js'), 'payload');
    fs.symlinkSync(external, path.join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    assert.throws(() => assertRequiredRegularFiles(source, ['../external/payload.js']), /unsafe/);
    assert.throws(() => copyRegularTree(source, target), /symbolic link|reparse point/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('generated Tauri frontend resources are symlink-free and remain exactly scoped', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-tauri-resource-contract-'));
  try {
    const source = path.join(fixture, 'source');
    const generated = path.join(fixture, 'generated');
    const external = path.join(fixture, 'external');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'index.html'), '<!doctype html>');
    fs.writeFileSync(path.join(source, 'bundle.js'), 'bundle');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'payload.js'), 'external');

    copyRegularTree(source, generated);
    assert.doesNotThrow(() => assertSymlinkFreeTree(generated));
    fs.symlinkSync(external, path.join(generated, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => assertSymlinkFreeTree(generated), /symbolic link|reparse point/);

    const tauriConfig = JSON.parse(await readFile(path.join(tauriDirectory, 'tauri.conf.json'), 'utf8'));
    const generatedFrontendScopes = [
      tauriConfig.build?.frontendDist,
      ...Object.keys(tauriConfig.bundle?.resources ?? {})
        .filter(sourcePath => sourcePath.includes('frontend')),
    ].sort();
    assert.deepEqual(generatedFrontendScopes, ['../browser-frontend', '../tauri-frontend']);
    assert.equal(tauriConfig.bundle.resources['../browser-frontend'], 'lib/frontend');
    assert.equal(
      Object.keys(tauriConfig.bundle.resources)
        .some(sourcePath => ['*', '?', '[', ']'].some(marker => sourcePath.includes(marker))),
      false,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
