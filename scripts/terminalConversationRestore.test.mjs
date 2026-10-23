import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const plain = value => JSON.parse(JSON.stringify(value));
const settle = async () => { for (let n = 0; n < 20; n++) await Promise.resolve(); };
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function modules(overrides = {}) {
  const cache = new Map();
  function load(path) {
    if (Object.hasOwn(overrides, path)) return overrides[path];
    if (!isAbsolute(path)) return require(path);
    if (cache.has(path)) return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, {
      exports,
      require: specifier => load(specifier.startsWith(".") ? resolve(dirname(path), `${specifier}.ts`) : specifier),
      Date, Set, Map,
    });
    return exports;
  }
  return path => load(resolve(root, path));
}
const load = modules();
const { persistTerminalSession, resolveTerminalConversationRestore } = load("src/lib/terminalConversationRestore.ts");
const { applyAgentDetection, applyHookAgentIdentity } = load("src/lib/terminalAgent.ts");
const workspan = load("src/stores/terminalWorkspan.ts");
const OLD = "019f2c9e-ed25-73e1-a883-86d578fc9e08";
const CURRENT = "019f5e8b-2d11-76d1-89b4-a0c0ff20d111";
const project = (extra = {}) => ({
  id: "project", name: "Project", path: "/repo", cli_tool: "codex", cli_args: "",
  startup_cmd: "", shell: "zsh", environment_type: "local", cli_config_root: "", provider_overrides: "{}", ...extra,
});
const shell = (extra = {}) => ({ id: "pane", title: "Terminal", cwd: "/repo", shell: "zsh", isAgentSession: false, ...extra });
function running(extra = {}, tool = "codex", id = CURRENT) {
  return applyAgentDetection(shell(extra), {
    agent: { tool, runId: `${tool}-run`, detectedAtMs: 1000, cliSessionId: id }, updatedAtMs: 1000,
  });
}

function sessionStore(initial = {}, barrier) {
  const memory = plain(initial), disk = plain(initial), writes = [];
  let first = true, failSave = false;
  const store = {
    get: async key => memory[key],
    set: async (key, value) => {
      if (first && barrier) { first = false; await barrier; }
      memory[key] = plain(value);
      writes.push(key);
    },
    save: async () => {
      if (failSave) throw new Error("disk unavailable");
      Object.assign(disk, plain(memory));
    },
  };
  const localLoad = modules({
    "@tauri-apps/plugin-store": { Store: { load: async () => store } },
    [resolve(root, "src/lib/appPaths.ts")]: { getCliManagerDataPaths: async () => ({ sessionsStorePath: "test-only" }) },
  });
  return {
    api: localLoad("src/stores/sessionStore.ts").useSessionStore,
    snapshots: localLoad("src/lib/terminalSnapshotCache.ts"),
    activity: localLoad("src/lib/terminalOutputActivity.ts"),
    memory, disk, writes, store, failNextFlush: () => { failSave = true; },
  };
}

