# Tauri packaged interaction smoke 操作手册

本手册用于对真实 R-IDE Tauri 打包程序执行有界、可审计的 IDE 交互检查。命令与 [`app/package.json`](../app/package.json) 的 `smoke:tauri-packaged` 脚本以及 [`run-tauri-packaged-smoke.mjs`](../app/scripts/run-tauri-packaged-smoke.mjs) 的实际参数解析保持一致。

## 它验证什么

Packaged interaction smoke 与另外两类检查不同：

| 检查 | 作用 | 不证明什么 |
| --- | --- | --- |
| Profile inventory / static package validation | 校验资源、构建 profile manifest、插件 inventory 和 smoke contract | 不证明窗口、sidecar 或 IDE 操作真实可用 |
| Startup measurement | 启动真实包，测量启动里程碑和进程树指标 | 不执行完整 IDE 功能序列 |
| Packaged interaction smoke | 启动真实包并执行固定 IDE 操作，验证报告、日志、退出和进程清理 | 不代表其他 OS、其他 profile 或其他场景也已通过 |

## Windows 前置条件

真实交互 smoke 当前要求 Windows，并需要可用的交互式桌面会话。运行前准备 Node.js 22+、Yarn 1.x、Rust stable、Git、Visual Studio C++ Build Tools、Windows SDK 和 WebView2 Runtime。

在仓库的 `app` 目录安装依赖并下载插件：

```powershell
cd app
yarn install --frozen-lockfile
yarn download:plugins
```

`yarn download:plugins` 是构建前置。CI 也在构建前执行这一步。构建脚本会从 `app/plugins` 生成打包 smoke 插件 inventory；目录缺失、插件不是规范的直接子目录、manifest 非 canonical、插件重复或缺少批准的零参数命令时会 fail closed，常见错误为：

```text
packaged plugin inventory is not canonical
```

不要跳过 `generate:packaged-smoke-plugin` 或手改生成文件来绕过该校验。

## 场景与 profile 绑定

| 场景 | profile | 文件 | 动作 |
| --- | --- | ---: | --- |
| `critical-file` | `tauri-critical` | 2 | `editor-save`、`terminal-sentinel`、`workspace-search`、`scm-status`、`packaged-plugin-command`、`secondary-window`、`second-file-forwarding` |
| `critical-empty` | `tauri-critical` | 0 | `terminal-sentinel`、`packaged-plugin-command` |
| `full-file` | `full` | 2 | 与 `critical-file` 相同的七步序列 |

runner 会先读取 package metadata 并校验 profile。Rust、Node 和前端还会再次严格校验场景、文件数与动作顺序；任何错配都会拒绝协议，而不是降级运行部分动作。

## 本地命令

以下命令均从 `app` 目录运行。

### `critical-file`

```powershell
$env:RIDE_TAURI_FRONTEND_PROFILE = 'tauri-critical'
npm run build:tauri
npm --workspace applications/tauri run verify
npm run verify:tauri-profile -- --expected-smoke-scenario critical-file
npm run smoke:tauri-packaged -- --scenario critical-file
```

### `critical-empty`

可复用同一个 `tauri-critical` 构建：

```powershell
npm run verify:tauri-profile -- --expected-smoke-scenario critical-empty
npm run smoke:tauri-packaged -- --scenario critical-empty
```

### `full-file`

切换 profile 后必须重新构建：

```powershell
$env:RIDE_TAURI_FRONTEND_PROFILE = 'full'
npm run build:tauri
npm --workspace applications/tauri run verify
npm run verify:tauri-profile -- --expected-smoke-scenario full-file
npm run smoke:tauri-packaged -- --scenario full-file
```

这些命令只是操作说明；本文不把尚未实际运行的本地场景预先记录为通过。

## Runner 参数

runner 没有 `--help` 选项。支持的参数如下：

- `--scenario critical-file|critical-empty|full-file`：必填。
- `--output <json-path>`：最终报告路径；默认是当前目录的 `tauri-packaged-smoke.json`。
- `--timeout-ms <integer>`：每个受控阶段的超时，默认 `30000`，允许 `1000` 到 `300000`。
- `--bundle-root <path>`：可执行文件发现根目录；默认是 `applications/tauri/src-tauri/target`。
- `--executable <path>`：显式指定真实打包可执行文件。
- `--keep-workspace`：保留该次 runner 拥有的临时工作区用于本地排障。

`--bundle-root` 与 `--executable` 互斥，重复参数、未知参数和缺值都会失败。自定义报告示例：

