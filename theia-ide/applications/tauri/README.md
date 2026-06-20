# R-IDE Tauri 桌面版

R-IDE 的 Tauri 桌面应用程序实现，提供更小的包体积和更低的内存占用。

## 技术栈

- **前端**: Eclipse Theia Web UI (React)
- **后端**: Node.js (Theia 后端，使用 pkg 编译为二进制)
- **桌面框架**: Tauri 2.x (Rust)
- **插件系统**: VSCode 扩展支持

## 架构概述

```
Tauri 应用程序
├── WebView 前端 (Theia Web UI)
├── Rust 后端 (系统 API、sidecar 管理)
└── Node.js Sidecar (Theia 后端、插件宿主)
```

## 开发环境设置

### 前置要求

- Node.js >= 22
- Yarn >= 1.7.0
- Rust (通过 rustup)
- Tauri CLI
- pkg (用于编译 Node.js 后端)

### 安装依赖

```bash
# 在项目根目录
cd theia-ide
yarn install
cd applications/tauri
yarn install
```

### 构建前端资源

```bash
# 在项目根目录
cd theia-ide

# 1. 下载插件（首次运行）
yarn download:plugins

# 2. 构建 Theia 前端
yarn browser build:prod

# 3. 构建 Tauri 版本
yarn build:tauri
```

### 开发模式

```bash
# 方式 1: 从项目根目录
yarn tauri:dev

# 方式 2: 进入 tauri 目录
cd applications/tauri
yarn dev
```

开发模式会：
1. 复制前端资源
2. 复制插件
3. 启动 Tauri 开发服务器
4. 启动 Node.js 后端（开发模式，未编译）

### 生产构建

```bash
# 方式 1: 从项目根目录
yarn build:tauri

# 方式 2: 进入 tauri 目录
cd applications/tauri
yarn build:prod
```

生产构建会：
1. 构建完整的 Theia 前端
2. 编译 Node.js 后端为二进制文件
3. 复制所有资源到 Tauri 目录
4. 构建最终的可执行文件

## 可用脚本

### 在项目根目录

- `yarn tauri` - 进入 Tauri 应用目录
- `yarn tauri:dev` - 启动开发模式
- `yarn tauri:build` - 构建生产版本
- `yarn build:tauri` - 完整构建（包括后端编译）

### 在 Tauri 应用目录

- `yarn dev` - 开发模式
- `yarn build` - 生产构建
- `yarn copy:frontend` - 仅复制前端资源
- `yarn copy:plugins` - 仅复制插件
- `yarn copy:all` - 复制所有资源

## 环境变量

### 开发环境

- `RIDE_BACKEND_PATH` - 指定 Node.js 后端路径（用于使用未编译的 Node.js 后端）
- `RIDE_PLUGINS_DIR` - 指定插件目录路径

### 生产环境

生产环境使用内置的 sidecar 和插件，无需设置环境变量。

## 故障排除

### Rust 编译错误

确保 Rust 工具链是最新的：
```bash
rustup update
```

### 前端资源未找到

确保已构建 Theia 前端：
```bash
cd theia-ide
yarn browser build:prod
```

### 插件未加载

确保已下载插件：
```bash
cd theia-ide
yarn download:plugins
```

### 后端启动失败

在开发模式中，可以手动启动后端进行调试：
```bash
cd applications/browser
yarn start
```

## 性能对比

| 指标 | Electron 版 | Tauri 版 | 改进 |
|------|-------------|----------|------|
| 包体积 | ~150 MB | ~50-80 MB | ~50-60% |
| 内存占用 | ~150 MB | ~80-120 MB | ~20-40% |
| 启动时间 | ~3-5s | ~2-4s | ~20% |

## 注意事项

1. **原生模块**: pkg 对某些 Node.js 原生模块的支持有限，可能需要特殊处理
2. **插件兼容性**: 大部分 VSCode 插件应该能正常工作，但依赖特定环境的插件可能有问题
3. **开发调试**: 建议先使用 Electron 版进行开发，Tauri 版主要用于生产部署

## 未来改进

- [ ] 实现更智能的端口发现机制
- [ ] 优化包体积（排除未使用的插件）
- [ ] 添加自动更新功能
- [ ] 改进进程生命周期管理
- [ ] 添加性能监控

## 贡献

欢迎贡献！请参考主项目的贡献指南。

## 许可证

MIT - 与主项目相同
