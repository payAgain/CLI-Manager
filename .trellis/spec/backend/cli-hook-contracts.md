# CLI Hook Contracts

Concrete contracts for Claude/Codex hook integration.

## Scenario: Sub-Agent Transcript Hook

### 1. Scope / Trigger

- Trigger: a CLI emits `SubagentStart` and CLI-Manager opens a read-only transcript pane for that child agent; the matching `SubagentStop` marks it finished and closes the pane after a short grace period.
- Applies to: hook installation, hidden `__hook` client, local TCP bridge payload, frontend `CliHookPayload`, and transcript subscription.

### 2. Signatures

- Installed hook command: `<cli-manager-exe> __hook --source <claude|codex> --event <event>`.
- Bridge event name: `claude-hook-notification`.
- Frontend subscribe command: `subagent_transcript_subscribe({ key, transcriptPath, cwd, sessionId, agentId })`.
- Frontend store action on stop: `finishSubagentTranscript(payload)`.

### 3. Contracts

- Common payload fields: `tabId`, `source`, `event`, `title`, `message`, `sessionId`, `cwd`, `timestamp`.
- Claude sub-agent fields: `agentId`, `agentType`, `agentTranscriptPath`.
- Codex sub-agent fields: `agentId`, `agentType`, `transcriptPath`.
- Frontend transcript path priority: `agentTranscriptPath ?? transcriptPath ?? derive from cwd/sessionId/agentId`.
- `SubagentStart` and `SubagentStop` must be installed/uninstalled together for each source.
- Stop routing priority: match by `agentId`; if missing, close only when exactly one transcript pane belongs to the parent `tabId`.

### 4. Validation & Error Matrix

- Empty or overlong `tabId` -> bridge rejects with `400 invalid payload`.
- Unknown `source` -> bridge rejects with `400 invalid payload`.
- Event not allowed for its source -> bridge rejects with `400 invalid payload`.
- Missing explicit transcript path and missing derivation fields -> `subagent_transcript_subscribe` returns the specific missing field error.
- Missing or ambiguous stop target -> frontend does nothing; it must not guess and close multiple child panes.

### 5. Good/Base/Bad Cases

- Good: Codex `SubagentStart` includes `transcript_path`; frontend subscribes directly to that path.
- Base: Claude `SubagentStart` includes `agent_transcript_path`; frontend uses it unchanged.
- Good: `SubagentStop` includes `agent_id`; frontend marks the pane ended and closes it after the grace delay.
- Bad: A new hook event is installed but not added to the bridge whitelist; the hook silently posts but the bridge rejects it.
- Bad: `SubagentStop` has no `agent_id` while multiple child panes share one parent; frontend must not close all of them.

### 6. Tests Required

- Hook install/uninstall tests assert `SubagentStart` and `SubagentStop` are written and removed for the affected source.
- Rust compile check must pass after bridge payload or command signature changes.
- TypeScript type-check must pass after `CliHookPayload` field changes.

### 7. Wrong vs Correct

#### Wrong

```ts
transcriptPath: payload.agentTranscriptPath ?? null
```

#### Correct

```ts
transcriptPath: payload.agentTranscriptPath ?? payload.transcriptPath ?? null
```
