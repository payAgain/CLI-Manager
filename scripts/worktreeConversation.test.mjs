import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const plain = value => JSON.parse(JSON.stringify(value));
function modules(overrides = {}) {
  const cache = new Map();
  function load(path) {
    if (Object.hasOwn(overrides, path)) return overrides[path];
    if (!isAbsolute(path)) return require(path);
    if (cache.has(path)) return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, { exports, Date, Set, Map,
      require: name => load(name.startsWith(".") ? resolve(dirname(path), `${name}.ts`) : name),
    });
    return exports;
  }
  return path => load(resolve(root, path));
}
const load = modules();
const { planWorktreeContinuation, worktreeConversationIdentity } = load("src/lib/worktreeConversation.ts");
const project = { id: "project", name: "Project", path: "/repo", cli_tool: "codex", cli_args: "", startup_cmd: "",
  shell: "zsh", environment_type: "local", env_vars: '{"PROJECT":"kept"}' };
const worktree = { id: "feature", project_id: project.id, path: "/trees/feature", branch: "feature", status: "active" };
const conversationId = "019f5e8b-2d11-76d1-89b4-a0c0ff20d111";
const source = { id: "source", title: "Current conversation", projectId: project.id, cwd: project.path,
  shell: "zsh", cliTool: "codex", isAgentSession: true, cliSessionId: conversationId,
  workspace: { id: "main:project", projectId: project.id, path: project.path, environmentType: "local" },
  envVars: { INSTANCE: "kept" } };

test("Codex continuation uses the exact identity and authoritative target cwd, preserving model and environment", () => {
  const target = { ...worktree, path: "/trees/it's a feature" };
  const p = { ...project, cli_args: 'resume old-id --last -C/old --model "fast model"' };
  const plan = planWorktreeContinuation(source, p, target, conversationId);
  assert.equal(plan.cwd, target.path);
  assert.equal(plan.startupCmd, `codex resume --no-alt-screen ${conversationId} --model "fast model" --cd '/trees/it'\\''s a feature'`);
  assert.deepEqual(plain(plan.envVars), { PROJECT: "kept", INSTANCE: "kept" });
  assert.equal(plan.source.cliSessionId, conversationId);
});

test("Claude continuation keeps the same conversation and does not fork or inherit another Worktree selector", () => {
  const p = { ...project, cli_tool: "claude", cli_args: '-r old-id -c -wold --fork-session --model opus' };
  const plan = planWorktreeContinuation({ ...source, cliTool: "claude" }, p, worktree, conversationId);
  assert.equal(plan.startupCmd, `claude --resume ${conversationId} --model opus`);
  assert.equal(plan.cwd, worktree.path);
  const back = planWorktreeContinuation({ ...source, worktreeId: worktree.id,
    workspace: { ...source.workspace, id: worktree.id, worktreeId: worktree.id, path: worktree.path } }, project, null, conversationId);
  assert.equal(back.cwd, project.path);
});

test("WSL and PowerShell target paths are passed in the correct shell format", () => {
  for (const [shell, path, expected] of [
    ["wsl", "\\\\wsl.localhost\\Ubuntu\\home\\user\\repo", "'/home/user/repo'"],
    ["wsl.exe", "D:\\Work\\feature", "'/mnt/d/Work/feature'"],
    ["powershell", "C:\\Work\\it's a feature", "'C:\\Work\\it''s a feature'"],
    ["cmd.exe", "C:\\Work\\feature", '"C:\\Work\\feature"'],
  ]) {
    const plan = planWorktreeContinuation({ ...source, shell }, project, { ...worktree, path }, conversationId);
    assert.ok(plan.startupCmd.endsWith(`--cd ${expected}`), plan.startupCmd);
  }
});

test("unsafe or ambiguous continuation does not generate a launch command", () => {
  for (const [session, p, target, expectedId, issue] of [
    [{ ...source, runtimeAgent: null }, project, worktree, conversationId, "notAgent"],
    [{ ...source, cliSessionId: undefined }, project, worktree, conversationId, "missingId"],
    [{ ...source, cliSessionId: "$(touch bad)" }, project, worktree, conversationId, "missingId"],
    [{ ...source, cliTool: "pi" }, project, worktree, conversationId, "unsupportedTool"],
    [{ ...source, environmentType: "ssh" }, project, worktree, conversationId, "remoteUnsupported"],
    [{ ...source, startupCmd: "wsl -d Ubuntu codex" }, project, worktree, conversationId, "unsupportedLaunch"],
    [source, { ...project, cli_args: "--remote wss://example.invalid" }, worktree, conversationId, "unsupportedLaunch"],
    [{ ...source, workspace: null }, project, worktree, conversationId, "unbound"],
    [source, project, worktree, "another-id", "sourceChanged"],
    [source, project, { ...worktree, project_id: "other" }, conversationId, "missingTarget"],
    [source, project, { ...worktree, status: "missing" }, conversationId, "missingTarget"],
    [source, project, null, conversationId, "sameTarget"],
    [source, project, { ...worktree, path: "/line\nbreak" }, conversationId, "invalidPath"],
    [{ ...source, shell: "cmd.exe" }, project, { ...worktree, path: "C:\\%PATH%" }, conversationId, "invalidPath"],
  ]) assert.throws(() => planWorktreeContinuation(session, p, target, expectedId), error => error.issue === issue, issue);
});