```powershell
npm run smoke:tauri-packaged -- --scenario critical-file --output applications/tauri/src-tauri/target/release/bundle/smoke-diagnostics/critical-file.json --timeout-ms 60000
```

## 报告与失败诊断

成功时，runner 原子写入 `--output` 指定的 JSON，schema 为 `ride.tauri-packaged-smoke@1`，并删除同 stem 的旧 failure pointer。应检查至少以下字段：

- `scenario` 和 `profile` 与本次命令匹配。
- `status` 为 `passed`。
- `steps` 按场景规定顺序记录 started/passed 转换。
- `durationMs` 是该次运行数据，不是跨机器性能基线。

失败时，runner 在 output 同目录创建：

```text
<stem>.failure.json
<stem>-diagnostics-<uuid>/
```

`<stem>.failure.json` 是小型 pointer，其 `diagnostics.directory` 指向本次唯一的诊断目录。目录可包含 `failure.json`、受大小限制的 stdout/stderr 日志和已产生的协议报告。错误会保留 primary failure，并聚合 process cleanup、diagnostic preservation 或 workspace cleanup 问题。

诊断文本、CLI 路径和已识别敏感值会脱敏；CI 仅在失败时上传 smoke diagnostics，保留期为 7 天。即使已脱敏，仍应按内部诊断资料处理，不要公开发布。

## 安全边界

- runner 为每次运行生成高熵 authority token；原始 token 只通过 `RIDE_TAURI_SMOKE_TOKEN` 注入受控子进程环境。
- spec 只保存 token 的 SHA-256；最终报告、failure pointer 和诊断不得包含原始 token。runner 还会拒绝 token 出现在捕获日志中。
- runner 拒绝从父环境继承 `RIDE_TAURI_SMOKE_SPEC`、`RIDE_TAURI_SMOKE_REPORT` 或 `RIDE_TAURI_SMOKE_TOKEN`，避免复用旧授权。
- 普通启动未设置这三个变量时，Rust smoke 协议为 `disabled`，前端不会解析或执行 smoke actions；部分变量、无效 spec 或上下文错配会进入 `rejected`，不会降级为普通 smoke。
- 不要手工设置上述三个环境变量，也不要把 smoke authority 文件用于其他程序。

`--keep-workspace` 仅用于本机排障。它会保留 runner 在系统临时目录创建、带 owner marker 的 `ride-tauri-smoke-*` 根目录；不要共享或上传整个目录。默认情况下 runner 只会删除路径、owner schema 和 run ID 均验证通过的直属临时目录，否则 fail closed 并报告 workspace cleanup failure。

## 超时、关闭与残留进程

每个启动、转发、最终报告和优雅退出阶段都使用有界 deadline。场景成功后 runner 请求主窗口优雅关闭，等待实例退出，再按已验证的进程身份、Windows containment 和运行 marker 清理受控进程树；之后校验日志中没有 sidecar 启动失败或 authority token。

任何阶段失败仍会尝试保存诊断、清理所有已启动实例和临时工作区。若错误包含 `process cleanup failure (owned processes may remain)`，不要把结果视为通过：

1. 根据诊断确认本次 run 的 R-IDE、sidecar 和插件宿主 PID。
2. 检查任务管理器中的 R-IDE 整体进程树。
3. 只在核对进程身份后手工结束残留进程。
4. 修复清理原因并重新运行；不要复用共享开发实例。

## CI 操作范围

两个 workflow 都提供 boolean `workflow_dispatch` 输入 `run_windows_packaged_smoke`，默认 `false`：

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) 在既有 Windows package matrix 完成 package verify 与 `tauri-critical` profile 校验后，手动运行 `critical-file`。
- [`.github/workflows/tauri.yml`](../.github/workflows/tauri.yml) 使用独立的 Windows full-profile job 构建并手动运行 `full-file`。

在 GitHub Actions 页面选择对应 workflow，点击 **Run workflow**，勾选 `run_windows_packaged_smoke` 后启动。`critical-empty` 当前没有独立的真实交互 CI 步骤，可按本地命令执行。

在 packaged interaction smoke 维度，macOS/Linux CI 只执行 package、profile inventory 和 smoke contract 的 non-interactive 静态验证，不宣称交互成功。workflow 中明确配置的 startup measurement 属于另一验证层级，也不能替代交互 smoke；托管 runner 的性能数据不与本地历史基线直接比较。

构建前置和常见错误另见 [Tauri 构建与验证指南](../app/TAURI-BUILD-GUIDE.md)，实现覆盖见 [Tauri 实现状态](../app/TAURI-IMPLEMENTATION-STATUS.md)。
