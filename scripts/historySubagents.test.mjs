import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  buildHistorySessionHierarchy, buildHistorySessionTreeRows,
  includeHistorySessionAncestors, inferSubagentParentSessionId,
  inferClaudeSubagentParentSessionId,
} from "../src/lib/historySubagents.ts";

function session(id, parent, overrides = {}) {
  return {
    sessionKey: `codex:${id}`, session_id: id, source: "codex", project_key: "app",
    title: id, displayTitle: id, file_path: `/home/dev/.codex/sessions/2026/10/21/rollout-${id}.jsonl`,
    updated_at: 100, created_at: 1, message_count: 1, alias: "", tags: [], starred: false,
    subagent: parent ? { parent_session_id: parent, nickname: id } : null,
    ...overrides,
  };
}

test("Codex tasks are descendants, keep their activity order, and expand recursively", () => {
  const parent = session("main");
  const child = session("task", "main", { project_key: "other-worktree" });
  const nested = session("nested", "task");
  const other = session("other");
  const items = [nested, other, child, parent];
  const before = structuredClone(items);
  const { roots } = buildHistorySessionHierarchy(items);
  assert.deepEqual(roots.map(item => item.session_id), ["main", "other"]);
  assert.deepEqual(buildHistorySessionTreeRows(items, new Set()).map(row => row.item.session_id), ["main", "other"]);
  const rows = buildHistorySessionTreeRows(items, new Set([parent.sessionKey, child.sessionKey]));
  assert.deepEqual(rows.map(row => [row.item.session_id, row.depth, row.childCount]), [
    ["main", 0, 1], ["task", 1, 1], ["nested", 2, 0], ["other", 0, 0],
  ]);
  assert.deepEqual(items, before);
});

test("filtering and local pagination retain the full parent chain without unrelated siblings", () => {
  const parent = session("main");
  const child = session("task", "main");
  const nested = session("nested", "task");
  const sibling = session("sibling", "main");
  const result = includeHistorySessionAncestors([nested], [sibling, nested, child, parent]);
  assert.deepEqual(result.map(item => item.session_id), ["nested", "task", "main"]);
  assert.deepEqual(buildHistorySessionHierarchy(result).roots, [parent]);
});

test("same thread IDs cannot connect across config roots, WSL distributions, SSH hosts, or sources", () => {
  const remote = (id, parent, instance) => session(id, parent, {
    file_path: "", sessionKey: `${instance}:${id}`,
    session_ref: { sourceId: "codex", sourceInstanceId: instance, sourceSessionId: id, transportKind: "ssh", rawPointers: [] },
  });
  const child = session("task", "main");
  for (const parent of [
    session("main", null, { file_path: "/other/.codex/sessions/rollout-main.jsonl" }),
    remote("main", null, "host-a"),
    session("main", null, { source: "claude" }),
  ]) assert.equal(buildHistorySessionHierarchy([child, parent]).parentByChildKey.size, 0);
  assert.equal(buildHistorySessionHierarchy([remote("task", "main", "a"), remote("main", null, "b")]).parentByChildKey.size, 0);
  assert.equal(buildHistorySessionHierarchy([remote("task", "main", "a"), remote("main", null, "a")]).parentByChildKey.size, 1);
  const wsl = (id, parent, distro) => session(id, parent, { file_path: `\\\\wsl.localhost\\${distro}\\home\\dev\\.codex\\sessions\\rollout-${id}.jsonl` });
  assert.equal(buildHistorySessionHierarchy([wsl("task", "main", "Ubuntu"), wsl("main", null, "Debian")]).parentByChildKey.size, 0);
  assert.equal(buildHistorySessionHierarchy([wsl("task", "main", "Ubuntu"), wsl("main", null, "Ubuntu")]).parentByChildKey.size, 1);
  const aliasChild = wsl("task", "main", "Ubuntu");
  aliasChild.file_path = aliasChild.file_path.replace("\\\\wsl.localhost\\", "\\\\?\\UNC\\wsl$\\");
  assert.equal(buildHistorySessionHierarchy([aliasChild, wsl("main", null, "Ubuntu")]).parentByChildKey.size, 1);
});

