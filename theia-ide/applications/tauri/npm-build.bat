/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

@echo off
REM R-IDE Tauri 构建脚本 (使用 npm)
REM 此脚本使用 npm 代替 yarn 来构建 Tauri 应用

setlocal enabledelayedexpansion

echo ====================================
echo R-IDE Tauri Build (npm version)
echo ====================================
echo.

REM 检查前置条件
echo Checking prerequisites...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js not found
    exit /b 1
)

where rustc >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Rust not found
    exit /b 1
)

echo [OK] Prerequisites OK
echo.

REM 安装 npm 依赖
echo Installing npm dependencies...
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: npm install failed
    exit /b 1
)
echo [OK] Dependencies installed
echo.

REM 复制前端资源
echo Copying frontend resources...
call node copy-frontend.js
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to copy frontend
    exit /b 1
)
echo [OK] Frontend copied
echo.

REM 复制插件
echo Copying plugins...
call node copy-plugins.js
if %ERRORLEVEL% neq 0 (
    echo ERROR: Failed to copy plugins
    exit /b 1
)
echo [OK] Plugins copied
echo.

REM 构建 Tauri 应用
echo Building Tauri application...
call npm run build
if %ERRORLEVEL% neq 0 (
    echo ERROR: Tauri build failed
    exit /b 1
)

echo.
echo ====================================
echo Build completed successfully!
echo ====================================
echo.
echo Output location: src-tauri\target\release\bundle\

pause
