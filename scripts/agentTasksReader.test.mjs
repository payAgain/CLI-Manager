import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function load(path, dependencies, globals = {}) {
  const exports = {};
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("exports", "require", ...Object.keys(globals), output)(exports, name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, ...Object.values(globals));
  return exports;
}
const presentation = load("../src/lib/agentTasks.ts", {});

function reader() {
  let state, callbacks;
  const effects = [];
  const { useAgentTasks } = load("../src/hooks/useAgentTasks.ts", {
    react: {
      useState(initial) { state = initial; return [state, update => { state = typeof update === "function" ? update(state) : update; }]; },
      useRef(value) { return { current: value }; },
      useEffect(effect) { effects.push(effect); },
    },
    "@tauri-apps/api/core": { isTauri: () => false },
    "@tauri-apps/api/window": {},
    "../lib/agentTasks": presentation,
    "../lib/historyPathArgs": {},
    "../lib/subagentBrowser": { resolveSubagentBrowserIdentity: () => ({ source: "codex", parentSessionId: "parent" }) },
    "../lib/visibleResourcePolling": { createVisibleResourcePoller(options) {
      callbacks = options;
      return { refresh() {}, dispose() {} };
    } },
  }, {
    window: { setInterval() { return 1; }, clearInterval() {} },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
  });
  useAgentTasks({ id: "terminal", cwd: "/repo", envVars: {} }, null, 0);
  const cleanups = effects.map(effect => effect());
  return { get state() { return state; }, get callbacks() { return callbacks; }, close() { cleanups.forEach(cleanup => cleanup?.()); } };
}

test("a failed task read preserves content but revokes every stale confirmed status until a successful snapshot", () => {
  const h = reader();
  try {
    const old = {
      supported: true, warnings: [],
      tasks: [{ id: "1", title: "Build release", status: "done" }],
      plans: [{ id: "plan", title: "Release", content: "Build and verify", status: "done" }],
      backgroundTasks: [{ id: "job", title: "cargo build", output: "Finished", status: "running" }],
    };
    h.callbacks.onSnapshot(old);
    h.callbacks.onError("transcript_session_mismatch");
    assert.equal(h.state.error, "transcript_session_mismatch");
    assert.equal(h.state.loading, false);
    for (const group of ["tasks", "plans", "backgroundTasks"]) {
      assert.equal(h.state.snapshot[group][0].status, "unknown");
      assert.equal(h.state.snapshot[group][0].title, old[group][0].title);
    }
    assert.equal(h.state.snapshot.backgroundTasks[0].output, "Finished");
    assert.equal(old.tasks[0].status, "done", "the last successful snapshot must not be mutated");
    assert.equal(old.backgroundTasks[0].status, "running");
    const recovered = { ...old, tasks: [{ ...old.tasks[0], status: "running" }] };
    h.callbacks.onSnapshot(recovered);
    assert.equal(h.state.error, null);
    assert.equal(h.state.snapshot, recovered);
    assert.equal(h.state.snapshot.tasks[0].status, "running");
    assert.equal(h.state.snapshot.plans[0].status, "done");
  } finally { h.close(); }
});

test("a read error before the first successful snapshot never creates an empty confirmed task list", () => {
  const h = reader();
  try {
    h.callbacks.onError("transcript_unavailable");
    assert.equal(h.state.snapshot, null);
    assert.equal(h.state.error, "transcript_unavailable");
  } finally { h.close(); }
});
