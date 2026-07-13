# Journal - CLI-Manager (Part 1)

> AI development session journal
> Started: 2026-04-21

---



## Session 1: Bootstrap frontend spec guidelines

**Date**: 2026-04-23
**Task**: Bootstrap frontend spec guidelines
**Branch**: `feat/compact-mode-launcher`

### Summary

Filled the frontend Trellis spec files, verified build, and captured current UI/component/state/type-quality conventions from the codebase.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `c7b2bd5` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: 全项目性能优化 MVP

**Date**: 2026-05-26
**Task**: 全项目性能优化 MVP
**Branch**: `feat/compact-mode-launcher`

### Summary

优化终端输出解码与隐藏缓冲、历史会话搜索匹配和 WebDAV 同步内存边界，并补充相关 Trellis code-spec。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `256549b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: 修正 Claude Code IME 候选框漂移（底部优先锚点）

**Date**: 2026-06-15
**Task**: fix-claude-code-ime-drift
**Branch**: `master`

### Summary

上一轮"硬件光标就近双向扫描输入行"方案仍漂移：Claude Code 输入中文时候选框贴到屏幕顶部而非底部输入框。根因——TUI 的硬件光标（`buffer.cursorX/Y`）不指向底部真实输入框（输入框光标是 TUI 用反色字符画的视觉光标），而屏幕顶部历史回显的 `> hishu` 这类以 `>` 开头的行会被识别成输入行；就近双向扫描在光标漂移到上半屏时命中了顶部诱饵。改为从屏幕最底行向上扫描第一个输入行作为锚点（TUI/shell 当前输入框恒在底部），光标恰在该行时才返回精确光标以保留普通 shell 行内 caret。

### Main Changes

- `src/components/XTermTerminal.tsx` `resolveCompositionAnchorCell`：删除"光标在行即 return cursor + 就近双向扫描"两段，改为单向从 `terminal.rows-1` 向上扫第一个输入行；命中即锚点（光标在该行则返回精确光标），无输入行才回落硬件光标。净减代码，消除顶部诱饵死角。

### Testing

- [OK] `npx tsc --noEmit` 通过
- [ ] 运行态人工验收：Claude Code / Codex 中文 IME 候选框贴底部输入框；普通 shell 行内移动 caret 后 IME 跟随（待用户验证）

### Status

[进行中] 代码完成，待人工验收

### Next Steps

- 人工验证三场景：Claude Code 流式输出期间中文 IME、Codex、普通 shell 行内 caret 移动


## Session 3: V1.1.4 统计计费口径与界面一致性收口

**Date**: 2026-06-18
**Task**: V1.1.4 统计计费口径与界面一致性收口
**Branch**: `master`

### Summary

完成并提交 V1.1.4：统一模型价格计费来源、缓存用量文案、终端 Tab 状态展示、设置页外层容器和全局滚动条样式；归档 5 个 06-18 任务。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `271509d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: 终端选区右键直接复制

**Date**: 2026-06-22
**Task**: 终端选区右键直接复制
**Branch**: `master`

### Summary

终端有选区时右键直接复制并关闭菜单，无选区时保留原右键菜单；提交 a5d339d。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `a5d339d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: 优化子任务分屏流式输出

**Date**: 2026-07-10
**Task**: 优化子任务分屏流式输出
**Branch**: `master`

### Summary

Claude 启动阶段提前订阅子任务 transcript，Codex rollout 增加有界发现重试，并补齐跨平台契约、变更记录与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `04f63bd` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: 优化项目列表拖拽排序即时反馈

**Date**: 2026-07-10
**Task**: 优化项目列表拖拽排序即时反馈
**Branch**: `master`

### Summary

项目与分组拖拽放手后先乐观更新 Zustand 项目树，再持久化 SQLite；失败时回滚，并同步更新 TEMP 变更记录与功能清单。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `e3bbee6` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: 终端文件路径快捷打开

**Date**: 2026-07-12
**Task**: 终端文件路径快捷打开
**Branch**: `master`

### Summary

为 xterm 终端输出添加绝对文件路径识别；项目或 Worktree 内文件使用内置编辑器打开，其他路径回退系统默认应用。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `180bd87` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
