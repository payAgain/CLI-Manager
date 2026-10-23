import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-session-rebind-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(new URL("../src/stores/terminalCliSession.ts", import.meta.url), "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modulePath = join(tempDir, "terminalCliSession.mjs");
writeFileSync(modulePath, output, "utf8");
const { resolveCliSessionRebind } = await import(pathToFileURL(modulePath).href);

test("Codex /clear 后把同一 Tab 重新绑定到新会话 ID", () => {
  const initial = resolveCliSessionRebind(undefined, "old-session");
  assert.deepEqual(initial, { cliSessionId: "old-session", changed: true });

  const afterClear = resolveCliSessionRebind(initial.cliSessionId, " new-session ");
  assert.deepEqual(afterClear, { cliSessionId: "new-session", changed: true });

  const nextPrompt = resolveCliSessionRebind(afterClear.cliSessionId, "new-session");
  assert.deepEqual(nextPrompt, { cliSessionId: "new-session", changed: false });
});

test("空会话 ID 不覆盖当前绑定", () => {
  assert.deepEqual(resolveCliSessionRebind("current-session", "  "), {
    cliSessionId: "current-session",
    changed: false,
  });
});

test("内存已绑定但持久化快照缺失 ID 时仍需自愈保存", () => {
  const incomingId = "current-session";
  assert.equal(resolveCliSessionRebind(incomingId, incomingId).changed, false);
  assert.equal(resolveCliSessionRebind(undefined, incomingId).changed, true);
});

test("Hook 对账持久化快照后，恢复时优先使用明确 ID", async () => {
  const require = createRequire(import.meta.url), cache = new Map();
  function load(path) {
    if (cache.has(path)) return cache.get(path);
    const exports = {}; cache.set(path, exports);
    const compiled = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(compiled, {
      exports, Date,
      require: name => name.startsWith(".") ? load(resolve(dirname(path), `${name}.ts`)) : require(name),
    });
    return exports;
  }
  const { persistChangedHookIdentity } = load(fileURLToPath(new URL("../src/lib/terminalHookIdentity.ts", import.meta.url)));
  const { resolveTerminalConversationRestore } = load(fileURLToPath(new URL("../src/lib/terminalConversationRestore.ts", import.meta.url)));
  for (const environmentType of ["local", "wsl", "ssh"]) {
    const current = { id: environmentType, cwd: "/repo", title: "codex", cliTool: "codex", isAgentSession: true, cliSessionId: "current-session", environmentType };
    let saved = { ...current, cliSessionId: undefined }, writes = 0;
    await persistChangedHookIdentity(current, saved, async () => { saved = { ...current }; writes++; });
    assert.equal(writes, 1);
    assert.equal(resolveTerminalConversationRestore(saved).cliSessionId, "current-session");
    await persistChangedHookIdentity(current, saved, async () => { writes++; });
    assert.equal(writes, 1);
  }
});
