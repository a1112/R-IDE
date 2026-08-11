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
const tauriFrontendDir = path.resolve(__dirname, './tauri-frontend');

const requiredFiles = [
  'index.html',
  'bundle.js',
  'bundle.css',
];

fs.rmSync(targetDir, { recursive: true, force: true });
fs.rmSync(tauriFrontendDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });
fs.mkdirSync(tauriFrontendDir, { recursive: true });

// 要复制的文件列表
const filesToCopy = [
  ...requiredFiles,
  'plugin-worker.js',
  'editor.worker.js',
  'secondary-window.js',
  'secondary-window.css',
  'favicon.ico',
];

const sourceMapFiles = [
  'bundle.js.map',
  'bundle.css.map',
  'plugin-worker.js.map',
  'editor.worker.js.map',
  'secondary-window.js.map',
  'secondary-window.css.map',
];

if (process.env.RIDE_COPY_SOURCEMAPS === '1') {
  filesToCopy.push(...sourceMapFiles);
}

const missingRequired = requiredFiles.filter(file => !fs.existsSync(path.join(sourceDir, file)));
if (missingRequired.length > 0) {
  console.error('Required Theia frontend build artifacts are missing:');
  missingRequired.forEach(file => console.error(`  - ${path.join(sourceDir, file)}`));
  console.error('\nBuild the browser application first from the app workspace:');
  console.error('  yarn --cwd applications/browser build:prod');
  process.exit(1);
}

// 复制文件
console.log('Copying frontend resources...');
filesToCopy.forEach(file => {
  const sourcePath = path.join(sourceDir, file);
  const targetPath = path.join(targetDir, file);

  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, targetPath);
    console.log(`✓ Copied ${file}`);
  } else {
    console.warn(`- Optional source file not found: ${file}`);
  }
});

// Create the desktop-served frontend with an early locale bootstrap and CSP.
const htmlSource = path.join(sourceDir, 'index.html');
const htmlTarget = path.join(targetDir, 'index.html');

if (fs.existsSync(htmlSource)) {
  let html = fs.readFileSync(htmlSource, 'utf-8');
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

  // The preload template contains a redundant inline favicon script. Removing it
  // lets the desktop frontend enforce script-src without unsafe-inline.
  html = html.replace(
    /\s*<script>\s*if \(document\.head\)[\s\S]*?<\/script>/,
    ''
  );
  html = html.replace('</head>', `${cspMeta}</head>`);
  html = html.replace(
    '    <script type="text/javascript" src="./bundle.js" charset="utf-8"></script>',
    `${localeScript}    <script type="text/javascript" src="./bundle.js" charset="utf-8"></script>`
  );

  fs.writeFileSync(htmlTarget, html);
  console.log('✓ Added desktop CSP and locale bootstrap');
} else {
  console.warn('✗ Source index.html not found');
}

const frontendBootstrap = `(() => {
  'use strict';

  if (window.localStorage.getItem('localeId')) {
    return;
  }

  const requestedLocale = new URLSearchParams(window.location.search).get('ride_locale');
  const languages = [
    requestedLocale,
    ...(Array.isArray(window.navigator.languages) ? window.navigator.languages : []),
    window.navigator.language
  ];
  const language = languages.find(candidate => typeof candidate === 'string' && /^(zh|en)([-_]|$)/i.test(candidate));
  if (language) {
    window.localStorage.setItem('localeId', /^zh/i.test(language) ? 'zh-cn' : 'en');
  }
})();
`;

fs.writeFileSync(path.join(targetDir, 'ride-bootstrap.js'), frontendBootstrap);

const bootstrapHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>R-IDE</title>
  <style>
    html,
    body {
      width: 100%;
      height: 100%;
      margin: 0;
      background: transparent;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .ride-bootstrap {
      position: fixed;
      inset: 0;
      display: grid;
      place-items: center;
      border-radius: 10px;
      background:
        radial-gradient(circle at 22% 0%, rgba(255, 255, 255, 0.16), transparent 34%),
        linear-gradient(180deg, rgba(34, 37, 42, 0.58), rgba(16, 18, 21, 0.72));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.16),
        inset 0 0 0 1px rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(30px) saturate(1.22);
      -webkit-backdrop-filter: blur(30px) saturate(1.22);
    }

    .ride-bootstrap svg {
      width: min(220px, 18vw);
      min-width: 150px;
      height: auto;
      animation: ride-pulse 1.8s ease-in-out infinite;
      filter:
        drop-shadow(0 22px 42px rgba(0, 0, 0, 0.24))
        invert(49%) sepia(71%) saturate(5980%) hue-rotate(199deg) brightness(103%) contrast(101%);
    }

    @keyframes ride-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(0.92); opacity: 0.82; }
    }
  </style>
