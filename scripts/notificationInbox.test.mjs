import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const policy = {};
runInNewContext(compile("../src/lib/notificationInbox.ts"), { exports: policy });
const target = (extra = {}) => ({ tabId: "old-pty", cliSessionId: "cli-1", agentRunId: "run-1", source: "codex", environment: "local", hostId: null, wslDistro: null, ...extra });
const session = (extra = {}) => ({ id: "old-pty", title: "Agent", cliSessionId: "cli-1", runtimeAgent: { tool: "codex", runId: "run-1" }, ...extra });
const item = (sequence, extra = {}) => ({ ...target(), sequence, eventId: `event-${sequence}`, event: "Stop", receivedAt: sequence, readAt: null, ...extra });

test("restored terminal IDs rebind only a unique exact CLI conversation", () => {
  const restored = session({ id: "new-pty" });
  assert.equal(policy.resolveNotificationTarget(target(), [restored]), restored);
  assert.equal(policy.resolveNotificationTarget(target(), [restored, session({ id: "another" })]), null);
  assert.equal(policy.resolveNotificationTarget(target(), [session({ cliSessionId: "new-conversation" })]), null);
  assert.equal(policy.resolveNotificationTarget(target({ cliSessionId: null }), [session({ runtimeAgent: { tool: "codex", runId: "new-run" } })]), null);
});

test("same-path SSH hosts, WSL distributions and agent vendors stay isolated", () => {
  const remote = target({ environment: "ssh", hostId: "host-a" });
  const wrongHost = session({ environmentType: "ssh", sshHostId: "host-b", cwd: "/srv/work" });
  assert.equal(policy.resolveNotificationTarget(remote, [wrongHost]), null);
  assert.equal(policy.resolveNotificationTarget(remote, [session({ cwd: "/srv/work" })]), null);
  const wsl = target({ environment: "wsl", wslDistro: "Ubuntu" });
  assert.equal(policy.resolveNotificationTarget(wsl, [session({ environmentType: "wsl", shell: "wsl.exe -d Debian" })]), null);
  const ubuntu = session({ environmentType: "wsl", cwd: "\\\\wsl.localhost\\Ubuntu\\work" });
  assert.equal(policy.resolveNotificationTarget(wsl, [ubuntu]), ubuntu);
  assert.equal(policy.resolveNotificationTarget(target(), [session({ runtimeAgent: { tool: "claude", runId: "run-1" } })]), null);
});

test("a visible file editor or transcript cannot consume a terminal notification", () => {
  for (const kind of ["file-editor", "subagent-transcript", "synced-history"]) {
    assert.equal(policy.resolveNotificationTarget(target(), [session({ kind })]), null);
  }
});

test("unread totals use all backend target groups, including off-page events", () => {
  const active = session();
  const targets = [{ ...target(), count: 71, latestSequence: 93 }, { ...target({ cliSessionId: "different" }), count: 5, latestSequence: 94 }];
  assert.equal(policy.getUnreadCountForSession(targets, active, [active]), 71);
});

test("automatic read requires foreground, visible, focused target and document", () => {
  const foreground = { visible: true, focused: true, windowFocused: true, windowVisible: true, minimized: false, documentVisible: true, terminalFocused: true };
  assert.equal(policy.shouldAutoReadInbox(foreground), true);
  for (const state of [{ visible: false }, { focused: false }, { windowFocused: false }, { windowVisible: false }, { minimized: true }, { documentVisible: false }, { terminalFocused: false }]) {
    assert.equal(policy.shouldAutoReadInbox({ ...foreground, ...state }), false);
  }
});

