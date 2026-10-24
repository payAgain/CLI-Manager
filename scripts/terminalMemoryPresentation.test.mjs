import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
const require = createRequire(import.meta.url);
function load(file, dependencies = {}, globals = {}) {
  const exports = {};
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require: id => dependencies[id] ?? require(id), Intl, Number, Map, Set, ...globals,
  });
  return exports;
}
const project = { id: "p", name: "CLI-Manager", path: "/repo", remote_path: "", environment_type: "local" };
const worktree = { id: "wt", project_id: "p", name: "terminal-performance", path: "/repo-wt" };
const resolver = load("src/lib/workspaceTerminals.ts", { "./terminalProject": load("src/lib/terminalProject.ts") });
const presentation = load("src/lib/terminalMemoryPresentation.ts", { "./workspaceTerminals": resolver });
const { appendTerminalMemoryHistory } = load("src/hooks/useTerminalMemory.ts", { "@tauri-apps/api/core": {}, "@tauri-apps/api/window": {} });
const sample = (sessionId, totalBytes = 1024) => ({ sessionId, totalBytes, rootPid: 10, shellBytes: 124, otherBytes: 0, localOnly: false, agents: [{ pid: 11, name: "codex", memoryBytes: 900, selfBytes: 800, childBytes: 100, processCount: 2 }], processes: [
  { pid: 10, parentPid: 1, name: "zsh", memoryBytes: 124, kind: "shell", agentPid: null },
  { pid: 11, parentPid: 10, name: "codex", memoryBytes: 800, kind: "agent", agentPid: 11 },
  { pid: 12, parentPid: 11, name: "rg", memoryBytes: 100, kind: "tool", agentPid: 11 },
] });
const snapshot = { sampledAt: 1000, daemonAvailable: true, totalBytes: 3372, unassignedBytes: 0,
  framework: { appBytes: 100, webviewBytes: 100, daemonBytes: 100, helperBytes: 0, totalBytes: 300 },
  terminals: [sample("main"), sample("wt"), sample("retained")],
};
const sessions = [
  { id: "main", title: "Terminal 1", projectId: "p", worktreeId: "wt", workspace: { projectId: "p" } },
  { id: "wt", title: "Remote connection", projectId: "p", workspace: { projectId: "p", worktreeId: "wt" }, environmentType: "ssh" },
];

test("workspace RSS uses authoritative ownership and retains every sampled PTY once", () => {
  const groups = presentation.groupTerminalMemory([...sessions, sessions[0], { id: "file", kind: "file-editor" }], [project], [worktree], snapshot);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].worktree, undefined, "stale legacy Worktree cannot override explicit main checkout");
  assert.equal(groups[1].worktree.id, "wt");
  assert.equal(groups[2].kind, "retained");
  assert.equal(groups.flatMap(group => group.terminals).length, 3);
  assert.equal(groups.reduce((sum, group) => sum + group.totalBytes, 0) + snapshot.framework.totalBytes, snapshot.totalBytes);
});

test("missing samples and removed Worktrees remain unknown and ungrouped", () => {
  const groups = presentation.groupTerminalMemory([
    ...sessions, { id: "unmeasured", workspace: { projectId: "p" } },
    { id: "removed", workspace: { projectId: "p", worktreeId: "deleted" } },
    { id: "unbound", cwd: "/repo", workspace: null },
  ], [project], [worktree], snapshot);
  assert.equal(groups[0].totalBytes, null);
  const ungrouped = groups.find(group => group.kind === "ungrouped");
  assert.deepEqual(Array.from(ungrouped.terminals, row => row.id), ["removed", "unbound"]);
  assert.equal(ungrouped.totalBytes, null);
  assert.equal(presentation.sumMemorySamples([0, 0]), 0);
  assert.equal(presentation.sumMemorySamples([100, null]), null);
});

test("RSS history is bounded, measured, deduplicated and excludes raw process snapshots", () => {
  let history = [];
  for (let index = 0; index < 30; index++) history = appendTerminalMemoryHistory(history, { ...snapshot, sampledAt: index });
  assert.equal(history.length, 24);
  assert.equal(history[0].sampledAt, 6);
  const last = appendTerminalMemoryHistory(history, { ...snapshot, sampledAt: 29, totalBytes: 4000 });
  assert.equal(last.length, 24);
  assert.equal(last.at(-1).totalBytes, 4000);
  assert.equal(last.at(-1).terminals.main, 1024);
  assert.equal(last.at(-1).processes, undefined);
});

const { translate } = load("src/lib/i18n.ts", { "../stores/settingsStore": { useSettingsStore: { getState: () => ({ language: "zh-CN" }) } } });
function render(language) {
  const i18n = { useI18n: () => ({ language, t: (key, params) => translate(language, key, params) }) };
  const { ResourceDetailPopover } = load("src/components/terminal/ResourceDetailPopover.tsx", {
    "../../lib/i18n": i18n,
    "../ui/popover": { PopoverContent: ({ children, ...props }) => React.createElement("section", props, children) },
    "@radix-ui/react-popover": { Close: ({ children }) => children },
  });
  const module = load("src/components/sidebar/MemoryUsage.tsx", {
    "../../lib/i18n": i18n,
    "../../lib/terminalMemoryPresentation": presentation,
    "../../hooks/useTerminalMemory": { useTerminalMemory: () => ({ snapshot, history: [], error: false, refresh: () => {} }) },
    "../../stores/terminalStore": { useTerminalStore: selector => selector({ sessions, activeSessionId: "main" }) },
    "../../stores/projectStore": { useProjectStore: selector => selector({ projects: [project], worktrees: [worktree] }) },
    "../ui/popover": { Popover: ({ children }) => children, PopoverTrigger: ({ children }) => children },
    "../terminal/ResourceDetailPopover": { ResourceDetailPopover },
    "../terminal/StatusBarButton": { StatusBarButton: () => null },
  });
  return { html: renderToStaticMarkup(React.createElement(module.MemoryUsage, { collapsed: false })), ...module };
}

