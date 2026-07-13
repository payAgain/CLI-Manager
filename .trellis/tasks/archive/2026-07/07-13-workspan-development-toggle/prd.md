# Workspan 开发开关

## Goal

在“设置 → 终端 → 终端行为”的“按项目聚焦终端”下方增加默认开启的“Workspan开发”开关。开启时维持当前 Workspan 顶层工作区；关闭时恢复 Workspan 引入前的单一 Pane 树与 Pane 内 Tab 行为，且切换过程中不关闭或重建 PTY。

## Requirements

- 新增持久化设置 `workspanEnabled`，缺失或非法值回退为 `true`。
- 关闭 Workspan 时立即保留活动 Workspan 的完整 Pane 树，将其他 Workspan 的会话按顺序追加到活动 Pane 作为 Tab。
- 关闭模式下普通新终端追加到当前 Pane；显式分屏、拖拽、关闭、项目聚焦和会话恢复继续使用现有 Pane 树能力。
- 关闭模式隐藏顶层 Workspan Tab 栏，并让单会话 Pane 也显示 Tab 标签头。
- 再次开启时，当前全局 Pane 树整体作为一个 Workspan；之后新建普通终端创建独立 Workspan。
- 模式切换不得调用 `pty_create` / `pty_close`，不得丢失会话 ID、滚动内容或活动状态。
- 新增文案同时支持 `zh-CN` 与 `en-US`。
- Changelog Target: `[TEMP]`。

## Acceptance Criteria

- [ ] 默认开启时，当前 Workspan 行为无变化。
- [ ] 关闭后顶层 Workspan 栏消失，每个 Pane 保留终端 Tab。
- [ ] 活动 Workspan 的分屏结构保持不变，其他 Workspan 会话进入活动 Pane，所有会话 ID 恰好出现一次。
- [ ] 关闭模式下新建普通终端成为当前 Pane 的 Tab，分屏和跨 Pane 拖拽正常。
- [ ] 再次开启后当前布局成为一个 Workspan，新建普通终端成为独立 Workspan。
- [ ] 两种模式重启恢复后布局、活动会话和设置值正确。
- [ ] 项目聚焦、批量启动、中英文界面正常。
- [ ] `node scripts/terminalWorkspan.test.mjs` 与 `npx tsc --noEmit` 通过。

## Out of Scope

- 不修改 Rust、PTY IPC、数据库或依赖。
- 不为两种模式维护两套独立布局快照。
- 不把旧版布局中的每个 Pane 或会话自动拆成独立 Workspan。
