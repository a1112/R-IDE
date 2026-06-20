/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * 前端资源复制脚本
 *
 * 从 browser 应用的构建产物复制前端资源到 Tauri 应用目录
 */

const fs = require('fs');
const path = require('path');

const sourceDir = path.resolve(__dirname, '../browser/lib/frontend');
const targetDir = path.resolve(__dirname, './browser-frontend');

// 确保目标目录存在
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

// 要复制的文件列表
const filesToCopy = [
  'index.html',
  'bundle.js',
  'bundle.css',
  'bundle.js.map',
  'bundle.css.map',
  'plugin-worker.js',
  'plugin-worker.js.map',
  'editor.worker.js',
  'editor.worker.js.map',
  'secondary-window.js',
  'secondary-window.js.map',
  'secondary-window.css',
  'secondary-window.css.map',
  'favicon.ico',
];

// 复制文件
console.log('Copying frontend resources...');
filesToCopy.forEach(file => {
  const sourcePath = path.join(sourceDir, file);
  const targetPath = path.join(targetDir, file);

  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
    console.log(`✓ Copied ${file}`);
  } else {
    console.warn(`✗ Source file not found: ${file}`);
  }
});

// 创建修改后的 index.html
const htmlSource = path.join(sourceDir, 'index.html');
const htmlTarget = path.join(targetDir, 'index.html');

if (fs.existsSync(htmlSource)) {
  let html = fs.readFileSync(htmlSource, 'utf-8');

  // 注入 Tauri 配置脚本
  const tauriScript = `
  <script>
    // R-IDE Tauri 前端配置
    window.RIDE_TAURI = true;
    window.RIDE_BACKEND_PORT = null; // 将由 Tauri 设置

    // 监听来自 Tauri 的后端就绪事件
    window.addEventListener('DOMContentLoaded', () => {
      // 如果在 Tauri 环境中，请求后端端口
      if (window.__TAURI__) {
        window.__TAURI__.core.invoke('get_backend_port')
          .then(port => {
            if (port) {
              window.RIDE_BACKEND_PORT = port;
              console.log('[R-IDE] Backend port:', port);
              // 这里可以配置 API 基础路径
              // 例如：window.API_BASE = \`http://localhost:\${port}\`;
            }
          })
          .catch(err => console.error('[R-IDE] Failed to get backend port:', err));
      }
    });

    // 监听后端日志事件（用于调试）
    if (window.__TAURI__) {
      window.__TAURI__.event.listen('backend-log', (event) => {
        console.log('[Backend]', event.payload);
      });

      window.__TAURI__.event.listen('backend-error', (event) => {
        console.error('[Backend Error]', event.payload);
      });

      window.__TAURI__.event.listen('backend-ready', (event) => {
        console.log('[Backend Ready on port]', event.payload);
        window.RIDE_BACKEND_PORT = event.payload;
        // 可以在这里重新加载或通知应用
        window.dispatchEvent(new CustomEvent('backend-ready', {
          detail: { port: event.payload }
        }));
      });
    }
  </script>
  </head>`;

  html = html.replace('</head>', tauriScript);

  fs.writeFileSync(htmlTarget, html);
  console.log('✓ Modified index.html for Tauri');
} else {
  console.warn('✗ Source index.html not found');
}

console.log('Frontend resources copied successfully!');
console.log('Source:', sourceDir);
console.log('Target:', targetDir);
