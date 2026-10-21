# AGENTS.md

CLI-Manager 精简版：多项目 AI CLI 终端工作台。当前开发版本为 0.1.0，完成精简后再发布正式版。

## 工作方式

- 直接检查、实现和验证；不使用 Trellis 或任务脚本。
- 避免可选过程说明，只报告必要的状态、发现、阻碍及交付结果。
- 每次开始只读检查并报告 Git 分支状态：git status --short --branch、git branch -vv、git rev-list --left-right --count HEAD...@{upstream}。
- 不自动 pull、push、merge、rebase、提交或发布。用户明确授权的操作可直接执行。
- 用户授权提交后，按功能和修改类型分批提交；每个提交只包含一个独立、可审查的改动，不把工作区内不同功能或不同类型的修改合并成一次提交。后续提交持续遵循此规则。
- 修改前分析根因和全部调用方；优先使用可用的代码索引，否则用 rg 和源码交叉引用。不要只在症状处增加兜底。
- 涉及状态的修复检查窗口焦点、隐藏/托盘、分屏/Workspan、本地/WSL/SSH、Worktree 和 Hook 安装状态。

## 产品边界

保留项目与分组、PTY 终端、分屏与 Workspan、SSH、Git/Worktree、历史浏览/搜索/Diff/恢复、模板、主题、Hook 通知和当前会话实时信息。

已移除桌宠、供应商管理与配置注入、命令建议、Statusline 管理、cc-connect、WebDAV 同步、历史统计、请求记录和 ccusage。不要在修复或同步上游时重新引入这些功能。

## 架构

- React 19 + TypeScript + Vite 7 + Zustand + Tailwind CSS 4。
- Tauri 2 / Rust：主进程负责配置和 IPC；独立 daemon 使用原生 PTY 并通过 WebSocket 传输终端数据。
- src/components/：界面；src/stores/：状态；src/lib/：共享逻辑；src/terminal/：终端传输和生命周期。
- src-tauri/src/commands/：命令；src-tauri/src/daemon/：守护进程；src-tauri/src/pty/：原生 PTY。
- SQLite 与 Store 保存数据。保持旧迁移编号和校验和兼容，不删除用户历史会话文件。

## 国际化和验证

- 用户可见文案放入 src/lib/i18n.ts，同步支持 zh-CN 和 en-US，保留 zh-TW 转换；日期时间统一 24 小时制。
- 前端运行 npx tsc --noEmit；后端运行 cargo check --manifest-path src-tauri/Cargo.toml，根据变更运行相关测试。
- 只有实际通过的检查才能报告成功；明确说明环境导致的验证限制。
- 新界面手动检查中英文及必要的本地/WSL/SSH 场景。
- 代码变更同步更新有版本号的 CHANGELOG.md 和 docs/功能清单.md；版本未明确时询问，仍未提供则使用 TEMP。