const terminalSource = readFileSync(resolve(root, "src/stores/terminalStore.ts"), "utf8");
const terminalAst = ts.createSourceFile("terminalStore.ts", terminalSource, ts.ScriptTarget.Latest, true);
function findNode(predicate) {
  let found;
  function visit(node) { if (predicate(node)) found = node; else ts.forEachChild(node, visit); }
  visit(terminalAst);
  assert.ok(found, "production entry point exists");
  return found;
}
const restoreBody = findNode(node => ts.isPropertyAssignment(node) && node.name.getText(terminalAst) === "restoreSessions").initializer.getText(terminalAst);
const launchBody = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "resolvePtyLaunch").getText(terminalAst);
const mirrorBody = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === "buildWorkspanMirror").getText(terminalAst);
const restoreCompiled = ts.transpileModule(`let restoreInProgress = false; ${launchBody}\n${mirrorBody}\nexports.restore = ${restoreBody}; exports.launch = resolvePtyLaunch;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function restoreHarness(saved, projects = [], daemon = [], integration = {}, settings = {}) {
  const persistence = sessionStore(saved);
  await persistence.api.getState().load();
  const state = {}, created = [], writes = [], timers = [], notices = [], errors = [];
  const exports = {};
  let sequence = 0;
  const setState = update => {
    const patch = typeof update === "function" ? update(state) : update;
    Object.assign(state, patch);
    if (Object.hasOwn(patch, "sessions")) persistence.snapshots.retainTerminalSnapshots(state.sessions);
  };
  const projectState = { projects, worktrees: [] };
  const sshState = { loaded: true, hosts: [{ id: "host", startup_script: "" }] };
  runInNewContext(restoreCompiled, {
    exports, Date, Map, Set, crypto: { randomUUID: () => `bridge-${++sequence}` },
    ...persistence.snapshots,
    ...workspan, resolveTerminalConversationRestore,
    ...load("src/lib/agentLaunchPermissions.ts"),
    ...load("src/lib/cliTools.ts"),
    useSessionStore: persistence.api,
    useTerminalStore: { getState: () => state, setState }, set: setState, get: () => state,
    useProjectStore: { getState: () => projectState },
    useSshHostStore: { getState: () => sshState },
    useSshAgentIntegrationStore: { getState: () => ({ loaded: true, installations: [], integrations: [], preferences: [], ...integration }) },
    useSettingsStore: { getState: () => ({ workspanEnabled: true, ...settings }) },
    invoke: async command => { assert.equal(command, "pty_daemon_sessions"); return daemon; },
    getOsPlatform: async () => "macos",
    terminalProcessManager: {
      create: async args => { created.push(plain(args)); return `new-${++sequence}`; },
      subscribeStatus: async () => () => {},
      write: async (id, text) => writes.push({ id, text }),
      close: async () => {},
    },
    resolveShellForPty: value => value,
    prepareStartupCommandForPty: value => value,
    normalizeShellKey: value => value,
    buildPtyEnvVars: value => value,
    shouldEnableHookEnv: async () => true,
    getCurrentTerminalColors: () => ({}),
    ...load("src/lib/sshToolIntegration.ts"),
    buildSshConnectionSpec: () => ({}),
    getSshClientInstanceId: () => "client",
    parseProjectEnvVars: () => ({}),
    resolveProjectStartupCommand: p => p.cli_tool,
    prepareTerminalScrollback: load("src/lib/terminalScrollback.ts").prepareTerminalScrollback,
    createWorkspanId: () => `ws-${++sequence}`, createPaneId: () => `leaf-${++sequence}`,
    formatStartupInputForPty: text => `${text}\r`,
    isCliManagerSyncArtifactText: () => false,
    getRestoredAgentTerminalMetadata: (s, projectId) => load("src/lib/agentTerminal.ts").resolveAgentTerminalMetadata(s, projects.find(p => p.id === projectId)),
    resolveAttachedDaemonSession: s => s,
    resolveDaemonAttachTaskStatus: () => "none", resolveDaemonAttachUpdatedAt: () => null,
    buildTabStatusUpdate: () => ({}), releaseRemoteHistoryConsumer: () => {},
    setTimeout: callback => { timers.push(callback); },
    logError: (...args) => errors.push(args), logInfo: () => {},
    toast: Object.fromEntries(["info", "success", "warning"].map(kind => [kind, (...args) => notices.push({ kind, args })])),
    translateCurrent: key => key,
  });
  await exports.restore(new Map(projects.map(p => [p.id, p])), {});
  for (const timer of timers) timer();
  await settle();
  assert.deepEqual(errors, []);
  return { state, persistence, created, writes, notices, resolveLaunch: exports.launch };
}

test("project and Worktree blank-terminal actions suppress SSH Agent fallback and preserve their launch context", async () => {
  const sidebarSource = readFileSync(resolve(root, "src/components/sidebar/index.tsx"), "utf8");
  const sidebarAst = ts.createSourceFile("sidebar.tsx", sidebarSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findCallback = name => {
    let result;
    function visit(node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(sidebarAst) === name) result = node.initializer.arguments[0].getText(sidebarAst);
      else ts.forEachChild(node, visit);
    }
    visit(sidebarAst);
    assert.ok(result, `production callback ${name} exists`);
    return result;
  };
  for (const environment of ["local", "wsl", "ssh"]) {
    const p = project({ environment_type: environment, shell: environment === "wsl" ? "wsl" : "zsh", ssh_host_id: "host", remote_path: "/remote/repo" });
    const h = await restoreHarness({}, [p], [], {}, { agentPermissionMode: "yolo" });
    for (const name of ["handleNewProjectTerminal", "handleNewWorktreeTerminal"]) {
      const calls = [], exports = {};
      runInNewContext(ts.transpileModule(`exports.callback = ${findCallback(name)};`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
        exports, compactMode: false, useExternalTerminal: false,
        createSession: async (...args) => calls.push(args), parseProjectEnvVars: () => ({ APP_TEST: "kept" }),
        projectScopedTerminalViewEnabled: false, closeHistory: () => {}, rejectMissingWorktree: () => false,
      });
      await exports.callback(p, { id: "wt", project_id: p.id, path: "/repo/worktree", name: "branch" });
      const [projectId, cwd, , startupCmd, envVars, shell, , worktreeId] = calls[0];
      assert.equal(startupCmd, "", `${environment} ${name} must explicitly suppress project startup`);
      assert.equal(cwd, name === "handleNewWorktreeTerminal" ? "/repo/worktree" : p.path);
      assert.equal(worktreeId, name === "handleNewWorktreeTerminal" ? "wt" : undefined);
      const launch = await h.resolveLaunch({ projectId, cwd, startupCmd, envVars, shell, worktreeId }, "macos");
      assert.equal(launch.startupCmd, undefined);
      assert.equal(launch.baseStartupCmd, undefined);
      if (environment === "ssh") {
        assert.equal(launch.invokeArgs.sshLaunch.startupCommand, null);
        assert.equal(launch.invokeArgs.sshLaunch.environmentOverrides.APP_TEST, "kept");
        assert.equal(launch.invokeArgs.sshLaunch.remotePath, "/remote/repo");
      } else {
        assert.equal(launch.invokeArgs.envVars.APP_TEST, "kept");
        assert.equal(launch.shell, p.shell);
      }
    }
  }
});

test("manual Agent and exact Hook identity survive save, PTY shutdown and a new application load", async () => {
  const h = sessionStore();
  const manual = running();
  await h.api.getState().saveSessions([manual, shell({ id: "editor", kind: "file-editor" })]);
  await h.api.getState().freezeForExit([manual]);
  const ended = applyAgentDetection(manual, { agent: null, updatedAtMs: 2000 });
  await h.api.getState().saveSessions([ended]);
  assert.equal(h.disk.sessions.length, 1);
  assert.equal(h.disk.sessions[0].runtimeAgent, undefined);
  assert.equal(h.disk.sessions[0].cliTool, "codex");
  const restored = await restoreHarness(h.disk);
  assert.equal(restored.created.length, 1);
  assert.equal(restored.writes[0].text, `codex resume --no-alt-screen ${CURRENT}\r`);
  assert.equal(restored.state.sessions[0].initialTerminalOutput, undefined);
});

test("YOLO is applied to exact conversation restoration and switching to Manual removes only injected defaults", async () => {
  const saved = { sessions: [persistTerminalSession(running())] };
  const yolo = await restoreHarness(saved, [], [], {}, { agentPermissionMode: "yolo" });
  assert.equal(yolo.writes[0].text, `codex --dangerously-bypass-approvals-and-sandbox resume --no-alt-screen ${CURRENT}\r`);
  assert.equal(yolo.state.sessions[0].startupCmd, `codex resume --no-alt-screen ${CURRENT}`);
  assert.equal(yolo.state.sessions[0].cliSessionId, CURRENT);
  const manual = await restoreHarness({ sessions: yolo.state.sessions }, [], [], {}, { agentPermissionMode: "manual" });
  assert.equal(manual.writes[0].text, `codex resume --no-alt-screen ${CURRENT}\r`);
});

test("deferred startup applies current permissions after scrollback without persisting automatic arguments", async () => {
  const yolo = await restoreHarness({ sessions: [shell({ startupCmd: "gemini", initialTerminalOutput: "previous output" })] }, [], [], {}, { agentPermissionMode: "yolo" });
  const session = yolo.state.sessions[0];
  assert.equal(session.startupCmd, "gemini");
  assert.equal(session.deferredStartupCmd, "gemini --yolo");
  assert.equal(session.deferStartupUntilInitialOutput, true);
  assert.equal(session.initialTerminalOutput, undefined);
  assert.equal(yolo.persistence.snapshots.getTerminalSnapshot(session), "previous output");
  assert.equal(yolo.persistence.memory.sessions[0].initialTerminalOutput, "previous output");
  assert.equal(yolo.writes.length, 0);
  assert.equal(persistTerminalSession(session).deferredStartupCmd, undefined);
  yolo.persistence.snapshots.setTerminalSnapshot(session.id, "new output");
  await yolo.persistence.api.getState().saveSessions(yolo.state.sessions);
  assert.equal(yolo.persistence.snapshots.getTerminalSnapshot(session), "new output");
  assert.equal(yolo.persistence.memory.sessions[0].initialTerminalOutput, "new output");
  assert.equal(JSON.stringify(yolo.state.sessions).includes("previous output"), false);
});

test("SSH and WSL restore use YOLO without changing remote identity or requiring a Hook installation", async () => {
  const ssh = project({ environment_type: "ssh", ssh_host_id: "host", remote_path: "/remote/repo" });
  const saved = persistTerminalSession(running({ projectId: ssh.id, environmentType: "ssh", sshHostId: "host", remotePath: "/remote/repo" }));
  const restored = await restoreHarness({ sessions: [saved] }, [ssh], [], {}, { agentPermissionMode: "yolo" });
  assert.equal(restored.created[0].sshLaunch.startupCommand, `codex --dangerously-bypass-approvals-and-sandbox resume --no-alt-screen ${CURRENT}`);
  assert.equal(restored.created[0].sshLaunch.remotePath, "/remote/repo");
  assert.equal(restored.created[0].sshLaunch.agentPath, "");
  assert.equal(restored.writes.length, 0);
  assert.doesNotMatch(restored.state.sessions[0].startupCmd, /dangerously/);
  const wsl = await restoreHarness({ sessions: [persistTerminalSession(running({ startupCmd: "wsl.exe -d Ubuntu -- codex", shell: "pwsh" }))] }, [], [], {}, { agentPermissionMode: "yolo" });
  assert.equal(wsl.writes[0].text, `wsl.exe -d Ubuntu -- codex --dangerously-bypass-approvals-and-sandbox resume --no-alt-screen ${CURRENT}\r`);
});

test("an in-flight stale write cannot overtake the final snapshot or discard", async () => {
  const gate = deferred(), h = sessionStore({}, gate.promise);
  const stale = h.api.getState().saveSessions([running({}, "codex", OLD)]);
  await settle();
  const final = h.api.getState().freezeForExit([running()]);
  const late = h.api.getState().saveSessions([shell()]);
  gate.resolve();
  await Promise.all([stale, final, late]);
  assert.equal(h.disk.sessions[0].cliSessionId, CURRENT);
  await h.api.getState().clear();
  await h.api.getState().saveSessions([running()]);
  assert.deepEqual(h.disk.sessions, []);
});

test("many terminal checkpoints preserve UI identities and publish no terminal-store updates", async () => {
  const h = sessionStore();
  const { createStore } = require("zustand/vanilla");
  const sessions = Array.from({ length: 100 }, (_, index) => shell({
    id: `pane-${index}`,
  }));
  for (const session of sessions) h.snapshots.setTerminalSnapshot(session.id, `loaded-${session.id}`);
  const state = createStore(() => ({ sessions, statsPanelRefreshSeq: {} }));
  const action = findNode(node => ts.isPropertyAssignment(node)
    && node.name.getText(terminalAst) === "updateSessionTerminalSnapshot").initializer.getText(terminalAst);
  const subscription = findNode(node => ts.isCallExpression(node)
    && node.expression.getText(terminalAst) === "useTerminalStore.subscribe").arguments[0].getText(terminalAst);
  const exports = {};
  runInNewContext(ts.transpileModule(`exports.update = ${action}; exports.reconcile = ${subscription};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports, ...h.snapshots, ...h.activity, ...load("src/lib/terminalHookIdentity.ts"),
    get: state.getState, set: state.setState, useTerminalStore: state,
    terminalProcessManager: { getAgentDetection: () => null },
    receiveAgentDetection: () => { throw new Error("unexpected detection"); },
  });
  state.subscribe(exports.reconcile);
  let notifications = 0;
  state.subscribe(() => { notifications++; });
  for (let round = 0; round < 10; round++) {
    for (const session of sessions) exports.update(session.id, `${session.id}-snapshot-${round}`);
  }
  assert.equal(notifications, 0);
  assert.equal(state.getState().sessions, sessions);
  assert.equal(state.getState().sessions[0], sessions[0]);
  assert.equal(sessions[0].initialTerminalOutput, undefined);
  await h.api.getState().saveSessions(state.getState().sessions);
  assert.equal(h.memory.sessions[99].initialTerminalOutput, "pane-99-snapshot-9");

  // A temporary view unmount keeps its snapshot; removing the session clears it.
  assert.equal(h.snapshots.getTerminalSnapshot(sessions[0]), "pane-0-snapshot-9");
  state.setState({ sessions: sessions.slice(1) });
  exports.update("pane-0", "late-unmount");
  assert.equal(h.snapshots.getTerminalSnapshot(shell({ id: "pane-0" })), undefined);
  assert.equal(h.snapshots.getTerminalSnapshot(sessions[1]), "pane-1-snapshot-9");
});

