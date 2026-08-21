/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function assertSafeEntryName(name) {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error(`Refusing unsafe build entry name: ${name}`);
  }
}

function assertWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Build asset escapes the copy root: ${candidate}`);
  }
}

function assertRegularDirectory(candidate, label) {
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a regular directory: ${candidate}`);
  }
}

function assertSymlinkFreeTree(root) {
  assertRegularDirectory(root, 'Generated frontend root');
  const visit = candidate => {
    assertWithin(root, candidate);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`Generated frontend contains a symbolic link or reparse point: ${candidate}`);
    }
    if (stat.isFile()) {
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Generated frontend contains a non-regular asset: ${candidate}`);
    }
    for (const entry of fs.readdirSync(candidate, { withFileTypes: true })) {
      assertSafeEntryName(entry.name);
      visit(path.join(candidate, entry.name));
    }
  };
  visit(path.resolve(root));
}

function copyRegularTree(sourceRoot, targetRoot, options = {}) {
  const includeSourceMaps = options.includeSourceMaps === true;
  const copyEntry = (source, target) => {
    assertWithin(sourceRoot, source);
    assertWithin(targetRoot, target);
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to copy symbolic link or reparse point: ${source}`);
    }
    if (stat.isFile()) {
      if (!includeSourceMaps && source.toLowerCase().endsWith('.map')) {
        return;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Refusing to copy non-regular build asset: ${source}`);
    }
    fs.mkdirSync(target, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      assertSafeEntryName(entry.name);
      copyEntry(path.join(source, entry.name), path.join(target, entry.name));
    }
  };

  assertRegularDirectory(sourceRoot, 'Build source');
  copyEntry(sourceRoot, targetRoot);
  assertSymlinkFreeTree(targetRoot);
}

function createSiblingPath(target, purpose) {
  const parent = path.dirname(target);
  const name = path.basename(target);
  return path.join(parent, `.${name}.${purpose}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
}

function retryFilesystemOperation(operation) {
  const retryable = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);
  let lastError;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (process.platform !== 'win32' || !retryable.has(error.code) || attempt === 11) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
  throw lastError;
}

function publishDirectoryAtomic(target, populate, options = {}) {
  const renameSync = options.renameSync ?? fs.renameSync;
  const rmSync = options.rmSync ?? fs.rmSync;
  const resolvedTarget = path.resolve(target);
  const parent = path.dirname(resolvedTarget);
  assertRegularDirectory(parent, 'Copy target parent');
  const temporary = createSiblingPath(resolvedTarget, 'tmp');
  const backup = createSiblingPath(resolvedTarget, 'backup');
  let targetMoved = false;
  fs.mkdirSync(temporary, { recursive: false });
  try {
    populate(temporary);
    if (fs.existsSync(resolvedTarget)) {
      assertRegularDirectory(resolvedTarget, 'Existing copy target');
      retryFilesystemOperation(() => renameSync(resolvedTarget, backup));
      targetMoved = true;
    }
    try {
      retryFilesystemOperation(() => renameSync(temporary, resolvedTarget));
    } catch (installError) {
      if (targetMoved) {
        retryFilesystemOperation(() => renameSync(backup, resolvedTarget));
        targetMoved = false;
      }
      throw installError;
    }
    if (targetMoved) {
      try {
        retryFilesystemOperation(() => rmSync(backup, { recursive: true, force: false }));
      } catch (cleanupError) {
        (options.onCleanupError ?? console.warn)(
          `Installed ${resolvedTarget}, but could not remove old backup ${backup}: ${cleanupError.message}`,
        );
      }
      targetMoved = false;
    }
  } catch (error) {
    if (fs.existsSync(temporary)) {
      retryFilesystemOperation(() => fs.rmSync(temporary, { recursive: true, force: false }));
    }
    if (targetMoved && !fs.existsSync(resolvedTarget) && fs.existsSync(backup)) {
      retryFilesystemOperation(() => renameSync(backup, resolvedTarget));
    }
    throw error;
  }
}