test("missing parents remain a separate task group, and corrupt cycles never hide records", () => {
  const items = [session("a", "missing"), session("other"), session("b", "missing")];
  const rows = buildHistorySessionTreeRows(items, new Set());
  assert.deepEqual(rows.map(row => row.type === "session" ? [row.item.session_id, row.depth] : [row.type]), [
    ["missingParent"], ["a", 1], ["b", 1], ["other", 0],
  ]);
  const cyclic = [session("a", "b"), session("b", "a"), session("self", "self")];
  const cycleRows = buildHistorySessionTreeRows(cyclic, new Set(cyclic.map(item => item.sessionKey)));
  assert.deepEqual(cycleRows.filter(row => row.type === "session").map(row => row.item.session_id).sort(), ["a", "b", "self"]);
});

test("Claude path compatibility is independent of Codex's non-cascading file deletion", () => {
  const child = session("child", null, { source: "claude", file_path: "C:\\Users\\dev\\.claude\\projects\\app\\main\\subagents\\agent-child.jsonl" });
  const parent = session("main", null, { source: "claude", file_path: "c:/Users/dev/.claude/projects/app/main.jsonl" });
  assert.equal(inferSubagentParentSessionId(child), "main");
  assert.equal(buildHistorySessionHierarchy([child, parent]).parentByChildKey.size, 1);
  assert.equal(inferSubagentParentSessionId(session("task", "main")), "main");
  assert.equal(inferClaudeSubagentParentSessionId(session("task", "main")), null);
});

// Exercise the actual normalization and store projection, including page lookahead.
const storeSource = ts.createSourceFile("historyStore.ts", readFileSync(new URL("../src/stores/historyStore.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const functionNames = new Set(["asString", "asNumber", "normalizeSessionRef", "normalizeSummary", "makeSessionKey", "summarySessionKey", "normalizeMetaPath", "parseTags", "toView", "applyMeta", "sortSessionViews", "viewToSummary", "snapshotToSummary"]);
const declarations = storeSource.statements.filter(node => ts.isFunctionDeclaration(node) && functionNames.has(node.name?.text)).map(node => node.getText(storeSource)).join("\n");
const context = vm.createContext({ normalizeSessionUsage: () => undefined });
vm.runInContext(ts.transpileModule(declarations, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);

test("backend parent context survives normalization and pagination without consuming the lookahead", () => {
  const rawParent = { sessionId: "main", source: "codex", projectKey: "app", filePath: "/home/dev/.codex/sessions/rollout-main.jsonl", title: "main", updatedAt: 1 };
  const rawChild = { ...rawParent, sessionId: "task", filePath: "/home/dev/.codex/sessions/rollout-task.jsonl", subagent: { parentSessionId: "main", nickname: "Feynman" }, parentSession: rawParent, updatedAt: 3 };
  const rawLookahead = { ...rawParent, sessionId: "later", filePath: "/home/dev/.codex/sessions/rollout-later.jsonl" };
  const summaries = [rawChild, rawLookahead].map(raw => context.normalizeSummary(raw)).slice(0, 1);
  const views = context.applyMeta(summaries, {});
  assert.deepEqual(Array.from(views, item => item.session_id), ["task", "main"]);
  assert.equal(views[0].subagent.nickname, "Feynman");
  const restored = context.applyMeta(Array.from(views, item => context.viewToSummary(item)), {});
  assert.equal(buildHistorySessionHierarchy(restored).roots.length, 1);
  assert.equal(inferSubagentParentSessionId(restored[0]), "main");
  const afterParentDeletion = context.applyMeta(Array.from(views.filter(item => item.session_id !== "main"), item => context.viewToSummary(item)), {});
  assert.equal(afterParentDeletion.length, 1);
  assert.equal(afterParentDeletion[0].parent_session, null);
  const snapshot = context.snapshotToSummary({ ...rawChild, session_id: "task", detail_json: JSON.stringify(rawChild) });
  assert.equal(snapshot.subagent.parent_session_id, "main");
});
