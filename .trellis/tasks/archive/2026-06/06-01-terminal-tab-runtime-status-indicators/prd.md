# Terminal Tab Runtime Status Indicators

## Goal

在内部终端 Tab 上统一展示运行状态，让用户不用切换 Tab 就能判断哪个任务正在执行、哪个任务等待审批、哪个任务已结束或异常退出。

## Requirements

* Tab 上展示统一的运行状态标识。
* 状态文案使用短文本：`运行中`、`待审批`、`已完成`、`异常退出`。
* `运行中` 使用蓝紫色呼吸灯。
* `待审批` 使用橙色呼吸灯。
* `已完成` 使用绿色或灰绿色静态点。
* `异常退出` 使用红色静态点。
* 悬浮提示展示：当前状态、会话、更新时间。
* 不使用 emoji。
* MVP 纳入通用 shell 命令生命周期监控。
* Claude Code hook 安装状态需要在 Hook 设置页中体现是否已安装。
* 通用 shell 监控需要在终端设置/终端管理中提供用户可控开关。
* 通用 shell 监控关闭时，不应注入 shell 生命周期监控逻辑。
* 通用 shell 监控开关默认开启：新终端默认启用命令生命周期监控，用户可在终端设置中关闭。
* 通用 shell 监控 MVP 优先覆盖 PowerShell / pwsh；bash / zsh 暂不完整实现，但代码结构需要预留扩展点。
* PowerShell / pwsh 监控需要尽量避免修改用户 profile，优先使用会话级注入。
* 状态优先级：`待审批` > `异常退出` > `运行中` > `已完成`。

## Acceptance Criteria

* [ ] Tab 可以展示 `运行中` 状态。
* [ ] Tab 可以展示 `待审批` 状态。
* [ ] Tab 可以展示 `已完成` 状态。
* [ ] Tab 可以展示 `异常退出` 状态。
* [ ] 鼠标悬浮 Tab 状态标识或 Tab 标签时可以看到当前状态提示。
* [ ] 状态展示不依赖 emoji。
* [ ] Claude Code hook 事件能映射到对应状态。
* [ ] Codex hook 事件能映射到对应状态。
* [ ] 通用 shell 命令开始时，Tab 能进入 `运行中`。
* [ ] 通用 shell 命令结束后，Tab 能进入 `已完成` 或 `异常退出`。
* [ ] 终端设置中存在通用 shell 监控开关。
* [ ] 关闭通用 shell 监控后，新终端不启用命令生命周期监控。
* [ ] 状态冲突时按 `待审批` > `异常退出` > `运行中` > `已完成` 显示。

## Definition of Done

* Tests added/updated where appropriate.
* `npx tsc --noEmit` passes.
* `cd src-tauri && cargo check` passes if Rust code changes.
* UI 在本地 dev 环境验证过基础交互。
* 行为变化对应的 Trellis 记录完整。

## Technical Approach

* 复用现有 Tab 左侧状态点，扩展为统一运行状态模型。
* Claude Code 继续通过现有 hook bridge 上报 `Notification`、`Stop`、`StopFailure`、`PermissionRequest`。
* Codex 继续通过现有 hook 安装脚本上报 `PermissionRequest`、`Stop`。
* 通用 shell 监控通过会话级注入实现，默认只针对 PowerShell / pwsh。
* 终端设置新增开关控制通用 shell 监控是否启用。
* Tooltip 继续使用轻量原生 `title` 或同等低成本方案。

## Decision (ADR-lite)

**Context**: 需要统一展示 CLI/终端运行状态，但又不想把 UI 做成多套状态体系。

**Decision**: 采用统一的 4 态状态模型，Claude/Codex hook 与通用 shell 监控共用同一套 tab 展示；通用 shell 监控默认开启，但只优先实现 PowerShell / pwsh。

**Consequences**: 第一版可见性强，用户无需切 Tab；代价是需要补一层 shell 注入逻辑，并维护状态优先级与开关控制。

## Out of Scope

* 暂不做复杂任务耗时统计。
* 暂不做跨应用全局系统托盘状态。
* 暂不依赖解析终端屏幕文本判断状态。
* 暂不完整实现 bash / zsh 监控。

## Technical Notes

* `src/components/TerminalTabs.tsx` 已有 Tab 左侧圆点，当前由 `TabNotificationState` 映射颜色和 title。
* `src/stores/terminalStore.ts` 已有 `tabNotifications`、`SessionStatus` 和 `handleCliHookEvent`。
* `CliHookEventName` 当前包含 `Notification`、`Stop`、`StopFailure`、`PermissionRequest`。
* `src-tauri/src/claude_hook.rs` 已有本地 HTTP bridge，通过 `CLI_MANAGER_TAB_ID`、`CLI_MANAGER_NOTIFY_PORT`、`CLI_MANAGER_NOTIFY_TOKEN` 接收 hook payload 并 emit 到前端。
* `src-tauri/src/commands/hook_settings.rs` 已有 Claude 与 Codex hook 安装脚本；Codex 覆盖 `PermissionRequest` 和 `Stop`，Claude 覆盖 `Notification`、`Stop`、`StopFailure`。
* 现有 `TerminalTabs` 使用原生 `title` 作为轻量 tooltip，项目未发现独立 Tooltip 组件。
* 终端相关设置目前集中在 `src/components/settings/pages/ThemeSettingsPage.tsx`，包括默认 Shell、外部终端、终端字体和终端主题；可在该页新增通用 shell 监控开关。
* `src/stores/settingsStore.ts` 已有持久化布尔开关模式，可新增通用 shell 监控开关并参与 settings migration。

## Open Questions

* 无。
