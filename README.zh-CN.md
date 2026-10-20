<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="80" height="80" alt="CLI-Manager 图标" />

# CLI-Manager

**把项目、AI 终端和对话，放在同一个工作区。**

精简版 · `0.1.0` 开发中 · [AGPL-3.0-or-later](LICENSE)

[English](README.md) · 简体中文

[功能亮点](#highlights) · [开始使用](#get-started) · [源码构建](#build-from-source) · [项目文档](#documentation)

</div>

---

CLI-Manager 是面向多项目 AI 编程的桌面终端工作台。在一个窗口里组织项目和 Worktree，运行已安装的 CLI 工具、检查代码变更，并在重新打开应用后继续原来的对话。

这个分支围绕日常开发流程做了精简和重设计：**项目 → 终端 → 对话 → 代码变更**。新的桌面布局、Agent 自动识别、原对话恢复和后台通知，都是为这条工作流服务。

> **开发预览版。** 本分支独立从 **0.1.0** 开始编号，尚未正式发布，目前通过本地构建进行测试。桌面应用已关闭完整版上游的自动更新链路。

<a id="highlights"></a>

## 功能亮点

| 特点 | 可以怎样使用 |
| --- | --- |
| **围绕项目组织工作区** | 把文件夹拖进侧边栏即可创建项目。主工作区、Worktree、分支和打开的终端集中展示；查看历史对话时，可以把历史列表停靠在终端旁边。 |
| **手动运行 Agent，自动识别身份** | 在本地终端直接启动 Codex、Claude Code、Gemini、OpenCode、Pi 等可识别的 Agent。身份跟随实际前台进程，退出、挂起或切换工具时同步更新；分屏和 Workspan 各自独立绑定。 |
| **重新打开原来的对话** | 终端仍在 daemon 中运行时直接接回；需要重建时，按保存的准确会话 ID 重新打开受支持的 Agent 对话。手动启动的 Agent 也能保存和恢复。 |
| **专注时安静，后台时提醒** | Hook 任务提醒使用系统通知，正在前台查看的终端保持安静。默认应用聚焦时全部静默，也可以单独允许后台标签提醒。 |
| **从最近命令创建模板** | 搜索在 CLI-Manager 内执行过的命令，选中后命名并保存为模板。按项目筛选和去重，减少重复输入常用命令。 |
| **统一、紧凑的桌面界面** | 项目侧栏、终端标签、文件／Git／会话工具和底部状态栏组成统一布局。炭灰与暖纸终端配色跟随应用深浅模式，历史页与设置页保持相同风格。 |

### 继续原来的 Agent 对话

会话恢复使用保存下来的 Agent 身份：

| 重新打开时的情况 | 恢复方式 |
| --- | --- |
| daemon 中的终端仍然存活 | 重新附着原进程，回放已有输出。 |
| 需要重建终端，且保存了准确 ID | 重新打开原来的 **Claude Code、Codex CLI、Grok Build 或 Pi** 对话，继续聊天。 |
| 缺少 ID，或工具尚不支持恢复 | 保留终端历史画面并提示；可恢复的来源可以从历史会话中选择原对话。 |

启用对应 CLI 的 **Hook 集成**，可以保存准确会话 ID，并获得工作中、待审批、完成和失败等精确状态。进程识别负责判断当前运行的 Agent，进程存在本身不代表任务正在执行。恢复时不会按同目录的“最近一次”猜测对话。

### 更贴合工作流的历史会话

- 集中浏览和搜索 Claude Code、Codex CLI、Gemini CLI、GitHub Copilot CLI、Grok Build、Pi、OpenCode、Antigravity、Kiro、Cursor、Cline 的历史，按各来源能力显示可用操作。
- Codex 会话优先使用 **Codex Desktop 保存的名称**，后续重命名也会同步，便于在两个应用中找到同一个对话。
- 查看消息、Unified Diff 与 Codex Patch，打开原始文件，并使用来源支持的编辑、转换、备份和恢复操作。
- 历史来源采用紧凑列表，按需展开目录配置；备份与恢复使用独立页签。

## 完整工作台能力

| 方面 | 已有能力 |
| --- | --- |
| 项目管理 | 分组、拖入文件夹、项目搜索、CLI 启动参数、环境变量和 Shell 设置。 |
| 终端工作区 | PTY、多标签、拖拽分屏、用于组织终端布局的 Workspan、后台任务、输出回放和工作区恢复。 |
| 代码检查 | 本地文件编辑、Git 变更与 Diff、暂存、提交、Git 远程操作、Worktree 创建与清理。 |
| SSH | 主机与认证、远端终端、分屏、命令模板，以及只读文件／Git／历史面板；Claude／Codex Hook 在对应主机的 CLI 集成中管理。 |
| 当前会话 | 展示来源可提供的模型、Token／上下文、工具／MCP 调用和 Hook 状态。 |
| 系统资源 | 本机 CPU、内存和进程详情，查看各终端及 Agent 的内存归属；SSH／WSL 数据仅覆盖本机连接进程。 |
| 日常操作 | 命令模板、快捷键、命令面板、Markdown 回答预览、自定义终端主题和背景图。 |
| 语言与时间 | 简体中文、繁体中文、英文，统一使用 24 小时制。 |

终端还补齐了 Unicode 15 字素簇占格、输入法重复输入修复、关闭预览后释放内容和串行快照保存。历史输出与实时输入隔离，避免回放中的终端查询和旧鼠标模式成为 Shell 输入。

### 当前支持范围

- **Agent 自动识别：** 本机前台进程。SSH／WSL 使用客端 Hook 提供身份，本机进程扫描不判断远端 Agent 是否存活。
- **最近命令采集：** 开启后新建的本地 Zsh、Bash、Git Bash 和 PowerShell 终端。记录确认执行的单行 Shell 命令，过滤常见敏感参数，可关闭和清理；不读取系统 Shell 历史，不采集 Agent 对话。SSH／WSL、Fish、Sh、CMD 和自定义 Shell 路径暂不采集。
- **SSH 工具面板：** 文件与 Git 当前只读，暂不支持远程 Worktree 管理和面板写操作；仍可直接在远端终端执行命令。
- **平台验证：** 保留 Windows、macOS、Linux 构建配置；本分支近期已进行 macOS `.app` 本地构建测试，其他平台及 SSH／WSL 组合需要分别验证。

<a id="get-started"></a>

## 开始使用

1. **自行安装 CLI 工具。** 先确认 `codex`、`claude` 等命令可以在 Shell 中运行，继续使用工具自身的登录和配置。
2. **打开项目。** 将一个或多个文件夹拖进左侧项目列表，也可以手动添加；SSH 项目先添加对应主机。
3. **打开终端，运行 Agent。** 使用项目启动命令或手动输入，需要并行处理时添加分屏或 Workspan。
4. **在设置中启用 Hook 和历史来源。** Hook 提供准确会话绑定和任务状态，历史来源用于浏览、搜索及受支持的恢复操作；SSH 的 CLI 集成在对应主机上配置。
5. **选择退出和恢复策略。** 可让任务转入后台、最小化到托盘，或终止任务并退出；下次启动按提示恢复，也可以启用自动恢复。

选择“终止任务，退出应用”会清除终端恢复数据，原始 CLI 对话文件仍保留。旧标签如果已经丢失会话 ID，需要从历史中恢复原对话一次，重新建立绑定。

<a id="build-from-source"></a>

## 源码构建

需要 Node.js **22.12+** 与 npm、稳定版 Rust 工具链及 Tauri 2 对应的平台依赖。macOS 需要 Xcode Command Line Tools；Windows 需要 MSVC C++ 构建工具和 WebView2；Linux 需要 Tauri 使用的 WebKitGTK 等桌面开发库。

```sh
git clone https://github.com/payAgain/CLI-Manager.git
cd CLI-Manager
npm ci
npm run tauri -- dev
```

**macOS 测试构建，只生成 `.app`：**

```sh
npm run tauri:build:local -- --bundles app
```

默认本地构建产物位于 `src-tauri/target/release/bundle/macos/CLI-Manager.app`，此命令不生成 DMG 和更新器产物。Windows、Linux 构建使用各自平台的 bundle 类型。

<details>
<summary>开发验证与源码结构</summary>

```sh
npx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
node --test scripts/terminalAgent.test.mjs scripts/terminalConversationRestore.test.mjs scripts/terminalReplayWriter.test.mjs
```

`npm run build` 用于构建前端。上述 Node 命令运行部分终端回归测试，其他专项测试位于 `scripts/`。

| 目录 | 职责 |
| --- | --- |
| `src/components/` | 桌面界面、终端视图、历史和设置。 |
| `src/stores/` | 应用状态和工作区持久化。 |
| `src/lib/` | 共享逻辑、CLI 集成和国际化。 |
| `src/terminal/` | 终端传输与生命周期。 |
| `src-tauri/src/commands/` | 原生命令和 IPC。 |
| `src-tauri/src/daemon/` | 独立 PTY daemon 与 Agent 识别。 |
| `src-tauri/src/pty/` | 原生终端与 Shell 集成。 |

技术栈：**Tauri 2 · Rust · React 19 · TypeScript · Vite · Zustand · SQLite · xterm.js**。

</details>

<a id="documentation"></a>

## 项目文档

- [当前功能清单与边界](docs/功能清单.md)
- [变更记录](CHANGELOG.md)
- [PTY daemon、后台任务与恢复](docs/pty-daemon-manual.md)
- [终端验证清单](docs/terminal-validation-checklist.md)
- [终端已知问题](docs/terminal-known-issues.md)
- [反馈问题与建议](https://github.com/payAgain/CLI-Manager/issues)

## 精简边界与项目来源

本分支保留项目、终端、SSH、Git／Worktree、历史会话、模板、主题、Hook 通知和当前会话信息。已移除桌宠、供应商管理与配置注入、命令建议、Statusline 管理、cc-connect、WebDAV 同步、历史统计、请求记录、ccusage 及 Trellis 工具。旧数据库迁移保持兼容，精简过程不删除外部 CLI 对话文件。

CLI-Manager 精简版基于 [dark-hxx/CLI-Manager](https://github.com/dark-hxx/CLI-Manager) 开发，工作区布局与侧边栏交互参考了 [Orca](https://github.com/stablyai/orca)。本仓库独立维护界面、功能边界和开发版本。

项目遵循 [AGPL-3.0-or-later](LICENSE)。原作者与第三方版权声明保留在 [NOTICE](NOTICE) 和[第三方许可证文件](third-party/)中。
