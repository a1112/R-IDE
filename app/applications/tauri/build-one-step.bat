/********************************************************************************
 * Copyright (C) 2026 R-IDE contributors.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

@echo off
REM R-IDE Tauri 一键构建脚本 (Windows)
REM 此脚本会从项目根目录开始执行完整的构建流程

echo ====================================
echo R-IDE Tauri Desktop Build Script
echo ====================================
echo.

REM 切换到项目根目录
cd "%~dp0..\..\.."

echo [1/5] Checking prerequisites...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js not found. Please install Node.js >= 22
    exit /b 1
)

where yarn >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Yarn not found. Please install Yarn
    exit /b 1
)

where rustc >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Rust not found. Please install Rust via rustup
    exit /b 1
)

echo ✓ Prerequisites checked
echo.

echo [2/5] Installing dependencies...
if not exist "node_modules" (
    call yarn install
    echo ✓ Dependencies installed
) else (
    echo ✓ Dependencies already installed
)
echo.

echo [3/5] Downloading plugins...
if not exist "plugins" (
    call yarn download:plugins
    echo ✓ Plugins downloaded
) else (
    echo ✓ Plugins already downloaded
)
echo.

echo [4/5] building Theia frontend...
call yarn browser build:prod
if %ERRORLEVEL% neq 0 (
    echo ERROR: Frontend build failed
    exit /b 1
)
echo ✓ Frontend built
echo.

echo [5/5] Building Tauri application...
cd applications\tauri
call yarn build:prod
if %ERRORLEVEL% neq 0 (
    echo ERROR: Tauri build failed
    exit /b 1
)
echo.

echo ====================================
echo Build completed successfully!
echo ====================================
echo.
echo Output location: applications\tauri\src-tauri\target\release\bundle\
echo.

pause
