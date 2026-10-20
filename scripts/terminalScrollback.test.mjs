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
const { prepareTerminalScrollback } = load("../src/lib/terminalScrollback.ts");
const { writeTerminalReplay, trackTerminalMouseProtocol, canForwardTerminalBinaryInput } = load("../src/lib/terminalReplayWriter.ts");
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));
const replay = (terminal, text) => new Promise(resolve => writeTerminalReplay(terminal, text, resolve));
// The input-mode suffix found in the affected saved terminal, without user content.
const oldModes = "\x1b[?1h\x1b[?66h\x1b[?2004h\x1b[?1004h\x1b[?1003h";
function terminal(t) {
  const value = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
  t.after(() => value.dispose());
  return value;
}

test("replay isolation alone leaves mouse motion enabled after the historical write", async t => {
  const value = terminal(t);
  await replay(value, `old output${oldModes}`);
  assert.equal(value.options.disableStdin, false);
  assert.equal(value.modes.mouseTrackingMode, "any");
  assert.equal(value.modes.sendFocusMode, true);
});

test("a recreated shell keeps historical text but never inherits the old mouse and focus protocols", async t => {
  const value = terminal(t);
  await replay(value, prepareTerminalScrollback(`\x1b[32m历史 output\x1b[0m${oldModes}`));
  assert.equal(value.modes.mouseTrackingMode, "none");
  assert.equal(value.modes.sendFocusMode, false);
  assert.equal(value.modes.applicationCursorKeysMode, false);
  assert.equal(value.modes.applicationKeypadMode, false);
  assert.equal(value.modes.bracketedPasteMode, false);
  assert.equal(value.buffer.active.getLine(0).translateToString(true), "历史 output");
  const input = [];
  value.onData(data => input.push(data));
  value.input("echo normal\r", true);
  assert.deepEqual(input, ["echo normal\r"]);
});

test("the newly started shell or Agent can negotiate its own live input modes", async t => {
  const value = terminal(t);
  await replay(value, prepareTerminalScrollback(oldModes));
  await write(value, "\x1b[?2004h");
  assert.equal(value.modes.bracketedPasteMode, true);
  await write(value, "\x1b[?1003h\x1b[?1006h\x1b[?1004h");
  assert.equal(value.modes.mouseTrackingMode, "any");
  assert.equal(value.modes.sendFocusMode, true);
});

test("a fresh PTY does not inherit an old checkpoint's unknown mouse encoding", async t => {
  for (const marker of [
    "\x1b]777;CLIManagerMouseEncoding=unknown\x07",
    "\x1b]777;CLIManagerMouseEncoding=unknown\x1b\\",
  ]) {
    const value = terminal(t);
    const protocol = trackTerminalMouseProtocol(value);
    t.after(() => protocol.dispose());
    await replay(value, prepareTerminalScrollback(`history${oldModes}${marker}`));
    assert.equal(value.modes.mouseTrackingMode, "none");
    await write(value, "\x1b[?1003h");
    assert.equal(canForwardTerminalBinaryInput(value, "\x1b[MC,("), true);
    assert.equal(value.buffer.active.getLine(0).translateToString(true), "history");
  }
});

test("live daemon snapshots continue to retain the running TUI's modes", async t => {
  const value = terminal(t);
  await replay(value, oldModes);
  assert.equal(value.modes.mouseTrackingMode, "any");
  assert.equal(value.modes.applicationCursorKeysMode, true);
});

test("mixed mode commands retain cursor, origin and wrapping state while removing input protocols", () => {
  assert.equal(prepareTerminalScrollback("\x1b[?1;25;1003h\x1b[?7;1004l"), "\x1b[?25h\x1b[?7l");
  assert.equal(prepareTerminalScrollback("\x9b?1003;25h"), "\x9b?25h");
  assert.equal(prepareTerminalScrollback("\x1b=\x1b>\x1b[>31u\x1b[=3;1u\x1b[<2u\x1b[>4;2mtext"), "text");
  assert.equal(prepareTerminalScrollback("\x1b[u\x1b[4h\x1b[38;2;255;128;0mtext"), "\x1b[u\x1b[4h\x1b[38;2;255;128;0mtext");
});

test("screen content, colors, Unicode, links and normal/alternate buffers remain intact", async t => {
  for (const alt of [false, true]) {
    const original = terminal(t), restored = terminal(t);
    const originalAddon = new SerializeAddon(), restoredAddon = new SerializeAddon();
    original.loadAddon(originalAddon);
    restored.loadAddon(restoredAddon);
    await write(original, `\x1b[34m中文 history\x1b[0m\r\n${alt ? "\x1b[?1049h" : ""}\x1b[2;5Hsaved view${oldModes}`);
    const snapshot = originalAddon.serialize();
    const prepared = prepareTerminalScrollback(snapshot);
    assert.equal(prepareTerminalScrollback(prepared), prepared);
    await replay(restored, prepared);
    assert.equal(restored.modes.mouseTrackingMode, "none");
    assert.equal(restoredAddon.serialize({ excludeModes: true }), originalAddon.serialize({ excludeModes: true }));
  }
});
