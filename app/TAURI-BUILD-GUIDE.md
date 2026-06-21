# R-IDE Tauri 版本构建指南

本文档描述如何为 R-IDE 项目构建 Tauri 桌面版本。

## 快速开始

### 一键构建（推荐）

#### Windows
```cmd
cd applications\tauri
build-one-step.bat
```

#### Linux/macOS
```bash
cd applications/tauri
chmod +x build-one-step.sh
./build-one-step.sh
```

### 手动构建步骤

1. **安装依赖**
```bash
cd theia-ide
yarn install
cd applications/tauri
yarn install
```

2. **下载 VSCode 插件**
```bash
cd theia-ide
yarn download:plugins
```

3. **构建 Theia 前端**
```bash
cd theia-ide
yarn browser build:prod
```

4. **构建 Tauri 应用**
```bash
cd theia-ide
yarn build:tauri
```

## 开发模式

启动开发模式（热重载支持）：
```bash
cd theia-ide
yarn tauri:dev
```

## 输出位置

构建完成后，可执行文件位于：
- **Windows**: `applications/tauri/src-tauri/target/release/bundle/msi/`
- **macOS**: `applications/tauri/src-tauri/target/release/bundle/dmg/`
- **Linux**: `applications/tauri/src-tauri/target/release/bundle/deb/` 或 `appimage/`

## 环境要求

### 必需项
- **Node.js** >= 22
- **Yarn** >= 1.7.0
- **Rust** (通过 rustup 安装)
- **系统依赖**:
  - Windows: Visual Studio C++ Build Tools
  - Linux: `webkit2gtk`, `libayatana-appindicator`, `librsvg`
  - macOS: Xcode Command Line Tools

### 可选项
- **pkg** (用于编译 Node.js 后端为二进制)

## 性能对比

与 Electron 版本相比：

| 指标 | Electron | Tauri | 改进 |
|------|----------|-------|------|
| 安装包大小 | ~150 MB | ~50-80 MB | 50-60% ⬇️ |
| 内存占用 | ~150 MB | ~80-120 MB | 20-40% ⬇️ |
| 启动时间 | ~3-5s | ~2-4s | ~20% ⬆️ |

## 故障排除

### Rust 编译失败
```bash
rustup update
rustup target add x86_64-pc-windows-msvc  # Windows
```

### 前端构建失败
```bash
cd theia-ide
yarn browser clean
yarn browser build:prod
```

### 插件未加载
```bash
cd theia-ide
rm -rf plugins
yarn download:plugins
```

### 后端编译失败
pkg 可能无法完美处理所有原生模块。如遇问题：
1. 使用开发模式（不编译后端）
2. 或检查原生模块的兼容性

## 架构说明

Tauri 版本使用三层架构：

1. **WebView 层**: Theia 前端 UI
2. **Rust 层**: Tauri 桌面框架 + 系统调用
3. **Sidecar 层**: Node.js 后端（pkg 编译）

这种架构提供了：
- ✅ 更小的包体积
- ✅ 更低的内存占用
- ✅ 原生性能
- ✅ 完整的 IDE 功能
- ✅ VSCode 插件支持

## 已知限制

1. **原生模块**: pkg 对某些原生模块支持有限
2. **插件兼容性**: 极少数依赖特定 Electron API 的插件可能不工作
3. **首次构建**: 第一次构建需要较长时间（下载 Rust 依赖）

## 贡献

欢迎贡献改进！请参考主项目的贡献指南。