test("snapshot DTOs are captured before queueing and survive exit cleanup after freezing", async () => {
  const gate = deferred(), h = sessionStore({}, gate.promise);
  const active = running({ initialTerminalOutput: "loaded" });
  h.snapshots.setTerminalSnapshot(active.id, "periodic");
  const first = h.api.getState().saveSessions([active]);
  await settle();
  h.snapshots.setTerminalSnapshot(active.id, "final-full-screen");
  const final = h.api.getState().freezeForExit([active]);
  h.snapshots.retainTerminalSnapshots([]);
  const late = h.api.getState().saveSessions([]);
  gate.resolve();
  await Promise.all([first, final, late]);
  assert.equal(h.disk.sessions[0].initialTerminalOutput, "final-full-screen");
  assert.equal(h.disk.sessions[0].cliSessionId, CURRENT);
  assert.equal(active.initialTerminalOutput, "loaded");
});

test("cold restore fallback and empty live screens persist for local, WSL and SSH sessions", async () => {
  const h = sessionStore();
  const sessions = ["local", "wsl", "ssh"].map(environmentType => shell({
    id: environmentType, environmentType, initialTerminalOutput: `${environmentType}-restored`,
  }));
  for (const session of sessions) {
    assert.equal(h.snapshots.getTerminalSnapshot(session), `${session.id}-restored`);
  }
  h.snapshots.setTerminalSnapshot("local", "");
  h.snapshots.setTerminalSnapshot("wsl", "wsl-latest");
  await h.api.getState().saveSessions(sessions);
  assert.deepEqual(h.memory.sessions.map(session => session.initialTerminalOutput), ["", "wsl-latest", "ssh-restored"]);
  assert.equal(h.snapshots.withTerminalSnapshot(sessions[2]), sessions[2]);
});

