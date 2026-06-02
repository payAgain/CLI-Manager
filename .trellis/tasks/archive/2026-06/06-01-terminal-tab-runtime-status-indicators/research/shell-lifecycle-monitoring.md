# Research: Shell lifecycle monitoring for terminal tab runtime status

- **Query**: Research shell command lifecycle monitoring for a Tauri terminal manager on Windows. Determine practical ways to detect `command_started` / `command_finished` / `prompt_shown` for PowerShell, pwsh, bash, zsh, and whether to inject via startup command/environment/profile. Include recommended MVP scope, risks, and mapping to tab states `running` / `done` / `failed`.
- **Scope**: mixed
- **Date**: 2026-06-01

## Findings

### Files Found

| File Path | Description |
|---|---|
| `src-tauri/src/pty/manager.rs` | PTY creation, shell selection, output/status event emission, shell-process exit tracking. |
| `src-tauri/src/commands/terminal.rs` | Tauri IPC boundary for `pty_create`, `pty_write`, `pty_resize`, `pty_close`, `pty_status`; currently applies Claude hook env vars before spawning PTY. |
| `src/stores/terminalStore.ts` | Frontend terminal session state, PTY status listeners, startup command write delay, Claude hook notification mapping. |
| `src/components/TerminalTabs.tsx` | Tab indicator UI currently consumes `tabNotifications` only (`none` / `attention` / `done` / `failed`). |
| `src/components/XTermTerminal.tsx` | xterm output/input bridge; records typed commands from Enter but does not know shell execution lifecycle. |
| `src/lib/shell.ts` | Supported normalized shell keys: `powershell`, `cmd`, `pwsh`, `wsl`, `bash`. No `zsh` key today. |
| `src/lib/types.ts` | `TerminalSession` stores `cwd`, `shell`, `envVars`, and `startupCmd`; `Project` stores `startup_cmd`, `cli_tool`, `env_vars`, and `shell`. |
| `.trellis/spec/backend/index.md` | Backend contract reminder: keep Tauri command signatures stable unless explicitly changed; run Cargo checks after backend changes. |
| `.trellis/spec/frontend/component-guidelines.md` | Terminal component convention: avoid recreating xterm on terminal-related state/settings changes. |

### Code Patterns

#### Current PTY status is shell-process lifecycle, not command lifecycle

- `src-tauri/src/pty/manager.rs:38-42` defines `PtyProcessStatus { status, exit_code }`.
- `src-tauri/src/pty/manager.rs:142-148` initializes every PTY session status as `running` when the shell process is spawned.
- `src-tauri/src/pty/manager.rs:196-253` only emits `pty-status-{sessionId}` when the reader reaches EOF and checks the PTY child process with `try_wait()`. This detects PowerShell/bash process exit, not individual commands entered inside that shell.
- `src/stores/terminalStore.ts:149-155` listens to `pty-status-{sessionId}` and stores `running` / `exited` / `error`; this state is not wired to tab notification colors.

#### Shell selection is currently minimal

- `src-tauri/src/pty/manager.rs:57-64` maps shell keys to executable plus at most one fixed argument:
  - `cmd` -> `cmd.exe /Q`
  - `pwsh` -> `pwsh.exe -NoLogo`
  - `wsl` -> `wsl.exe`
  - `bash` -> `bash.exe`
  - default -> `powershell.exe -NoLogo`
- `src/lib/shell.ts:0-32` normalizes only `powershell`, `cmd`, `pwsh`, `wsl`, `bash`. `zsh` is not a first-class shell key today.
- Practical consequence: bootstrap injection via shell command-line arguments would require extending the backend command construction beyond the current `(exe, optional single arg)` shape.

#### Startup commands are currently written after shell spawn

- `src/stores/terminalStore.ts:169-181` waits 500 ms after `pty_create`, then writes `startupCmd + "\r"` into the shell.
- `src/stores/terminalStore.ts:499-510` repeats the same pattern for restored sessions.
- This can mark project startup as “intended to run” from the frontend side, but cannot reliably detect completion without shell hooks or output parsing.

#### Existing tab indicator channel is Claude-specific

- `src/stores/terminalStore.ts:11-12` defines `ClaudeHookEventName = "Notification" | "Stop" | "StopFailure"` and `TabNotificationState = "none" | "attention" | "done" | "failed"`.
- `src/stores/terminalStore.ts:93-97` maps Claude `Stop` to `done`, `StopFailure` to `failed`, `Notification` to `attention`.
- `src/components/TerminalTabs.tsx:25-37` assigns colors/labels to those states.
- `src/components/TerminalTabs.tsx:183-189` passes only `tabNotifications[s.id] ?? "none"` to the tab dot, so runtime command state would need either a separate state field or a broader tab-state model.

