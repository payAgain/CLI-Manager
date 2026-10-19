# CLI-Manager — Lean Edition

English | [简体中文](README.zh-CN.md)

A desktop workspace for managing AI CLI tools across local, WSL, and SSH projects.

**Development version: 0.1.0.** The lean edition starts a new version series and will be released after the cleanup is complete. The desktop app no longer checks for or installs updates from the full upstream edition.

## Features

- Projects and groups with per-project CLI commands, Shell settings, arguments, and environment variables.
- PTY terminals, tabs, draggable splits, Workspans, background tasks, replay, and workspace restoration.
- SSH hosts, authentication, remote projects, signed SSH Agent installation, and remote files.
- File editing, Git changes and Diff review, staging, commits, remote operations, and Worktree workflows.
- Multi-source session history with search, transcripts, Diff, and resume where supported by the CLI.
- Hook notifications and current-session Token, context, tool-call, and status information.
- Command templates, shortcuts, terminal themes, background images, and Markdown previews.
- Simplified Chinese, Traditional Chinese, and English; 24-hour time formatting.

Windows is the primary development platform. macOS and Linux configurations remain available; they require platform-specific validation.

## Scope

This edition removes desktop pets, provider management/configuration injection, command suggestions, Statusline management, cc-connect, WebDAV synchronization, historical analytics, request logs, ccusage, and project-wide daily usage. Trellis development tooling is also removed.

History browsing and current-session information remain available. Existing database migrations are preserved for compatibility, and external CLI session files are not removed. Old __statusline invocations exit silently to avoid opening extra windows.

## Development

Install Node.js/npm, Rust, and the platform requirements for Tauri 2. On Windows, use the MSVC C++ build tools and WebView2 runtime.

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

The CLI tools themselves must be installed separately. Configure their paths and Hook integrations in Settings.

## Documentation and attribution

- [Current feature list](docs/功能清单.md)
- [Changelog](CHANGELOG.md)
- [PTY daemon manual](docs/pty-daemon-manual.md)
- [Lean edition repository](https://github.com/payAgain/CLI-Manager)
- [Original project](https://github.com/dark-hxx/CLI-Manager)

Built with Tauri 2, Rust, React 19, TypeScript, Vite, Zustand, SQLite, and xterm.js. Licensed under [AGPL-3.0-or-later](LICENSE). Original authors and third-party notices are retained in [NOTICE](NOTICE) and third-party license files.
