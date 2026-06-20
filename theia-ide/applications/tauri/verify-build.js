/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * Tauri 构建验证脚本
 *
 * 验证所有必需的组件和配置是否正确
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('====================================');
console.log('R-IDE Tauri Build Verification');
console.log('====================================\n');

let errors = 0;
let warnings = 0;

function logSuccess(message) {
  console.log(`✅ ${message}`);
}

function logError(message) {
  console.error(`❌ ${message}`);
  errors++;
}

function logWarning(message) {
  console.warn(`⚠️  ${message}`);
  warnings++;
}

// 1. 检查 Rust 环境
console.log('1. Checking Rust environment...');
try {
  const rustVersion = execSync('rustc --version', { encoding: 'utf8' });
  logSuccess(`Rust installed: ${rustVersion.trim()}`);
} catch (e) {
  logError('Rust not found. Please install Rust from https://rustup.rs/');
}
console.log();

// 2. 检查 Node.js 环境
console.log('2. Checking Node.js environment...');
try {
  const nodeVersion = execSync('node --version', { encoding: 'utf8' });
  const majorVersion = parseInt(nodeVersion.match(/v(\d+)/)[1]);
  if (majorVersion >= 22) {
    logSuccess(`Node.js installed: ${nodeVersion.trim()}`);
  } else {
    logError(`Node.js version ${nodeVersion.trim()} is too old. Required: >= 22`);
  }
} catch (e) {
  logError('Node.js not found.');
}
console.log();

// 3. 检查项目结构
console.log('3. Checking Tauri project structure...');

const requiredFiles = [
  'src-tauri/Cargo.toml',
  'src-tauri/tauri.conf.json',
  'src-tauri/src/main.rs',
  'src-tauri/src/lib.rs',
  'src-tauri/src/sidecar.rs',
  'src-tauri/src/commands.rs',
  'copy-frontend.js',
  'copy-plugins.js',
  'package.json',
  'README.md',
];

for (const file of requiredFiles) {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    logSuccess(`Found: ${file}`);
  } else {
    logError(`Missing: ${file}`);
  }
}
console.log();

// 4. 检查 Theia 前端构建
console.log('4. Checking Theia frontend build...');
const frontendDir = path.join(__dirname, '../browser/lib/frontend');
if (fs.existsSync(frontendDir)) {
  const requiredFrontendFiles = ['index.html', 'bundle.js', 'bundle.css'];
  let allFilesExist = true;

  for (const file of requiredFrontendFiles) {
    const filePath = path.join(frontendDir, file);
    if (fs.existsSync(filePath)) {
      logSuccess(`Frontend file: ${file}`);
    } else {
      logWarning(`Missing frontend file: ${file}`);
      allFilesExist = false;
    }
  }

  if (allFilesExist) {
    logSuccess('Theia frontend build found');
  } else {
    logWarning('Theia frontend build incomplete. Run: cd ../browser && npm run build:prod');
  }
} else {
  logWarning('Theia frontend build not found. Run: cd ../browser && npm run build:prod');
}
console.log();

// 5. 检查插件
console.log('5. Checking VSCode plugins...');
const pluginsDir = path.join(__dirname, '../../plugins');
if (fs.existsSync(pluginsDir)) {
  const pluginCount = fs.readdirSync(pluginsDir).filter(f => {
    const pluginPath = path.join(pluginsDir, f);
    return fs.statSync(pluginPath).isDirectory() && !f.startsWith('.');
  }).length;

  if (pluginCount > 0) {
    logSuccess(`Found ${pluginCount} plugins`);
  } else {
    logWarning('No plugins found. Run: cd ../.. && npm run download:plugins');
  }
} else {
  logWarning('Plugins directory not found. Run: cd ../.. && npm run download:plugins');
}
console.log();

// 6. 检查 Cargo 配置
console.log('6. Checking Cargo.toml configuration...');
const cargoPath = path.join(__dirname, 'src-tauri/Cargo.toml');
if (fs.existsSync(cargoPath)) {
  const cargoContent = fs.readFileSync(cargoPath, 'utf8');
  const requiredDeps = ['tauri', 'tokio', 'serde', 'serde_json'];

  for (const dep of requiredDeps) {
    if (cargoContent.includes(dep)) {
      logSuccess(`Cargo dependency: ${dep}`);
    } else {
      logError(`Missing Cargo dependency: ${dep}`);
    }
  }
}
console.log();

// 7. 检查 Tauri 配置
console.log('7. Checking tauri.conf.json configuration...');
const tauriConfigPath = path.join(__dirname, 'src-tauri/tauri.conf.json');
if (fs.existsSync(tauriConfigPath)) {
  try {
    const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));

    if (tauriConfig.bundle?.externalBin?.includes('theia-backend')) {
      logSuccess('Sidecar configured: theia-backend');
    } else {
      logWarning('Sidecar binary not configured in tauri.conf.json');
    }

    if (tauriConfig.app?.windows?.[0]?.title) {
      logSuccess(`Window title: ${tauriConfig.app.windows[0].title}`);
    }

    if (tauriConfig.build?.frontendDist) {
      logSuccess(`Frontend dist: ${tauriConfig.build.frontendDist}`);
    }
  } catch (e) {
    logError(`Failed to parse tauri.conf.json: ${e.message}`);
  }
}
console.log();

// 8. 总结
console.log('====================================');
console.log('Summary');
console.log('====================================');

if (errors === 0 && warnings === 0) {
  console.log('✅ All checks passed! Ready to build.');
  console.log('\nTo build the Tauri application:');
  console.log('1. cd applications/tauri');
  console.log('2. npm run dev (for development) or npm run build (for production)');
} else if (errors === 0) {
  console.log(`✅ Build verification passed with ${warnings} warnings.`);
  console.log('\nYou can proceed with building, but consider fixing warnings for optimal results.');
} else {
  console.log(`❌ Build verification failed with ${errors} errors and ${warnings} warnings.`);
  console.log('\nPlease fix the errors above before attempting to build.');
  process.exit(1);
}
