import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-hook-binding-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/stores/terminalHookBinding.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "terminalHookBinding.mjs");
writeFileSync(modulePath, output, "utf8");
const { normalizeHookBindingPath, resolveCliHookTarget } = await import(pathToFileURL(modulePath).href);

const candidate = (id, overrides = {}) => ({
  id,
  source: "grok",
  paths: ["D:/work/project"],
  environmentType: "local",
  ...overrides,
});

test("精确 tabId 始终优先", () => {
  const result = resolveCliHookTarget({
    rawTabId: "tab-b",
    primaryTabId: "tab-a",
    source: "grok",
    cwd: "D:/work/project",
    receivedAt: 10_000,
    candidates: [candidate("tab-a"), candidate("tab-b")],
  });
  assert.deepEqual(result, { tabId: "tab-b", reason: "exact" });
});

test("外部 Hook 即使只有一个同目录终端也不能凭路径绑定", () => {
  const result = resolveCliHookTarget({
    rawTabId: "external:grok:session",
    primaryTabId: "external:grok:session",
    source: "grok",
    cwd: "D:/work/project/subdir",
    sessionId: "session",
    receivedAt: 10_000,
    candidates: [candidate("tab-a")],
  });
  assert.deepEqual(result, { tabId: null, reason: "not-found" });
});

test("旧标签 ID 恢复只绑定唯一近期有输出且未绑定会话的终端", () => {
  const result = resolveCliHookTarget({
    rawTabId: "stale-tab",
    primaryTabId: "stale-tab",
    source: "grok",
    cwd: "D:/work/project",
    receivedAt: 10_000,
    candidates: [
      candidate("tab-a", { outputActivityAt: 1_000 }),
      candidate("tab-b", { outputActivityAt: 9_500 }),
    ],
  });
  assert.deepEqual(result, { tabId: "tab-b", reason: "recent-output" });
});

test("多个活跃候选时拒绝猜测", () => {
  const result = resolveCliHookTarget({
    rawTabId: "stale-tab",
    primaryTabId: "stale-tab",
    source: "grok",
    cwd: "D:/work/project",
    receivedAt: 10_000,
    candidates: [
      candidate("tab-a", { outputActivityAt: 9_000 }),
      candidate("tab-b", { outputActivityAt: 9_500 }),
    ],
  });
  assert.deepEqual(result, { tabId: null, reason: "ambiguous" });
});

test("Windows、WSL 挂载盘和 WSL UNC 路径使用一致口径", () => {
  assert.equal(normalizeHookBindingPath("C:\\repo"), normalizeHookBindingPath("/mnt/c/repo"));
  assert.equal(
    normalizeHookBindingPath("\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo"),
    normalizeHookBindingPath("/home/dev/repo", "Ubuntu"),
  );
});

test("磁盘根目录可匹配其子目录", () => {
  const result = resolveCliHookTarget({
    rawTabId: "stale-tab",
    primaryTabId: "stale-tab",
    source: "codex",
    cwd: "C:\\repo",
    receivedAt: 10_000,
    candidates: [candidate("root", { source: "codex", paths: ["C:\\"] })],
  });
  assert.deepEqual(result, { tabId: "root", reason: "unique-path" });
});

test("旧标签恢复可匹配 WSL 终端但不会匹配 SSH", () => {
  const result = resolveCliHookTarget({
    rawTabId: "stale-tab",
    primaryTabId: "stale-tab",
    source: "claude",
    cwd: "/home/dev/repo",
    wslDistroName: "Ubuntu",
    receivedAt: 10_000,
    candidates: [
      candidate("wsl", {
        source: "claude",
        paths: ["\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo"],
        environmentType: "wsl",
      }),
      candidate("ssh", {
        source: "claude",
        paths: ["/home/dev/repo"],
        environmentType: "ssh",
      }),
    ],
  });
  assert.deepEqual(result, { tabId: "wsl", reason: "unique-path" });
});

test("本地 Hook 即使携带精确 ID 也不会绑定 SSH Tab", () => {
  const result = resolveCliHookTarget({
    rawTabId: "ssh",
    primaryTabId: "ssh",
    source: "claude",
    cwd: "/home/dev/repo",
    receivedAt: 10_000,
    candidates: [candidate("ssh", {
      source: "claude",
      paths: ["/home/dev/repo"],
      environmentType: "ssh",
    })],
  });
  assert.deepEqual(result, { tabId: null, reason: "not-found" });
});

test("SSH Hook 仍可按精确 ID 绑定 SSH Tab", () => {
  const result = resolveCliHookTarget({
    rawTabId: "ssh",
    primaryTabId: "ssh",
    source: "claude",
    cwd: "/home/dev/repo",
    environmentType: "ssh",
    receivedAt: 10_000,
    candidates: [candidate("ssh", {
      source: "claude",
      paths: ["/home/dev/repo"],
      environmentType: "ssh",
    })],
  });
  assert.deepEqual(result, { tabId: "ssh", reason: "exact" });
});

const externalCodex = {
  rawTabId: "external:codex:desktop-thread",
  primaryTabId: "external:codex:desktop-thread",
  source: "codex", cwd: "/repo", sessionId: "desktop-thread", receivedAt: 10_000,
};

test("Desktop 和其他客户端不能抢占同目录终端的已有身份或未绑定终端", () => {
  for (const cliSessionId of [undefined, "terminal-thread"]) {
    const result = resolveCliHookTarget({
      ...externalCodex,
      candidates: [candidate("terminal", {
        source: "codex", paths: ["/repo"], cliSessionId, outputActivityAt: 9_999,
      })],
    });
    assert.deepEqual(result, { tabId: null, reason: "not-found" });
  }
});

test("没有精确标签的 Hook 仍可按唯一已知会话 ID 找到隐藏分屏，与 cwd 无关", () => {
  const result = resolveCliHookTarget({
    ...externalCodex, cwd: undefined,
    candidates: [
      candidate("active", { source: "codex", paths: ["/repo"], outputActivityAt: 9_999 }),
      candidate("hidden-worktree", { source: "codex", paths: ["/trees/feature"], cliSessionId: "desktop-thread" }),
    ],
  });
  assert.deepEqual(result, { tabId: "hidden-worktree", reason: "bound-session" });
});

test("旧标签路径恢复也不能覆盖已绑定的另一条会话", () => {
  const result = resolveCliHookTarget({
    ...externalCodex, rawTabId: "stale-tab", primaryTabId: "stale-tab",
    candidates: [candidate("terminal", { source: "codex", paths: ["/repo"], cliSessionId: "terminal-thread" })],
  });
  assert.deepEqual(result, { tabId: null, reason: "not-found" });
});

test("同一会话同时打开在多个终端时不猜测归属，但精确标签仍可定位", () => {
  const input = {
    ...externalCodex,
    candidates: ["a", "b"].map(id => candidate(id, { source: "codex", cliSessionId: "desktop-thread" })),
  };
  assert.deepEqual(resolveCliHookTarget(input), { tabId: null, reason: "ambiguous" });
  assert.deepEqual(resolveCliHookTarget({ ...input, rawTabId: "b" }), { tabId: "b", reason: "exact" });
});

test("精确终端 Hook 允许用户在同一 CLI 进程中切换对话", () => {
  assert.deepEqual(resolveCliHookTarget({
    ...externalCodex, rawTabId: "terminal",
    candidates: [candidate("terminal", { source: "codex", cliSessionId: "old-thread" })],
  }), { tabId: "terminal", reason: "exact" });
});