test("production hierarchy renders process evidence, remote scope and unavailable CPU in all languages", () => {
  for (const language of ["zh-CN", "en-US", "zh-TW"]) {
    const { html } = render(language);
    for (const text of ["CLI-Manager", "terminal-performance", "Terminal 1", "Remote connection", "retained", "codex", "zsh", "PID 12", "RSS"]) assert.ok(html.includes(text), `${language}: ${text}`);
    assert.ok(html.includes(translate(language, "memory.remoteNote")));
    assert.ok(html.includes(translate(language, "memory.cpuUnavailable")));
    assert.ok(html.includes(translate(language, "memory.agentSelf")));
    assert.ok(html.includes(translate(language, "memory.agentChildren")));
    assert.ok(!html.includes("0.0%"), "unavailable CPU cannot be manufactured as zero");
    assert.ok(!html.includes("memory.ungrouped"));
  }
});

test("memory sparklines never invent samples or bridge missing measurements", () => {
  const { memoryTrendPath, formatMemory } = render("en-US");
  assert.equal(memoryTrendPath([100]), "");
  assert.equal(memoryTrendPath([null, 100]), "");
  const gap = memoryTrendPath([100, 200, null, 300, 400]);
  assert.equal((gap.match(/M/g) ?? []).length, 2);
  assert.equal((gap.match(/L/g) ?? []).length, 2);
  assert.equal(formatMemory(null), "—");
  assert.equal(formatMemory(0), "0 B");
});

test("system process cards align real RSS beside CPU and retain PID and percentage evidence", () => {
  const language = "en-US";
  const { SystemResourcesPanel } = load("src/components/terminal/SystemResourcesPanel.tsx", {
    "../../lib/i18n": { useI18n: () => ({ t: (key, params) => translate(language, key, params) }) },
    "../../hooks/useSystemResources": { useSystemResources: () => ({}) },
    "../../stores/settingsStore": { SYSTEM_RESOURCE_CARD_KEYS: ["processes"], useSettingsStore: selector => selector({ systemResourceCardVisibility: {}, systemResourceCardOrder: [] }) },
    "../stats/termStatsUi": { TERM_PANEL: {}, panelColorTint: () => "gray", EmptyHint: () => null },
    "./TerminalPanelHeader": { TerminalPanelHeader: () => null },
    "./ResourceCardSettings": { ResourceCardSettings: () => null },
  });
  const html = renderToStaticMarkup(React.createElement(SystemResourcesPanel, { open: true, embedded: true, card: "processes", hideHeader: true, data: {
    snapshot: { topProcesses: [{ pid: "44", name: "node", command: "node build.js", displayName: "Build", cpuUsagePercent: 6.7, memoryBytes: 268435456, memoryUsagePercent: 1.2 }], sampledAt: 1000 }, history: [], loading: false, error: null, refresh: () => {},
  } }));
  for (const text of ["Name", "CPU", "RSS", "256 MB", "6.7%", "PID 44", "1.2%", "node build.js"]) assert.ok(html.includes(text), text);
});

test("memory sampling remains single flight and pauses for hidden or minimized windows", async () => {
  let stateIndex = 0;
  const states = [];
  let dispose;
  let interval;
  let focus;
  let visible = true;
  let minimized = false;
  let calls = 0;
  let pendingResolve;
  let stopped = 0;
  let cleared = 0;
  const listeners = new Map();
  const document = { visibilityState: "visible", addEventListener: (event, callback) => listeners.set(event, callback), removeEventListener: event => listeners.delete(event) };
  const window = { setInterval: callback => { interval = callback; return 1; }, clearInterval: () => { cleared++; } };
  const hook = load("src/hooks/useTerminalMemory.ts", {
    react: {
      useState: initial => { const index = stateIndex++; states[index] = initial; return [initial, next => { states[index] = typeof next === "function" ? next(states[index]) : next; }]; },
      useRef: value => ({ current: value }), useCallback: callback => callback, useEffect: effect => { dispose = effect(); },
    },
    "@tauri-apps/api/core": { isTauri: () => true, invoke: () => { calls++; return new Promise(resolve => { pendingResolve = resolve; }); } },
    "@tauri-apps/api/window": { getCurrentWindow: () => ({ isVisible: async () => visible, isMinimized: async () => minimized, onFocusChanged: callback => { focus = callback; return Promise.resolve(() => { stopped++; }); } }) },
  }, { window, document });
  const { refresh } = hook.useTerminalMemory();
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  assert.equal(calls, 1);
  refresh(); interval();
  await settle();
  assert.equal(calls, 1, "refresh and timer cannot overlap");
  pendingResolve(snapshot);
  await settle();
  assert.equal(states[0].sampledAt, 1000);
  assert.equal(states[1].length, 1);
  document.visibilityState = "hidden"; refresh();
  await settle();
  assert.equal(calls, 1);
  document.visibilityState = "visible"; minimized = true; interval();
  await settle();
  assert.equal(calls, 1);
  minimized = false; visible = false; focus({ payload: true });
  await settle();
  assert.equal(calls, 1);
  visible = true; focus({ payload: true });
  await settle();
  assert.equal(calls, 2);
  dispose();
  pendingResolve({ ...snapshot, sampledAt: 2000 });
  await settle();
  assert.equal(states[0].sampledAt, 1000, "late response cannot update an unmounted inspector");
  assert.equal(states[1].length, 1);
  assert.equal(cleared, 1);
  assert.equal(stopped, 1);
  assert.equal(listeners.size, 0);
});