function storeHarness(initial = Array.from({ length: 130 }, (_, index) => item(index + 1))) {
  let rows = initial.map(row => ({ ...row }));
  const calls = [];
  let beforeList = null;
  let failingCommand = null;
  function create(factory) {
    let state;
    const get = () => state;
    const set = update => { state = { ...state, ...(typeof update === "function" ? update(state) : update) }; };
    const api = selector => selector ? selector(state) : state;
    api.getState = get; api.setState = set; state = factory(set, get); return api;
  }
  const invoke = async (command, args = {}) => {
    calls.push({ command, args });
    if (command === failingCommand) { failingCommand = null; throw new Error("disk unavailable"); }
    if (command === "notification_inbox_list") {
      if (beforeList) { const fn = beforeList; beforeList = null; await fn(); }
      const filtered = rows.filter(row => (!args.before || row.sequence < args.before) && (!args.unreadOnly || row.readAt === null)).sort((a, b) => b.sequence - a.sequence);
      const page = filtered.slice(0, args.limit);
      const unreadRows = rows.filter(row => row.readAt === null);
      return { entries: page.map(row => ({ ...row })), unreadCount: unreadRows.length, latestSequence: Math.max(0, ...rows.map(row => row.sequence)),
        nextBefore: filtered.length > page.length ? page.at(-1).sequence : null, trimmedCount: 0,
        unreadTargets: unreadRows.length ? [{ ...target(), count: unreadRows.length, latestSequence: Math.max(...unreadRows.map(row => row.sequence)) }] : [] };
    }
    if (command === "notification_inbox_mark_all_read") rows.forEach(row => { if (row.sequence <= args.throughSequence) row.readAt = 1; });
    else if (command === "notification_inbox_mark_target_read") rows.forEach(row => { if (policy.inboxTargetKey(row) === policy.inboxTargetKey(args.target) && row.sequence <= args.throughSequence) row.readAt = 1; });
    else if (command === "notification_inbox_set_read") rows.forEach(row => { if (args.eventIds.includes(row.eventId)) row.readAt = args.read ? 1 : null; });
    else if (command === "notification_inbox_clear_read") rows = rows.filter(row => row.readAt === null);
    else throw new Error(command);
  };
  const exports = {};
  runInNewContext(compile("../src/stores/notificationInboxStore.ts"), { exports, Set, Map, Promise,
    require: name => name === "zustand" ? { create } : name === "@tauri-apps/api/core" ? { invoke } : policy });
  return { store: exports.useNotificationInboxStore, calls, rows: () => rows, add: row => rows.push(row), beforeList: fn => { beforeList = fn; }, failNext: command => { failingCommand = command; } };
}

test("cursor pages keep only 50 rows and can visit all retained entries", async () => {
  const h = storeHarness();
  await h.store.getState().refresh();
  assert.equal(h.store.getState().entries.length, 50);
  assert.equal(h.store.getState().unreadCount, 130);
  await h.store.getState().loadMore();
  assert.equal(h.store.getState().entries[0].sequence, 80);
  await h.store.getState().loadMore();
  assert.equal(h.store.getState().entries[0].sequence, 30);
  assert.equal(h.store.getState().entries.length, 30);
  h.store.getState().previousPage(); await h.store.getState().refresh();
  assert.equal(h.store.getState().entries[0].sequence, 80);
  h.store.getState().showLatest(); await h.store.getState().refresh();
  assert.equal(h.store.getState().entries[0].sequence, 130);
});

test("read-all and automatic-read acknowledge a snapshot, preserving new arrivals", async () => {
  const h = storeHarness([item(1)]);
  await h.store.getState().refresh();
  h.add(item(2));
  await h.store.getState().markAllRead();
  assert.equal(h.rows()[0].readAt, 1); assert.equal(h.rows()[1].readAt, null);
  const targets = h.store.getState().unreadTargets;
  h.add(item(3));
  await h.store.getState().readTargets(targets);
  assert.equal(h.rows()[1].readAt, 1); assert.equal(h.rows()[2].readAt, null);
});

test("manual unread survives the same pane dwell until explicit leave", async () => {
  const h = storeHarness([item(1, { readAt: 1 })]);
  await h.store.getState().refresh();
  await h.store.getState().setRead(h.store.getState().entries[0], false);
  await h.store.getState().readTargets(h.store.getState().unreadTargets);
  assert.equal(h.rows()[0].readAt, null);
  h.store.getState().releaseManualUnread([policy.inboxTargetKey(target())]);
  await h.store.getState().readTargets(h.store.getState().unreadTargets);
  assert.equal(h.rows()[0].readAt, 1);
});