test("a failed application exit resumes persistence, including deliberate Agent exit", async () => {
  const h = sessionStore(), active = running();
  await h.api.getState().freezeForExit([active]);
  h.api.getState().resumePersistence();
  const exited = applyAgentDetection(active, { agent: null, updatedAtMs: 3000 });
  await h.api.getState().saveSessions([exited]);
  assert.equal(h.memory.sessions[0].isAgentSession, false);
  assert.equal(h.memory.sessions[0].cliSessionId, undefined);
  const restored = await restoreHarness(h.memory, [project()]);
  assert.deepEqual(restored.writes, []);
});

test("disk failure is observable before PTYs are closed; normal writes recover after unfreezing", async () => {
  const h = sessionStore();
  h.failNextFlush();
  await assert.rejects(h.api.getState().freezeForExit([running()]), /disk unavailable/);
  h.api.getState().resumePersistence();
  await h.api.getState().saveSessions([running({}, "claude")]);
  assert.equal(h.memory.sessions[0].cliTool, "claude");
});

test("switching Agent restores the current tool even when the project and launch command name another", async () => {
  const switched = running({ startupCmd: "codex", cliTool: "codex", isAgentSession: true, projectId: "project" }, "claude");
  const restored = await restoreHarness({ sessions: [plain(persistTerminalSession(switched))] }, [project({ cli_args: "--model codex-model" })]);
  assert.equal(restored.writes[0].text, `claude --resume ${CURRENT}\r`);
  assert.equal(restored.state.sessions[0].cliTool, "claude");
});

