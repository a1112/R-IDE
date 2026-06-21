/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * 插件目录复制脚本
 *
 * 从主项目复制 VSCode 插件到 Tauri 应用资源目录
 */

const fs = require('fs');
const path = require('path');

// 源插件目录（相对于项目根目录）
const sourcePluginsDir = path.resolve(__dirname, '../../plugins');
const shouldCopyPlugins = process.env.RIDE_COPY_PLUGINS === '1' || process.env.RIDE_COPY_PLUGINS === 'true';
const pluginProfile = (process.env.RIDE_PLUGIN_PROFILE || 'lean').trim().toLowerCase();

// 目标插件目录
const targetPluginsDir = path.resolve(__dirname, 'resources/plugins');

const leanPluginAllowList = new Set([
  'ms-vscode.js-debug',
  'ms-vscode.vscode-js-profile-table',
  'vscode.bat',
  'vscode.builtin-notebook-renderers',
  'vscode.coffeescript',
  'vscode.configuration-editing',
  'vscode.cpp',
  'vscode.css',
  'vscode.debug-auto-launch',
  'vscode.debug-server-ready',
  'vscode.diff',
  'vscode.docker',
  'vscode.dotenv',
  'vscode.emmet',
  'vscode.git',
  'vscode.git-base',
  'vscode.github',
  'vscode.github-authentication',
  'vscode.go',
  'vscode.html',
  'vscode.ini',
  'vscode.ipynb',
  'vscode.java',
  'vscode.javascript',
  'vscode.json',
  'vscode.log',
  'vscode.make',
  'vscode.markdown',
  'vscode.markdown-math',
  'vscode.merge-conflict',
  'vscode.npm',
  'vscode.php',
  'vscode.python',
  'vscode.r',
  'vscode.references-view',
  'vscode.rust',
  'vscode.search-result',
  'vscode.shellscript',
  'vscode.simple-browser',
  'vscode.sql',
  'vscode.swift',
  'vscode.terminal-suggest',
  'vscode.theme-defaults',
  'vscode.typescript',
  'vscode.vscode-theme-seti',
  'vscode.xml',
  'vscode.yaml',
]);

function parsePluginList(value) {
  return new Set((value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean));
}

const forcedIncludes = parsePluginList(process.env.RIDE_PLUGIN_INCLUDE);
const forcedExcludes = parsePluginList(process.env.RIDE_PLUGIN_EXCLUDE);

function writeGitKeep() {
  fs.writeFileSync(path.join(targetPluginsDir, '.gitkeep'), '\n');
}

// 检查源目录是否存在
if (!fs.existsSync(sourcePluginsDir)) {
  console.warn('⚠ Source plugins directory not found:', sourcePluginsDir);
  console.warn('Plugins will not be included in the Tauri build.');
  console.warn('Make sure to run "yarn download:plugins" from the project root first.');
  process.exit(0);
}

if (!shouldCopyPlugins) {
  fs.rmSync(targetPluginsDir, { recursive: true, force: true });
  fs.mkdirSync(targetPluginsDir, { recursive: true });
  writeGitKeep();
  console.log('Skipping plugin copy for faster Tauri runs.');
  console.log('Source:', sourcePluginsDir);
  console.log('Target:', targetPluginsDir);
  console.log('Set RIDE_COPY_PLUGINS=1 when creating a distributable build that should bundle plugins.');
  process.exit(0);
}

// 递归复制目录
function copyDirectory(source, target) {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

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

function listSourcePlugins() {
  return fs.readdirSync(sourcePluginsDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
}

function selectPlugins() {
  const plugins = listSourcePlugins();
  if (pluginProfile === 'full') {
    return plugins.filter(plugin => !forcedExcludes.has(plugin));
  }
  if (pluginProfile !== 'lean') {
    console.error(`Unsupported RIDE_PLUGIN_PROFILE: ${pluginProfile}`);
    console.error('Supported profiles: lean, full');
    process.exit(1);
  }

  return plugins.filter(plugin => {
    if (forcedExcludes.has(plugin)) {
      return false;
    }
    return leanPluginAllowList.has(plugin) || forcedIncludes.has(plugin);
  });
}

// 统计插件信息
function countPlugins(dir) {
  let count = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      count++;
    }
  }

  return count;
}

// 开始复制
console.log('Copying VSCode plugins...');
console.log('Source:', sourcePluginsDir);
console.log('Target:', targetPluginsDir);
console.log('Profile:', pluginProfile);

try {
  fs.rmSync(targetPluginsDir, { recursive: true, force: true });
  fs.mkdirSync(targetPluginsDir, { recursive: true });

  const selectedPlugins = selectPlugins();
  for (const plugin of selectedPlugins) {
    copyDirectory(path.join(sourcePluginsDir, plugin), path.join(targetPluginsDir, plugin));
  }
  writeGitKeep();

  const pluginCount = countPlugins(targetPluginsDir);

  // 计算目录大小
  function getDirectorySize(dir) {
    let size = 0;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        size += getDirectorySize(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        size += stats.size;
      }
    }

    return size;
  }

  const totalSize = getDirectorySize(targetPluginsDir);
  const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);

  console.log('✓ Plugins copied successfully!');
  console.log(`  - ${pluginCount} plugins`);
  console.log(`  - ${sizeMB} MB`);
  console.log(`  - Target: ${targetPluginsDir}`);
  if (pluginProfile === 'lean') {
    console.log('  - Set RIDE_PLUGIN_PROFILE=full to include every downloaded plugin.');
  }

} catch (error) {
  console.error('✗ Failed to copy plugins:', error.message);
  process.exit(1);
}
