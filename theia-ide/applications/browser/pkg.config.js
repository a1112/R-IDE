/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * pkg 配置文件 - 用于将 Theia 后端编译为独立可执行文件
 *
 * 注意：pkg 对原生模块支持有限，Theia 使用的原生模块可能需要特殊处理
 */

module.exports = {
  // 入口文件
  input: './lib/backend/main.js',

  // 输出配置
  output: 'dist',

  // 目标平台
  targets: [
    'node22-win-x64',
    'node22-linux-x64',
    'node22-macos-x64',
  ],

  // 可选：指定输出文件名
  name: 'theia-backend',

  // 打包配置
  options: {
    // 包含的资产文件
    assets: [
      'node_modules/@theia/**/*',
      'plugins/**/*',
    ],

    // 排除的文件
    exclude: [
      'node_modules/**/*.md',
      'node_modules/**/*.map',
      'node_modules/**/*.ts',
      'node_modules/**/test/**',
      'node_modules/**/tests/**',
    ],

    // 脚本配置
    script: './lib/backend/main.js',
  },

  // pkg 特定配置
  pkg: {
    // 原生模块处理
    native: [
      'node_modules/@theia/*/native/**',
      'node_modules/keytar/**',
      'node_modules/watcher/**',
      'node_modules/drivelist/**',
    ],

    // 公开配置
    public: [
      'package.json',
      'node_modules/@theia/**/*',
    ],

    // 忽略路径
    ignore: [
      'node_modules/**/*.test.js',
      'node_modules/**/*.spec.js',
    ],
  },

  // 环境变量
  env: {
    NODE_ENV: 'production',
    THEIA_APP: 'theia-ide-browser-app',
  },

  // 后处理钩子
  hooks: {
    // 编译前
    prebuild: 'echo "Starting pkg build..."',

    // 编译后
    postbuild: 'echo "pkg build completed. Note: Native modules may need manual intervention."',
  },
};