test("same-directory split panes and inactive Workspans keep their own conversation and Worktree", async () => {
  const first = persistTerminalSession(running({ id: "a", worktreeId: "tree-a" }, "codex", OLD));
  const second = persistTerminalSession(running({ id: "b", worktreeId: "tree-b" }));
  const third = persistTerminalSession(running({ id: "c", cwd: "/repo/other-tree", worktreeId: "tree-c" }, "claude"));
  const spans = [
    { id: "split", customTitle: null, activePaneId: "left", activeSessionId: "a", paneTree: {
      type: "split", id: "pair", direction: "horizontal", ratio: 0.4,
      first: { type: "leaf", id: "left", sessionIds: ["a"], activeSessionId: "a" },
      second: { type: "leaf", id: "right", sessionIds: ["b"], activeSessionId: "b" },
    } },
    workspan.createTerminalWorkspan("hidden", "hidden-pane", "c"),
  ];
  const h = await restoreHarness({ sessions: [first, second, third], workspans: spans, activeWorkspanId: "split", activeSessionId: "a" });
  assert.equal(h.writes.length, 3);
  assert.match(h.writes[0].text, new RegExp(OLD));
  assert.match(h.writes[1].text, new RegExp(CURRENT));
  assert.deepEqual(plain(h.state.sessions.map(s => s.worktreeId)), ["tree-a", "tree-b", "tree-c"]);
  assert.equal(h.state.workspans.length, 2);
  assert.equal(h.state.paneTree.ratio, 0.4);
  assert.equal(h.state.paneTree.first.activeSessionId, h.state.sessions[0].id);
});

