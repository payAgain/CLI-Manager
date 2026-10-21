import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const cli = url(compile(readFileSync(new URL("../src/lib/cliTools.ts", import.meta.url), "utf8")));
const resume = url(compile(readFileSync(new URL("../src/lib/resumeCliArgs.ts", import.meta.url), "utf8")));
const code = compile(readFileSync(new URL("../src/lib/subagentBrowser.ts", import.meta.url), "utf8"))
  .replace('from "./cliTools"', `from "${cli}"`).replace('from "./resumeCliArgs"', `from "${resume}"`);
const { resolveSubagentBrowserIdentity: identity, inferWslDistroFromCwd, resolveSubagentConfigDir } = await import(url(code));

test("restored Codex conversations can browse children before any Hook, using the exact resume ID", () => {
  const base = { id: "restored", cliTool: "codex", startupCmd: "codex resume --no-alt-screen main-123" };
  assert.deepEqual(identity(base), { source: "codex", parentSessionId: "main-123" });
  assert.deepEqual(identity({ ...base, cliSessionId: "bound-123" }), { source: "codex", parentSessionId: "bound-123" });
  assert.deepEqual(identity({ ...base, runtimeAgent: { tool: "codex", cliSessionId: "live-123" } }), { source: "codex", parentSessionId: "live-123" });
  assert.equal(identity({ id: "other", cliTool: "codex", startupCmd: "codex resume --last" }), null);
});

test("pending restores, Claude resumes, unsupported tools and child tabs keep distinct identities", () => {
  const parent = { id: "p", cliTool: "claude", startupCmd: "claude --resume old-123" };
  assert.deepEqual(identity(parent), { source: "claude", parentSessionId: "old-123" });
  assert.deepEqual(identity({ ...parent, pendingConversationResume: { tool: "codex", sessionId: "pending", expiresAtMs: Date.now() + 60000 } }), { source: "codex", parentSessionId: "pending" });
  assert.equal(identity({ ...parent, kind: "subagent-transcript" }), null);
  assert.equal(identity({ id: "shell", cliTool: "gemini", cliSessionId: "same" }), null);
  assert.equal(identity({ ...parent, cliSessionId: "../other" }), null);
});

test("WSL path aliases retain the distribution and never classify SSH/Linux paths as local WSL", () => {
  for (const path of ["//wsl.localhost/Ubuntu/home/me", "\\\\wsl$\\Ubuntu\\home\\me", "\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me"]) assert.equal(inferWslDistroFromCwd(path), "Ubuntu");
  assert.equal(inferWslDistroFromCwd("/home/me/repo"), null);
  assert.equal(inferWslDistroFromCwd("/Users/me/repo"), null);
});

test("subagent browsing follows the session environment, project installation and selected history root in order", () => {
  const defaults = { codexConfigDir: "/selected/codex", claudeConfigDir: "/selected/claude" };
  assert.equal(resolveSubagentConfigDir("codex", { envVars: { CODEX_HOME: "/session/codex" } }, { cli_config_root: "/project" }, defaults), "/session/codex");
  assert.equal(resolveSubagentConfigDir("claude", {}, { cli_config_root: "/project" }, defaults), "/project");
  assert.equal(resolveSubagentConfigDir("claude", {}, null, defaults), "/selected/claude");
  assert.equal(resolveSubagentConfigDir("codex", {}, null, {}), null);
});

const store = readFileSync(new URL("../src/stores/historyStore.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("historyStore.ts", store, ts.ScriptTarget.Latest, true);
const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ["fetchRemoteSubagentSessions", "fetchRemoteSubagentDetail"].includes(node.name?.text));
const remoteCode = compile(functions.map(node => node.getText(ast).replace(/^export /, "")).join("\n"));
function remoteHarness({ stalled = false, mismatched = false, pagedCache = false } = {}) {
  const calls = [];
  let page = 0;
  const environment = {
    buildSshAgentHistoryContext: async () => ({ hostId: "host-a", source: "codex", consumerId: "project-consumer", projectPaths: ["/repo"], sourceInstanceId: "instance-a" }),
    syncRemoteHistoryContext: async context => ({ ...context, cursor: stalled ? "" : String(++page), hasMore: stalled || page === 1 }),
    normalizeSummary: value => value,
    normalizeDetail: value => value,
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "history_remote_list_cached") {
        if (pagedCache && args.offset === 0) return Array.from({length:args.limit}, (_, index) => ({session_id:`foreign-${index}`,subagent:{parent_session_id:"other"}}));
        return [{ session_id: "child", subagent: { parent_session_id: "main" } }, { session_id: "foreign", subagent: { parent_session_id: "other" } }];
      }
      if (command === "history_remote_get_session") return { session_id: "child", session_ref: { sourceInstanceId: mismatched ? "instance-b" : "instance-a" } };
    },
  };
  const api = new Function(...Object.keys(environment), `${remoteCode}\nreturn {fetchRemoteSubagentSessions,fetchRemoteSubagentDetail};`)(...Object.values(environment));
  return { ...api, calls };
}

test("remote discovery exhausts pages, filters by parent and keeps a dedicated consumer in its source instance", async () => {
  const { fetchRemoteSubagentSessions, calls } = remoteHarness();
  const { context, summaries } = await fetchRemoteSubagentSessions({}, "main");
  assert.deepEqual(summaries.map(item => item.session_id), ["child"]);
  assert.equal(context.cursor, "2");
  assert.match(context.consumerId, /^project-consumer:subagents:main:/);
  assert.deepEqual(context.projectPaths, []);
  assert.equal(calls[0].command, "history_remote_list_cached");
  assert.equal(calls[0].args.sourceInstanceId, "instance-a");
  assert.equal(calls[0].args.projectPath, null);
});

test("stalled remote sync releases its consumer and detail mismatches are rejected", async () => {
  const stalled = remoteHarness({ stalled: true });
  await assert.rejects(stalled.fetchRemoteSubagentSessions({}, "main"), /history_remote_sync_stalled/);
  assert.equal(stalled.calls.at(-1).command, "history_remote_close");
  const remote = remoteHarness({ mismatched: true });
  await assert.rejects(remote.fetchRemoteSubagentDetail({ sourceInstanceId: "instance-a" }, "child"), /history_remote_identity_mismatch/);
  await assert.rejects(remote.fetchRemoteSubagentSessions({}, "main", "instance-b"), /history_remote_identity_mismatch/);
  assert.equal(remote.calls.at(-1).command, "history_remote_close");
});

test("remote browsing reads cached pages beyond the IPC default of twenty records", async () => {
  const remote = remoteHarness({pagedCache:true});
  const {summaries} = await remote.fetchRemoteSubagentSessions({}, "main");
  assert.deepEqual(summaries.map(item=>item.session_id), ["child"]);
  const pages = remote.calls.filter(call=>call.command === "history_remote_list_cached");
  assert.deepEqual(pages.map(call=>call.args.offset), [0,1000]);
  assert.equal(pages[0].args.limit, 1000);
});
