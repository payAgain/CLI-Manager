import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as icons from "lucide-react";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(file, dependencies) {
  const exports = {};
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require: id => dependencies[id] ?? require(id),
  });
  return exports;
}
const { TaskSection, TaskStatus } = load("src/components/terminal/TaskList.tsx", {
  "../../lib/taskPresentation": { taskProgress: () => null },
});
const { translate } = load("src/lib/i18n.ts", {
  "../stores/settingsStore": { useSettingsStore: { getState: () => ({ language: "zh-CN" }) } },
});

function render(state, language = "zh-CN") {
  const { AgentTasksPanel } = load("src/components/terminal/AgentTasksPanel.tsx", {
    "../../hooks/useAgentTasks": { useAgentTasks: () => state },
    "../../lib/i18n": { useI18n: () => ({ t: (key, params) => translate(language, key, params) }) },
    "../ui/MarkdownContent": { MarkdownContent: ({ content }) => React.createElement("div", null, content) },
    "./TaskList": { TaskSection, TaskStatus },
    "lucide-react": icons,
  });
  return renderToStaticMarkup(React.createElement(AgentTasksPanel, { session: { id: "one", title: "Current Claude" }, refreshSeq: 0 }));
}
const snapshot = {
  supported: true, warnings: [],
  tasks: [{ id: "1", title: "Build installer", description: "Compile release", status: "running" }],
  plans: [{ id: "plan", title: "Release plan", content: "1. Test\n2. Build", status: "pending" }],
  backgroundTasks: [{ id: "b123", title: "cargo build", description: "Compile", output: "Compiling CLI-Manager", status: "unknown" }],
};

test("Agent task lists, plans and background commands render with independent real statuses in all languages", () => {
  for (const language of ["zh-CN", "en-US", "zh-TW"]) {
    const html = render({ snapshot, hasIdentity: true, remote: false, loading: false }, language);
    for (const text of ["Build installer", "Release plan", "cargo build", "Compiling CLI-Manager", "Current Claude"]) assert.ok(html.includes(text), `${language}: ${text}`);
    assert.ok(html.includes('data-status="running"'));
    assert.ok(html.includes('data-status="unknown"'));
    assert.ok(html.includes('class="task-section__icon"'));
    assert.ok(!html.includes("terminal.agentTasks."));
  }
});

test("missing identity, SSH limitation and parse failure never masquerade as an empty task list", () => {
  for (const [state, expected] of [
    [{ hasIdentity: false, remote: false }, "尚未绑定"],
    [{ hasIdentity: true, remote: true }, "SSH"],
    [{ hasIdentity: true, error: "permission denied", remote: false }, "读取失败"],
  ]) {
    const html = render({ snapshot: null, loading: false, ...state });
    assert.ok(html.includes(expected));
    assert.ok(!html.includes("当前会话尚未记录任务清单"));
  }
});

test("retained terminals and app operations stay in separate sections with their original actions", () => {
  const { BackgroundTasksPanel } = load("src/components/BackgroundTasksPanel.tsx", {
    "../lib/i18n": { useI18n: () => ({ language: "zh-CN", t: (key, params) => translate("zh-CN", key, params) }) },
    "../lib/systemClipboard": { copyTextToClipboard: async () => {} },
    "../lib/taskPresentation": { backgroundTaskStatus: task => task.taskStatus, compareTaskActivity: () => 0, taskProgress: () => null },
    "../stores/backgroundOperationStore": { useBackgroundOperationStore: selector => selector({ operations: { sync: { id: "sync", titleKey: "backgroundOperations.remoteHistory.title", detailKey: "backgroundOperations.remoteHistory.loading", contextLabel: "SSH host", status: "failed", error: "failed", retry: () => {} } }, dismiss: () => {}, clearFinished: () => {} }) },
    "../stores/projectStore": { useProjectStore: selector => selector({ projects: [] }) },
    "../stores/sessionStore": { useSessionStore: selector => selector({ sessions: [{ id: "retained", title: "Retained build" }] }) },
    "../stores/sshAgentIntegrationStore": { useSshAgentIntegrationStore: selector => selector({ agentInstallJobs: {}, clearAgentInstallJob: () => {} }) },
    "../stores/sshHostStore": { useSshHostStore: selector => selector({ hosts: [] }) },
    "../stores/terminalStore": { useTerminalStore: selector => selector({ attachDaemonSession: () => {}, discardDaemonSession: () => {} }) },
    "./ConfirmDialog": { ConfirmDialog: () => null },
    "./terminal/TaskList": load("src/components/terminal/TaskList.tsx", { "../../lib/taskPresentation": { taskProgress: () => null } }),
  });
  const html = renderToStaticMarkup(React.createElement(BackgroundTasksPanel, { tasks: [{ sessionId: "retained", alive: true, taskStatus: "running", createdAtMs: 1 }], onRefresh: async () => {} }));
  assert.ok(html.includes('aria-label="保留终端"'));
  assert.ok(html.includes('aria-label="应用操作"'));
  assert.ok(html.includes("Retained build"));
  assert.ok(html.includes("恢复"));
  assert.ok(html.includes("丢弃"));
  assert.ok(html.includes("加载远程会话历史"));
  assert.ok(html.includes("重试"));
  assert.ok(html.includes("清除已完成"));
});

test("background commands keep active work above a collapsed finished archive and retain command evidence", () => {
  const html = render({ snapshot: { ...snapshot, backgroundTasks: [
    { id: "old", title: "npm run tauri:build:local -- --bundles nsis -- --locked", description: "Build Windows installer", status: "done", output: "Finished release" },
    { id: "live", title: "cargo check --manifest-path src-tauri/Cargo.toml", description: "Check backend", status: "running" },
    { id: "broken", title: "cargo test", description: "Test backend", status: "failed", output: "test failed" },
  ] }, hasIdentity: true, remote: false, loading: false });
  assert.ok(html.indexOf("Check backend") < html.indexOf("agent-task-archive"));
  assert.ok(html.includes('<details class="agent-task-archive">'));
  assert.ok(html.includes("已结束 2"));
  assert.ok(html.includes("1 项失败"));
  assert.ok(html.includes("Build Windows installer"));
  assert.ok(html.includes("npm run tauri:build:local -- --bundles nsis -- --locked"));
  assert.ok(html.includes("Finished release"));
  assert.ok(html.includes("完整命令"));
  assert.ok(html.includes("任务输出"));
});

test("empty groups start collapsed while unavailable data has one shared notice", () => {
  const emptyHtml = render({ snapshot: { supported: true, warnings: [], tasks: [], plans: [], backgroundTasks: [] }, hasIdentity: true, remote: false, loading: false });
  assert.equal((emptyHtml.match(/aria-expanded="false"/g) ?? []).length, 3);
  const unavailableHtml = render({ snapshot: null, hasIdentity: true, remote: true, loading: false });
  assert.equal((unavailableHtml.match(/当前 SSH 链路/g) ?? []).length, 1);
});

test("partial reads keep confirmed records while exposing diagnostics", () => {
  const html = render({ snapshot: { ...snapshot, warnings: ["transcript_truncated"] }, error: "read_failed", hasIdentity: true, remote: false, loading: false });
  assert.ok(html.includes("Build installer"));
  assert.ok(html.includes("transcript_truncated"));
  assert.ok(html.includes("read_failed"));
});
