# Hook 桥接独立启用开关

## Goal

允许用户分别关闭 Claude Code 与 Codex CLI Hook 桥接检查，避免只安装其中一个 CLI 时，左下角 Hook 状态灯因另一个未安装而持续显示黄色。

## Changelog Target

`[TEMP]`

## Requirements

- Hook 设置页为 Claude Code、Codex CLI 分别提供独立启用开关。
- 两个开关默认开启，保持现有用户行为兼容。
- 左下角 Hook 状态灯只统计已启用的桥接。
- Hook 快捷重装只处理已启用的桥接。
- Claude 桥接关闭时，不执行 Claude Hook 自动修复。
- 新终端只在至少一个已启用桥接安装完整时注入 Hook 环境。
- 两个桥接都关闭时，Hook 状态灯显示灰色。
- 关闭开关不自动卸载或删除现有 Hook 配置。
- 新增用户可见文案同时支持 `zh-CN` 与 `en-US`。

## Acceptance Criteria

- [ ] 仅启用 Claude 且 Claude Hook 完整安装时，状态灯为绿色。
- [ ] 仅启用 Codex 且 Codex Hook 完整安装时，状态灯为绿色。
- [ ] 已启用桥接部分安装时，状态灯为黄色。
- [ ] 两个桥接都关闭时，状态灯为灰色且不会触发快捷重装。
- [ ] Claude 桥接关闭时，不会因状态刷新触发自动修复。
- [ ] 两个桥接都关闭时，新终端不注入 Hook 环境。
- [ ] 开关状态重启后保持。
- [ ] 中英文界面均显示正确文案。
- [ ] TypeScript 类型检查通过。

## Technical Approach

- 在 `settingsStore` 增加两个持久化布尔配置，默认值为 `true`。
- 设置页在两个桥接标题区域增加开关。
- 状态灯通过启用配置过滤参与健康检查和重装的工具。
- App 与终端统计入口在请求 Hook 状态时按 Claude 开关控制 `autoRepair`。

## Out of Scope

- 自动卸载已关闭桥接的 Hook 配置。
- 修改 Rust Hook 安装协议或事件载荷。
- 改造模块级 Hook 安装功能。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
