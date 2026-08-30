// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  parseTauriProfileArguments,
  verifyTauriProfileInventory,
} from '../verify-tauri-profile.mjs';
import { createProfileMetadataPlugin } from '../../applications/browser/tauri-src/esbuild-metadata.mjs';

const require = createRequire(import.meta.url);

test('repository Tauri profile declares the exact deferred Markdown preview descriptor', () => {
  const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const profile = JSON.parse(fs.readFileSync(path.join(appDirectory, 'applications', 'browser', 'tauri-profile.json'), 'utf8'));
  const preview = profile.featureGroups['preview-getting-started'];
  assert.deepEqual(preview.deferredFrontendModules, [{
    package: '@theia/preview',
    module: '@theia/preview/lib/browser/preview-frontend-module',
    proxy: 'tauri-src/preview-proxy-frontend-module.ts',
    entry: 'tauri-src/preview-markdown-feature.ts',
    action: 'markdown-preview',
  }]);
  assert.match(preview.deferBlockedReason, /markdown/i);
});

test('repository Tauri profile declares the exact deferred BrowserAutomation backend descriptor', () => {
  const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const profile = JSON.parse(fs.readFileSync(path.join(appDirectory, 'applications', 'browser', 'tauri-profile.json'), 'utf8'));
  assert.deepEqual(profile.featureGroups.ai.deferredBackendModules, [{
    package: '@theia/ai-ide',
    module: '@theia/ai-ide/lib/node/app-tester-agent/browser-automation-impl',
    proxy: 'tauri-src/backend/ai-ide-browser-automation-proxy.ts',
    entry: 'tauri-src/backend/ai-ide-browser-automation-feature.ts',
    output: 'lib/backend/ai-ide-browser-automation-feature.cjs',
    action: 'browser-automation',
  }]);
});

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digestContract(manifest) {
  return crypto.createHash('sha256').update(canonicalJson({
    schema: 'ride.tauri-frontend-profile@2',
    profile: manifest.profile,
    roots: manifest.roots,
    extensions: manifest.extensions,
    packages: manifest.packages,
    featureGroups: manifest.featureGroups,
  })).digest('hex');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function publishManifest(fixture) {
  fixture.manifest.digest = digestContract(fixture.manifest);
  writeJson(path.join(fixture.browserDirectory, 'lib', 'frontend', 'ride-tauri-profile.json'), fixture.manifest);
  for (const [name, record] of Object.entries(fixture.records)) {
    record.digest = fixture.manifest.digest;
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', `${name}.json`), record);
  }
}

function metadata(manifest, target, inputs, outputs) {
  const allInputs = [...new Set([
    ...inputs,
    ...outputs.flatMap(output => [output.entryPoint, ...(output.additionalInputs ?? [])]).filter(Boolean),
  ])];
  return {
    schema: 'ride.esbuild-metafile@1',
    profile: manifest.profile,
    buildId: manifest.buildId,
    digest: manifest.digest,
    target,
    outputHashes: {},
    metafile: {
      inputs: Object.fromEntries(allInputs.map(input => [input, { bytes: 1, imports: [] }])),
      outputs: Object.fromEntries(outputs.map(output => [
        output.path,
        {
          bytes: 1,
          inputs: Object.fromEntries(
            [output.entryPoint, ...(output.additionalInputs ?? [])]
              .filter(Boolean)
              .map(input => [input, { bytesInOutput: 1 }]),
          ),
          imports: [],
          exports: [],
          ...(output.entryPoint ? { entryPoint: output.entryPoint } : {}),
        },
      ])),
    },
  };
}

function createFixture(profile = 'tauri-critical') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-profile-inventory-'));
  const browserDirectory = path.join(root, 'applications', 'browser');
  const pluginsDirectory = path.join(root, 'plugins');
  fs.mkdirSync(path.join(pluginsDirectory, 'publisher.extension'), { recursive: true });
  const extensionRoots = ['@theia/core', '@theia/plugin-ext', '@theia/plugin-ext-vscode', '@theia/filesystem', 'theia-ide-product-ext'];
  const manifest = {
    schema: 'ride.tauri-profile',
    version: 1,
    commit: 'a'.repeat(40),
    sourceIdentity: { commit: 'a'.repeat(40), clean: true },
    buildId: 'build-1',
    profile,
    roots: profile === 'full' ? [...extensionRoots, 'fs-extra'] : extensionRoots,
    extensions: extensionRoots,
    packages: profile === 'full' ? [{
      requestName: 'fs-extra',
      packageName: 'fs-extra',
      version: '1.0.0',
      dependencyPath: ['fs-extra'],
    }] : [],
    featureGroups: {
      deferred: {
        deferredRoots: profile === 'tauri-critical' ? ['@theia/deferred-only'] : [],
        deferredFrontendModules: [{
          module: '@theia/secondary-window/lib/browser/secondary-window-frontend-module',
          entry: 'tauri-src/secondary-window-feature.ts',
        }],
      },
    },
  };
  manifest.digest = digestContract(manifest);
  for (const extension of manifest.extensions) {
    writeJson(path.join(root, 'node_modules', ...extension.split('/'), 'package.json'), {
      name: extension,
      version: '1.0.0',
      theiaExtensions: [{ frontend: 'lib/browser/frontend-module', backend: 'lib/node/backend-module' }],
    });
  }
  writeJson(path.join(browserDirectory, 'package.json'), {
    name: 'fixture-browser-app',
    dependencies: Object.fromEntries(manifest.roots.map(rootName => [rootName, '1.0.0'])),
  });
  const frontendVsCodeInitSource = path.join(root, 'node_modules', '@theia', 'plugin-ext-vscode', 'lib', 'node', 'context', 'plugin-vscode-init-fe.js');
  fs.mkdirSync(path.dirname(frontendVsCodeInitSource), { recursive: true });
  fs.writeFileSync(frontendVsCodeInitSource, 'init');
  writeJson(path.join(browserDirectory, 'lib', 'frontend', 'ride-tauri-profile.json'), manifest);
  fs.mkdirSync(path.join(browserDirectory, 'lib', 'frontend', 'context'), { recursive: true });
  fs.copyFileSync(frontendVsCodeInitSource, path.join(browserDirectory, 'lib', 'frontend', 'context', 'plugin-vscode-init-fe.js'));

  const frontendInputs = manifest.extensions.map(extension => `node_modules/${extension}/lib/browser/frontend-module.js`);
  const backendInputs = manifest.extensions.map(extension => `node_modules/${extension}/lib/node/backend-module.js`);
  const records = {
    'frontend-main': metadata(manifest, 'frontend-main', frontendInputs, [
      { path: 'lib/frontend/bundle.js', entryPoint: 'src-gen/frontend/index.js', additionalInputs: frontendInputs },
      {
        path: 'lib/frontend/chunks/secondary-window-feature-ABC123.js',
        entryPoint: 'tauri-src/secondary-window-feature.ts',
        additionalInputs: ['node_modules/@theia/secondary-window/lib/browser/secondary-window-frontend-module.js'],
      },
    ]),
    'frontend-secondary-window': metadata(manifest, 'frontend-secondary-window', ['node_modules/@theia/secondary-window/lib/browser/index.js'], [
      { path: 'lib/frontend/secondary-window.js', entryPoint: 'src-gen/frontend/secondary-index.js' },
    ]),
    'frontend-editor.worker': metadata(manifest, 'frontend-editor.worker', ['node_modules/@theia/monaco-editor-core/esm/vs/editor/common/services/editorWebWorkerMain.js'], [
      { path: 'lib/frontend/editor.worker.js', entryPoint: 'node_modules/@theia/monaco-editor-core/esm/vs/editor/common/services/editorWebWorkerMain.js' },
    ]),
    'frontend-plugin-worker': metadata(manifest, 'frontend-plugin-worker', ['node_modules/@theia/plugin-ext/lib/hosted/browser/worker/worker-main.js'], [
      { path: 'lib/frontend/plugin-worker.js', entryPoint: 'node_modules/@theia/plugin-ext/lib/hosted/browser/worker/worker-main.js' },
    ]),
    backend: metadata(manifest, 'backend', backendInputs, [
      { path: 'lib/backend/main.js', entryPoint: 'src-gen/backend/main.js', additionalInputs: backendInputs },
      { path: 'lib/backend/plugin-host.js', entryPoint: 'node_modules/@theia/plugin-ext/lib/hosted/node/plugin-host.js' },
      { path: 'lib/backend/backend-init-theia.js', entryPoint: 'node_modules/@theia/plugin-ext/lib/hosted/node/scanners/backend-init-theia.js' },
      { path: 'lib/backend/plugin-vscode-init.js', entryPoint: 'node_modules/@theia/plugin-ext-vscode/lib/node/plugin-vscode-init.js' },
      { path: 'lib/backend/parcel-watcher.js', entryPoint: 'node_modules/@theia/filesystem/lib/node/parcel-watcher/index.js' },
    ]),
  };
  for (const [name, record] of Object.entries(records)) {
    for (const output of Object.keys(record.metafile.outputs)) {
      const outputPath = path.join(browserDirectory, output);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, 'x');
      record.outputHashes[output] = crypto.createHash('sha256').update('x').digest('hex');
    }
    writeJson(path.join(browserDirectory, 'lib', 'metadata', `${name}.json`), record);
  }
  return { root, browserDirectory, pluginsDirectory, manifest, records };
}

