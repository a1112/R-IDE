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

// 目标插件目录
const targetPluginsDir = path.resolve(__dirname, 'resources/plugins');

// 确保目标目录存在
if (!fs.existsSync(targetPluginsDir)) {
  fs.mkdirSync(targetPluginsDir, { recursive: true });
}

// 检查源目录是否存在
if (!fs.existsSync(sourcePluginsDir)) {
  console.warn('⚠ Source plugins directory not found:', sourcePluginsDir);
  console.warn('Plugins will not be included in the Tauri build.');
  console.warn('Make sure to run "yarn download:plugins" from the project root first.');
  process.exit(0);
}

if (!shouldCopyPlugins) {
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

try {
  copyDirectory(sourcePluginsDir, targetPluginsDir);

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

} catch (error) {
  console.error('✗ Failed to copy plugins:', error.message);
  process.exit(1);
}