function harness(options = {}) {
  const calls = [], saved = [], created = [];
  const other = { ...source, id: "unrelated", title: "Unrelated", cliSessionId: "other-conversation" };
  const state = { sessions: [structuredClone(source), other], sessionStatuses: { source: "running", unrelated: "running" },
    statusListeners: { source: () => calls.push("unsubscribe") },
    workspans: [{ id: "span", activePaneId: "source-pane", activeSessionId: "source",
      paneTree: { type: "split", id: "split", direction: "horizontal", ratio: 0.4,
        first: { type: "leaf", id: "source-pane", sessionIds: ["source"], activeSessionId: "source" },
        second: { type: "leaf", id: "other-pane", sessionIds: ["unrelated"], activeSessionId: "unrelated" } } }],
    createSession: async (...args) => {
      calls.push("launch"); created.push(args);
      if (options.launchFailure) throw new Error("launch failed");
      state.sessions.push({ ...source, id: "target", worktreeId: args[7], cwd: args[1] });
      return "target";
    },
    closeSession: async id => { calls.push(`remove:${id}`); state.sessions = state.sessions.filter(session => session.id !== id); },
    setTerminalScope: scope => { state.terminalScope = scope; },
    setActive: id => { state.activeSessionId = id; },
  };
  const catalog = { projects: [project], worktrees: [worktree] };
  const localLoad = modules({
    "@tauri-apps/api/core": { invoke: async (command, args) => {
      calls.push("preflight"); assert.equal(command, "check_paths_exist"); assert.deepEqual(plain(args.paths), [worktree.path]);
      return [!options.missing];
    } },
    [resolve(root, "src/stores/terminalStore.ts")]: { useTerminalStore: {
      getState: () => state, setState: update => Object.assign(state, typeof update === "function" ? update(state) : update),
    } },
    [resolve(root, "src/stores/projectStore.ts")]: { useProjectStore: { getState: () => catalog } },
    [resolve(root, "src/stores/sessionStore.ts")]: { useSessionStore: { getState: () => ({ saveSessions: async (sessions, flush) => {
      assert.equal(flush, true, "recovery and final snapshots must reach disk");
      calls.push("flush"); saved.push(plain(sessions));
      if (options.flushFailure) throw new Error("disk failed");
      options.afterFlush?.(state);
    } }) } },
    [resolve(root, "src/terminal/core/TerminalProcessManager.ts")]: { terminalProcessManager: { close: async id => {
      assert.equal(id, "source"); calls.push("stop");
      if (options.stopFailure) throw new Error("stop failed");
      // Simulate the real exit notification clearing volatile Agent identity before the ACK.
      state.sessions[0] = { ...state.sessions[0], runtimeAgent: null, cliSessionId: undefined };
      state.sessionStatuses.source = "exited";
    } } },
  });
  const api = localLoad("src/stores/worktreeContinuationStore.ts").useWorktreeContinuationStore;
  api.getState().open("source");
  return { api, state, calls, saved, created, catalog, other };
}

test("continuation flushes recovery before stop, awaits stop before launch and preserves the original pane", async () => {
  const h = harness();
  assert.equal(await h.api.getState().continueIn(worktree.id), "target");
  assert.deepEqual(h.calls, ["preflight", "flush", "stop", "unsubscribe", "flush", "launch", "remove:source", "flush"]);
  assert.equal(h.saved[0][0].cliSessionId, conversationId);
  assert.equal(h.created[0][6], "source-pane");
  assert.equal(h.created[0][7], worktree.id);
  assert.equal(h.created[0][9], conversationId);
  assert.equal(h.created[0][13], true, "launch must await startup command delivery");
  assert.equal(h.state.activeSessionId, "target");
  assert.equal(h.state.terminalScope.worktreeId, worktree.id);
  assert.equal(h.state.sessions.find(s => s.id === "unrelated"), h.other);
  assert.equal(h.state.workspans[0].paneTree.ratio, 0.4);
  assert.equal(h.api.getState().pending, false);
  assert.equal(h.api.getState().intent, null);
});

test("preflight, disk and stop failures never launch another copy of the conversation", async () => {
  for (const options of [{ missing: true }, { flushFailure: true }, { stopFailure: true }]) {
    const h = harness(options);
    await assert.rejects(h.api.getState().continueIn(worktree.id));
    assert.ok(!h.calls.includes("launch"));
    if (!options.stopFailure) assert.ok(!h.calls.includes("stop"));
    assert.equal(h.state.sessions[0].cliSessionId, conversationId);
    assert.equal(h.api.getState().pending, false);
  }
});

test("a launch failure retains exact recovery identity despite the old PTY exit event", async () => {
  const h = harness({ launchFailure: true });
  await assert.rejects(h.api.getState().continueIn(worktree.id), /launch failed/);
  assert.equal(h.state.sessions[0].id, "source");
  assert.equal(h.state.sessionStatuses.source, "exited");
  assert.equal(worktreeConversationIdentity(h.state.sessions[0], project).sessionId, conversationId);
  assert.equal(h.saved.at(-1)[0].cliSessionId, conversationId);
  assert.equal(h.api.getState().intent.sourceId, "source");
  assert.equal(h.state.sessions[1], h.other);
});

test("changed identity during asynchronous persistence and duplicate running copies block the stop", async () => {
  const changed = harness({ afterFlush: state => { state.sessions[0].cliSessionId = "changed-conversation"; } });
  await assert.rejects(changed.api.getState().continueIn(worktree.id), error => error.issue === "sourceChanged");
  assert.ok(!changed.calls.includes("stop"));
  const duplicate = harness();
  duplicate.state.sessions[1].cliSessionId = conversationId;
  await assert.rejects(duplicate.api.getState().continueIn(worktree.id), error => error.issue === "busy");
  assert.ok(!duplicate.calls.includes("stop"));
});
