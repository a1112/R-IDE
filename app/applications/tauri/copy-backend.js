/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Backend resource copy script.
 *
 * Copies the Theia browser backend build into the Tauri resource directory.
 */

const fs = require('fs');
const path = require('path');
const {
  assertRequiredRegularFiles,
  copyRegularTree,
  publishDirectoryAtomic,
} = require('./copy-build-tree');

const sourceDir = path.resolve(__dirname, '../browser/lib/backend');
const targetDir = path.resolve(__dirname, 'resources/backend');
const requiredFiles = ['main.js'];

function nodePtyPlatformTag() {
  return `${process.platform}-${process.arch}`;
}

function bundledNodeName() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function copyBundledNodeRuntime(destinationRoot) {
  const source = process.execPath;
  const target = path.join(destinationRoot, 'runtime', bundledNodeName());

  if (!source || !fs.existsSync(source)) {
    console.warn('Current Node.js executable was not found; desktop launches may require RIDE_NODE_PATH.');
    return;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  if (process.platform !== 'win32') {
    fs.chmodSync(target, 0o755);
  }
  console.log(`Copied Node.js runtime: ${source} -> ${target}`);
}

const extraNativeResources = [
  {
    source: path.resolve(__dirname, '../../node_modules/node-pty/prebuilds', nodePtyPlatformTag()),
    target: path.join(targetDir, 'prebuilds', nodePtyPlatformTag()),
    required: true,
  },
  {
    source: path.resolve(__dirname, '../../node_modules/node-pty/build/Release'),
    target: path.join(targetDir, 'build/Release'),
    required: false,
  },
];

function patchFrontendStaticPath(destinationRoot) {
  const mainPath = path.join(destinationRoot, 'main.js');
  if (!fs.existsSync(mainPath)) {
    return;
  }

  let content = fs.readFileSync(mainPath, 'utf8');
  if (content.includes('process.env.RIDE_FRONTEND_DIR')) {
    return;
  }

  const frontendPathPattern = /([A-Za-z_$][\w$]*)\.resolve\(\s*__dirname\s*,\s*["']\.\.\/\.\.\/lib\/frontend["']\s*\)/;
  const match = content.match(frontendPathPattern);
  if (!match) {
    console.warn('Theia static frontend path was not found in backend bundle; desktop debug launch may not serve the copied frontend.');
    return;
  }

  content = content.replace(match[0], `(process.env.RIDE_FRONTEND_DIR||${match[0]})`);
  fs.writeFileSync(mainPath, content);
  console.log('Patched backend static frontend path for R-IDE desktop runtime.');
}

if (!fs.existsSync(sourceDir)) {
  console.error('Theia backend build directory is missing:');
  console.error(`  - ${sourceDir}`);
  console.error('\nBuild the browser backend first from the app workspace:');
  console.error('  yarn --cwd applications/browser build:prod');
  process.exit(1);
}

try {
  assertRequiredRegularFiles(sourceDir, requiredFiles);
} catch (error) {
  console.error('Required Theia backend build artifacts are missing:');
  console.error(`  - ${error.message}`);
  console.error('\nBuild the browser backend first from the app workspace:');
  console.error('  yarn --cwd applications/browser build:prod');
  process.exit(1);
}

publishDirectoryAtomic(targetDir, stagingDirectory => {
  copyRegularTree(sourceDir, stagingDirectory, {
    includeSourceMaps: process.env.RIDE_COPY_SOURCEMAPS === '1',
  });
  patchFrontendStaticPath(stagingDirectory);
  copyBundledNodeRuntime(stagingDirectory);

  for (const resource of extraNativeResources) {
    const relativeTarget = path.relative(targetDir, resource.target);
    const stagingTarget = path.join(stagingDirectory, relativeTarget);
    if (fs.existsSync(resource.source)) {
      copyRegularTree(resource.source, stagingTarget, {
        includeSourceMaps: process.env.RIDE_COPY_SOURCEMAPS === '1',
      });
      console.log(`Copied native resource: ${resource.source} -> ${stagingTarget}`);
    } else if (resource.required) {
      throw new Error([
        'Required native backend resource is missing:',
        `  - ${resource.source}`,
        '',
        'Run from app/:',
        '  npm rebuild node-pty --foreground-scripts',
      ].join('\n'));
    }
  }
  fs.writeFileSync(path.join(stagingDirectory, '.gitkeep'), '\n');
});

console.log('Backend resources copied successfully!');
console.log('Source:', sourceDir);
console.log('Target:', targetDir);
