<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="80" height="80" alt="CLI-Manager icon" />

# CLI-Manager

**Your projects, AI terminals, and conversations in one workspace.**

Lean Edition · [v0.1.0](https://github.com/payAgain/CLI-Manager/releases/tag/v0.1.0) · [AGPL-3.0-or-later](LICENSE)

English · [简体中文](README.zh-CN.md)

[Download](#download) · [Highlights](#highlights) · [Get started](#get-started) · [Build from source](#build-from-source) · [Documentation](#documentation)

</div>

---

CLI-Manager is a desktop terminal workspace for working with AI coding agents across multiple projects. Organize repositories and Worktrees, run your installed CLI tools, review changes, and return to the same conversation when you reopen the app.

This fork focuses on the daily coding workflow: **projects → terminals → conversations → code changes**. It combines a redesigned desktop layout with automatic Agent discovery, exact conversation restore, and quieter notifications.

**v0.1.0 is the first release of the Lean Edition.** It uses its own version series. Download updates from this repository's [Releases](https://github.com/payAgain/CLI-Manager/releases).

## Download

| Download | Contents |
| --- | --- |
| [macOS Apple Silicon](https://github.com/payAgain/CLI-Manager/releases/download/v0.1.0/CLI-Manager-0.1.0-macos-arm64.zip) | `CLI-Manager.app` in a ZIP archive, built for arm64 Macs. |
| [SHA256SUMS.txt](https://github.com/payAgain/CLI-Manager/releases/download/v0.1.0/SHA256SUMS.txt) | SHA-256 checksum for the archive. |

This release provides the macOS Apple Silicon app. Intel Mac, Windows, and Linux users can [build from source](#build-from-source); installers for those platforms are not included in v0.1.0.

1. Download the ZIP and checksum file into the same folder. In that folder, run `shasum -a 256 -c SHA256SUMS.txt`.
2. Extract the ZIP and move `CLI-Manager.app` to Applications. Quit an existing copy before replacing it.
3. Open the app, then install or configure the CLI tools you want to use as described in [Get started](#get-started).

The app uses an ad-hoc signature and has not been notarized by Apple. If macOS blocks the first launch, verify the download's source and checksum, try opening it once, then use **System Settings → Privacy & Security → Open Anyway**. See [Apple's instructions](https://support.apple.com/en-us/102445).

## Highlights

| Feature | What it does for you |
| --- | --- |
| **A workspace organized around projects** | Drag folders into the sidebar to create projects. Main workspaces and Worktrees keep their branch, terminals, and status indicators in one card. Discover external Worktrees and review changes and running sessions before removing them. |
| **Run an Agent and get recognized** | Start Codex, Claude Code, Gemini, OpenCode, Pi, or another recognized Agent inside a local terminal. Its identity follows the actual foreground process and updates when you exit, suspend, or switch tools. Each split and Workspan keeps its own binding. |
| **Reopen the original conversation** | Reattach to a surviving daemon terminal, or resume a supported Agent conversation directly from history using its exact saved session ID. Manually started Agents are included. |
| **Notifications with a persistent inbox** | Hook task alerts use system notifications and a persistent unread inbox. Jump back to the right terminal and configure foreground suppression and background-tab alerts to fit your workflow. |
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
- Resume a supported conversation from its history row. CLI-Manager reuses an already-running terminal with the same confirmed identity or starts the exact session in its source project/Worktree.
- Review messages, Unified Diff and Codex Patch views; open source files and use available editing, conversion, backup, and restore actions.
- Configure sources in a compact list with expandable path controls and a separate backup/restore tab.

## Also included

**Automatic YOLO startup:** choose **Settings → Agents → YOLO** to add the appropriate permission arguments when launching a supported Agent. Applies to new tabs, splits, Worktrees, and conversation restoration locally, in WSL, and over SSH. Explicit project permission arguments take precedence; typed commands and complex scripts retain their own arguments. The default is Manual.

| Area | Capabilities |
| --- | --- |
| Projects | Groups, folder import, project search, CLI launch arguments, environment variables, and Shell settings. |
| Terminals | PTYs, tabs, draggable splits, Workspans for grouping terminal layouts, background tasks, output replay, and workspace restoration. |
| Code review | Local file editing, Git changes and Diff, staging, commits, remote Git operations, and Worktree creation/cleanup. |
| SSH | Hosts and authentication, remote terminals, splits, templates, and read-only file/Git/history views. Claude/Codex Hooks are managed per host through CLI integration. |
| Current session | Available model, Token/context, tool/MCP calls, and Hook status for the active conversation. |
| Tasks | Session-scoped task lists, plans, background commands, and subagents; retained terminals and app operations stay separate. Large records are parsed with bounded reads, and unconfirmed states stay explicit. |
| System resources | Local CPU, memory, and process details, with a workspace → terminal → Agent/process memory hierarchy. Unavailable samples stay empty rather than being estimated; SSH/WSL figures cover local connection processes. |
| Everyday controls | Command templates, shortcuts, command palette, Markdown answer previews, custom terminal themes, and backgrounds. |
| Languages | Simplified Chinese, Traditional Chinese, English, and 24-hour time formatting. |

Terminal improvements include Unicode 15 grapheme handling, IME input fixes, previews that release content when closed, and serialized snapshots. Historical output is isolated from live terminal input so replayed terminal queries and old mouse modes do not become Shell commands.

### Current coverage

- **Agent discovery:** local foreground processes. SSH and WSL use guest-side Hook evidence for Agent identity; local process discovery does not determine whether a remote Agent is alive.
- **Recent command capture:** local Zsh, Bash, Git Bash, and PowerShell terminals created after capture is enabled. It records submitted single-line Shell commands, filters common sensitive arguments, and offers an off switch and history clearing. It does not import system Shell history or collect Agent chat input. SSH/WSL, Fish, Sh, CMD, and custom Shell paths are not collected yet.
- **SSH tools:** file and Git panels are read-only; remote Worktree management and panel write operations are not supported yet. You can run commands directly in the remote terminal. This package does not bundle the Linux SSH Agent; installation or updates require access to the existing signed distribution source, or an already-installed compatible Agent.
- **Platform validation:** v0.1.0 provides a macOS Apple Silicon build. Windows, Linux, Intel Mac, and SSH/WSL combinations need validation in their respective environments; their presence in the source does not imply a tested release package.

## Get started

1. **Install your CLI tools separately.** Make sure commands such as `codex` or `claude` work in your Shell; keep using their own authentication and configuration.
2. **Open a project.** Drag one or more folders into the sidebar, or add a project manually. Add a host first for an SSH project.
3. **Open a terminal and start your Agent.** Use the project's startup command or launch it manually. Add splits or a Workspan when you need more terminals.
4. **Enable Hooks and history sources in Settings.** Hooks provide exact session binding and task status. History sources provide past conversations, search, and supported resume actions. SSH CLI integration is configured on the corresponding host.
5. **Choose an exit and restore policy.** Continue tasks in the background, minimize to the tray, or stop tasks and exit. On startup, restore saved terminals when prompted, or enable automatic restore.

Selecting “Stop tasks and exit the app” stops running processes while keeping tabs and conversation identities for the next launch. Rejecting restoration, or explicitly deleting a terminal/background task, removes the corresponding restoration data. Original CLI conversation files are retained. If an older terminal has already lost its session ID, resume the original conversation from history once to establish a new binding.

## Build from source

Use Node.js **22.12+** with npm, a stable Rust toolchain, and the platform dependencies for Tauri 2. macOS requires Xcode Command Line Tools; Windows requires MSVC C++ build tools and WebView2; Linux requires the WebKitGTK and desktop development libraries used by Tauri.

```sh
git clone https://github.com/payAgain/CLI-Manager.git
cd CLI-Manager
git checkout v0.1.0
npm ci
npm run tauri -- dev
```

**macOS build — `.app` only:**

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
- [v0.1.0 release notes](docs/releases/v0.1.0.md)
- [Changelog](CHANGELOG.md)
- [PTY daemon, background tasks, and recovery](docs/pty-daemon-manual.md)
- [Terminal validation checklist](docs/terminal-validation-checklist.md)
- [Known terminal issues](docs/terminal-known-issues.md)
- [Report a problem or suggest an improvement](https://github.com/payAgain/CLI-Manager/issues)

## Scope and project origins

This edition retains projects, terminals, SSH, Git/Worktrees, conversation history, templates, themes, Hook notifications, and current-session information. Desktop pets, provider management/configuration injection, command suggestions, Statusline management, cc-connect, WebDAV sync, historical analytics, request logs, ccusage, and Trellis tooling have been removed. Existing database migrations remain compatible; cleanup does not delete external CLI conversation files.

CLI-Manager Lean Edition is a fork of [dark-hxx/CLI-Manager](https://github.com/dark-hxx/CLI-Manager). The workspace layout and sidebar interactions take inspiration from [Orca](https://github.com/stablyai/orca). This repository maintains its own UI, feature scope, and release series.

Licensed under [AGPL-3.0-or-later](LICENSE). Original author attribution and third-party notices are retained in [NOTICE](NOTICE) and [third-party license files](third-party/).
