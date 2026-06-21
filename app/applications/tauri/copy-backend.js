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

const sourceDir = path.resolve(__dirname, '../browser/lib/backend');
const targetDir = path.resolve(__dirname, 'resources/backend');
const requiredFiles = ['main.js'];

function nodePtyPlatformTag() {
  return `${process.platform}-${process.arch}`;
}

function bundledNodeName() {
  return process.platform === 'win32' ? 'node.exe' : 'node';
}

function copyBundledNodeRuntime() {
  const source = process.execPath;
  const target = path.join(targetDir, 'runtime', bundledNodeName());

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

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });

  const entries = fs.readdirSync(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function patchNodePtyNativeLookup() {
  const mainPath = path.join(targetDir, 'main.js');
  if (!fs.existsSync(mainPath)) {
    return;
  }

  let content = fs.readFileSync(mainPath, 'utf8');
  if (content.includes('node-pty native module is disabled in the R-IDE Tauri backend runtime')) {
    return;
  }

  const marker = 'for(var e=["build/Release","build/Debug","prebuilds/"+process.platform+"-"+process.arch],n=["..","."],';
  const markerIndex = content.indexOf(marker);
  if (markerIndex === -1) {
    console.warn('node-pty native lookup was not found in backend bundle; startup may require bundled pty.node to load directly.');
    return;
  }

  const functionStart = content.lastIndexOf('function ', markerIndex);
  const functionBrace = content.indexOf('{', functionStart);
  const prefix = content.slice(Math.max(0, functionStart - 800), functionStart);
  const requireMatch = prefix.match(/var ([A-Za-z_$][\w$]*)=require;/);
  if (functionStart === -1 || functionBrace === -1 || !requireMatch) {
    console.warn('Could not patch node-pty native lookup in backend bundle.');
    return;
  }

  const requireAlias = requireMatch[1];
  const injection = `if(t==="pty"){var ridePtyDisabled=function(){throw new Error("node-pty native module is disabled in the R-IDE Tauri backend runtime")};return{dir:"",module:{fork:ridePtyDisabled,open:ridePtyDisabled}}}if(t==="pty"&&process.env.RIDE_NODE_PTY_PREBUILD_DIR){var ridePtyDir=process.env.RIDE_NODE_PTY_PREBUILD_DIR;try{return{dir:ridePtyDir,module:${requireAlias}(ridePtyDir+"/"+t+".node")}}catch(ridePtyError){}}`;
  content = `${content.slice(0, functionBrace + 1)}${injection}${content.slice(functionBrace + 1)}`;
  fs.writeFileSync(mainPath, content);
  console.log('Patched node-pty native lookup for R-IDE desktop runtime.');
}

if (!fs.existsSync(sourceDir)) {
  console.error('Theia backend build directory is missing:');
  console.error(`  - ${sourceDir}`);
  console.error('\nBuild the browser backend first from the app workspace:');
  console.error('  yarn --cwd applications/browser build:prod');
  process.exit(1);
}

const missingRequired = requiredFiles.filter(file => !fs.existsSync(path.join(sourceDir, file)));
if (missingRequired.length > 0) {
  console.error('Required Theia backend build artifacts are missing:');
  missingRequired.forEach(file => console.error(`  - ${path.join(sourceDir, file)}`));
  console.error('\nBuild the browser backend first from the app workspace:');
  console.error('  yarn --cwd applications/browser build:prod');
  process.exit(1);
}

fs.rmSync(targetDir, { recursive: true, force: true });
copyDirectory(sourceDir, targetDir);
patchNodePtyNativeLookup();
copyBundledNodeRuntime();

for (const resource of extraNativeResources) {
  if (fs.existsSync(resource.source)) {
    copyDirectory(resource.source, resource.target);
    console.log(`Copied native resource: ${resource.source} -> ${resource.target}`);
  } else if (resource.required) {
    console.error('Required native backend resource is missing:');
    console.error(`  - ${resource.source}`);
    console.error('\nRun from app/:');
    console.error('  npm rebuild node-pty --foreground-scripts');
    process.exit(1);
  }
}

fs.writeFileSync(path.join(targetDir, '.gitkeep'), '\n');

console.log('Backend resources copied successfully!');
console.log('Source:', sourceDir);
console.log('Target:', targetDir);
