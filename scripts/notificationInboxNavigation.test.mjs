import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { resolveNotificationTarget } from "../src/lib/notificationInbox.ts";

const source = readFileSync(new URL("../src/lib/notificationInboxNavigation.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness({ alive = true, compact = false, afterList } = {}) {
  const events = [];
  const session = { id: "pty", cliSessionId: "cli", environmentType: "ssh", sshHostId: "host", kind: "pty" };
  const terminal = {
    sessions: [session], workspans: [{ id: "mixed", sessions: ["pty"] }], activeSessionId: "old",
    setTerminalScope: scope => events.push(["scope", scope]),
    setActive: id => { terminal.activeSessionId = id; events.push(["active", id]); },
  };
  const settings = {
    viewMode: compact ? "compact" : "standard",
    update: async (key, value) => { settings[key] = value; events.push(["setting", key, value]); },
  };
  const modules = {
    "@tauri-apps/api/core": { invoke: async name => {
      assert.equal(name, "pty_daemon_sessions", "navigation cannot invoke a launch command");
      afterList?.(terminal);
      return [{ sessionId: "pty", alive }];
    } },
    "../stores/historyStore": { useHistoryStore: { getState: () => ({ closeHistory: () => events.push(["history-close"]) }) } },
    "../stores/settingsStore": { useSettingsStore: { getState: () => settings } },
    "../stores/terminalStore": { useTerminalStore: { getState: () => terminal } },
    "../stores/terminalWorkspan": { findWorkspanBySession: (workspans, id) => workspans.find(w => w.sessions.includes(id)) },
    "./notificationInbox": { resolveNotificationTarget },
    "./terminalScope": { ALL_TERMINALS_SCOPE: { kind: "all" } },
  };
  const exports = {};
  new Function("exports", "require", compiled)(exports, name => {
    assert.ok(modules[name], `unexpected dependency ${name}`);
    return modules[name];
  });
  const target = { source: "codex", tabId: "pty", cliSessionId: "cli", agentRunId: null, environment: "ssh", hostId: "host", wslDistro: null };
  return { ...exports, target, terminal, events, settings };
}

test("opening a live notification reveals its complete Workspan and exits compact mode", async () => {
  const h = harness({ compact: true });
  assert.equal(await h.activateNotificationTarget(h.target), true);
  assert.deepEqual(h.events, [["history-close"], ["scope", { kind: "all" }], ["active", "pty"], ["setting", "viewMode", "standard"]]);
});

test("closed, stale, wrong-host and orphaned targets never launch or change the workspace", async () => {
  for (const variant of ["dead", "closed", "identity", "host", "workspan"]) {
    const h = harness({ alive: variant !== "dead", afterList: state => {
      if (variant === "closed") state.sessions = [];
      if (variant === "identity") state.sessions[0].cliSessionId = "another";
      if (variant === "host") state.sessions[0].sshHostId = "another";
      if (variant === "workspan") state.workspans = [];
    } });
    assert.equal(await h.activateNotificationTarget(h.target), false, variant);
    assert.deepEqual(h.events, [], variant);
  }
});

test("missing target fails without querying or modifying sessions", async () => {
  const h = harness();
  assert.equal(await h.activateNotificationTarget({ ...h.target, tabId: "gone", cliSessionId: "other" }), false);
  assert.deepEqual(h.events, []);
});
