import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-tui-color-sync-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const originalWindow = globalThis.window;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
let nextAnimationFrameId = 1;
const animationFrames = new Map();

globalThis.window = globalThis;
globalThis.requestAnimationFrame = (callback) => {
  const frameId = nextAnimationFrameId++;
  animationFrames.set(frameId, callback);
  return frameId;
};
globalThis.cancelAnimationFrame = (frameId) => {
  animationFrames.delete(frameId);
};

function flushNextAnimationFrame() {
  const nextFrame = animationFrames.entries().next();
  assert.equal(nextFrame.done, false, "expected a scheduled animation frame");
  const [frameId, callback] = nextFrame.value;
  animationFrames.delete(frameId);
  callback(performance.now());
}

test.after(() => {
  animationFrames.clear();
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
  if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  if (originalCancelAnimationFrame === undefined) delete globalThis.cancelAnimationFrame;
  else globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

writeFileSync(join(tempDir, "terminalTuiDisplay.mjs"), `
export let normalizeCalls = 0;
export function resetNormalizeCalls() { normalizeCalls = 0; }
export function inspectTerminalTuiViewport() { return { codex: false, known: false, composerPrompt: false }; }
export function normalizeTerminalTuiComposerBackground() { normalizeCalls += 1; }
`);
writeFileSync(join(tempDir, "TerminalCliContext.mjs"), `
export function isClaudeTerminalContext() { return false; }
export function isCodexTerminalContext() { return false; }
`);

writeFileSync(join(tempDir, "terminalMutationGate.mjs"), ts.transpileModule(
  readFileSync(new URL("../src/lib/terminalMutationGate.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText);

const source = readFileSync(new URL("../src/lib/terminalTuiColorSync.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "terminalTuiColorSync.ts",
}).outputText
  .replace('from "./terminalMutationGate"', 'from "./terminalMutationGate.mjs"')
  .replace('from "./terminalTuiDisplay"', 'from "./terminalTuiDisplay.mjs"')
  .replace('from "../terminal/browser/TerminalCliContext"', 'from "./TerminalCliContext.mjs"');
const modulePath = join(tempDir, "terminalTuiColorSync.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { createTerminalTuiColorSyncController } = await import(pathToFileURL(modulePath).href);
const tuiDisplayStub = await import(pathToFileURL(join(tempDir, "terminalTuiDisplay.mjs")).href);

function createOptions() {
  return {
    isVisible: false,
    isTransparent: false,
    isLightTheme: false,
    terminalTextColor: undefined,
    tuiUserColor: undefined,
    tuiAssistantColor: undefined,
    getContext: () => ({}),
  };
}

test("hidden terminal skips direct TUI color scanning until it becomes visible", (t) => {
  tuiDisplayStub.resetNormalizeCalls();
  const options = createOptions();
  const controller = createTerminalTuiColorSyncController(() => options);
  t.after(() => controller.dispose());

  controller.normalize({});
  assert.equal(tuiDisplayStub.normalizeCalls, 0);

  options.isVisible = true;
  controller.normalize({});
  assert.equal(tuiDisplayStub.normalizeCalls, 1);
});

test("hidden terminal skips scheduled TUI color scanning until it becomes visible", (t) => {
  tuiDisplayStub.resetNormalizeCalls();
  const options = {
    ...createOptions(),
  };
  const controller = createTerminalTuiColorSyncController(() => options);
  t.after(() => controller.dispose());

  controller.schedule({});
  flushNextAnimationFrame();
  assert.equal(tuiDisplayStub.normalizeCalls, 0);

  options.isVisible = true;
  controller.schedule({});
  flushNextAnimationFrame();
  assert.equal(tuiDisplayStub.normalizeCalls, 1);
});

test("a synchronous parser update supersedes coalesced scroll and resize scans", t => {
  tuiDisplayStub.resetNormalizeCalls();
  const controller = createTerminalTuiColorSyncController(() => ({ ...createOptions(), isVisible: true }));
  t.after(() => controller.dispose());
  const terminal = {};
  controller.schedule(terminal);
  controller.schedule(terminal);
  assert.equal(animationFrames.size, 1);
  controller.normalize(terminal);
  assert.equal(tuiDisplayStub.normalizeCalls, 1);
  assert.equal(animationFrames.size, 0);
});

// Real xterm verifies the public parser event and actual cell changes without
// relying on a renderer-specific version counter or stubbed buffer contents.
for (const [name, sourcePath] of [
  ["terminalTui", "../src/lib/terminalTui.ts"],
  ["terminalTuiDisplay", "../src/lib/terminalTuiDisplay.ts"],
  ["TerminalCliContext", "../src/terminal/browser/TerminalCliContext.ts"],
  ["terminalTuiColorSync", "../src/lib/terminalTuiColorSync.ts"],
]) {
  const actual = ts.transpileModule(readFileSync(new URL(sourcePath, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace('from "./terminalTui"', 'from "./real-terminalTui.mjs"')
    .replace('from "./terminalMutationGate"', 'from "./terminalMutationGate.mjs"')
    .replace('from "./terminalTuiDisplay"', 'from "./real-terminalTuiDisplay.mjs"')
    .replace('from "../terminal/browser/TerminalCliContext"', 'from "./real-TerminalCliContext.mjs"');
  writeFileSync(join(tempDir, `real-${name}.mjs`), actual);
}
const realDisplay = await import(pathToFileURL(join(tempDir, "real-terminalTuiDisplay.mjs")).href);
const realSync = await import(pathToFileURL(join(tempDir, "real-terminalTuiColorSync.mjs")).href);
const realContext = await import(pathToFileURL(join(tempDir, "real-TerminalCliContext.mjs")).href);
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));

test("combined TUI detection translates each visible row at most once", () => {
  const rows = ["history outside viewport", "ordinary shell", "OpenAI Codex", "› hello", "last row"];
  const reads = [];
  const terminal = { rows: 4, buffer: { active: {
    viewportY: 1,
    getLine(index) { return { translateToString() { reads.push(index); return rows[index]; } }; },
  } } };
  assert.deepEqual(realDisplay.inspectTerminalTuiViewport(terminal), { codex: true, known: true, composerPrompt: true });
  assert.deepEqual(reads, [1, 2, 3]);
});

test("real parsed output normalizes before paint, and refresh does not cause another scan", async t => {
  const terminal = new Terminal({ cols: 60, rows: 6, scrollback: 100, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const options = {
    ...createOptions(), isVisible: true, isTransparent: true,
    getContext: () => realContext.createTerminalCliContext({ title: "Terminal", cliTool: "codex" }),
  };
  const controller = realSync.createTerminalTuiColorSyncController(() => options);
  t.after(() => controller.dispose());
  let scans = 0;
  const subscription = terminal.onWriteParsed(() => { scans++; controller.normalize(terminal); });
  t.after(() => subscription.dispose());
  await write(terminal, "OpenAI Codex\r\n\x1b[48;2;80;90;100m› prompt\x1b[0m");
  assert.equal(terminal.buffer.active.getLine(1).getCell(0).getBgColorMode(), 0);
  const afterParse = scans;
  terminal.refresh(0, terminal.rows - 1);
  assert.equal(scans, afterParse);
  assert.equal(animationFrames.size, 0);

  options.isVisible = false;
  await write(terminal, "\r\x1b[48;2;80;90;100m› hidden\x1b[0m");
  assert.notEqual(terminal.buffer.active.getLine(1).getCell(0).getBgColorMode(), 0);
  options.isVisible = true;
  controller.normalize(terminal);
  assert.equal(terminal.buffer.active.getLine(1).getCell(0).getBgColorMode(), 0);
});

test("light Claude patch and slash menu colors survive parser-batch synchronization", async t => {
  const terminal = new Terminal({ cols: 80, rows: 8, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const controller = realSync.createTerminalTuiColorSyncController(() => ({
    ...createOptions(), isVisible: true, isLightTheme: true,
    getContext: () => realContext.createTerminalCliContext({ title: "Terminal", startupCmd: "claude" }),
  }));
  t.after(() => controller.dispose());
  const subscription = terminal.onWriteParsed(() => controller.normalize(terminal));
  t.after(() => subscription.dispose());
  await write(terminal, "Claude Code\r\n\x1b[48;2;40;40;40m+ changed line\x1b[0m\r\n› /\r\n/model choose model\r\n/help get help");
  assert.equal(terminal.buffer.active.getLine(1).getCell(0).getBgColorMode(), 0);
  assert.equal(terminal.buffer.active.getLine(3).getCell(0).getBgColor(), 0xe7eefc);
  assert.notEqual(terminal.buffer.active.getLine(4).getCell(0).getBgColor(), 0xe7eefc);
});

test("scroll and alternate buffers still receive configured TUI colors", async t => {
  const terminal = new Terminal({ cols: 60, rows: 4, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const controller = realSync.createTerminalTuiColorSyncController(() => ({
    ...createOptions(), isVisible: true, tuiUserColor: "#123456", tuiAssistantColor: "#abcdef",
    getContext: () => realContext.createTerminalCliContext({ title: "Terminal", cliTool: "codex" }),
  }));
  t.after(() => controller.dispose());
  const subscription = terminal.onWriteParsed(() => controller.normalize(terminal));
  const scroll = terminal.onScroll(() => controller.schedule(terminal));
  t.after(() => { subscription.dispose(); scroll.dispose(); });
  await write(terminal, "OpenAI Codex\r\n› question\r\nanswer\r\nmore\r\nlast");
  terminal.scrollToTop();
  if (animationFrames.size) flushNextAnimationFrame();
  assert.equal(terminal.buffer.active.getLine(1).getCell(0).getFgColor(), 0x123456);
  assert.equal(terminal.buffer.active.getLine(2).getCell(0).getFgColor(), 0xabcdef);
  await write(terminal, "\x1b[?1049h\x1b[H› alternate\r\nresponse");
  assert.equal(terminal.buffer.active.type, "alternate");
  assert.equal(terminal.buffer.active.getLine(0).getCell(0).getFgColor(), 0x123456);
  assert.equal(terminal.buffer.active.getLine(1).getCell(0).getFgColor(), 0xabcdef);
});