### Practical Shell Lifecycle Detection Options

#### Option A — PTY child process exit only

- Works today for detecting the terminal shell process ending.
- Does not detect commands run inside the shell.
- Useful fallback:
  - shell process exits with code `0` -> terminal done/closed normally
  - shell process exits non-zero or backend wait error -> failed/error
- Not enough for `command_started`, `command_finished`, or `prompt_shown` while the shell remains open.

#### Option B — Frontend Enter heuristic

- `src/components/XTermTerminal.tsx:274-291` already sees user input and clears `inputBuffer` on `\r`.
- Can infer `command_started` when Enter is pressed and the current input buffer is non-empty.
- Limitations:
  - cannot distinguish accepted command vs multiline continuation;
  - misses commands pasted with embedded newlines in nuanced ways;
  - does not know when the command actually finishes;
  - cannot classify success/failure.
- Practical role: MVP fallback for “running” immediately after user submits input, paired with shell prompt hook for finish.

#### Option C — Shell prompt/hooks emit lifecycle markers

Most practical cross-shell approach: inject a small shell-specific bootstrap that emits machine-readable markers to PTY output. The app parses markers before/while forwarding normal terminal output.

Recommended events:

| Event | Meaning | Typical source |
|---|---|---|
| `prompt_shown` | Shell is ready for input. | PowerShell `prompt` function; bash `PROMPT_COMMAND`; zsh `precmd`. |
| `command_started` | A command line is accepted for execution. | zsh `preexec`; bash `DEBUG` trap with filtering or frontend Enter heuristic; PowerShell frontend Enter heuristic or PSReadLine-based interception if available. |
| `command_finished` | Last command returned an exit status. | Next prompt hook: `$?` / `$LASTEXITCODE` in PowerShell; `$?` in bash/zsh `PROMPT_COMMAND`/`precmd`. |

Marker transport choices:

1. **Custom OSC escape sequence**: for example `ESC ] 777;cli-manager;event=command_finished;exit=0 BEL`.
   - Pros: invisible in terminal if handled/ignored as OSC; common terminal-integration pattern.
   - Cons: backend/frontend must parse and strip to avoid xterm/log pollution; arbitrary programs could emit spoofed sequences.
2. **Plain sentinel line**: for example `__CLI_MANAGER_EVENT__...`.
   - Pros: easiest to parse.
   - Cons: visible and pollutes terminal output/history.
3. **Out-of-band pipe/socket** from bootstrap to app.
   - Pros: clean event channel.
   - Cons: much more implementation surface and Windows quoting/security complexity.

For MVP, custom OSC markers are the best balance.

### Shell-by-Shell Feasibility

| Shell | `prompt_shown` | `command_finished` | `command_started` | Practicality |
|---|---|---|---|---|
| Windows PowerShell (`powershell.exe`) | Override/wrap `function prompt` | In wrapped `prompt`, inspect `$?` and `$LASTEXITCODE` from previous command | No universal native `preexec`; use frontend Enter heuristic for MVP, or PSReadLine integration later | Good for finish/prompt, weaker for start |
| PowerShell 7 (`pwsh.exe`) | Same as Windows PowerShell | Same as Windows PowerShell | Same as Windows PowerShell | Good for finish/prompt, weaker for start |
| bash (`bash.exe`, Git Bash/MSYS-like) | `PROMPT_COMMAND` | In `PROMPT_COMMAND`, inspect `$?` before emitting prompt marker | `trap DEBUG` can emit before simple commands, but is noisy; frontend Enter heuristic is safer for MVP | Good, with DEBUG-trap caveats |
| zsh | `precmd` hook | `precmd` receives previous `$?` semantics before prompt | `preexec` hook is designed for command-start notification | Best lifecycle coverage, but not supported by current `ShellKey` |
| WSL default shell | Depends on shell inside WSL | Depends on shell inside WSL | Depends on shell inside WSL | Harder because `wsl.exe` may launch user default shell; use bash/zsh hooks only if explicitly launching that shell |
| cmd.exe | Prompt customization exists but success/failure and preexec support are weak | `%ERRORLEVEL%` can be read in prompt-like wrappers, but interactive lifecycle hooks are poor | Poor | Not recommended for MVP command lifecycle |

### Injection Mechanism Comparison

