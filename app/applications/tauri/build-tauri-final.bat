@echo off
setlocal enabledelayedexpansion

echo ========================================
echo R-IDE Tauri Complete Build
echo ========================================
echo.

REM 检查 Node.js
where node >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not found. Please install Node.js 22 or higher.
    pause
    exit /b 1
)

echo Step 1: Building Node.js backend...
cd /d "%~dp0..\.."
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)

call npm run build
if errorlevel 1 (
    echo ERROR: npm run build failed
    pause
    exit /b 1
)

cd applications\browser

REM 检测 Rust 工具链类型
rustc --version -v >nul 2>&1
if errorlevel 1 (
    echo ERROR: Rust not found. Please install Rust.
    pause
    exit /b 1
)

REM 获取 Rust host triple
for /f "tokens=2" %%i in ('rustc --version -v ^| find "host"') do set RUST_HOST=%%i

REM 转换 GNU 到 pkg 格式
set "PKG_TARGET=node22-win-x64"
set "EXE_NAME=theia-backend"

if "!RUST_HOST!"=="x86_64-pc-windows-msvc" (
    set "EXE_NAME=!EXE_NAME!-x86_64-pc-windows-msvc.exe"
) else if "!RUST_HOST!"=="x86_64-pc-windows-gnu" (
    set "EXE_NAME=!EXE_NAME!-x86_64-pc-windows-gnu.exe"
) else (
    echo WARNING: Unknown Rust host: !RUST_HOST!
    echo Using default: theia-backend.exe
    set "EXE_NAME=!EXE_NAME!.exe"
)

echo Found Rust host: !RUST_HOST!
echo Building backend as: !EXE_NAME!

REM 创建 bin 目录
if not exist "..\tauri\src-tauri\bin" mkdir "..\tauri\src-tauri\bin"

REM 编译 Node.js 后端
npx pkg lib/backend/main.js -t !PKG_TARGET! -o "../tauri/src-tauri/bin/!EXE_NAME!"
if errorlevel 1 (
    echo ERROR: pkg build failed
    pause
    exit /b 1
)

echo.
echo Step 2: Building Tauri application...
cd ..\tauri

call npm install --legacy-peer-deps
if errorlevel 1 (
    echo ERROR: Tauri npm install failed
    pause
    exit /b 1
)

call npm run tauri build
if errorlevel 1 (
    echo ERROR: Tauri build failed
    pause
    exit /b 1
)

echo.
echo ========================================
echo Build Complete!
echo ========================================
echo.
echo Executable: src-tauri\target\release\ride-tauri.exe
echo.
echo Bundle location:
dir /b src-tauri\target\release\bundle\*.exe 2>nul
dir /b src-tauri\target\release\bundle\*.msi 2>nul
echo.
echo To run the application:
echo   src-tauri\target\release\ride-tauri.exe
echo.
pause