test("existing daemon sessions attach without creating a duplicate Agent or replaying a resume command", async () => {
  const saved = persistTerminalSession(running());
  const h = await restoreHarness({ sessions: [saved] }, [], [{ sessionId: saved.id, alive: true }]);
  assert.equal(h.created.length, 0);
  assert.deepEqual(h.writes, []);
  assert.equal(h.state.sessions[0].id, saved.id);
  assert.equal(h.state.daemonAttachPendingSessionIds.has(saved.id), true);
});

test("an ended daemon PTY is recreated so the original Agent conversation can accept new messages", async () => {
  const saved = persistTerminalSession(running());
  const h = await restoreHarness({ sessions: [saved] }, [], [{ sessionId: saved.id, alive: false }]);
  assert.equal(h.created.length, 1);
  assert.equal(h.writes[0].text, `codex resume --no-alt-screen ${CURRENT}\r`);
  assert.equal(h.state.daemonAttachPendingSessionIds.size, 0);
});

test("early shell discovery does not erase an exact resume target before its process appears", async () => {
  const h = await restoreHarness({ sessions: [persistTerminalSession(running())] });
  const launch = h.state.sessions[0];
  const shellPoll = applyAgentDetection(launch, { agent: null, updatedAtMs: Date.now() });
  assert.equal(shellPoll.cliSessionId, CURRENT);
  const saved = persistTerminalSession(shellPoll);
  assert.equal(saved.cliTool, "codex");
  assert.equal(saved.cliSessionId, CURRENT);
  assert.equal(saved.pendingConversationResume, undefined);
  const started = applyAgentDetection(shellPoll, {
    agent: { tool: "codex", runId: "new-process", detectedAtMs: Date.now() }, updatedAtMs: Date.now(),
  });
  assert.equal(started.cliSessionId, CURRENT);
  assert.equal(started.pendingConversationResume, undefined);
  const exited = applyAgentDetection(started, { agent: null, updatedAtMs: Date.now() + 1000 });
  assert.equal(exited.cliSessionId, undefined);
});

test("failed resume launch and unexpected tool switches release the pending identity", async () => {
  const h = await restoreHarness({ sessions: [persistTerminalSession(running())] });
  const launch = h.state.sessions[0];
  const expired = applyAgentDetection(launch, { agent: null, updatedAtMs: launch.pendingConversationResume.expiresAtMs + 1 });
  assert.equal(expired.cliSessionId, undefined);
  assert.equal(persistTerminalSession(expired).isAgentSession, false);
  const switched = applyAgentDetection(launch, {
    agent: { tool: "claude", runId: "different", detectedAtMs: Date.now() }, updatedAtMs: Date.now(),
  });
  assert.equal(switched.cliSessionId, undefined);
  assert.equal(switched.pendingConversationResume, undefined);
});

