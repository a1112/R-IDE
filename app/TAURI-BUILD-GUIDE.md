# R-IDE Tauri 构建与验证指南

本文说明如何构建 Tauri 桌面版，以及如何区分静态产物校验、启动测量和真实交互 smoke。命令默认从仓库的 `app` 目录执行。

## 环境要求

- Node.js 22 或更高版本。
- Yarn 1.x。
- Rust stable（通过 rustup 安装）。
- Git；packaged smoke 会创建临时 Git 工作区。
- Windows：Visual Studio C++ Build Tools、Windows SDK 和可用的 WebView2 Runtime。
- macOS：Xcode Command Line Tools。
- Linux：项目所需的 WebKitGTK、AppIndicator 和 SVG 系统依赖。

真实 packaged interaction smoke 目前以 Windows 桌面会话为支持范围。它必须能显示和控制真实窗口；无交互桌面、服务会话或纯静态产物检查不等价。

## 首次准备

```powershell
cd app
yarn install --frozen-lockfile
yarn download:plugins
```

`yarn download:plugins` 是新工作树的必要步骤，不只是可选资源下载。`npm run build:tauri` 会先运行 `generate:packaged-smoke-plugin`，从 `app/plugins` 的已解包 manifest 生成可信 inventory。目录缺失或内容非 canonical 时构建会 fail closed，例如：

```text
packaged plugin inventory is not canonical
```

CI 在构建前也执行 `yarn download:plugins`。遇到此错误时应重新下载并检查插件目录，不要跳过生成器，也不要手工伪造生成的 inventory。

## 构建 profile

默认关键 profile：

```powershell
$env:RIDE_TAURI_FRONTEND_PROFILE = 'tauri-critical'
npm run build:tauri
```

显式 full profile：

```powershell
$env:RIDE_TAURI_FRONTEND_PROFILE = 'full'
npm run build:tauri
```

每次切换 profile 后必须重新构建。构建链会生成 smoke 插件 inventory、构建 R-IDE 扩展与 sidecar、复制 Tauri 资源并运行生产 Tauri build。

可执行文件和 bundle 位于：

```text
applications/tauri/src-tauri/target/release/
applications/tauri/src-tauri/target/release/bundle/
```

runner 默认从 `applications/tauri/src-tauri/target` 发现当前平台的可执行文件；也可显式传入 `--bundle-root` 或 `--executable`，二者互斥。

## 三类验证不要混用

### 1. Profile inventory / static package validation

```powershell
npm --workspace applications/tauri run verify
npm run verify:tauri-profile -- --expected-profile tauri-critical
```

full 构建对应：

```powershell
npm run verify:tauri-profile -- --expected-profile full
```

这些命令校验构建资源、manifest 和 profile inventory，不启动完整 IDE 交互，因此不能声明交互 smoke 成功。

也可以把 profile 与场景绑定一起校验：

```powershell
npm run verify:tauri-profile -- --expected-smoke-scenario critical-file
npm run verify:tauri-profile -- --expected-smoke-scenario critical-empty
npm run verify:tauri-profile -- --expected-smoke-scenario full-file
```

### 2. Startup measurement

```powershell
npm run measure:tauri-startup -- --runs 5 --output applications/tauri/src-tauri/target/release/bundle/startup-metrics-windows-x64.json
```

启动测量会启动真实打包程序，记录里程碑与进程角色指标，并清理测量进程树；它不执行编辑器、终端、搜索、SCM、插件、辅助窗口和第二文件转发的完整 smoke 序列。不同机器或不同构建的结果不应直接作为性能回归结论。

### 3. Packaged interaction smoke

真实交互命令、报告格式、安全限制和 CI 范围见 [Packaged smoke 操作手册](../docs/desktop-packaged-smoke.md)。最小示例：

```powershell
npm run smoke:tauri-packaged -- --scenario critical-file
```

只有生成 `status: "passed"` 的最终 JSON，并完成日志校验与进程清理，才表示该次场景通过。

## 开发模式

```powershell
npm run tauri:dev
```

开发模式用于日常调试，不等价于 production package 验证，也不满足 packaged interaction smoke 的证据要求。

## 故障排除

### `packaged plugin inventory is not canonical`

确认命令在 `app` 目录运行，然后执行：

```powershell
yarn download:plugins
npm run generate:packaged-smoke-plugin
```

如果仍失败，检查 `app/plugins` 是否完整解包、目录名是否与 extension manifest 身份一致，以及是否存在符号链接、junction、重复插件或损坏 manifest。生成器有意 fail closed。

### `Failed to start backend` / `Backend process exited before ready`

先确认构建链成功生成并复制 sidecar、前端资源和插件，然后运行静态 package verify。真实 smoke 失败时使用 `.failure.json` pointer 定位脱敏诊断目录，不要只依据顶层退出码判断原因。

### Profile 与场景不匹配

`critical-file`、`critical-empty` 只接受 `tauri-critical`；`full-file` 只接受 `full`。设置 `RIDE_TAURI_FRONTEND_PROFILE` 后重新构建，再运行对应 profile 校验。

### 运行超时或窗口未关闭

runner 对每个阶段使用有界超时，随后尝试优雅关闭并清理受跟踪的进程树。失败报告包含 cleanup 分类时，应检查是否仍有该次 R-IDE/sidecar 子进程；确认后再手工结束残留进程。不要把共享开发实例作为 smoke 的目标。

## CI 范围

GitHub Actions 的 Windows 真实交互 smoke 只在手动 `workflow_dispatch` 且 `run_windows_packaged_smoke=true` 时运行。普通 push/PR 仍保留跨平台 package/profile/contract 校验。在 packaged interaction smoke 维度，macOS/Linux 只运行 non-interactive 静态验证，不宣称完整交互成功；startup measurement 也不能替代交互 smoke。

当前实现状态见 [Tauri 实现状态](TAURI-IMPLEMENTATION-STATUS.md)。
