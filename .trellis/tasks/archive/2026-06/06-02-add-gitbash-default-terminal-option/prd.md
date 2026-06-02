# Add GitBash Default Terminal Option

## Goal

在“新增项目/终端设置”的默认终端选择里增加 `Git Bash`，让用户可以明确选择 Git for Windows 的 Bash，而不是只能选择现有的通用 `Bash`。

## What I already know

* 用户要求：在新增项目 / 终端设置的默认终端位置增加 `GitBash` 选项。
* 前端统一选项来自 `src/lib/types.ts` 的 `SHELL_OPTIONS`。
* 新增项目弹窗 `src/components/ConfigModal.tsx` 和设置页 `src/components/settings/pages/ThemeSettingsPage.tsx` 都复用 `SHELL_OPTIONS`。
* shell key 归一化在 `src/lib/shell.ts`。
* 内置终端后端在 `src-tauri/src/pty/manager.rs` 通过 shell key 映射可执行文件。
* 外部 Windows Terminal 后端在 `src-tauri/src/commands/shell.rs` 通过 shell key 映射可执行文件。
* 现有 `bash` 只映射到 `bash.exe`，没有单独的 `gitbash` key。

## Requirements

* 在项目 Shell 下拉框增加 `Git Bash`。
* 在终端设置默认 Shell 下拉框增加 `Git Bash`。
* `Git Bash` 作为独立 shell key 保存为 `gitbash`，保持现有 `Bash` 行为不变。
* `Git Bash` 只有在系统安装 Git for Windows 或 PATH 中存在 Git Bash 可执行文件时可启动。
* 新建内置终端时，`gitbash` 能启动 Git Bash，不应回退到 PowerShell。
* 使用外部 Windows Terminal 时，`gitbash` 能启动 Git Bash，不应回退到 PowerShell。

## Decision (ADR-lite)

**Context**: 现有 `Bash` 映射到通用 `bash.exe`，不能明确表达 Git for Windows 的 Git Bash。
**Decision**: 新增独立 `gitbash` key 和 `Git Bash` 展示文案，前后端统一识别该 key。
**Consequences**: 用户需要已安装 Git for Windows 或已把 Git Bash 放入 PATH；非常规安装路径可能仍需依赖 PATH。

## Acceptance Criteria (evolving)

* [ ] 新增项目弹窗的 Shell 下拉框包含 `Git Bash`。
* [ ] 终端设置页的默认 Shell 下拉框包含 `Git Bash`。
* [ ] 选择 `Git Bash` 后保存值为 `gitbash`。
* [ ] 内置终端创建时 `gitbash` 不回退到 PowerShell。
* [ ] 外部 Windows Terminal 创建时 `gitbash` 不回退到 PowerShell。
* [ ] TypeScript 构建通过。
* [ ] Rust `cargo check` 通过。

## Definition of Done

* Tests added/updated only if an existing test seam is present.
* Typecheck / build checks pass for touched layers.
* No dependency added.
* Existing shell options remain backward-compatible.

## Out of Scope

* 不新增 Git Bash 安装路径配置 UI。
* 不改造现有 `Bash` 的语义。
* 不为 Git Bash 注入 PowerShell 专属运行状态监控脚本。

## Technical Notes

* `src/lib/types.ts`: add `gitbash` option to `SHELL_OPTIONS`.
* `src/lib/shell.ts`: extend `ShellKey` and normalize common Git Bash values.
* `src-tauri/src/pty/manager.rs`: map `gitbash` to Git for Windows Bash executable selection.
* `src-tauri/src/commands/shell.rs`: map `gitbash` for external Windows Terminal launch.
* `src/stores/terminalStore.ts`: runtime monitoring remains only PowerShell / pwsh, so no change expected for Git Bash.