test("missing IDs and unsupported tools retain screen output but never pick a latest or start a new chat", async () => {
  const h = await restoreHarness({ sessions: [
    persistTerminalSession(running({ initialTerminalOutput: "previous answer\x1b[?1003h", startupCmd: "codex resume --last" }, "codex", undefined)),
    persistTerminalSession(running({ id: "unsupported", initialTerminalOutput: "other answer" }, "gemini")),
  ].map((s, i) => i === 0 ? { ...s, cliSessionId: undefined } : s) });
  assert.equal(h.created.length, 2);
  assert.deepEqual(h.writes, []);
  assert.equal(h.persistence.snapshots.getTerminalSnapshot(h.state.sessions[0]), "previous answer");
  assert.equal(h.persistence.snapshots.getTerminalSnapshot(h.state.sessions[1]), "other answer");
  assert.ok(h.state.sessions.every(session => session.initialTerminalOutput === undefined));
  assert.equal(h.notices.filter(n => n.args[1]?.description === "terminal.restore.missingId").length, 1);
  assert.equal(h.notices.filter(n => n.args[1]?.description === "terminal.restore.unsupportedTool").length, 1);
});

test("SSH Hook identity restores on the same host and original remote directory after project edits", async () => {
  let remote = applyHookAgentIdentity(shell({ projectId: "project", environmentType: "ssh", sshHostId: "host", remotePath: "/remote/worktree" }), {
    source: "codex", sessionId: CURRENT,
  });
  remote = { ...remote, cliSessionId: CURRENT };
  const h = await restoreHarness({ sessions: [persistTerminalSession(remote)] }, [project({ environment_type: "ssh", ssh_host_id: "different-host", remote_path: "/remote/changed" })]);
  assert.equal(h.created[0].sshLaunch.hostId, "host");
  assert.equal(h.created[0].sshLaunch.remotePath, "/remote/worktree");
  assert.equal(h.created[0].sshLaunch.startupCommand, `codex resume --no-alt-screen ${CURRENT}`);
  assert.deepEqual(h.writes, []);
});

test("a standalone SSH terminal restores its saved host instead of opening a local shell", async () => {
  const s = persistTerminalSession(running({ environmentType: "ssh", sshHostId: "host", remotePath: "/remote/project" }));
  const h = await restoreHarness({ sessions: [s] });
  assert.equal(h.created[0].sshLaunch.hostId, "host");
  assert.equal(h.created[0].sshLaunch.remotePath, "/remote/project");
});

test("SSH restore selects the actual Agent's installed Hook bridge and keeps its original configuration root", async () => {
  const source = "claude", root = "/remote/original-claude-config";
  const s = persistTerminalSession(running({
    projectId: "project", environmentType: "ssh", sshHostId: "host", remotePath: "/remote/worktree",
    envVars: { CLAUDE_CONFIG_DIR: root },
  }, source));
  const installation = { host_id: "host", status: "installed", installation_id: "install", remote_machine_id: "machine", install_path: "/agent" };
  const h = await restoreHarness({ sessions: [s] }, [project({
    environment_type: "ssh", ssh_host_id: "host", remote_path: "/remote/project", cli_config_root: "/wrong-codex-root",
  })], [], {
    installations: [installation], integrations: [{
      host_id: "host", source, configured_root: root, cleanup_state: "active",
      hook_record_json: JSON.stringify({ source, status: "installed", configFiles: [], installationId: "install", remoteMachineId: "machine" }),
    }],
  });
  assert.equal(h.created[0].sshLaunch.toolSource, source);
  assert.equal(h.created[0].sshLaunch.agentPath, "/agent");
  assert.equal(h.created[0].sshLaunch.environmentOverrides.CLAUDE_CONFIG_DIR, root);
});

test("SSH with no exact identity suppresses the project's automatic Agent launch", async () => {
  const s = { ...persistTerminalSession(running({ projectId: "project" })), cliSessionId: undefined };
  const h = await restoreHarness({ sessions: [s] }, [project({ environment_type: "ssh", ssh_host_id: "host", remote_path: "/remote" })]);
  assert.equal(h.created[0].sshLaunch.startupCommand, null);
});

test("WSL wrappers and native WSL shells retain their launch environment", () => {
  const wrapped = resolveTerminalConversationRestore({ ...persistTerminalSession(running()), startupCmd: "wsl.exe -d Ubuntu -- codex", shell: "pwsh" });
  assert.equal(wrapped.startupCmd, `wsl.exe -d Ubuntu -- codex resume --no-alt-screen ${CURRENT}`);
  const native = resolveTerminalConversationRestore({ ...persistTerminalSession(running()), shell: "wsl" });
  assert.equal(native.startupCmd, `codex resume --no-alt-screen ${CURRENT}`);
});

