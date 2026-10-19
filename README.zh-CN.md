# CLI-Manager 精简版

[English](README.md) | 简体中文

用于集中管理本地、WSL 和 SSH 项目中 AI CLI 工具的桌面终端工作台。

**开发版本：0.1.0。** 精简版采用全新版本序列，完成精简后再发布。桌面应用已移除指向完整版上游的自动检查与安装更新。

## 保留功能

- 项目与分组、CLI 命令、Shell、启动参数历史和项目环境变量。
- PTY 终端、多标签、拖拽分屏、Workspan、后台任务、回放与工作区恢复。
- SSH 主机与认证、远端项目、带签名验证的 SSH Agent 安装和远端文件。
- 文件编辑、Git 变更与 Diff、暂存、提交、远程操作和 Worktree 工作流。
- 多来源历史会话浏览、搜索、消息、Diff，以及 CLI 支持的恢复操作。
- Hook 通知与当前会话 Token、上下文、工具调用和运行状态。
- 命令模板、快捷键、主题、背景图及 Markdown 预览。
- 简体中文、繁体中文、英文与 24 小时制时间。

Windows 为主要开发平台；保留 macOS/Linux 配置，需在对应平台单独验证。

## 精简边界

已移除桌宠、供应商管理与配置注入、命令建议、Statusline 管理、cc-connect、WebDAV 同步、历史统计、请求记录、ccusage、今日项目用量及 Trellis 开发工具。

保留历史浏览与当前会话信息。旧数据库迁移继续兼容，不删除外部 CLI 历史文件；旧配置执行 __statusline 时直接静默退出，避免重复打开窗口。

## 开发与验证

安装 Node.js/npm、Rust 和 Tauri 2 的平台构建依赖；Windows 需要 MSVC C++ 构建工具与 WebView2。

~~~powershell
npm ci
npm run tauri dev
~~~

~~~powershell
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri:build:local
~~~

CLI 工具需自行安装，配置路径与 Hook 可在设置页管理。

## 文档与致谢

- [当前功能清单](docs/功能清单.md)
- [变更记录](CHANGELOG.md)
- [PTY daemon 手册](docs/pty-daemon-manual.md)
- [精简版仓库](https://github.com/payAgain/CLI-Manager)
- [原始项目](https://github.com/dark-hxx/CLI-Manager)

技术栈为 Tauri 2、Rust、React 19、TypeScript、Vite、Zustand、SQLite 与 xterm.js。遵循 [AGPL-3.0-or-later](LICENSE)，原作者与第三方版权声明见 [NOTICE](NOTICE) 和第三方许可证文件。