function rewriteDesktopHtml(source) {
  let html = source;
  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' http: https: ws: wss:",
    "worker-src 'self' blob:",
    "frame-src 'self' http: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  const cspMeta = `  <meta http-equiv="Content-Security-Policy" content="${csp}">\n`;
  const localeScript = '    <script type="text/javascript" src="./ride-bootstrap.js" charset="utf-8"></script>\n';
  const afterBundleScript = '<script type="text/javascript" src="./ride-after-bundle.js" charset="utf-8"></script>';

  html = html.replace(
    /\s*<script>\s*if \(document\.head\)[\s\S]*?<\/script\b[^>]*>/,
    '',
  );
  if (!/<\/head>/i.test(html)) {
    throw new Error('Frontend index.html does not contain a closing head tag.');
  }
  html = html.replace(/<\/head>/i, `${cspMeta}</head>`);
  const bundleScript = /([ \t]*)<script\b([^>]*\bsrc=["']\.\/bundle\.js["'][^>]*)><\/script\b[^>]*>/i;
  if (!bundleScript.test(html)) {
    throw new Error('Frontend index.html does not contain the bundle.js script tag.');
  }
  html = html.replace(bundleScript, (_match, indent, attributes) =>
    `${localeScript}${indent}<script${attributes}></script>\n${indent}${afterBundleScript}`
  );
  for (const script of html.matchAll(/<script\b([^>]*)>[\s\S]*?<\/script\b[^>]*>/gi)) {
    if (!/(?:^|\s)src\s*=/i.test(script[1])) {
      throw new Error('Desktop index.html contains an inline script that violates the CSP.');
    }
  }
  return html;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON does not support non-finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort(compareText)
      .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`Unsupported canonical JSON value: ${typeof value}.`);
}

function canonicalDigest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function readProfileManifest(manifestPath) {
  const stat = fs.lstatSync(manifestPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Packaged profile manifest is not a regular file: ${manifestPath}`);
  }
  const text = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(text.toString('utf8'));
  if (manifest.schema !== 'ride.tauri-profile' || manifest.version !== 1
    || typeof manifest.profile !== 'string' || !manifest.profile
    || typeof manifest.buildId !== 'string' || !manifest.buildId
    || typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(manifest.commit)
    || typeof manifest.digest !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.digest)) {
    throw new Error(`Invalid packaged profile identity: ${manifestPath}`);
  }
  if (!manifest.sourceIdentity || manifest.sourceIdentity.commit !== manifest.commit
    || manifest.sourceIdentity.clean !== true
    || !Array.isArray(manifest.roots) || !Array.isArray(manifest.extensions)
    || !Array.isArray(manifest.packages)
    || !manifest.featureGroups || typeof manifest.featureGroups !== 'object'
    || Array.isArray(manifest.featureGroups)) {
    throw new Error(`Invalid packaged profile contract: ${manifestPath}`);
  }
  const digest = canonicalDigest({
    schema: 'ride.tauri-frontend-profile@2',
    profile: manifest.profile,
    roots: manifest.roots,
    extensions: manifest.extensions,
    packages: manifest.packages,
    featureGroups: manifest.featureGroups,
  });
  if (digest !== manifest.digest) {
    throw new Error(`Packaged profile digest mismatch: expected ${digest}, found ${manifest.digest}`);
  }
  return { manifest, text };
}

function validatePackagedProfileAssets(frontendDirectory, backendDirectory) {
  const frontend = readProfileManifest(path.join(frontendDirectory, 'ride-tauri-profile.json'));
  const backend = readProfileManifest(path.join(backendDirectory, 'ride-tauri-profile.json'));
  if (!frontend.text.equals(backend.text)) {
    throw new Error('Frontend and backend packaged profile identities do not match');
  }

  const chunks = [];
  if (frontend.manifest.profile === 'tauri-critical') {
    const featureGroups = frontend.manifest.featureGroups;
    const chunkDirectory = path.join(frontendDirectory, 'chunks');
    assertRegularDirectory(chunkDirectory, 'Packaged chunk directory');
    const chunkEntries = fs.readdirSync(chunkDirectory, { withFileTypes: true });
    let deferredFeatureCount = 0;
    for (const [groupName, group] of Object.entries(featureGroups)) {
      if (!group || typeof group !== 'object' || Array.isArray(group)
        || (group.deferredFrontendModules !== undefined && !Array.isArray(group.deferredFrontendModules))) {
        throw new Error(`Invalid packaged feature group metadata for ${groupName}`);
      }
      for (const feature of group.deferredFrontendModules ?? []) {
        deferredFeatureCount++;
        if (!feature || typeof feature.entry !== 'string' || !feature.entry) {
          throw new Error(`Invalid deferred frontend feature metadata for ${groupName}`);
        }
        const entryName = path.basename(feature.entry, path.extname(feature.entry));
        const escapedName = entryName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`^${escapedName}-[A-Za-z0-9]+\\.js$`);
        const matches = chunkEntries.filter(entry => entry.isFile() && pattern.test(entry.name));
        if (matches.length === 0) {
          throw new Error(`Missing packaged deferred feature chunk for ${groupName}`);
        }
        for (const match of matches) {
          const chunkPath = path.join(chunkDirectory, match.name);
          const stat = fs.lstatSync(chunkPath);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error(`Packaged deferred feature chunk is not regular: ${chunkPath}`);
          }
          chunks.push({ groupName, name: match.name });
        }
      }
    }
    if (deferredFeatureCount === 0) {
      throw new Error('Critical packaged profile does not contain a validated deferred feature');
    }
  }
  return { manifest: frontend.manifest, chunks };
}

function assertRequiredRegularFiles(sourceRoot, requiredFiles) {
  const missing = [];
  for (const relative of requiredFiles) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(segment => segment === '..')) {
      throw new Error(`Required build path is unsafe: ${relative}`);
    }
    const candidate = path.resolve(sourceRoot, relative);
    assertWithin(sourceRoot, candidate);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        missing.push(relative);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing.push(relative);
      } else {
        throw error;
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`Required build artifacts are missing or non-regular: ${missing.join(', ')}`);
  }
}

module.exports = {
  assertRequiredRegularFiles,
  assertSymlinkFreeTree,
  canonicalDigest,
  copyRegularTree,
  publishDirectoryAtomic,
  rewriteDesktopHtml,
  validatePackagedProfileAssets,
};