</head>
<body>
  <main class="ride-bootstrap" aria-label="Loading R-IDE">
    <svg id="spinner" version="1.1" xmlns="http://www.w3.org/2000/svg"
      xmlns:xlink="http://www.w3.org/1999/xlink" x="0" y="0" preserveAspectRatio="xMinYMin meet"
      viewBox="0, 0, 1150, 540.6">
      <g id="Layer_1" fill="#FFFFFF">
        <path d="M880.199,2.8 C1028.1,2.8 1147.9,122.6 1147.9,270.5 C1147.9,418.3 1028.1,538.2 880.2,538.2 L290.1,538.2 C269,538.2 251.9,521.1 251.9,500 C251.9,478.9 269,461.8 290.1,461.8 L427.6,461.8 C448.6,461.8 465.7,444.7 465.7,423.6 C465.7,402.5 448.6,385.4 427.6,385.4 L396.999,385.4 C375.9,385.4 358.8,368.3 358.8,347.2 C358.8,326.1 375.9,309 397,309 L488.703,309 C509.918,308.941 526.373,291.65 526.9,270.8 C526.9,249.7 509.8,232.6 488.7,232.6 L167.8,232.6 C146.7,232.6 129.6,215.5 129.6,194.4 C129.6,173.3 146.7,156.2 167.8,156.2 L404.604,156.2 C425.818,156.141 442.273,138.85 442.8,118 C442.8,96.9 425.7,79.8 404.6,79.8 L351.2,79.8 C330.1,79.8 313,62.7 313,41.6 C313,20.5 330.1,2.4 351.2,2.4 L880.199,2.8 z M837.4,92 L837.4,92 C755.2,92 688.7,158.6 688.7,240.7 L688.7,300.2 C688.7,382.4 755.2,448.9 837.4,448.9 C919.5,448.9 986.1,382.4 986.1,300.2 L986.1,240.7 C986.1,158.6 919.5,92 837.4,92 L837.4,92 z M888.2,232.6 C908,232.6 924.1,248.7 924.1,268.5 L924.1,273.1 C924.1,292.9 908,309 888.2,309 L776.6,309 C756.8,309 740.7,292.9 740.7,273.1 L740.7,268.5 C740.7,248.7 756.8,232.6 776.6,232.6 L888.2,232.6 z" />
        <path d="M170.1,461.8 C190,461.8 206,477.8 206,497.7 L206,502.3 C206,522.1 190,538.2 170.1,538.2 L38,538.2 C18.2,538.2 2.1,522.1 2.1,502.3 L2.1,497.7 C2.1,477.8 18.2,461.8 38,461.8 L170.1,461.8 z" />
        <path d="M231.3,3.4 C251.1,3.4 267.1,19.5 267.1,39.3 L267.1,44 C267.1,63.8 251.1,79.8 231.3,79.8 L83.8,79.8 C64,79.8 47.9,63.8 47.9,44 L47.9,39.3 C47.9,19.5 64,3.4 83.8,3.4 L231.3,3.4 z" />
        <path d="M277.1,309 C296.9,309 313,325.1 313,344.9 L313,349.5 C313,369.3 296.9,385.4 277.1,385.4 L196.1,385.4 C176.3,385.4 160.2,369.3 160.2,349.5 L160.2,344.9 C160.2,325.1 176.3,309 196.1,309 L277.1,309 z" />
      </g>
    </svg>
  </main>
  <script src="./bootstrap.js"></script>
</body>
</html>`;

fs.writeFileSync(path.join(tauriFrontendDir, 'index.html'), bootstrapHtml);
const tauriBootstrapScript = `(() => {
  'use strict';

  const target = new URL('http://127.0.0.1:3000/');
  const languages = Array.isArray(window.navigator.languages)
    ? window.navigator.languages
    : [window.navigator.language];
  const language = languages.find(candidate => typeof candidate === 'string' && candidate.length > 0);
  if (language) {
    target.searchParams.set('ride_locale', language);
  }

  const openBackend = async () => {
    try {
      await fetch(target.origin, {
        cache: 'no-store',
        mode: 'no-cors'
      });
      window.location.replace(target.href);
    } catch {
      window.setTimeout(openBackend, 250);
    }
  };

  window.setTimeout(openBackend, 100);
})();
`;

fs.writeFileSync(path.join(tauriFrontendDir, 'bootstrap.js'), tauriBootstrapScript);
console.log('✓ Created Tauri bootstrap frontend');

console.log('Frontend resources copied successfully!');
console.log('Source:', sourceDir);
console.log('Target:', targetDir);
console.log('Bootstrap:', tauriFrontendDir);