| Injection method | Works for | Pros | Cons | Research conclusion |
|---|---|---|---|---|
| **Spawn shell with bootstrap args** | PowerShell/pwsh/bash; zsh with special handling | Session-local; no persistent user-profile mutation; deterministic per tab | Requires changing `resolve_shell`/`CommandBuilder` to support multiple args and per-shell bootstrap files/commands; quoting is tricky | Best default approach |
| **Environment variables only** | All shells can receive metadata (`CLI_MANAGER_SESSION_ID`, token, feature flag) | Low-risk; already supported by `pty_create` env var map | Env alone cannot install prompt/preexec hooks in interactive shells | Use as metadata, not as hook injection by itself |
| **Write bootstrap as first startup command** | All interactive shells | Fits current frontend `pty_write` pattern | Races with user profile prompt; bootstrap text may be visible; ordering conflicts with project `startupCmd`; quoting per shell; can be interrupted | Possible quick prototype, but less clean than spawn args |
| **Modify user profiles** (`$PROFILE`, `.bashrc`, `.zshrc`) | PowerShell/bash/zsh | Persistent and works for manually started shells too | High side-effect risk; can break user prompt frameworks; uninstall complexity; security/trust concerns | Avoid for MVP; optional explicit install only |
| **Shell-specific env profile hooks** | Limited | Can avoid command-line quoting in some cases | Not uniform: Bash `BASH_ENV` is for non-interactive shells; interactive bash uses rc files; PowerShell has no equivalent env-only profile hook | Not sufficient |

Recommended session-local bootstrap patterns:

- **PowerShell/pwsh**: launch with `-NoLogo -NoExit -ExecutionPolicy Bypass -Command "& { . '<temp>/cli-manager.ps1'; <optional startup command> }"` or dot-source bootstrap then remain interactive. If preserving user profile behavior is required, do not add `-NoProfile`; if deterministic bootstrap ordering is required, use `-NoProfile` and explicitly dot-source the user profile only after evaluating compatibility.
- **bash**: launch interactive bash with `--rcfile <temp>/cli-manager.bashrc -i`; temp rc can source the user's `~/.bashrc` then append `PROMPT_COMMAND`/trap hooks, or append hooks before sourcing user rc if app hooks must win.
- **zsh**: zsh lacks a simple bash-style `--rcfile`; common session-local approach is setting `ZDOTDIR=<temp>` and providing a temp `.zshrc` that sources the user's original `.zshrc`, then installs `precmd`/`preexec` hooks using `add-zsh-hook` when available.
- **WSL**: prefer explicit `wsl.exe --exec bash --rcfile ... -i` or `wsl.exe --exec zsh ...` for shell-specific hooks. Plain `wsl.exe` is too ambiguous for reliable lifecycle monitoring.

### Recommended MVP Scope

1. **Do not treat current `pty-status` as command status.** Keep it as shell-process health/exit fallback.
2. **First-class MVP shells**: `powershell`, `pwsh`, and `bash`, because the repository already supports these shell keys.
3. **Defer first-class `zsh` until `ShellKey`/backend shell resolution supports it.** Document the zsh path now because it is the cleanest model (`preexec` + `precmd`), but current code has no `zsh` key.
4. **Use session-local injection, not profile mutation.** Extend backend shell spawn to allow shell-specific args/temp bootstrap and pass session metadata through env vars.
5. **Use frontend Enter/startup-command heuristic for `command_started` in PowerShell/pwsh and optionally bash.** Use prompt hooks for authoritative `command_finished` and `prompt_shown`.
6. **Use shell hook markers for finish/prompt**:
   - PowerShell/pwsh: wrapped `prompt` emits previous command result and prompt marker.
   - bash: `PROMPT_COMMAND` emits previous command result and prompt marker.
7. **Map startup commands explicitly**: when a project `startupCmd` is queued/sent, mark tab `running`; the next `command_finished` marker decides `done`/`failed`.
8. **Use custom OSC markers and strip them before xterm display/logging** to avoid visible sentinel noise.

### Mapping to Tab States

| Input event | Tab state | Notes |
|---|---|---|
| `command_started` | `running` | Emitted by zsh `preexec`, bash DEBUG trap if used, or frontend heuristic when Enter/startup command is submitted. |
| Startup command sent | `running` | Existing delayed `pty_write(startupCmd + "\r")` can trigger this immediately. |
| `prompt_shown` with no known active command | `done` or neutral | For initial shell prompt, avoid showing “done” if no command has run yet; use neutral/none unless a command was active. |
| `command_finished` with exit code `0` / PowerShell success | `done` | Last command completed successfully. |
| `command_finished` with non-zero exit code / PowerShell failure | `failed` | PowerShell should prefer native `$LASTEXITCODE` when meaningful, otherwise map `$? -eq $false` to failure. |
| PTY shell process exits with code `0` | `done` or closed | Fallback when shell itself exits. |
| PTY shell process exits non-zero or backend status `error` | `failed` | Fallback for shell-level failure, not command-level failure. |
| Claude `Notification` | Existing `attention` | Keep separate priority rules if runtime and Claude states share the same dot. |

