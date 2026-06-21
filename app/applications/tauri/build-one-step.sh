#!/bin/bash
/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

# R-IDE Tauri 一键构建脚本 (Linux/macOS)
# 此脚本会从项目根目录开始执行完整的构建流程

set -e  # 遇到错误立即退出

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# 切换到项目根目录
cd "$(dirname "$0")/../../.."

echo "===================================="
echo "R-IDE Tauri Desktop Build Script"
echo "===================================="
echo

# 检查前置条件
echo "[1/5] Checking prerequisites..."
if ! command -v node &> /dev/null; then
    echo -e "${RED}ERROR: Node.js not found. Please install Node.js >= 22${NC}"
    exit 1
fi

if ! command -v yarn &> /dev/null; then
    echo -e "${RED}ERROR: Yarn not found. Please install Yarn${NC}"
    exit 1
fi

if ! command -v rustc &> /dev/null; then
    echo -e "${RED}ERROR: Rust not found. Please install Rust via rustup${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Prerequisites checked${NC}"
echo

# 安装依赖
echo "[2/5] Installing dependencies..."
if [ ! -d "node_modules" ]; then
    yarn install
    echo -e "${GREEN}✓ Dependencies installed${NC}"
else
    echo -e "${GREEN}✓ Dependencies already installed${NC}"
fi
echo

# 下载插件
echo "[3/5] Downloading plugins..."
if [ ! -d "plugins" ]; then
    yarn download:plugins
    echo -e "${GREEN}✓ Plugins downloaded${NC}"
else
    echo -e "${GREEN}✓ Plugins already downloaded${NC}"
fi
echo

# 构建 Theia 前端
echo "[4/5] Building Theia frontend..."
yarn browser build:prod
echo -e "${GREEN}✓ Frontend built${NC}"
echo

# 构建 Tauri 应用
echo "[5/5] Building Tauri application..."
cd applications/tauri
yarn build:prod
cd ../..
echo

echo "===================================="
echo -e "${GREEN}Build completed successfully!${NC}"
echo "===================================="
echo
echo "Output location: applications/tauri/src-tauri/target/release/bundle/"
echo

# 使脚本可执行
chmod +x "$(dirname "$0")/build-one-step.sh"
