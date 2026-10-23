import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/lib/terminalFileLinks.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  findTerminalFileLinks,
  findTerminalRelativeFileLinks,
  terminalStringRangeToBufferColumns,
  terminalHyperlinkFilePath,
  resolveTerminalFileSystemPath,
} = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);

test("installer paths and OSC 8 file URIs resolve to local files", () => {
  const installer = "/E:/Work/CLI-Manager/src-tauri/target/release/bundle/nsis/CLI-Manager_0.1.0_x64-setup.exe";
  const [match] = findTerminalFileLinks(`打开安装包 (${installer})`);
  assert.equal(match.path, installer);
  assert.equal(resolveTerminalFileSystemPath(terminalHyperlinkFilePath(installer)), installer.slice(1));
  assert.equal(terminalHyperlinkFilePath("file:///E:/My%20Build/%E5%AE%89%E8%A3%85.exe"), "/E:/My Build/安装.exe");
  assert.equal(terminalHyperlinkFilePath("file://server/share/setup.exe"), String.raw`\\server\share\setup.exe`);
  assert.equal(terminalHyperlinkFilePath("file:///tmp/a%23b%25.pdf"), "/tmp/a#b%.pdf");
  assert.equal(terminalHyperlinkFilePath("/E:/repo/main.ts:12:3"), "/E:/repo/main.ts");
  for (const uri of ["https://example.com", "javascript:alert(1)", "data:text/html,test", "shell:AppsFolder", "./setup.exe", "file:///tmp/%broken"]) {
    assert.equal(terminalHyperlinkFilePath(uri), null, uri);
  }
});

test("system paths respect native platforms and WSL mappings", () => {
  assert.equal(resolveTerminalFileSystemPath("/tmp/build/setup", "/repo", "linux"), "/tmp/build/setup");
  assert.equal(resolveTerminalFileSystemPath("/Users/me/report.pdf", "/repo", "macos"), "/Users/me/report.pdf");
  assert.equal(resolveTerminalFileSystemPath("/mnt/e/build/setup.exe", null, "windows"), "E:/build/setup.exe");
  assert.equal(resolveTerminalFileSystemPath("/home/me/report.pdf", String.raw`\\wsl.localhost\Ubuntu\home\me`, "windows"), String.raw`\\wsl.localhost\Ubuntu\home\me\report.pdf`);
  assert.equal(resolveTerminalFileSystemPath("/srv/remote/setup.exe", "E:/repo", "windows"), null);
});

test("terminal click handlers dispatch default file opening and ignore unmodified clicks", async () => {
  const source = readFileSync(new URL("../src/components/XTermTerminal.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("XTermTerminal.tsx", source, ts.ScriptTarget.Latest, true);
  const names = new Set(["openHttpUrl", "getTerminalFileLinkContext", "openTerminalFilePath", "shouldActivateTerminalLink", "activateHyperlink"]);
  const declarations = [];
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && names.has(node.name.getText(ast))) declarations.push(`const ${node.getText(ast)};`);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(declarations.length, names.size);
  const calls = [];
  const session = { id: "terminal", cwd: "E:/Work/CLI-Manager", environmentType: "local" };
  const context = {
    terminalHyperlinkFilePath, resolveTerminalFileSystemPath,
    useTerminalStore: { getState: () => ({ sessions: [session] }) },
    useProjectStore: { getState: () => ({ projects: [], worktrees: [] }) },
    findProjectByPath: () => null, findWorktreeByPath: () => null,
    projectSupportsCapability: () => true, getOsPlatform: async () => "windows",
    invoke: async (command, args) => { calls.push({ command, ...args }); },
    openUrl: async (uri) => { calls.push({ uri }); },
    toast: { info: () => {}, error: () => assert.fail("unexpected open error") },
    translateCurrent: key => key, logError: () => assert.fail("unexpected open error"),
  };
  runInNewContext(ts.transpileModule(`const sessionId = "terminal", ctrlKeyDown = false; ${declarations.join("\n")} globalThis.activate = activateHyperlink;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  const installer = "/E:/Work/CLI-Manager/setup.exe";
  context.activate({ button: 0, ctrlKey: false }, installer);
  assert.equal(calls.length, 0);
  context.activate({ button: 0, ctrlKey: true }, installer);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0].command, "open_folder_in_explorer");
  assert.equal(calls[0].path, "E:/Work/CLI-Manager/setup.exe");
  assert.equal(calls[0].openFile, true);
  context.activate({ button: 0, ctrlKey: true }, "https://example.com");
  assert.equal(calls[1].uri, "https://example.com");
  context.activate({ button: 0, ctrlKey: true }, "javascript:alert(1)");
  assert.equal(calls.length, 2);
  session.environmentType = "ssh";
  context.activate({ button: 0, ctrlKey: true }, installer);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
});

test("relative file links do not capture HTTP URLs", () => {
  assert.deepEqual(findTerminalRelativeFileLinks("https://example.com/docs/file.ts"), []);
  assert.deepEqual(
    findTerminalRelativeFileLinks("https://example.com/docs src/lib/file.ts").map((match) => match.path),
    ["src/lib/file.ts"],
  );
});

test("absolute file links preserve line locations with diagnostic suffixes", () => {
  const [match] = findTerminalFileLinks(String.raw`D:\repo\src\main.ts:12:3:error`);
  assert.equal(match.path, String.raw`D:\repo\src\main.ts`);
  assert.equal(match.lineNumber, 12);
  assert.equal(match.columnNumber, 3);
});

test("relative file links strip trailing source symbols", () => {
  const [match] = findTerminalRelativeFileLinks("src/components/TerminalTabs.tsx:handleToggleFilesPanel");
  assert.equal(match.text, "src/components/TerminalTabs.tsx:handleToggleFilesPanel");
  assert.equal(match.path, "src/components/TerminalTabs.tsx");
});

test("relative file links split Chinese enumeration separators", () => {
  const matches = findTerminalRelativeFileLinks(
    "src/components/files/FileExplorerSidebar.tsx:438、src/components/files/FileExplorerSidebar.tsx:1047",
  );
  assert.deepEqual(
    matches.map(({ path, lineNumber }) => ({ path, lineNumber })),
    [
      { path: "src/components/files/FileExplorerSidebar.tsx", lineNumber: 438 },
      { path: "src/components/files/FileExplorerSidebar.tsx", lineNumber: 1047 },
    ],
  );
});

test("string ranges map to xterm columns across wide cells", () => {
  const cells = [
    { chars: "根", width: 2 },
    { chars: "", width: 0 },
    { chars: "因", width: 2 },
    { chars: "", width: 0 },
    { chars: " ", width: 1 },
    ...Array.from("src/lib/file.ts", (chars) => ({ chars, width: 1 })),
  ];
  const line = {
    length: cells.length,
    getCell(index) {
      const cell = cells[index];
      return cell && {
        getChars: () => cell.chars,
        getWidth: () => cell.width,
      };
    },
  };

  assert.deepEqual(terminalStringRangeToBufferColumns(line, 3, 18), {
    startColumn: 5,
    endColumn: 20,
  });
});
