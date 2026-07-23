# 修复 Codex 子任务窗格结束状态与自动关闭

## Changelog Target

[TEMP]

## Goal

修复 Codex 子任务已经结束但窗格仍显示“运行中”且不自动关闭的问题，并使关闭延迟遵循用户配置。

## Requirements

- 保留 `SubagentStop` Hook 的正常结束路径。
- 当 Hook 缺失、投递失败或 Codex 以中断/预算限制等路径结束时，从子任务转录终态提供结束兜底。
- 结束处理必须幂等，兼容多个并行子任务，不能误关闭其他窗格。
- 子任务窗格自动关闭延迟使用用户配置值。

## Acceptance Criteria

- [ ] Codex 正常完成后窗格显示“已结束”，并按配置延迟关闭。
- [ ] Codex 中断或预算限制结束且未发送 `SubagentStop` 时，窗格仍能识别为结束并关闭。
- [ ] 多个并行子任务只关闭对应窗格。
- [ ] 重复收到 Hook 与转录终态不会重复调度或报错。
- [ ] `npx tsc --noEmit` 与 Rust 检查通过。

## Definition of Done

- 添加或更新覆盖终态识别、幂等关闭和并行匹配的测试。
- 更新 `CHANGELOG.md` 的 `[TEMP]` 区段。
- 完成前端类型检查与 Rust 测试/检查。

## Out of Scope

- 不修改 Codex 本身的 Hook 配置格式。
- 不重构现有子任务窗格布局或历史会话功能。

## Technical Notes

- `src/App.tsx:741` 当前仅从 `SubagentStop` 进入结束流程。
- `src/stores/terminalStore.ts:3512` 在停止目标未解析时直接返回；`ended` 与关闭计时器均不会更新。
- `src-tauri/src/commands/subagent_transcript.rs:156` 当前只 tail 转录增量；本次在前端追加入口解析已推送的完整 JSONL 行，避免新增 IPC 事件。
- `src/components/settings/pages/HookSettingsPage.tsx:928` 的自动关闭设置目前只作用于 Hook Toast。
- 现有 Codex 窗格关闭延迟为硬编码 10 秒。

## Decision (ADR-lite)

采用前端转录追加入口兜底：Codex `event_msg.payload.type` 为 `task_complete` 或 `turn_aborted` 时，合成幂等的停止处理；正常 `SubagentStop` 仍保持主路径。这样不改变 Tauri 事件/命令契约，改动面小且能覆盖订阅初始内容与实时追加。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
