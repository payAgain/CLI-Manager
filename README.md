<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="80" height="80" alt="CLI-Manager icon" />

# CLI-Manager

**Your projects, AI terminals, and conversations in one workspace.**

Lean Edition · `0.1.0` in development · [AGPL-3.0-or-later](LICENSE)

English · [简体中文](README.zh-CN.md)

[Highlights](#highlights) · [Get started](#get-started) · [Build from source](#build-from-source) · [Documentation](#documentation)

</div>

---

CLI-Manager is a desktop terminal workspace for working with AI coding agents across multiple projects. Organize repositories and Worktrees, run your installed CLI tools, review changes, and return to the same conversation when you reopen the app.

This fork focuses on the daily coding workflow: **projects → terminals → conversations → code changes**. It combines a redesigned desktop layout with automatic Agent discovery, exact conversation restore, and quieter notifications.

> **Development preview.** This edition uses its own version series starting at **0.1.0** and has not been formally released. Build locally for testing; desktop updates from the full upstream edition are disabled.

## Highlights

| Feature | What it does for you |
| --- | --- |
| **A workspace organized around projects** | Drag folders into the sidebar to create projects. Keep the main workspace, Worktrees, open terminals, and branches together; dock history beside the terminal when reviewing a conversation. |
| **Run an Agent and get recognized** | Start Codex, Claude Code, Gemini, OpenCode, Pi, or another recognized Agent inside a local terminal. Its identity follows the actual foreground process and updates when you exit, suspend, or switch tools. Each split and Workspan keeps its own binding. |
| **Reopen the original conversation** | Reattach to a surviving daemon terminal, or reopen a supported Agent conversation using its exact saved session ID. Manually started Agents are included. |
| **Notifications that respect your focus** | Hook task alerts use system notifications. Visible foreground terminals stay quiet; by default the entire app stays quiet while focused. Optional background-tab alerts let you choose the behavior. |
| **Turn recent commands into templates** | Search commands executed inside CLI-Manager, select one, name it, and save it as a reusable template. Project filtering and deduplication keep the list useful. |
| **A consistent desktop interface** | A project sidebar, terminal tabs, files/Git/session tools, and a global status bar share a compact layout. Charcoal and warm-paper terminal themes follow the app's appearance; history and settings use the same visual language. |

### Continue the same conversation

Conversation restore uses the Agent's saved identity:

| Situation when reopening | Restore behavior |
| --- | --- |
| The daemon terminal is still alive | Reattach to the existing process and replay its output. |
| The terminal needs to be recreated and an exact ID is saved | Reopen the original **Claude Code, Codex CLI, Grok Build, or Pi** conversation so you can continue chatting. |
| The ID is missing or the tool has no supported resume path | Restore the terminal output and show a notice. Choose the original conversation from history where resume is available. |

Enable the supported CLI's **Hook integration** to save exact conversation IDs and receive precise working, approval, completion, and failure states. Process discovery identifies the Agent; a running process alone does not mean it is working on a task. Restore never guesses a conversation from the latest session in the same directory.

### History that fits the workflow

- Browse and search conversations from Claude Code, Codex CLI, Gemini CLI, GitHub Copilot CLI, Grok Build, Pi, OpenCode, Antigravity, Kiro, Cursor, and Cline. Actions depend on the source's capabilities.
- Codex titles follow names saved by **Codex Desktop**, including later renames, so the same conversation is recognizable in both apps.
- Review messages, Unified Diff and Codex Patch views; open source files and use available editing, conversion, backup, and restore actions.
- Configure sources in a compact list with expandable path controls and a separate backup/restore tab.

## Also included

| Area | Capabilities |
| --- | --- |
| Projects | Groups, folder import, project search, CLI launch arguments, environment variables, and Shell settings. |
| Terminals | PTYs, tabs, draggable splits, Workspans for grouping terminal layouts, background tasks, output replay, and workspace restoration. |
| Code review | Local file editing, Git changes and Diff, staging, commits, remote Git operations, and Worktree creation/cleanup. |
| SSH | Hosts and authentication, remote terminals, splits, templates, and read-only file/Git/history views. Claude/Codex Hooks are managed per host through CLI integration. |
| Current session | Available model, Token/context, tool/MCP calls, and Hook status for the active conversation. |
| System resources | Local CPU, memory, and process details, including memory attributed to terminals and Agents. SSH/WSL figures cover local connection processes. |
| Everyday controls | Command templates, shortcuts, command palette, Markdown answer previews, custom terminal themes, and backgrounds. |
| Languages | Simplified Chinese, Traditional Chinese, English, and 24-hour time formatting. |

Terminal improvements include Unicode 15 grapheme handling, IME input fixes, previews that release content when closed, and serialized snapshots. Historical output is isolated from live terminal input so replayed terminal queries and old mouse modes do not become Shell commands.

### Current coverage

- **Agent discovery:** local foreground processes. SSH and WSL use guest-side Hook evidence for Agent identity; local process discovery does not determine whether a remote Agent is alive.
- **Recent command capture:** local Zsh, Bash, Git Bash, and PowerShell terminals created after capture is enabled. It records submitted single-line Shell commands, filters common sensitive arguments, and offers an off switch and history clearing. It does not import system Shell history or collect Agent chat input. SSH/WSL, Fish, Sh, CMD, and custom Shell paths are not collected yet.
- **SSH tools:** file and Git panels are read-only; remote Worktree management and panel write operations are not supported yet. You can run commands directly in the remote terminal.
- **Platform validation:** Windows, macOS, and Linux build configurations are present. Recent testing for this fork includes a macOS `.app`; other platforms and SSH/WSL combinations require their own validation.

## Get started

1. **Install your CLI tools separately.** Make sure commands such as `codex` or `claude` work in your Shell; keep using their own authentication and configuration.
2. **Open a project.** Drag one or more folders into the sidebar, or add a project manually. Add a host first for an SSH project.
3. **Open a terminal and start your Agent.** Use the project's startup command or launch it manually. Add splits or a Workspan when you need more terminals.
4. **Enable Hooks and history sources in Settings.** Hooks provide exact session binding and task status. History sources provide past conversations, search, and supported resume actions. SSH CLI integration is configured on the corresponding host.
5. **Choose an exit and restore policy.** Continue tasks in the background, minimize to the tray, or stop tasks and exit. On startup, restore saved terminals when prompted, or enable automatic restore.

Selecting “Stop tasks and exit the app” clears terminal restoration data; the original CLI conversation files are retained. If an older terminal has already lost its session ID, resume the original conversation from history once to establish a new binding.

## Build from source

Use Node.js **22.12+** with npm, a stable Rust toolchain, and the platform dependencies for Tauri 2. macOS requires Xcode Command Line Tools; Windows requires MSVC C++ build tools and WebView2; Linux requires the WebKitGTK and desktop development libraries used by Tauri.

```sh
git clone https://github.com/payAgain/CLI-Manager.git
cd CLI-Manager
npm ci
npm run tauri -- dev
```

**macOS test build — `.app` only:**

```sh
npm run tauri:build:local -- --bundles app
```

The default local build produces `src-tauri/target/release/bundle/macos/CLI-Manager.app`. This command does not create a DMG or updater artifacts. Windows and Linux builds use their platform's bundle types.

<details>
<summary>Development checks and source map</summary>

```sh
npx tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
node --test scripts/terminalAgent.test.mjs scripts/terminalConversationRestore.test.mjs scripts/terminalReplayWriter.test.mjs
```

`npm run build` builds the frontend. The Node command above runs selected terminal regressions; additional focused tests live in `scripts/`.

| Directory | Responsibility |
| --- | --- |
| `src/components/` | Desktop UI, terminal views, history, and settings. |
| `src/stores/` | Application state and workspace persistence. |
| `src/lib/` | Shared logic, CLI integrations, and translations. |
| `src/terminal/` | Terminal transport and lifecycle. |
| `src-tauri/src/commands/` | Native commands and IPC. |
| `src-tauri/src/daemon/` | Independent PTY daemon and Agent discovery. |
| `src-tauri/src/pty/` | Native terminals and Shell integration. |

Built with **Tauri 2 · Rust · React 19 · TypeScript · Vite · Zustand · SQLite · xterm.js**.

</details>

## Documentation

- [Current feature list and boundaries](docs/功能清单.md)
- [Changelog](CHANGELOG.md)
- [PTY daemon, background tasks, and recovery](docs/pty-daemon-manual.md)
- [Terminal validation checklist](docs/terminal-validation-checklist.md)
- [Known terminal issues](docs/terminal-known-issues.md)
- [Report a problem or suggest an improvement](https://github.com/payAgain/CLI-Manager/issues)

## Scope and project origins

This edition retains projects, terminals, SSH, Git/Worktrees, conversation history, templates, themes, Hook notifications, and current-session information. Desktop pets, provider management/configuration injection, command suggestions, Statusline management, cc-connect, WebDAV sync, historical analytics, request logs, ccusage, and Trellis tooling have been removed. Existing database migrations remain compatible; cleanup does not delete external CLI conversation files.

CLI-Manager Lean Edition is a fork of [dark-hxx/CLI-Manager](https://github.com/dark-hxx/CLI-Manager). The workspace layout and sidebar interactions take inspiration from [Orca](https://github.com/stablyai/orca). This repository maintains its own UI, feature scope, and development version.

Licensed under [AGPL-3.0-or-later](LICENSE). Original author attribution and third-party notices are retained in [NOTICE](NOTICE) and [third-party license files](third-party/).
