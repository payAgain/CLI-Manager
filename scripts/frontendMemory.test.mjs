import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, relative } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
function pureModule(path, dependencies) {
  const text = readFileSync(resolve(root, path), "utf8");
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
  const exports = {};
  runInNewContext(ts.transpileModule(body, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, ...dependencies });
  return exports;
}

test("Simplified Chinese and English do not construct OpenCC; Traditional Chinese remains synchronous and cached", () => {
  const opencc = require("opencc-js/cn2t");
  let calls = 0;
  const i18n = pureModule("src/lib/i18n.ts", {
    OpenCC: { Converter(options) { calls++; return opencc.Converter(options); } },
    useMemo: factory => factory(),
    useSettingsStore: { getState: () => ({ language: "zh-CN" }) },
  });
  assert.equal(calls, 0);
  assert.equal(i18n.translate("zh-CN", "common.close"), "关闭");
  assert.equal(i18n.translate("en-US", "common.close"), "Close");
  assert.equal(i18n.convertChineseForLanguage("zh-CN", "设置终端"), "设置终端");
  assert.equal(calls, 0);
  assert.equal(i18n.translate("zh-TW", "common.close"), "關閉");
  assert.equal(i18n.convertChineseForLanguage("zh-TW", "设置终端"), "設置終端");
  assert.equal(i18n.translate("zh-TW", "memory.terminals", { count: 2 }), "打開的終端 · 2");
  assert.equal(calls, 1);
});

test("preview availability checks preserve runtime Agent identity without loading its UI", () => {
  const source = pureModule("src/lib/terminalMarkdownSource.ts", {
    runtimeAgentTool: session => session.runtimeAgent === undefined ? undefined : session.runtimeAgent?.tool ?? null,
    resolveCliToolHistorySourceId: tool => tool,
  });
  assert.equal(source.resolveTerminalMarkdownSource(null, null), null);
  assert.equal(source.resolveTerminalMarkdownSource({ cliTool: "codex" }, null), "codex");
  assert.equal(source.resolveTerminalMarkdownSource({ runtimeAgent: null, cliTool: "codex" }, null), null);
  assert.equal(source.resolveTerminalMarkdownSource({ runtimeAgent: { tool: "claude" }, cliTool: "codex" }, null), "claude");
  assert.equal(source.isTerminalMarkdownPreviewSupported({ cwd: "/repo" }, { cli_tool: "claude" }), true);
  assert.equal(source.isTerminalMarkdownPreviewSupported({ startupCmd: "wsl codex" }, null), true);
});

test("the startup import graph defers Markdown, file browsing, Monaco and settings", () => {
  const visited = new Set();
  const visit = path => {
    if (visited.has(path)) return;
    visited.add(path);
    const ast = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of ast.statements) {
      if (!ts.isImportDeclaration(node) || !node.importClause || node.importClause.isTypeOnly) continue;
      const clause = node.importClause;
      if (!clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.every(item => item.isTypeOnly)) continue;
      const specifier = node.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      const base = resolve(dirname(path), specifier);
      const dependency = [base + ".ts", base + ".tsx", resolve(base, "index.ts"), resolve(base, "index.tsx")].find(existsSync);
      if (dependency) visit(dependency);
    }
  };
  visit(resolve(root, "src/App.tsx"));
  const paths = [...visited].map(path => relative(root, path).replaceAll("\\", "/"));
  for (const deferred of ["src/components/ui/MarkdownContent.tsx", "src/components/files/FileExplorerSidebar.tsx", "src/lib/monacoSetup.ts", "src/components/SettingsModal.tsx"]) {
    assert.equal(paths.includes(deferred), false, `${deferred} is eagerly imported`);
  }
});
