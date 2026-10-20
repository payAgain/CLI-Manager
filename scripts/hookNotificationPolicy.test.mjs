import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const policy = {};
runInNewContext(compile(read("../src/lib/hookNotificationPolicy.ts")), { exports: policy });
const foreground = {
  focused: true, visible: true, minimized: false, documentVisible: true,
  targetVisible: true, suppressWhileAppFocused: false,
};

test("visible split panes stay quiet even when focused-window suppression is disabled", () => {
  assert.equal(policy.suppressHookNotification(foreground), true);
  assert.equal(policy.suppressHookNotification({ ...foreground, targetVisible: false }), false);
  assert.equal(policy.suppressHookNotification({ ...foreground, targetVisible: false, suppressWhileAppFocused: true }), true);
});

test("unfocused, hidden, minimized and tray windows can receive OS notifications", () => {
  for (const state of [{ focused: false }, { visible: false }, { minimized: true }, { documentVisible: false }]) {
    assert.equal(policy.suppressHookNotification({ ...foreground, suppressWhileAppFocused: true, ...state }), false);
  }
});

const pane = (id, visible = true, laidOut = true) => ({
  dataset: { terminalSessionId: id, terminalVisible: String(visible) },
  getClientRects: () => laidOut ? [{}] : [],
});
const documentWith = (panes, modal = false) => ({
  querySelector: () => modal ? {} : null,
  querySelectorAll: () => panes,
});

test("visibility uses the actual PTY pane across splits, Workspans, projects and remote environments", () => {
  const doc = documentWith([
    pane("local"), pane("ssh:1"), pane("wsl:1"), pane("worktree:1"),
    pane("hidden-workspan", false), pane("hidden-project", true, false),
  ]);
  for (const id of ["local", "ssh:1", "wsl:1", "worktree:1"]) {
    assert.equal(policy.isNotificationTerminalVisible(id, doc), true);
  }
  for (const id of ["hidden-workspan", "hidden-project", "external:codex:1", "missing"]) {
    assert.equal(policy.isNotificationTerminalVisible(id, doc), false);
  }
  assert.equal(policy.isNotificationTerminalVisible("local", documentWith([pane("local")], true)), false);
});

// Exercise the real App sender with native APIs replaced, rather than repeating its policy in a test.
const app = ts.createSourceFile("App.tsx", read("../src/App.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sender = app.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "sendSystemNotification").getText(app);
function harness() {
  const state = { focused: true, visible: true, minimized: false, documentVisible: true, targetVisible: true };
  const settings = {
    systemNotificationsEnabled: true, suppressSystemNotificationsWhenFocused: false,
    systemNotificationEvents: { Stop: true, StopFailure: true, PermissionRequest: true },
  };
  const calls = [], errors = [];
  let permissionRequests = 0;
  const permission = { granted: true, request: async () => "granted" };
  const context = {
    exports: {}, ...policy, backgroundTaskModeActive: false,
    useSettingsStore: { getState: () => settings },
    isSystemNotificationEvent: event => event in settings.systemNotificationEvents,
    getHookProjectName: () => "project", getSystemNotificationBody: () => "Task completed",
    getHookNotificationActionLabel: () => "View",
    getCurrentWindow: () => ({
      isFocused: async () => state.focused,
      isVisible: async () => state.visible,
      isMinimized: async () => state.minimized,
    }),
    document: {
      hasFocus: () => state.focused,
      get visibilityState() { return state.documentVisible ? "visible" : "hidden"; },
      querySelector: () => null,
      querySelectorAll: () => [pane("pty", state.targetVisible)],
    },
    require: name => {
      assert.equal(name, "@tauri-apps/plugin-notification");
      return {
        isPermissionGranted: async () => permission.granted,
        requestPermission: async () => { permissionRequests++; return permission.request(); },
      };
    },
    invoke: async (command, args) => { calls.push({ command, args }); },
    debugConsoleWarn: (...args) => errors.push(args),
  };
  runInNewContext(compile(`${sender}\nexports.send = sendSystemNotification;`), context);
  return { ...context.exports, state, settings, calls, errors, permission, context, permissionRequests: () => permissionRequests };
}
const event = (name = "Stop") => ({ event: name, source: "codex", tabId: "pty" });

test("real Hook sender suppresses foreground completion, failure and permission alerts", async () => {
  const h = harness();
  h.permission.granted = false;
  for (const name of ["Stop", "StopFailure", "PermissionRequest"]) await h.send(event(name), "pty");
  assert.equal(h.calls.length, 0);
  assert.equal(h.permissionRequests(), 0);
  assert.equal(h.errors.length, 0);
});

test("background alerts use the native interactive channel and retain the exact terminal target", async () => {
  const h = harness();
  h.state.focused = false;
  await h.send(event(), "pty");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].command, "send_interactive_system_notification");
  assert.equal(h.calls[0].args.tabId, "pty");
  assert.equal(h.errors.length, 0);
});

test("background tabs honor focus suppression and disabled event/OS settings", async () => {
  const h = harness();
  h.state.targetVisible = false;
  await h.send(event(), "pty");
  assert.equal(h.calls.length, 1);
  h.settings.suppressSystemNotificationsWhenFocused = true;
  await h.send(event(), "pty");
  h.state.focused = false;
  h.settings.systemNotificationEvents.Stop = false;
  await h.send(event(), "pty");
  h.settings.systemNotificationEvents.Stop = true;
  h.settings.systemNotificationsEnabled = false;
  await h.send(event(), "pty");
  assert.equal(h.calls.length, 1);
});

test("returning to the foreground during permission approval cancels delayed alerts", async () => {
  const h = harness();
  h.state.focused = false;
  h.permission.granted = false;
  h.permission.request = async () => { h.state.focused = true; return "granted"; };
  await h.send(event(), "pty");
  assert.equal(h.permissionRequests(), 1);
  assert.equal(h.calls.length, 0);
});

test("denied permission and settings changed during permission approval stop delivery", async () => {
  for (const update of [h => "denied", h => { h.settings.systemNotificationsEnabled = false; return "granted"; }]) {
    const h = harness();
    h.state.focused = false;
    h.permission.granted = false;
    h.permission.request = async () => update(h);
    await h.send(event(), "pty");
    assert.equal(h.calls.length, 0);
  }
});

test("background task mode still obeys foreground visibility", async () => {
  const h = harness();
  h.context.backgroundTaskModeActive = true;
  h.settings.systemNotificationsEnabled = false;
  await h.send(event(), "pty");
  assert.equal(h.calls.length, 0);
  h.state.focused = false;
  await h.send(event(), "pty");
  assert.equal(h.calls.length, 1);
});