test("all supported tools target an exact chat and inherit only matching structured launch arguments", () => {
  for (const tool of ["claude", "codex", "grok", "pi"]) {
    const s = persistTerminalSession(running({}, tool));
    const restored = resolveTerminalConversationRestore(s, project({ cli_tool: tool, cli_args: "--model test" }));
    assert.equal(restored.isAgentSession, true);
    assert.match(restored.startupCmd, new RegExp(CURRENT));
    assert.match(restored.startupCmd, /--model test$/);
    assert.doesNotMatch(restored.startupCmd, /--last|--continue/);
    assert.doesNotMatch(resolveTerminalConversationRestore(s, project({ cli_tool: tool, startup_cmd: "custom one-shot prompt" })).startupCmd, /one-shot/);
  }
});

test("invalid or shell-active conversation IDs never become startup input", () => {
  for (const id of ["", "bad id", "bad\nid", "$(touch-file)", "x;echo", "--last", "`command`", "\x00id"]) {
    const result = resolveTerminalConversationRestore({ ...persistTerminalSession(running()), cliSessionId: id });
    assert.equal(result.startupCmd, undefined);
    assert.equal(result.issue, "missingId");
  }
});

test("legacy records preserve exact IDs and ordinary shell startup commands", () => {
  const legacy = { id: "legacy", title: "Legacy", startupCmd: "claude", cliSessionId: CURRENT };
  assert.equal(resolveTerminalConversationRestore(legacy).startupCmd, `claude --resume ${CURRENT}`);
  const regular = shell({ startupCmd: "npm run dev", initialTerminalOutput: "output" });
  assert.equal(resolveTerminalConversationRestore(regular, project()).startupCmd, "npm run dev");
});

test("the application freezes after the final snapshot and before closing PTYs, unfreezing on failed exit", () => {
  const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
  const cleanup = app.slice(app.indexOf("const runExitCleanup"), app.indexOf("const minimizeToTray"));
  assert.ok(cleanup.indexOf("flushTerminalSnapshotsNow()") < cleanup.indexOf(".freezeForExit("));
  assert.ok(cleanup.indexOf(".freezeForExit(") < cleanup.indexOf("cleanupTerminalProcessesForExit("));
  assert.ok(cleanup.indexOf("if (canExit && await exitApp(source)) return") < cleanup.indexOf(".resumePersistence()"));
});

test("stopping a running task through the actual exit cleanup preserves restoration data", async () => {
  const app = readFileSync(resolve(root, "src/App.tsx"), "utf8");
  const ast = ts.createSourceFile("App.tsx", app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === "runExitCleanup") callback = node.initializer.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const compiled = ts.transpileModule(`exports.cleanup = ${callback};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const h = sessionStore(), exports = {}, state = { sessions: [running()] };
  let exited = false, closeCount = 0;
  runInNewContext(compiled, {
    exports,
    exitCleanupInProgressRef: { current: false },
    useTerminalStore: { getState: () => state }, useSessionStore: h.api,
    flushSync: fn => fn(), setExitNotice: () => {}, setExitPhase: () => {},
    flushTerminalSnapshotsNow: async () => {},
    logInfo: () => {}, logWarn: () => {},
    invoke: async () => true,
    exitApp: async () => { exited = true; return true; },
    cleanupTerminalProcessesForExit: load("src/lib/terminalExitCleanup.ts").cleanupTerminalProcessesForExit,
    terminalProcessManager: {
      closeAll: async () => {
        closeCount++;
        state.sessions = state.sessions.map(s => applyAgentDetection(s, { agent: null, updatedAtMs: Date.now() }));
        await h.api.getState().saveSessions(state.sessions);
      },
    },
  });
  await Promise.all([
    exports.cleanup("running task dialog", { closePty: true, closeAllPty: true }),
    exports.cleanup("repeated Cmd+Q", { closePty: true, closeAllPty: true }),
  ]);
  assert.equal(exited, true);
  assert.equal(closeCount, 1);
  assert.equal(h.disk.sessions.length, 1);
  assert.equal(h.disk.sessions[0].cliSessionId, CURRENT);
  const restored = await restoreHarness(h.disk);
  assert.equal(restored.writes[0].text, `codex resume --no-alt-screen ${CURRENT}\r`);
  assert.doesNotMatch(app, /discardSessions:\s*true/);
});