Important priority question if using the existing tab dot: decide whether Claude notifications or runtime command states win when both exist. Current code only models `TabNotificationState`; a separate runtime state avoids overwriting Claude `attention`/`failed` semantics.

### Risks

1. **Prompt-framework collisions**: Oh My Posh, starship, custom PowerShell `prompt`, bash prompt managers, and zsh plugin frameworks may overwrite or reorder hooks.
2. **PowerShell command-start gap**: PowerShell has a clean prompt hook but no built-in universal `preexec`; Enter heuristic can mark multiline input as running too early.
3. **bash DEBUG trap noisiness**: `trap DEBUG` fires before every simple command, including commands inside functions and prompt hooks unless carefully guarded.
4. **Exit-code semantics differ**:
   - POSIX shells use integer `$?`.
   - PowerShell `$?` is Boolean success of the last operation; `$LASTEXITCODE` applies mainly to native executables and can be stale after pure PowerShell commands.
5. **Initial prompt false “done”**: prompt hooks run when the shell first becomes ready; this should be `prompt_shown`, not `command_finished`.
6. **Nested shells/SSH/TUI programs**: lifecycle hooks only observe the current shell. Full-screen apps, nested shells, SSH sessions, and REPLs may suppress prompts or emit misleading output.
7. **Marker spoofing**: any process can print the custom OSC marker. Include an unguessable per-session token in markers if events affect user-visible state.
8. **Windows quoting and path escaping**: PowerShell `-Command`, bash `--rcfile`, WSL `--exec`, and temp path handling have different quoting rules.
9. **Execution policy/security perception**: PowerShell bootstrap using `-ExecutionPolicy Bypass` may be sensitive; prefer signed/local temp scripts or explain scope if implemented.
10. **Output parser placement**: if markers are parsed after base64 decode in frontend, they must be removed before `terminal.write`; if parsed in Rust, parser must preserve UTF-8/ANSI boundary protections currently implemented in `src-tauri/src/pty/boundary.rs`.
11. **Restored sessions**: repository comments say startup restore avoids rebuilding historical terminals in some startup paths; lifecycle state should not rerun persisted startup commands unintentionally.

### External References

- [Microsoft Learn, PowerShell `about_Prompts`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_prompts?view=powershell-7.5) — documents the `prompt` function customization point used for `prompt_shown` and previous-command finish markers.
- [Microsoft Learn, PowerShell `about_Automatic_Variables`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_automatic_variables?view=powershell-7.5) — documents `$?` and `$LASTEXITCODE`, needed for success/failure mapping.
- [GNU Bash Manual, Bash Variables](https://www.gnu.org/software/bash/manual/html_node/Bash-Variables.html) — documents `PROMPT_COMMAND`, the practical hook for prompt/finish markers in bash.
- [GNU Bash Manual, Bourne Shell Builtins / `trap`](https://www.gnu.org/software/bash/manual/html_node/Bourne-Shell-Builtins.html) — documents traps, including the basis for DEBUG-trap command-start detection.
- [Zsh Manual, Functions / Hook Functions](https://zsh.sourceforge.io/Doc/Release/Functions.html) — documents zsh hook functions such as `precmd` and `preexec`, the cleanest shell-native lifecycle pair.
- [Final Term / terminal shell integration control sequences](https://iterm2.com/documentation-escape-codes.html) — iTerm2 documents shell-integration style OSC control sequences; useful precedent for invisible terminal lifecycle markers, though the app can use its own private OSC namespace.

### Related Specs

- `.trellis/spec/backend/index.md` — backend command signatures and Rust/Tauri checks.
- `.trellis/spec/frontend/component-guidelines.md` — xterm lifecycle guidance; avoid recreating terminals for status UI changes.
- `.trellis/spec/guides/cross-layer-thinking-guide.md` — this feature crosses backend PTY spawn/output parsing, frontend store state, and tab UI.
- `.trellis/spec/guides/tauri-user-file-security-checklist.md` — relevant if bootstrap scripts are written to app-local temp/data paths or if any new Tauri command accepts paths.

## Caveats / Not Found

- No existing repository code detects per-command `command_started`, `command_finished`, or `prompt_shown` today.
- No current first-class `zsh` shell key exists in `src/lib/shell.ts` or `src-tauri/src/pty/manager.rs`; zsh support would be new shell support, not just lifecycle monitoring.
- External references were limited to official/manual documentation reachable during research; no implementation-specific Tauri/xterm shell-integration library was found in the repository.
- Exact bootstrap script content was not produced because this research task is descriptive and must not modify code outside this research file.
