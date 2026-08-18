# R-IDE Tauri 实现状态

本文只记录代码与自动化中可复核的状态。真实 Windows 打包程序的本地交互结果应由实际运行产生的 JSON 报告确认，不以静态检查或预期性能数字代替。

## 当前状态

Tauri 桌面架构、sidecar 生命周期、无边框窗口、平台化窗口按钮、启动测量、profile inventory 和 packaged interaction smoke 已实现。相关单元测试、Rust 协议测试和 CI 策略测试已经纳入仓库。

当前工作包含以下能力：

- Tauri 2 桌面壳、Theia WebView 前端和 Node.js sidecar。
- sidecar 就绪握手、启动失败诊断、优雅退出与进程树清理。
- `tauri-critical` 与 `full` 两种构建 profile，以及构建产物内的 profile manifest。
- 普通启动时禁用、仅受可信 runner 环境激活的 packaged smoke 协议。
- `critical-file`、`critical-empty` 和 `full-file` 三个固定场景。
- 编辑器保存、终端 sentinel、工作区搜索、SCM、打包插件命令、辅助窗口和第二文件转发检查。
- 原子 progress/final report、失败诊断保留、敏感值脱敏和残留进程检查。
- 页脚展示 R-IDE 整体进程树的 CPU/内存汇总，并在悬停时显示角色拆分。

## 验证层级

| 层级 | 验证内容 | 是否证明真实交互成功 |
| --- | --- | --- |
| Profile inventory / static package validation | 构建产物、资源和 profile manifest 与预期一致；smoke schema 与场景映射有效 | 否 |
| Startup measurement | 真实启动打包程序，记录启动里程碑、进程角色、CPU/内存相关指标并清理进程树 | 否；它不执行完整 IDE 交互序列 |
| Packaged interaction smoke | 启动真实打包程序并执行场景规定的 IDE 操作，校验报告、日志和清理 | 是，但仅限实际运行的平台、profile 和场景 |

禁止从静态验证、编译成功或 startup measurement 推导 packaged interaction smoke 已通过。

## Packaged smoke 场景

| 场景 | 必须匹配的 profile | 文件数 | 必须执行的动作 |
| --- | --- | ---: | --- |
| `critical-file` | `tauri-critical` | 2 | 完整七步交互序列 |
| `critical-empty` | `tauri-critical` | 0 | 终端 sentinel、打包插件命令 |
| `full-file` | `full` | 2 | 与 `critical-file` 相同的完整七步交互序列 |

Rust、Node runner 和前端对这三组映射做严格一致性校验；profile、文件数或动作顺序不匹配时协议拒绝执行。

## 自动化覆盖

- Node 契约与 runner 测试覆盖参数解析、场景编排、超时、报告、脱敏和清理失败聚合。
- Rust 测试覆盖协议启用/禁用、场景一致性、原子进度报告和静态诊断。
- Product 前端测试覆盖动作编排、场景一致性和拒绝时不解析动作依赖。
- 普通 push/PR 的 `quality` job 持续运行 runner、startup measurement 和 inventory 生成器测试，覆盖进程身份、清理、临时目录所有权和脱敏边界。
- Workflow 策略测试覆盖上述非交互回归入口、Windows 手动交互 job、非 Windows 静态验证、失败诊断上传和既有 package matrix。

GitHub Actions 中的真实 Windows 交互 smoke 默认关闭，仅在 `workflow_dispatch` 勾选 `run_windows_packaged_smoke` 后运行：

- `.github/workflows/ci.yml`：Windows `critical-file`。
- `.github/workflows/tauri.yml`：独立 Windows full-profile job 的 `full-file`。

非交互 runner/cleanup 单元测试以及 macOS/Linux 的 package/profile/contract 校验都不宣称真实 IDE 交互成功；其他明确标注的 startup measurement 也不能替代交互 smoke。`critical-empty` 已实现，可在本地 Windows 运行，但当前没有独立的 CI 真实交互步骤。

## 本地验证状态

- Packaged smoke 实现与自动化契约：已实现。
- Windows 真实 `critical-file` / `critical-empty` / `full-file`：本文不预先标记通过；以最新本地或手动 CI JSON 报告为准。
- 性能：不在本文提供未经同机、同构建、同采样策略验证的对比数字。需要性能证据时运行 startup measurement，并保留其原始 JSON。

## 构建前置与已知约束

`app/plugins` 是构建时 smoke 插件 inventory 的可信输入。新工作树或清理后的工作区必须先在 `app` 运行：

```powershell
yarn download:plugins
```

该命令与 `npm run build:tauri` 都会生成并校验 inventory。插件目录缺失、存在符号链接/重解析绕行、manifest 身份不匹配、重复项或未提供批准的零参数命令时会 fail closed，常见错误为 `packaged plugin inventory is not canonical`。不要通过跳过生成器或手改生成文件绕过检查。

完整构建、运行和诊断步骤见 [Tauri 构建指南](TAURI-BUILD-GUIDE.md) 与 [Packaged smoke 操作手册](../docs/desktop-packaged-smoke.md)。
