import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function load(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const { applyAgentDetection, acceptsAgentHook, applyHookAgentIdentity } = await load("../src/lib/terminalAgent.ts");
const { resolveAgentTerminalMetadata } = await load("../src/lib/agentTerminal.ts");
const codex = { tool: "codex", pid: 20, startedAt: 100, runId: "20:100", detectedAtMs: 100100 };
const detection = (agent, updatedAtMs = 100100) => ({ agent, updatedAtMs });

test("manual Agent detection overrides project configuration without changing the restart command", () => {
  const shell = { id: "pane-a", startupCmd: "", isAgentSession: false };
  const bound = applyAgentDetection(shell, detection(codex));
  assert.equal(bound.startupCmd, "");
  assert.deepEqual(resolveAgentTerminalMetadata(bound, { cli_tool: "claude" }), { isAgentSession: true, cliTool: "codex" });
  assert.equal(acceptsAgentHook(bound, { source: "codex", agentRunId: codex.runId }), true);
  assert.equal(acceptsAgentHook(bound, { source: "claude" }), false);
});

test("Agent exit clears session bindings and restores a regular shell despite a configured Agent", () => {
  const running = { ...applyAgentDetection({ id: "a" }, detection(codex)), cliSessionId: "old", cliReasoningEffort: "high" };
  const exited = applyAgentDetection(running, detection(null, 101000));
  assert.equal(exited.cliSessionId, undefined);
  assert.equal(exited.cliReasoningEffort, undefined);
  assert.deepEqual(resolveAgentTerminalMetadata(exited, { cli_tool: "codex" }), { isAgentSession: false, cliTool: undefined });
  assert.equal(acceptsAgentHook(exited, { source: "codex" }), false);
});

test("same-tool restart and tool switches reject Hooks from superseded process incarnations", () => {
  const previous = { ...applyAgentDetection({ id: "a" }, detection(codex)), cliSessionId: "old" };
  const restarted = applyAgentDetection(previous, detection({ ...codex, runId: "21:102", pid: 21, startedAt: 102 }, 102100));
  assert.equal(restarted.cliSessionId, undefined);
  assert.equal(acceptsAgentHook(restarted, { source: "codex", agentRunId: codex.runId }), false);
  assert.equal(acceptsAgentHook(restarted, { source: "codex", timestamp: new Date(101000).toISOString() }), false);
  const switched = applyAgentDetection(restarted, detection({ ...codex, tool: "claude", runId: "22:103" }, 103100));
  assert.equal(acceptsAgentHook(switched, { source: "codex" }), false);
});

test("unchanged observations retain precise Hook bindings; older observations cannot roll them back", () => {
  const current = { ...applyAgentDetection({ id: "a" }, detection(codex)), cliSessionId: "current" };
  assert.equal(applyAgentDetection(current, detection(codex, 101000)), current);
  assert.equal(applyAgentDetection(current, detection(null, 99000)), current);
});

test("promotion of matching Hook evidence preserves its precise session identity", () => {
  const current = { id: "a", cliSessionId: "hook-session", runtimeAgent: { ...codex, source: "hook" } };
  const promoted = applyAgentDetection(current, detection(codex));
  assert.equal(promoted.cliSessionId, "hook-session");
  assert.equal(promoted.runtimeAgent.source, "process");
});

test("panes sharing a project keep separate runtime identities; old daemons retain launch fallback", () => {
  const first = applyAgentDetection({ id: "a", cwd: "/project" }, detection(codex));
  const second = { id: "b", cwd: "/project", isAgentSession: false };
  assert.equal(first.runtimeAgent.tool, "codex");
  assert.equal(second.runtimeAgent, undefined);
  assert.deepEqual(resolveAgentTerminalMetadata({ cliTool: "claude", isAgentSession: true }, null), { cliTool: "claude", isAgentSession: true });
});

test("a Hook carrying the daemon observation can beat the separate WebSocket event", () => {
  const shell = applyAgentDetection({ id: "a" }, detection(null, 99000));
  const promoted = applyAgentDetection(shell, detection(codex));
  assert.equal(acceptsAgentHook(promoted, { source: "codex", agentRunId: codex.runId }), true);
  const restored = applyAgentDetection({ id: "a" }, detection({ ...codex, cliSessionId: "background-session" }));
  assert.equal(restored.cliSessionId, "background-session");
});

test("guest Hook identity can switch providers and rejects events older than that switch", () => {
  const previous = applyHookAgentIdentity({ id: "remote" }, { source: "codex", sessionId: "old", timestamp: new Date(100000).toISOString() });
  const switched = applyHookAgentIdentity(previous, { source: "claude", sessionId: "new", timestamp: new Date(101000).toISOString() });
  assert.equal(switched.runtimeAgent.tool, "claude");
  assert.equal(switched.cliSessionId, undefined);
  assert.equal(acceptsAgentHook(switched, { source: "codex", timestamp: new Date(100500).toISOString() }), false);
});
