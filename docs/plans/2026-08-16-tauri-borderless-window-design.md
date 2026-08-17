# Tauri 全平台无边框窗口设计

## 目标

让 R-IDE 的 Tauri 主窗口在 Windows、macOS、Linux 上都使用真正的无边框窗口，并由 R-IDE 顶部栏提供平台匹配的窗口控制按钮。Windows 优先验证，同时保持浏览器预览和 Electron 运行时不变。

## 已确认的交互

| 平台 | 窗口控制位置 | 按钮顺序 |
| --- | --- | --- |
| Windows | 顶部栏右侧 | 最小化、最大化/还原、关闭 |
| Linux | 顶部栏右侧 | 最小化、最大化/还原、关闭 |
| macOS | 顶部栏左侧 | 关闭、最小化、最大化/还原 |

所有平台的顶部栏空白区域都支持窗口拖动，双击切换最大化；控制按钮不参与拖动。窗口保持可调整大小、现有最小宽高和启动可见性流程。

## 方案

采用统一的 Web 前端自绘窗口栏，平台差异只保留在按钮位置、顺序和视觉样式：

1. Tauri 主窗口使用 `decorations: false`，保留 `resizable: true`、最小尺寸、透明背景和阴影。
2. Rust 端沿用现有 `ride_start_window_drag`、`ride_window_control` IPC，并在窗口初始化阶段统一应用无边框配置。
3. 前端 `RideWorkbenchContribution` 创建一个 `.ride-window-controls` 控件组，根据 `RideNativeChrome.platform` 插入到顶部栏左侧或右侧。
4. macOS 使用左侧交通灯风格按钮；Windows/Linux 使用右侧的最小化、最大化/还原、关闭按钮。
5. 所有按钮标记为 `data-no-drag`，使用现有 IPC；浏览器预览隐藏这些 Tauri 专属控件。

Tauri/Wry 在 Windows 的可调整大小窗口上会为无装饰窗口挂接原生边缘缩放处理，因此不额外覆盖编辑器边缘创建自定义缩放层。若构建后的平台验证发现 Linux 或 macOS 需要额外缩放命中区，再单独补充，不在本次范围内预先增加复杂度。

## 受影响的组件

- `app/applications/tauri/src-tauri/tauri.conf.json`：关闭主窗口系统装饰。
- `app/applications/tauri/src-tauri/src/native_chrome.rs`：统一无边框窗口初始化，保持现有窗口 IPC。
- `app/theia-extensions/product/src/browser/ride-workbench-contribution.ts`：创建并挂载平台化窗口控制组。
- `app/theia-extensions/product/src/browser/ride-native-chrome.ts`：补充控制按钮所需的平台布局类型或辅助数据。
- `app/theia-extensions/product/src/browser/style/index.css`：控制组布局、平台顺序、按钮视觉和拖动命中区样式。
- `scripts/test/desktop-integration-policy.test.mjs` 或新增针对窗口策略的测试：锁定 Tauri 无边框配置。
- `app/theia-extensions/product/test/`：验证平台到按钮布局的纯逻辑映射。

## 错误处理与兼容性

- Tauri IPC 调用失败只记录现有风格的警告，不阻塞前端启动。
- 非 Tauri 运行时不创建可点击的窗口控制组，避免浏览器预览调用不存在的 IPC。
- 保留 `ride_window_control` 对未知 action 的错误返回。
- 删除或停用仅适用于原生 macOS overlay 的间距逻辑，避免无边框后出现额外空白。

## 验证策略

1. 先写前端平台布局的失败测试，确认 Windows/Linux 右侧顺序、macOS 左侧顺序。
2. 增加配置策略测试，确认 Tauri 主窗口 `decorations` 为 `false` 且仍可调整大小。
3. 实现最小改动并运行对应 Node 测试，随后运行产品扩展 TypeScript 测试。
4. 执行 `cargo fmt --check`、`cargo test --manifest-path app/applications/tauri/src-tauri/Cargo.toml` 和必要的 Tauri 构建/校验命令。
5. 在 Windows Tauri 运行时手动验证：启动显示、拖动、双击最大化、最小化、最大化/还原、关闭、边缘缩放和窗口贴靠。

## 非目标

- 不改变 Electron 窗口装饰策略。
- 不改变 Theia 菜单、编辑器布局和启动性能流程。
- 不引入 Win32/Cocoa 专用窗口按钮 API；平台差异由 Tauri 窗口 IPC 和前端布局完成。
