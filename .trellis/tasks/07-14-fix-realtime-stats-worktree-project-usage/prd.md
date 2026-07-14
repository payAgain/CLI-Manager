# 修复实时统计遗漏 worktree 项目用量

## Goal

修复“实时统计 → 今日项目用量”无法将 Git worktree 中产生的 CLI 用量归属到对应项目的问题，避免统计缺失。

## What I already know

- 普通项目可正常统计，Git worktree 项目用量缺失。
- 修复应保持现有普通项目统计口径不变。
- Changelog Target: `[TEMP]`。

## Requirements

- worktree 路径产生的实时用量应能匹配并归属到正确项目。
- 不改变普通项目的统计结果。
- 采用最小必要改动，不新增依赖或配置。

## Acceptance Criteria

- [x] worktree 项目当天产生的用量通过实际 worktree 路径进入“今日项目用量”聚合。
- [x] 普通项目仍沿用同一项目路径匹配逻辑。
- [x] 后端路径匹配保留目录边界判断，不会合并仅前缀相近的路径。
- [x] `npx tsc --noEmit` 通过；`git diff --check` 无空白错误。

## Out of Scope

- 不重构整个实时统计模块。
- 不调整历史用量分析的统计口径，除非确认它与实时统计共用同一缺陷逻辑。

## Technical Notes

- 根因：`TerminalStatsPanel` 已使用 worktree 独立路径查找最近会话，但“今日项目用量”随后只把该会话的 raw `project_key` 传给 `history_get_stats`，丢失了 worktree 路径上下文。
- 后端 `history_get_stats` 已支持 `projectPath`，并通过 `session_matches_project_path` 按会话 `cwd` 精确匹配目标目录及子目录，无需修改 Rust 统计逻辑。
- 最小方案：让 `fetchTodayProjectStats` 可选接收项目路径；实时统计调用时传入 `lookupProjectPath`，有路径时按 `projectPath` 统计，不再依赖 worktree 的 raw `project_key`。
- 保留历史详情侧栏现有按 `project_key` 调用方式，避免扩大本次修复范围。
- GitNexus 影响分析：`fetchTodayProjectStats` 有 2 个直接调用方，风险 LOW；`TerminalStatsPanel` 上游影响为 0，风险 LOW。
- GitNexus 全工作区变更检测为 HIGH，但包含大量用户已有并行改动；本任务涉及的两个符号在改前影响分析中均为 LOW。
- `cargo test session_matches_project_path --lib` 被仓库根目录现有 `Cargo.toml` 阻断：根清单声明 `cli_manager_lib`，但根目录不存在 `src/lib.rs`。本任务未修改 Rust。
- 修改任何函数前需执行 GitNexus 上游影响分析。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