test('smoke scenarios select the authoritative packaged profile', () => {
  const critical = createFixture('tauri-critical');
  const full = createFixture('full');
  try {
    assert.equal(verifyTauriProfileInventory({
      ...critical,
      expectedScenario: 'critical-empty',
    }).profile, 'tauri-critical');
    assert.equal(verifyTauriProfileInventory({
      ...full,
      expectedScenario: 'full-file',
    }).profile, 'full');
    assert.throws(() => verifyTauriProfileInventory({
      ...critical,
      expectedScenario: 'full-file',
    }), /expected profile full/i);
    assert.deepEqual(parseTauriProfileArguments([
      '--expected-smoke-scenario',
      'critical-file',
    ]), { expectedScenario: 'critical-file' });
    assert.throws(
      () => parseTauriProfileArguments(['--expected-smoke-scenario', 'unknown']),
      /unsupported.*scenario/i,
    );
  } finally {
    fs.rmSync(critical.root, { recursive: true, force: true });
    fs.rmSync(full.root, { recursive: true, force: true });
  }
});

test('verifies critical profile inventory, workers, plugin hosts, VS Code init, and deferred chunks', () => {
  const fixture = createFixture();
  try {
    const report = verifyTauriProfileInventory(fixture);
    assert.equal(report.profile, 'tauri-critical');
    assert.equal(report.digest, fixture.manifest.digest);
    assert.equal(report.pluginCount, 1);
    assert.deepEqual(report.deferredChunks, ['lib/frontend/chunks/secondary-window-feature-ABC123.js']);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('verifies an attested deferred backend feature and rejects main-graph leakage', () => {
  const fixture = createFixture();
  const descriptor = {
    package: '@theia/ai-ide',
    module: '@theia/ai-ide/lib/node/app-tester-agent/browser-automation-impl',
    proxy: 'tauri-src/backend/ai-ide-browser-automation-proxy.ts',
    entry: 'tauri-src/backend/ai-ide-browser-automation-feature.ts',
    output: 'lib/backend/ai-ide-browser-automation-feature.cjs',
    action: 'browser-automation',
  };
  const realImplementationInput = `node_modules/${descriptor.module}.js`;
  const featureInputs = [
    descriptor.entry,
    realImplementationInput,
    'node_modules/@theia/ai-ide/node_modules/puppeteer-core/index.js',
    'node_modules/@theia/ai-ide/node_modules/chromium-bidi/index.js',
    'node_modules/@tootallnate/quickjs-emscripten/index.js',
    'node_modules/esprima/index.js',
  ];
  try {
    fixture.manifest.featureGroups.deferred.deferredBackendModules = [descriptor];
    const backendMain = fixture.records.backend.metafile.outputs['lib/backend/main.js'];
    fixture.records.backend.metafile.inputs[descriptor.proxy] = { bytes: 1, imports: [] };
    backendMain.inputs[descriptor.proxy] = { bytesInOutput: 1 };
    fixture.records['backend-browser-automation'] = metadata(
      fixture.manifest,
      'backend-browser-automation',
      featureInputs,
      [{
        path: descriptor.output,
        entryPoint: descriptor.entry,
        additionalInputs: featureInputs.slice(1),
      }],
    );
    const featureOutput = path.join(fixture.browserDirectory, descriptor.output);
    fs.mkdirSync(path.dirname(featureOutput), { recursive: true });
    fs.writeFileSync(featureOutput, 'feature');
    fixture.records['backend-browser-automation'].outputHashes[descriptor.output] = crypto
      .createHash('sha256')
      .update('feature')
      .digest('hex');
    publishManifest(fixture);

    const report = verifyTauriProfileInventory(fixture);
    assert.deepEqual(report.metadataTargets, [
      'frontend-main',
      'frontend-secondary-window',
      'frontend-editor.worker',
      'frontend-plugin-worker',
      'backend',
      'backend-browser-automation',
    ]);
    assert.deepEqual(report.deferredBackendFeatures, [{
      action: descriptor.action,
      output: descriptor.output,
    }]);

    fixture.records.backend.metafile.inputs[realImplementationInput] = { bytes: 1, imports: [] };
    backendMain.inputs[realImplementationInput] = { bytesInOutput: 1 };
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'backend.json'), fixture.records.backend);
    assert.throws(
      () => verifyTauriProfileInventory(fixture),
      /deferred backend implementation.*backend main/i,
    );

    delete fixture.records.backend.metafile.inputs[realImplementationInput];
    delete backendMain.inputs[realImplementationInput];
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'backend.json'), fixture.records.backend);
    delete fixture.records['backend-browser-automation'].metafile.inputs[realImplementationInput];
    delete fixture.records['backend-browser-automation'].metafile.outputs[descriptor.output].inputs[realImplementationInput];
    writeJson(
      path.join(fixture.browserDirectory, 'lib', 'metadata', 'backend-browser-automation.json'),
      fixture.records['backend-browser-automation'],
    );
    assert.throws(
      () => verifyTauriProfileInventory(fixture),
      /deferred backend feature.*real implementation/i,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a missing deferred chunk and a deferred-only backend package', () => {
  const fixture = createFixture();
  try {
    delete fixture.records['frontend-main'].metafile.outputs['lib/frontend/chunks/secondary-window-feature-ABC123.js'];
    delete fixture.records['frontend-main'].outputHashes['lib/frontend/chunks/secondary-window-feature-ABC123.js'];
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'frontend-main.json'), fixture.records['frontend-main']);
    assert.throws(() => verifyTauriProfileInventory(fixture), /deferred feature chunk/);

    const rebuiltFrontendInputs = fixture.manifest.extensions.map(extension => `node_modules/${extension}/lib/browser/frontend-module.js`);
    fixture.records['frontend-main'] = metadata(fixture.manifest, 'frontend-main', rebuiltFrontendInputs, [
      { path: 'lib/frontend/bundle.js', entryPoint: 'src-gen/frontend/index.js', additionalInputs: rebuiltFrontendInputs },
      {
        path: 'lib/frontend/chunks/secondary-window-feature-ABC123.js',
        entryPoint: 'tauri-src/secondary-window-feature.ts',
        additionalInputs: ['node_modules/@theia/secondary-window/lib/browser/secondary-window-frontend-module.js'],
      },
    ]);
    for (const output of Object.keys(fixture.records['frontend-main'].metafile.outputs)) {
      fixture.records['frontend-main'].outputHashes[output] = crypto.createHash('sha256').update('x').digest('hex');
    }
    fixture.records.backend.metafile.inputs['node_modules/@theia/deferred-only/lib/node/index.js'] = { bytes: 1, imports: [] };
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'frontend-main.json'), fixture.records['frontend-main']);
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'backend.json'), fixture.records.backend);
    assert.throws(() => verifyTauriProfileInventory(fixture), /deferred-only backend package/);

    delete fixture.records.backend.metafile.inputs['node_modules/@theia/deferred-only/lib/node/index.js'];
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'backend.json'), fixture.records.backend);
    fs.rmSync(path.join(fixture.browserDirectory, 'lib', 'frontend', 'chunks', 'secondary-window-feature-ABC123.js'));
    assert.throws(() => verifyTauriProfileInventory(fixture), /output file is missing/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('full fallback requires every browser root and rejects stale metadata identity', () => {
  const fixture = createFixture('full');
  try {
    assert.equal(verifyTauriProfileInventory(fixture).profile, 'full');
    const coreFrontendInput = 'node_modules/@theia/core/lib/browser/frontend-module.js';
    delete fixture.records['frontend-main'].metafile.inputs[coreFrontendInput];
    delete fixture.records['frontend-main'].metafile.outputs['lib/frontend/bundle.js'].inputs[coreFrontendInput];
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'frontend-main.json'), fixture.records['frontend-main']);
    assert.throws(() => verifyTauriProfileInventory(fixture), /missing profile inventory.*@theia\/core \(frontend-main\)/i);

    fixture.records['frontend-main'].metafile.inputs[coreFrontendInput] = { bytes: 1, imports: [] };
    fixture.records['frontend-main'].metafile.outputs['lib/frontend/bundle.js'].inputs[coreFrontendInput] = { bytesInOutput: 1 };
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'frontend-main.json'), fixture.records['frontend-main']);
    const coreBackendInput = 'node_modules/@theia/core/lib/node/backend-module.js';
    delete fixture.records.backend.metafile.inputs[coreBackendInput];
    delete fixture.records.backend.metafile.outputs['lib/backend/main.js'].inputs[coreBackendInput];
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'backend.json'), fixture.records.backend);
    assert.throws(() => verifyTauriProfileInventory(fixture), /missing profile inventory.*@theia\/core/i);

    fixture.records.backend.metafile.inputs[coreBackendInput] = { bytes: 1, imports: [] };
    fixture.records.backend.metafile.outputs['lib/backend/main.js'].inputs[coreBackendInput] = { bytesInOutput: 1 };
    fixture.records.backend.buildId = 'stale-build';
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'backend.json'), fixture.records.backend);
    assert.throws(() => verifyTauriProfileInventory(fixture), /metadata identity mismatch/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('inventory verification rejects a valid profile that differs from the expected build profile', () => {
  const fixture = createFixture('full');
  try {
    assert.throws(
      () => verifyTauriProfileInventory({ ...fixture, expectedProfile: 'tauri-critical' }),
      /expected profile tauri-critical.*received full/i,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('full fallback is checked against every browser dependency root', () => {
  const fixture = createFixture('full');
  try {
    fixture.manifest.roots = fixture.manifest.roots.filter(root => root !== 'fs-extra');
    fixture.manifest.packages = fixture.manifest.packages.filter(record => record.requestName !== 'fs-extra');
    publishManifest(fixture);

    assert.throws(() => verifyTauriProfileInventory(fixture), /browser dependency roots.*fs-extra/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('full fallback never skips a contribution merely because critical defers it', () => {
  const fixture = createFixture('full');
  try {
    fixture.manifest.featureGroups.deferred.deferredFrontendModules[0].module = '@theia/core/lib/browser/frontend-module';
    publishManifest(fixture);
    const coreInput = 'node_modules/@theia/core/lib/browser/frontend-module.js';
    delete fixture.records['frontend-main'].metafile.inputs[coreInput];
    delete fixture.records['frontend-main'].metafile.outputs['lib/frontend/bundle.js'].inputs[coreInput];
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'frontend-main.json'), fixture.records['frontend-main']);

    assert.throws(() => verifyTauriProfileInventory(fixture), /missing profile inventory.*@theia\/core.*frontend-main/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('backend contributions must belong to the backend main entry output', () => {
  const fixture = createFixture();
  try {
    const coreInput = 'node_modules/@theia/core/lib/node/backend-module.js';
    delete fixture.records.backend.metafile.outputs['lib/backend/main.js'].inputs[coreInput];
    fixture.records.backend.metafile.outputs['lib/backend/plugin-host.js'].inputs[coreInput] = { bytesInOutput: 1 };
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'backend.json'), fixture.records.backend);

    assert.throws(() => verifyTauriProfileInventory(fixture), /missing profile inventory.*@theia\/core.*backend/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects a stale frontend VS Code initialization copy', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.browserDirectory, 'lib', 'frontend', 'context', 'plugin-vscode-init-fe.js'), 'stale');
    assert.throws(() => verifyTauriProfileInventory(fixture), /VS Code initialization asset hash mismatch/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('rejects same-name shell outputs with a wrong entry point or empty bundled inputs', () => {
  const fixture = createFixture();
  try {
    const pluginOutput = fixture.records['frontend-plugin-worker'].metafile.outputs['lib/frontend/plugin-worker.js'];
    pluginOutput.entryPoint = 'src/fake-worker.js';
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'frontend-plugin-worker.json'), fixture.records['frontend-plugin-worker']);
    assert.throws(() => verifyTauriProfileInventory(fixture), /Plugin worker output has the wrong entry point/);

    pluginOutput.entryPoint = 'node_modules/@theia/plugin-ext/lib/hosted/browser/worker/worker-main.js';
    pluginOutput.inputs = {};
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'frontend-plugin-worker.json'), fixture.records['frontend-plugin-worker']);
    assert.throws(() => verifyTauriProfileInventory(fixture), /Plugin worker output has no bundled input inventory/);

    pluginOutput.inputs = {
      'node_modules/@theia/plugin-ext/lib/hosted/browser/worker/worker-main.js': { bytesInOutput: 1 },
    };
    writeJson(path.join(fixture.browserDirectory, 'lib', 'metadata', 'frontend-plugin-worker.json'), fixture.records['frontend-plugin-worker']);
    fs.writeFileSync(path.join(fixture.browserDirectory, 'lib', 'frontend', 'plugin-worker.js'), 'tampered');
    assert.throws(() => verifyTauriProfileInventory(fixture), /frontend-plugin-worker output hash does not match/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('profile builds emit named esbuild metadata and expose the verifier command', () => {
  const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const packageJson = JSON.parse(fs.readFileSync(path.join(appDirectory, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts?.['verify:tauri-profile'], 'node scripts/verify-tauri-profile.mjs');
  const esbuildSource = fs.readFileSync(path.join(appDirectory, 'applications', 'browser', 'esbuild.mjs'), 'utf8');
  const metadataSource = fs.readFileSync(path.join(appDirectory, 'applications', 'browser', 'tauri-src', 'esbuild-metadata.mjs'), 'utf8');
  assert.match(metadataSource, /schema:\s*'ride\.esbuild-metafile@1'/);
  assert.match(esbuildSource, /target:\s*'frontend-main'/);
  assert.match(esbuildSource, /`frontend-\$\{targetName\}`/);
  assert.match(esbuildSource, /withProfileMetadata\(backendBuildPlans\.main, 'backend'\)/);
  assert.match(esbuildSource, /withProfileMetadata\(options, `backend-\$\{action\}`\)/);
  assert.match(metadataSource, /lib', 'metadata'/);
  assert.match(metadataSource, /metafile:\s*result\.metafile/);
  const bundlerGeneratorSource = fs.readFileSync(
    require.resolve('@theia/application-manager/lib/generator/bundler-generator.js'),
    'utf8',
  );
  assert.match(bundlerGeneratorSource, /const sourcemap = production \? false : 'linked'/);
});

test('browser owns the exact installed date-fns bridge dependency and narrow exports', () => {
  const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const browserDirectory = path.join(appDirectory, 'applications', 'browser');
  const browserManifest = JSON.parse(fs.readFileSync(path.join(browserDirectory, 'package.json'), 'utf8'));
  assert.equal(browserManifest.dependencies?.['date-fns'], '4.4.0');

  const browserRequire = createRequire(path.join(browserDirectory, 'package.json'));
  const requests = [
    'date-fns/formatDistance',
    'date-fns/formatDistanceToNow',
    'date-fns/locale/en-US',
    'date-fns/locale/zh-CN',
  ];
  const resolved = requests.map(request => browserRequire.resolve(request));
  assert.equal(resolved.every(file => fs.statSync(file).isFile()), true);
  const installedManifest = JSON.parse(fs.readFileSync(path.join(path.dirname(resolved[0]), 'package.json'), 'utf8'));
  assert.equal(installedManifest.version, '4.4.0');
  for (const request of requests) {
    assert.ok(installedManifest.exports?.[`./${request.slice('date-fns/'.length)}`], `${request} must be exported`);
  }

  const lockfile = fs.readFileSync(path.join(appDirectory, 'yarn.lock'), 'utf8');
  const lockEntry = lockfile.match(/^date-fns@4\.4\.0, date-fns@\^4\.1\.0, date-fns@\^4\.4\.0:\r?\n(?: {2}.*\r?\n)+/m)?.[0];
  assert.ok(lockEntry, 'yarn.lock must include the exact browser date-fns selector');
  assert.match(lockEntry, /^ {2}version "4\.4\.0"$/m);
  assert.match(lockEntry, /date-fns-4\.4\.0\.tgz#806539edf45c616b2b76b5f78b88c56ed3c7e036/);
  assert.match(lockEntry, /sha512-\+1UMbeh68lH1SegH83CGWwpb6OHHbpSgr3\+s5Eww5M4CAgswBpoWS0AjTOfEJ33HiYKz1hdj\/KTFprzXHmq\/6w==/);
});

test('date-fns importer audit uses the complete metafile and rejects property bypasses', async t => {
  const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const browserDirectory = path.join(appDirectory, 'applications', 'browser');
  const deferredBuild = await import('../../applications/browser/tauri-src/esbuild-deferred.mjs');
  assert.equal(typeof deferredBuild.auditDateFnsBridgeContract, 'function');
  const inputs = {
    'node_modules/@theia/ai-chat-ui/lib/browser/chat-date-utils.js': {
      imports: [
        { original: 'date-fns', path: 'tauri-src/date-fns-bridge.ts', kind: 'require-call' },
        { original: 'date-fns/locale', path: 'tauri-src/date-fns-locales-bridge.ts', kind: 'require-call' },
      ],
    },
    'node_modules/@theia/ai-ide/lib/browser/ai-configuration/token-usage-configuration-widget.js': {
      imports: [{ original: 'date-fns', path: 'tauri-src/date-fns-bridge.ts', kind: 'require-call' }],
    },
  };
  assert.doesNotThrow(() => deferredBuild.auditDateFnsBridgeContract({ inputs }, browserDirectory));

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-date-fns-source-contract-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  for (const input of Object.keys(inputs)) {
    const source = fs.readFileSync(path.join(browserDirectory, input), 'utf8');
    const destination = path.join(fixture, input);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, source);
  }
  const chatSource = path.join(fixture, 'node_modules/@theia/ai-chat-ui/lib/browser/chat-date-utils.js');
  fs.writeFileSync(
    chatSource,
    fs.readFileSync(chatSource, 'utf8').replace('date_fns_1.formatDistance', "date_fns_1['formatDistance']"),
  );
  assert.throws(
    () => deferredBuild.auditDateFnsBridgeContract({ inputs }, fixture),
    /bracket notation.*formatDistance/i,
  );
});

test('metadata plugin atomically hashes successful outputs and removes stale records after failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-metadata-plugin-'));
  try {
    const output = 'lib/frontend/bundle.js';
    fs.mkdirSync(path.join(root, 'lib', 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(root, output), 'real-output');
    let onEnd;
    const profileManifest = { profile: 'tauri-critical', buildId: 'build-1', digest: 'd'.repeat(64) };
    createProfileMetadataPlugin({ target: 'frontend-main', profileManifest, baseDirectory: root }).setup({
      onEnd(callback) {
        onEnd = callback;
      },
    });
    const metafile = {
      inputs: { 'src-gen/frontend/index.js': { bytes: 1, imports: [] } },
      outputs: {
        [output]: {
          bytes: 11,
          inputs: { 'src-gen/frontend/index.js': { bytesInOutput: 11 } },
          imports: [],
          exports: [],
          entryPoint: 'src-gen/frontend/index.js',
        },
      },
    };
    onEnd({ errors: [], metafile });
    const metadataFile = path.join(root, 'lib', 'metadata', 'frontend-main.json');
    const record = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    assert.equal(record.outputHashes[output], crypto.createHash('sha256').update('real-output').digest('hex'));
    assert.equal(record.metafile.outputs[output].entryPoint, 'src-gen/frontend/index.js');
    assert.deepEqual(fs.readdirSync(path.dirname(metadataFile)), ['frontend-main.json']);

    fs.rmSync(path.join(root, output));
    assert.throws(() => onEnd({ errors: [], metafile }), /ENOENT|no such file/i);
    assert.equal(fs.existsSync(metadataFile), false);

    fs.writeFileSync(path.join(root, output), 'real-output');
    onEnd({ errors: [], metafile });
    onEnd({ errors: [{ text: 'failed rebuild' }] });
    assert.equal(fs.existsSync(metadataFile), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('metadata publication stays successful when obsolete backup cleanup is denied', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ride-metadata-backup-'));
  const originalRemove = fs.rmSync;
  try {
    const output = 'lib/frontend/bundle.js';
    fs.mkdirSync(path.join(root, 'lib', 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(root, output), 'first');
    let onEnd;
    const profileManifest = { profile: 'tauri-critical', buildId: 'build-1', digest: 'd'.repeat(64) };
    createProfileMetadataPlugin({ target: 'frontend-main', profileManifest, baseDirectory: root }).setup({
      onEnd(callback) {
        onEnd = callback;
      },
    });
    const metafile = {
      inputs: { 'src-gen/frontend/index.js': { bytes: 1, imports: [] } },
      outputs: {
        [output]: {
          bytes: 6,
          inputs: { 'src-gen/frontend/index.js': { bytesInOutput: 6 } },
          imports: [],
          exports: [],
          entryPoint: 'src-gen/frontend/index.js',
        },
      },
    };
    onEnd({ errors: [], metafile });
    fs.writeFileSync(path.join(root, output), 'second');
    fs.rmSync = (candidate, options) => {
      if (String(candidate).includes('.backup-')) {
        const error = new Error('backup is temporarily locked');
        error.code = 'EPERM';
        throw error;
      }
      return originalRemove(candidate, options);
    };

    assert.doesNotThrow(() => onEnd({ errors: [], metafile }));
    const record = JSON.parse(fs.readFileSync(path.join(root, 'lib', 'metadata', 'frontend-main.json'), 'utf8'));
    assert.equal(record.outputHashes[output], crypto.createHash('sha256').update('second').digest('hex'));
  } finally {
    fs.rmSync = originalRemove;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
