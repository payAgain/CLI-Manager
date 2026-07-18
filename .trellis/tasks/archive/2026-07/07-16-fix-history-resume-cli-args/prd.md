# 修复历史会话恢复遗漏 CLI 启动参数

## Goal

恢复 Claude/Codex 历史会话前，按会话目录/项目标识查找项目配置，并使用用户选定项目的 CLI 启动参数创建终端。

## Requirements

- 详情页“恢复会话”和历史列表右键“恢复会话”共用同一套项目解析与启动逻辑。
- 精确匹配到一个项目配置时直接恢复。
- 匹配到多个项目配置时弹出项目选择框，用户选择后再恢复；取消则不创建终端。
- 项目选择框参考现有“项目来源”组件风格：顶部搜索、项目分组、CLI 图标与项目名称列表。
- 恢复命令必须继承所选项目中与会话来源匹配的 `cli_args` 及现有供应商覆盖参数。
- Worktree 恢复继续保留 Worktree 路径和供应商覆盖。
- 新增用户可见文案同时支持 `zh-CN` 与 `en-US`。

## Acceptance Criteria

- [ ] Claude 历史会话恢复命令包含对应项目的 Claude CLI 启动参数。
- [ ] Codex 历史会话恢复命令包含对应项目的 Codex CLI 启动参数。
- [ ] 左键详情恢复与右键列表恢复行为一致。
- [ ] 多个匹配项目时必须选择项目，取消后不启动终端。
- [ ] Local、WSL/Bash、主项目及 Worktree 的 cwd/shell/env/provider override 保持正确。
- [ ] 无匹配项目配置时不再静默使用无参数命令恢复，并给出双语错误提示。
- [ ] 前端类型检查及相关测试通过。

## Root Cause

根因位于历史会话到项目配置的解析边界：`findHistoryProject` 使用 `find` 提前收敛为单个项目，无法表达零个/多个匹配结果；后续 `appendResumeCliArgs` 在项目缺失或不兼容时静默返回裸 resume 命令，导致恢复链路丢失项目 CLI 启动参数。

## Scenario Matrix

- 入口：详情页按钮 / 历史列表右键。
- 匹配：零个 / 一个 / 多个项目配置。
- 来源：Claude / Codex。
- 运行环境：Local PowerShell/CMD/Pwsh / WSL / Bash。
- 目录：主项目 / Worktree / Worktree 目录缺失。
- 选择框：确认 / 取消。
- 其他状态：分屏、窗口焦点、最小化、Workspan 不改变项目解析结果。

## Discovery List

- [x] `src/components/HistoryWorkspace.tsx`：两个恢复入口、项目匹配、cwd/shell/env 与终端创建。
- [x] `src/lib/projectStartupCommand.ts`：CLI 参数和供应商覆盖拼接；已有能力，避免重复实现。
- [x] `src/components/history/HistoryListPane.tsx`：右键入口仅转发同一个回调，确认无需独立恢复逻辑。
- [x] `src/components/history/SessionDetailPane.tsx`：详情按钮仅转发回调，确认无需独立恢复逻辑。
- [x] `src/lib/i18n.ts`：项目选择框及错误提示的中英文文案。
- [x] `src/stores/terminalStore.ts`：`createSession` 消费启动命令；确认无需改变 PTY/IPC 契约。

## Technical Approach

将历史项目解析结果改为候选列表；两个入口调用统一的恢复请求函数。单候选直接启动，多候选保存待恢复会话并展示轻量选择对话框，选择后复用现有 `appendResumeCliArgs`、Worktree 覆盖和 `createSession` 链路。零候选或候选 CLI 类型与会话来源不兼容时明确中止，杜绝裸 resume 命令。

## Impact Analysis

- `findHistoryProject`：GitNexus 风险 LOW，直接影响 `HistoryWorkspace`。
- `appendResumeCliArgs`：GitNexus 风险 MEDIUM，直接调用方为历史恢复与终端快照恢复；本任务优先不改其公共语义，在历史恢复入口做必需配置校验。

## Out of Scope

- 不修改 PTY 后端、数据库结构、项目配置结构。
- 不解析或继承自由文本 `startup_cmd`，避免把一次性 prompt 当作稳定 CLI 参数。
- 不重构其他终端创建入口。

## Definition of Done

- 实现与必要测试完成。
- `npx tsc --noEmit` 通过。
- `CHANGELOG.md` 写入指定版本；未指定时使用 `[TEMP]`。
- 行为变更按交付清单核对文档影响。

## Changelog Target

`v1.2.8`
