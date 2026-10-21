import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
function load(path) {
  const code = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("exports", code)(exports);
  return exports;
}
const { createTerminalScrollbackReplay } = load("../src/lib/terminalScrollback.ts");
const { writeTerminalReplay } = load("../src/lib/terminalReplayWriter.ts");
const write = (terminal, data) => new Promise(resolve => terminal.write(data, resolve));
const replay = (terminal, data) => new Promise(resolve => writeTerminalReplay(terminal, data, resolve));
function terminal(t, cols = 98, rows = 27, windows = true) {
  const value = new Terminal({
    cols, rows, allowProposedApi: true, scrollback: 1000, reflowCursorLine: true,
    ...(windows ? { windowsPty: { backend: "conpty" } } : {}),
  });
  const serializer = new SerializeAddon();
  value.loadAddon(serializer);
  t.after(() => value.dispose());
  return { value, serializer };
}
function history(value) {
  const buffer = value.buffer.normal;
  return Array.from({ length: buffer.baseY }, (_, row) => buffer.getLine(row).translateToString(true)).join("\n");
}
function assertFreshScreen(value) {
  const buffer = value.buffer.active;
  assert.equal(buffer.type, "normal");
  assert.deepEqual([buffer.cursorX, buffer.cursorY], [0, 0]);
  for (let row = 0; row < value.rows; row++) {
    assert.equal(buffer.getLine(buffer.baseY + row).translateToString(true), "");
  }
}
const prompt = "PS E:\\Work\\claude> ";
// PSReadLine redraw captured from the affected PowerShell, including its absolute row.
const input = "\x1b[?25l\x1b[1;20H\x1b[97m11123\x1b[0m\x1b[1;25H\x1b[?25h";
function assertPromptAndInput(value) {
  const buffer = value.buffer.active;
  assert.equal(buffer.getLine(buffer.baseY).translateToString(true), prompt + "11123");
  assert.deepEqual([buffer.cursorX, buffer.cursorY], [24, 0]);
}

test("a cold restored PowerShell starts at the same screen origin as PSReadLine", async t => {
  const old = terminal(t);
  await write(old.value, "\x1b[32m历史 output\x1b[0m\r\n" + prompt);
  const restored = terminal(t);
  await replay(restored.value, createTerminalScrollbackReplay(old.serializer.serialize(), restored.value.rows));
  assertFreshScreen(restored.value);
  assert.match(history(restored.value), /历史 output/);
  assert.match(history(restored.value), /PS E:\\Work\\claude> /);
  assert.equal(restored.value.buffer.normal.getLine(0).getCell(0).getFgColor(), 2);
  await write(restored.value, prompt);
  await write(restored.value, input);
  assertPromptAndInput(restored.value);
});

test("cold restore stays aligned when a hidden project becomes visible at another grid size", async t => {
  for (const windows of [false, true]) {
    const old = terminal(t, 178, 36, windows);
    await write(old.value, "saved project history\r\n" + prompt);
    const restored = terminal(t, 80, 24, windows);
    await replay(restored.value, createTerminalScrollbackReplay(old.serializer.serialize(), 24));
    assertFreshScreen(restored.value);
    await write(restored.value, prompt);
    restored.value.resize(98, 27);
    await write(restored.value, input);
    assertPromptAndInput(restored.value);
    assert.match(history(restored.value), /saved project history/);
  }
});

test("old origin, wrapping, insert mode and scroll margins cannot move the new prompt", async t => {
  const old = terminal(t);
  await write(old.value, "kept history\x1b[3;20r\x1b[?6h\x1b[4h\x1b[?7l\x1b[?25l");
  const restored = terminal(t);
  await replay(restored.value, createTerminalScrollbackReplay(old.serializer.serialize(), 27));
  assertFreshScreen(restored.value);
  assert.equal(restored.value.modes.originMode, false);
  assert.equal(restored.value.modes.wraparoundMode, true);
  assert.equal(restored.value.modes.insertMode, false);
  await write(restored.value, prompt + input);
  assertPromptAndInput(restored.value);
  assert.match(history(restored.value), /kept history/);
});

test("an exited alternate screen and the normal history both become scrollback", async t => {
  const old = terminal(t);
  await write(old.value, "normal history\x1b[?1049h\x1b[4;5H\x1b[34m旧 TUI 画面\x1b[0m");
  const restored = terminal(t);
  await replay(restored.value, createTerminalScrollbackReplay(old.serializer.serialize(), 27));
  assertFreshScreen(restored.value);
  assert.match(history(restored.value), /normal history/);
  assert.match(history(restored.value), /旧 TUI 画面/);
  await write(restored.value, prompt + input);
  assertPromptAndInput(restored.value);
});

test("the new shell can enter and leave its own alternate screen after cold restore", async t => {
  const restored = terminal(t);
  await replay(restored.value, createTerminalScrollbackReplay("old history", 27));
  await write(restored.value, prompt + "\x1b[?1049hnew TUI\x1b[?1049l" + input);
  assertPromptAndInput(restored.value);
  assert.match(history(restored.value), /old history/);
});

test("restarting twice archives each previous screen without discarding older history", async t => {
  let snapshot = "first run history";
  for (let turn = 0; turn < 2; turn++) {
    const restored = terminal(t);
    await replay(restored.value, createTerminalScrollbackReplay(snapshot, 27));
    assertFreshScreen(restored.value);
    await write(restored.value, prompt + input);
    assertPromptAndInput(restored.value);
    assert.match(history(restored.value), /first run history/);
    snapshot = restored.serializer.serialize();
  }
});

test("historical queries remain isolated while the fresh shell negotiates live protocols", async t => {
  const restored = terminal(t);
  const replies = [];
  restored.value.onData(data => replies.push(data));
  await replay(restored.value, createTerminalScrollbackReplay("old\x1b[6n\x1b[?1003h\x1b[?1004h", 27));
  assert.deepEqual(replies, []);
  assert.equal(restored.value.modes.mouseTrackingMode, "none");
  assert.equal(restored.value.modes.sendFocusMode, false);
  await write(restored.value, prompt + "\x1b[6n\x1b[?1004h");
  assert.deepEqual(replies, ["\x1b[1;20R", "\x1b[O"]);
  assert.equal(restored.value.modes.sendFocusMode, true);
});
