// Copyright (C) 2026 R-IDE contributors.
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDigest, PROFILE_SCHEMA } from './tauri-frontend-profile.mjs';

const METADATA_SCHEMA = 'ride.esbuild-metafile@1';
const REQUIRED_METADATA = [
  'frontend-main',
  'frontend-secondary-window',
  'frontend-editor.worker',
  'frontend-plugin-worker',
  'backend',
];

function normalize(candidate) {
  return candidate.replaceAll('\\', '/').replace(/^\.\//, '');
}

function hasPathSuffix(candidate, expected) {
  const actualParts = normalize(candidate).split('/').filter(Boolean);
  const expectedParts = normalize(expected).split('/').filter(Boolean);
  return expectedParts.length <= actualParts.length
    && expectedParts.every((part, index) => part === actualParts[actualParts.length - expectedParts.length + index]);
}

function readJson(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`${label} is missing: ${file} (${error.message})`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is malformed: ${file} (${error.message})`);
  }
}

function validateManifest(manifest) {
  if (manifest?.schema !== 'ride.tauri-profile' || manifest.version !== 1
    || !['tauri-critical', 'full'].includes(manifest.profile)
    || typeof manifest.buildId !== 'string' || !manifest.buildId
    || typeof manifest.digest !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.digest)
    || !Array.isArray(manifest.roots) || !Array.isArray(manifest.extensions)
    || !Array.isArray(manifest.packages)
    || !manifest.featureGroups || typeof manifest.featureGroups !== 'object'
    || Array.isArray(manifest.featureGroups)) {
    throw new Error('Tauri profile manifest has an invalid inventory contract.');
  }
  const digest = canonicalDigest({
    schema: PROFILE_SCHEMA,
    profile: manifest.profile,
    roots: manifest.roots,
    extensions: manifest.extensions,
    packages: manifest.packages,
    featureGroups: manifest.featureGroups,
  });
  if (digest !== manifest.digest) {
    throw new Error(`Tauri profile digest mismatch: expected ${digest}, found ${manifest.digest}.`);
  }
}

function readMetadata(metadataDirectory, name, manifest) {
  const record = readJson(path.join(metadataDirectory, `${name}.json`), `Tauri ${name} metadata`);
  if (record.schema !== METADATA_SCHEMA || record.target !== name
    || record.profile !== manifest.profile || record.buildId !== manifest.buildId
    || record.digest !== manifest.digest) {
    throw new Error(`Tauri metadata identity mismatch for ${name}.`);
  }
  if (!record.metafile || typeof record.metafile !== 'object'
    || !record.metafile.inputs || typeof record.metafile.inputs !== 'object'
    || !record.metafile.outputs || typeof record.metafile.outputs !== 'object') {
    throw new Error(`Tauri ${name} metadata does not contain an esbuild metafile.`);
  }
  if (!record.outputHashes || typeof record.outputHashes !== 'object' || Array.isArray(record.outputHashes)) {
    throw new Error(`Tauri ${name} metadata does not contain output hashes.`);
  }
  return record;
}

function pathContainsPackage(input, packageName) {
  const candidate = `/${normalize(input)}/`;
  const packagePath = normalize(packageName);
  if (candidate.includes(`/node_modules/${packagePath}/`)) {
    return true;
  }
  if (packageName === 'theia-ide-product-ext'
    && candidate.includes('/theia-extensions/product/')) {
    return true;
  }
  return false;
}

function loadExtensionContributions(browserDirectory, packageName) {
  let directory = browserDirectory;
  while (true) {
    const manifestPath = path.join(directory, 'node_modules', ...packageName.split('/'), 'package.json');
    if (fs.existsSync(manifestPath)) {
      const packageManifest = readJson(manifestPath, `Extension package manifest for ${packageName}`);
      if (!Array.isArray(packageManifest.theiaExtensions)) {
        throw new Error(`Profile package ${packageName} does not declare Theia extensions.`);
      }
      return packageManifest.theiaExtensions;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error(`Unable to locate installed profile package ${packageName}.`);
    }
    directory = parent;
  }
}

function verifyExtensionTargets(browserDirectory, expectedPackages, frontendMetadata, backendMetadata, label) {
  const frontendInputs = Object.keys(frontendMetadata.inputs);
  const backendInputs = Object.keys(backendMetadata.inputs);
  const missing = [];
  for (const packageName of expectedPackages) {
    const contributions = loadExtensionContributions(browserDirectory, packageName);
    const needsFrontend = contributions.some(contribution =>
      ['frontend', 'frontendOnly', 'frontendPreload', 'frontendOnlyPreload'].some(field => typeof contribution[field] === 'string')
    );
    const needsBackend = contributions.some(contribution => typeof contribution.backend === 'string');
    if (needsFrontend && !frontendInputs.some(input => pathContainsPackage(input, packageName))) {
      missing.push(`${packageName} (frontend-main)`);
    }
    if (needsBackend && !backendInputs.some(input => pathContainsPackage(input, packageName))) {
      missing.push(`${packageName} (backend)`);
    }
    for (const contribution of contributions) {
      for (const field of ['frontend', 'frontendOnly', 'frontendPreload', 'frontendOnlyPreload']) {
        if (typeof contribution[field] === 'string') {
          const expected = contribution[field].endsWith('.js') ? contribution[field] : `${contribution[field]}.js`;
          if (!frontendInputs.some(input => pathContainsPackage(input, packageName) && hasPathSuffix(input, expected))) {
            missing.push(`${packageName}/${contribution[field]} (frontend-main)`);
          }
        }
      }
      if (typeof contribution.backend === 'string') {
        const expected = contribution.backend.endsWith('.js') ? contribution.backend : `${contribution.backend}.js`;
        if (!backendInputs.some(input => pathContainsPackage(input, packageName) && hasPathSuffix(input, expected))) {
          missing.push(`${packageName}/${contribution.backend} (backend)`);
        }
      }
    }
    // Electron-only packages are retained as evidence-backed blocked roots but
    // intentionally have no browser/backend contribution in a Tauri build.
  }
  if (missing.length > 0) {
    throw new Error(`${label} missing profile inventory: ${missing.join(', ')}.`);
  }
}

function outputBySuffix(metafile, suffix) {
  return Object.entries(metafile.outputs)
    .find(([output]) => hasPathSuffix(output, suffix));
}

function verifyAllOutputHashes(record, browserDirectory, label) {
  const outputs = Object.keys(record.metafile.outputs).sort();
  const hashedOutputs = Object.keys(record.outputHashes).sort();
  if (outputs.join('\0') !== hashedOutputs.join('\0')) {
    throw new Error(`${label} metadata output hash inventory is incomplete.`);
  }
  for (const output of outputs) {
    assertRegularOutput(browserDirectory, output, label);
    const digest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.resolve(browserDirectory, output)))
      .digest('hex');
    if (record.outputHashes[output] !== digest) {
      throw new Error(`${label} output hash does not match its metadata: ${output}.`);
    }
  }
}

function assertRegularOutput(browserDirectory, outputPath, label) {
  const candidate = path.resolve(browserDirectory, outputPath);
  const relative = path.relative(browserDirectory, candidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} output escapes the browser build: ${outputPath}.`);
  }
  let stat;
  try {
    stat = fs.lstatSync(candidate);
  } catch (error) {
    throw new Error(`${label} output file is missing: ${outputPath} (${error.message}).`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} output is not a regular file: ${outputPath}.`);
  }
}

function requireOutput(record, suffix, label, browserDirectory, expectedEntryPoint) {
  const { metafile, outputHashes } = record;
  const output = outputBySuffix(metafile, suffix);
  if (!output) {
    throw new Error(`${label} output is missing: ${suffix}.`);
  }
  const [outputPath, detail] = output;
  if (typeof detail.entryPoint !== 'string'
    || !hasPathSuffix(detail.entryPoint, expectedEntryPoint)) {
    throw new Error(`${label} output has the wrong entry point: ${detail.entryPoint ?? '<missing>'}.`);
  }
  if (!detail.inputs || typeof detail.inputs !== 'object' || Object.keys(detail.inputs).length === 0) {
    throw new Error(`${label} output has no bundled input inventory.`);
  }
  if (!Object.keys(detail.inputs).some(input => hasPathSuffix(input, expectedEntryPoint))) {
    throw new Error(`${label} output does not include its expected entry input.`);
  }
  assertRegularOutput(browserDirectory, outputPath, label);
  const expectedHash = outputHashes?.[outputPath];
  const outputFile = path.resolve(browserDirectory, outputPath);
  const actualHash = fs.readFileSync(outputFile);
  const digest = crypto.createHash('sha256').update(actualHash).digest('hex');
  if (typeof expectedHash !== 'string' || expectedHash !== digest) {
    throw new Error(`${label} output hash does not match its metadata: expected ${expectedHash ?? '<missing>'}, found ${digest}.`);
  }
  return output;
}

function verifyDeferredChunks(manifest, frontendRecord, browserDirectory) {
  const { metafile: frontendMetadata, outputHashes } = frontendRecord;
  const chunks = [];
  for (const [groupName, group] of Object.entries(manifest.featureGroups)) {
    for (const feature of group.deferredFrontendModules ?? []) {
      if (!feature || typeof feature.entry !== 'string' || !feature.entry) {
        throw new Error(`Deferred feature metadata is invalid for ${groupName}.`);
      }
      const expectedEntry = normalize(feature.entry);
      const matches = Object.entries(frontendMetadata.outputs).filter(([output, detail]) =>
        /\/chunks\/[^/]+\.js$/.test(`/${normalize(output)}`)
        && typeof detail.entryPoint === 'string'
        && hasPathSuffix(detail.entryPoint, expectedEntry)
      );
      if (matches.length !== 1) {
        throw new Error(`Expected exactly one deferred feature chunk for ${groupName}/${expectedEntry}, found ${matches.length}.`);
      }
      const [outputPath, detail] = matches[0];
      if (!detail.inputs || typeof detail.inputs !== 'object' || Object.keys(detail.inputs).length === 0) {
        throw new Error(`Deferred feature chunk for ${groupName} has no bundled input inventory.`);
      }
      if (!Object.keys(detail.inputs).some(input => hasPathSuffix(input, expectedEntry))) {
        throw new Error(`Deferred feature chunk for ${groupName} does not include its expected entry input.`);
      }
      assertRegularOutput(browserDirectory, outputPath, `Deferred feature ${groupName}`);
      const digest = crypto.createHash('sha256')
        .update(fs.readFileSync(path.resolve(browserDirectory, outputPath)))
        .digest('hex');
      if (outputHashes[outputPath] !== digest) {
        throw new Error(`Deferred feature ${groupName} output hash does not match its metadata.`);
      }
      chunks.push(normalize(outputPath));
    }
  }
  if (manifest.profile === 'tauri-critical' && chunks.length === 0) {
    throw new Error('Critical profile has no validated deferred feature chunk.');
  }
  return chunks.sort();
}

function verifyDeferredBackendExclusion(manifest, backendRecord) {
  const backendInputs = Object.keys(backendRecord.metafile.inputs);
  const deferredRoots = Object.values(manifest.featureGroups)
    .flatMap(group => group.deferredRoots ?? []);
  const leaked = deferredRoots.filter(packageName =>
    backendInputs.some(input => pathContainsPackage(input, packageName))
  );
  if (leaked.length > 0) {
    throw new Error(`Critical backend contains deferred-only backend package: ${leaked.join(', ')}.`);
  }
}

function countBundledPlugins(pluginsDirectory) {
  if (!fs.existsSync(pluginsDirectory)) {
    throw new Error(`Bundled plugin directory is missing: ${pluginsDirectory}.`);
  }
  return fs.readdirSync(pluginsDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).length;
}

export function verifyTauriProfileInventory({
  browserDirectory,
  pluginsDirectory,
} = {}) {
  const resolvedBrowserDirectory = path.resolve(browserDirectory ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'applications', 'browser'));
  const resolvedPluginsDirectory = path.resolve(pluginsDirectory ?? path.join(resolvedBrowserDirectory, '..', '..', 'plugins'));
  const manifest = readJson(
    path.join(resolvedBrowserDirectory, 'lib', 'frontend', 'ride-tauri-profile.json'),
    'Tauri profile manifest',
  );
  validateManifest(manifest);

  const metadataDirectory = path.join(resolvedBrowserDirectory, 'lib', 'metadata');
  const metadataRecords = Object.fromEntries(
    REQUIRED_METADATA.map(name => [name, readMetadata(metadataDirectory, name, manifest)]),
  );
  for (const [target, record] of Object.entries(metadataRecords)) {
    verifyAllOutputHashes(record, resolvedBrowserDirectory, target);
  }
  requireOutput(metadataRecords['frontend-main'], 'lib/frontend/bundle.js', 'Main frontend', resolvedBrowserDirectory, 'src-gen/frontend/index.js');
  requireOutput(metadataRecords['frontend-secondary-window'], 'lib/frontend/secondary-window.js', 'Secondary window', resolvedBrowserDirectory, 'src-gen/frontend/secondary-index.js');
  requireOutput(metadataRecords['frontend-editor.worker'], 'lib/frontend/editor.worker.js', 'Editor worker', resolvedBrowserDirectory, 'node_modules/@theia/monaco-editor-core/esm/vs/editor/common/services/editorWebWorkerMain.js');
  requireOutput(metadataRecords['frontend-plugin-worker'], 'lib/frontend/plugin-worker.js', 'Plugin worker', resolvedBrowserDirectory, 'node_modules/@theia/plugin-ext/lib/hosted/browser/worker/worker-main.js');
  for (const [suffix, label, entryPoint] of [
    ['lib/backend/main.js', 'Backend main', 'src-gen/backend/main.js'],
    ['lib/backend/plugin-host.js', 'Plugin host', 'node_modules/@theia/plugin-ext/lib/hosted/node/plugin-host.js'],
    ['lib/backend/backend-init-theia.js', 'Theia plugin initialization', 'node_modules/@theia/plugin-ext/lib/hosted/node/scanners/backend-init-theia.js'],
    ['lib/backend/plugin-vscode-init.js', 'VS Code plugin initialization', 'node_modules/@theia/plugin-ext-vscode/lib/node/plugin-vscode-init.js'],
    ['lib/backend/parcel-watcher.js', 'Parcel watcher', 'node_modules/@theia/filesystem/lib/node/parcel-watcher.js'],
  ]) {
    requireOutput(metadataRecords.backend, suffix, label, resolvedBrowserDirectory, entryPoint);
  }
  const frontendVsCodeInit = path.join(resolvedBrowserDirectory, 'lib', 'frontend', 'context', 'plugin-vscode-init-fe.js');
  let frontendInitStat;
  try {
    frontendInitStat = fs.lstatSync(frontendVsCodeInit);
  } catch (error) {
    throw new Error(`Frontend VS Code initialization asset is missing: ${error.message}.`);
  }
  if (frontendInitStat.isSymbolicLink() || !frontendInitStat.isFile()) {
    throw new Error('Frontend VS Code initialization asset is not a regular file.');
  }

  const expectedPackages = manifest.profile === 'full' ? manifest.roots : manifest.extensions;
  verifyExtensionTargets(
    resolvedBrowserDirectory,
    expectedPackages,
    metadataRecords['frontend-main'].metafile,
    metadataRecords.backend.metafile,
    `${manifest.profile} profile`,
  );
  const frontendInputs = Object.keys(metadataRecords['frontend-main'].metafile.inputs);
  if (!frontendInputs.some(input => pathContainsPackage(input, 'theia-ide-product-ext'))) {
    throw new Error('R-IDE product extension is missing from the frontend inventory.');
  }

  const deferredChunks = manifest.profile === 'tauri-critical'
    ? verifyDeferredChunks(manifest, metadataRecords['frontend-main'], resolvedBrowserDirectory)
    : [];
  if (manifest.profile === 'tauri-critical') {
    verifyDeferredBackendExclusion(manifest, metadataRecords.backend);
  }
  const pluginCount = countBundledPlugins(resolvedPluginsDirectory);
  if (pluginCount === 0) {
    throw new Error('Bundled plugin inventory is empty.');
  }
  return {
    profile: manifest.profile,
    buildId: manifest.buildId,
    digest: manifest.digest,
    pluginCount,
    deferredChunks,
    metadataTargets: REQUIRED_METADATA,
  };
}

function main() {
  const report = verifyTauriProfileInventory();
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`Tauri profile inventory verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