test("mutations serialize and clearing read retains unread events", async () => {
  const h = storeHarness([item(1), item(2)]);
  await h.store.getState().refresh();
  const entry = h.store.getState().entries[0];
  await Promise.all([h.store.getState().setRead(entry, true), h.store.getState().setRead(entry, false)]);
  assert.equal(h.rows().find(row => row.eventId === entry.eventId).readAt, null);
  await h.store.getState().setRead(entry, true);
  await h.store.getState().clearRead();
  assert.equal(h.rows().length, 1); assert.equal(h.rows()[0].eventId, "event-1");
});

test("an event arriving during refresh gets one follow-up request without polling", async () => {
  const h = storeHarness([item(1)]);
  let release;
  h.beforeList(() => new Promise(resolve => { release = resolve; }));
  const first = h.store.getState().refresh();
  h.add(item(2));
  const second = h.store.getState().refresh();
  release(); await Promise.all([first, second]);
  assert.equal(h.store.getState().unreadCount, 2);
  assert.equal(h.calls.filter(call => call.command === "notification_inbox_list").length, 2);
});

test("failed unread mutations roll back their manual lock and report the error", async () => {
  const h = storeHarness([item(1, { readAt: 1 })]);
  await h.store.getState().refresh();
  h.failNext("notification_inbox_set_read");
  assert.equal(await h.store.getState().setRead(h.store.getState().entries[0], false), false);
  assert.equal(h.store.getState().manualUnreadTargets.size, 0);
  assert.match(h.store.getState().error, /disk unavailable/);
  assert.equal(h.rows()[0].readAt, 1);
});

test("explicit mark-all clears manual locks so later events can auto-read", async () => {
  const h = storeHarness([item(1, { readAt: 1 })]);
  await h.store.getState().refresh();
  await h.store.getState().setRead(h.store.getState().entries[0], false);
  await h.store.getState().markAllRead();
  assert.equal(h.store.getState().manualUnreadTargets.size, 0);
  h.add(item(2)); await h.store.getState().refresh();
  await h.store.getState().readTargets(h.store.getState().unreadTargets);
  assert.equal(h.rows()[1].readAt, 1);
});

test("real auto-read hook releases manual unread on pane switch, not window or dialog blur", () => {
  const effects = [], releases = [];
  const ref = { current: { sessionId: null, keys: [] } };
  const terminal = { sessions: [session(), session({ id: "other", cliSessionId: "cli-2" })], activeSessionId: "old-pty" };
  const inbox = { unreadTargets: [{ ...target(), count: 1, latestSequence: 1 }], releaseManualUnread: keys => { if (keys.length) releases.push([...keys]); } };
  const useInbox = selector => selector(inbox); useInbox.getState = () => inbox;
  const useTerminal = selector => selector(terminal); useTerminal.getState = () => terminal;
  const exports = {};
  runInNewContext(compile("../src/hooks/useNotificationInbox.ts"), { exports,
    require: name => {
      if (name === "react") return { useEffect: fn => effects.push(fn), useRef: () => ref };
      if (name.endsWith("/notificationInboxStore")) return { useNotificationInboxStore: useInbox };
      if (name.endsWith("/terminalStore")) return { useTerminalStore: useTerminal };
      if (name.endsWith("/notificationInbox")) return policy;
      return {};
    } });
  const render = () => { effects.length = 0; exports.useNotificationInboxAutoRead("old-pty", true, false); effects[0](); };
  render(); // Temporarily unfocused window / modal, same active pane.
  render(); assert.equal(releases.length, 0);
  terminal.activeSessionId = "other"; render();
  assert.equal(releases.length, 1);
  assert.equal(releases[0][0], policy.inboxTargetKey(target()));
});
