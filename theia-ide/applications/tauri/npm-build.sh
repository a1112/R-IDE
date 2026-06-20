#!/bin/bash
/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

# R-IDE Tauri 构建脚本 (使用 npm)
# 此脚本使用 npm 代替 yarn 来构建 Tauri 应用

set -e  # 遇到错误立即退出

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "===================================="
echo "R-IDE Tauri Build (npm version)"
echo "===================================="
echo

# 检查前置条件
echo "Checking prerequisites..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}ERROR: Node.js not found${NC}"
    exit 1
fi

if ! command -v rustc &> /dev/null; then
    echo -e "${RED}ERROR: Rust not found${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Prerequisites OK${NC}"
echo

# 安装 npm 依赖
echo "Installing npm dependencies..."
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo

# 复制前端资源
echo "Copying frontend resources..."
node copy-frontend.js
echo -e "${GREEN}✓ Frontend copied${NC}"
echo

# 复制插件
echo "Copying plugins..."
node copy-plugins.js
echo -e "${GREEN}✓ Plugins copied${NC}"
echo

# 安装 Tauri CLI（如果需要）
if ! npm list -g @tauri-apps/cli &> /dev/null; then
    echo "Installing Tauri CLI globally..."
    npm install -g @tauri-apps/cli
fi

# 构建 Tauri 应用
echo "Building Tauri application..."
npm run build

echo
echo -e "${GREEN}===================================="
echo "Build completed successfully!"
echo "====================================${NC}"
echo
echo "Output location: src-tauri/target/release/bundle/"
