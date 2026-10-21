import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_YOLO_ARGS, applyAgentLaunchPermissions as apply, normalizeAgentPermissionMode } from "../src/lib/agentLaunchPermissions.ts";

test("each supported Agent receives its own bypass recipe exactly once", () => {
  for (const [tool, args] of Object.entries(AGENT_YOLO_ARGS)) {
    const command = apply(`${tool} --model test`, "yolo");
    assert.equal(command, `${tool} ${args} --model test`);
    assert.equal(apply(command, "yolo"), command);
  }
});

test("manual and unrecognized stored values retain the user's original command", () => {
  for (const mode of ["manual", "true", true, 1, {}]) {
    assert.equal(normalizeAgentPermissionMode(mode), "manual");
    assert.equal(apply("codex --full-auto", normalizeAgentPermissionMode(mode)), "codex --full-auto");
  }
  assert.equal(normalizeAgentPermissionMode("yolo"), "yolo");
  for (const mode of [undefined, null]) {
    assert.equal(normalizeAgentPermissionMode(mode), "yolo");
    assert.equal(apply("codex", normalizeAgentPermissionMode(mode)), `codex ${AGENT_YOLO_ARGS.codex}`);
    assert.equal(apply("pi", normalizeAgentPermissionMode(mode)), "pi");
  }
  assert.equal(apply(undefined, "yolo"), undefined);
});

test("new and resumed Agent commands retain model, identity and quoted prompt arguments", () => {
  for (const command of ['codex resume --no-alt-screen 019-id --model test', 'codex fork 019-id', 'codex "fix the --yolo docs"', 'claude --resume 019-id --model test', "gemini --resume 019-id"]) {
    const tool = command.split(" ")[0];
    assert.equal(apply(command, "yolo"), `${tool} ${AGENT_YOLO_ARGS[tool]}${command.slice(tool.length)}`);
  }
  assert.equal(apply('codex -- "--yolo"', "yolo"), 'codex --dangerously-bypass-approvals-and-sandbox -- "--yolo"');
});

test("explicit permission arguments and profiles take precedence over automatic YOLO", () => {
  for (const command of [
    "codex -a on-request", "codex --sandbox=read-only", "codex --full-auto", "codex --auto-review", "codex --profile work",
    "codex -c 'approval_policy=\"on-request\"'", "codex --config=sandbox_mode=read-only",
    "claude --permission-mode plan", "grok --permission-mode default", "gemini --approval-mode=plan", "qwen --approval-mode default",
    "cline --auto-approve false", "aider --no-yes-always", "copilot --deny-tool shell",
  ]) assert.equal(apply(command, "yolo"), command);
  assert.equal(apply("codex -c theme=catppuccin-latte", "yolo"), "codex --dangerously-bypass-approvals-and-sandbox -c theme=catppuccin-latte");
});

test("literal executable paths and Windows launchers receive arguments outside the path quotes", () => {
  for (const executable of ['"C:\\Program Files\\codex.exe"', '& "C:\\Program Files\\codex.ps1"', "'/opt/agent tools/codex'", "codex.cmd"]) {
    assert.equal(apply(`${executable} resume 019-id`, "yolo"), `${executable} --dangerously-bypass-approvals-and-sandbox resume 019-id`);
  }
});

test("WSL distribution, user, directory and environment prefixes stay intact", () => {
  for (const prefix of ["wsl ", "wsl.exe -d Ubuntu -- ", "wsl -d Ubuntu -u me --cd /repo -e ", "env CODEX_HOME=/tmp/codex ", "CODEX_HOME='/tmp/agent config' ", "wsl -- env CODEX_HOME=/home/me/.codex "]) {
    assert.equal(apply(`${prefix}codex resume 019-id`, "yolo"), `${prefix}codex --dangerously-bypass-approvals-and-sandbox resume 019-id`);
  }
});

test("scripts, substitutions, utilities and unrelated commands remain unchanged", () => {
  for (const command of [
    "npm run codex", "echo codex", 'echo "claude"', "codex && echo done", "cd /repo; codex", "codex | tee output",
    "codex > output", "codex\nclaude", 'codex "$(pwd)"', "codex `pwd`", "bash -lc 'codex'", "wsl --status",
    "codex --help", "claude --version", "codex app-server", "codex mcp list", "codex exec task", "claude login",
    "opencode", "pi", "goose", "constructor", "toString", 'codex "unterminated',
  ]) assert.equal(apply(command, "yolo"), command, command);
});
