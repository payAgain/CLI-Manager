import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/terminalReplayWriter.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const exports = {};
new Function("exports", compiled)(exports);
const {
  writeTerminalReplay, trackTerminalMouseProtocol,
  resetTerminalMouseProtocol, canForwardTerminalBinaryInput,
} = exports;
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));
const replay = (terminal, text) => new Promise(resolve => writeTerminalReplay(terminal, text, resolve));
const queries = "\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[?25$p\x1bP$qm\x1b\\";

function createTerminal(t, options = {}) {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, ...options });
  t.after(() => terminal.dispose());
  const protocol = trackTerminalMouseProtocol(terminal);
  t.after(() => protocol.dispose());
  const input = [];
  terminal.onData(data => input.push(data));
  terminal.onBinary(data => {
    if (canForwardTerminalBinaryInput(terminal, data)) input.push(data);
  });
  return { terminal, input, protocol };
}

function reportMouse(terminal, overrides = {}) {
  const mouse = terminal._core.mouseStateService;
  const report = mouse.encodeMouseEvent({
    col: 12, row: 8, x: 120, y: 80, button: 3, action: 32,
    ctrl: false, alt: false, shift: false, ...overrides,
  });
  if (mouse.isDefaultEncoding) terminal._core.coreService.triggerBinaryEvent(report);
  else terminal._core.coreService.triggerDataEvent(report, true);
  return report;
}

test("the old serializer loses SGR and produces the screenshot's CSI M mouse text", async t => {
  const source = createTerminal(t).terminal;
  const addon = new SerializeAddon();
  source.loadAddon(addon);
  await write(source, "\x1b[?1003h\x1b[?1006h");
  assert.equal(reportMouse(source), "\x1b[<35;12;8M");
  const { terminal, input } = createTerminal(t);
  await replay(terminal, addon.serialize());
  assert.equal(terminal.modes.mouseTrackingMode, "any");
  assert.equal(reportMouse(terminal), "\x1b[MC,(");
  assert.deepEqual(input, [], "old checkpoints must not inject unknown mouse bytes");
  terminal.input("正常输入", true);
  assert.deepEqual(input, ["正常输入"]);
});

test("live Agent snapshots preserve SGR clicks, motion, wheel and release in both buffers", async t => {
  for (const alt of [false, true]) {
    const source = createTerminal(t);
    const addon = new SerializeAddon();
    source.terminal.loadAddon(addon);
    await write(source.terminal, `\x1b[32m历史\x1b[0m${alt ? "\x1b[?1049h" : ""}\x1b[?1003h\x1b[?1006h`);
    const snapshot = source.protocol.serializeSnapshot(addon);
    const restored = createTerminal(t);
    await replay(restored.terminal, snapshot);
    const restoredAddon = new SerializeAddon();
    restored.terminal.loadAddon(restoredAddon);
    assert.equal(restored.protocol.serializeSnapshot(restoredAddon), snapshot);
    for (const event of [{}, { button: 0, action: 1 }, { button: 0, action: 0 }, { button: 4, action: 0 }]) {
      const expected = reportMouse(source.terminal, event);
      assert.equal(reportMouse(restored.terminal, event), expected);
      assert.equal(restored.input.at(-1), expected);
    }
  }
});

test("pixel and deliberately negotiated legacy encodings also survive snapshots", async t => {
  for (const encoding of ["\x1b[?1016h", "\x1b[?1006l", ""]) {
    const source = createTerminal(t);
    const addon = new SerializeAddon();
    source.terminal.loadAddon(addon);
    await write(source.terminal, `\x1b[?1003h${encoding}`);
    const restored = createTerminal(t);
    await replay(restored.terminal, source.protocol.serializeSnapshot(addon));
    const expected = reportMouse(source.terminal);
    assert.equal(reportMouse(restored.terminal), expected);
    assert.deepEqual(restored.input, [expected]);
  }
});

test("fragmented replay negotiates encoding before releasing mouse reports at every split", async t => {
  const output = "\x1b[?1003h\x1b[?1006h";
  for (let split = 1; split < output.length; split++) {
    const restored = createTerminal(t);
    await replay(restored.terminal, output.slice(0, split));
    if (restored.terminal.modes.mouseTrackingMode === "any") {
      reportMouse(restored.terminal);
      assert.deepEqual(restored.input, [], `unsafe partial replay at ${split}`);
    }
    await replay(restored.terminal, output.slice(split));
    assert.equal(reportMouse(restored.terminal), "\x1b[<35;12;8M");
    assert.deepEqual(restored.input, ["\x1b[<35;12;8M"]);
  }
});

test("old ambiguous checkpoints stay quarantined through another save and regain live mouse support", async t => {
  const restored = createTerminal(t);
  await replay(restored.terminal, "old view\x1b[?1003h");
  const addon = new SerializeAddon();
  restored.terminal.loadAddon(addon);
  const next = createTerminal(t);
  await replay(next.terminal, restored.protocol.serializeSnapshot(addon));
  reportMouse(next.terminal);
  assert.deepEqual(next.input, []);
  await write(next.terminal, "\x1b[?1006h");
  assert.equal(reportMouse(next.terminal), "\x1b[<35;12;8M");
  assert.deepEqual(next.input, ["\x1b[<35;12;8M"]);
  // Tracking alone cannot recover the encoding lost by the old serializer.
  await write(restored.terminal, "\x1b[?1003l\x1b[?1003h");
  reportMouse(restored.terminal);
  assert.deepEqual(restored.input, []);
  await write(restored.terminal, "\x1b[?1006l");
  assert.equal(reportMouse(restored.terminal), "\x1b[MC,(");
  assert.deepEqual(restored.input, ["\x1b[MC,("], "live legacy TUIs remain supported");
});

test("mouse state is independent across panes, reset, and subsequent protocol switches", async t => {
  const old = createTerminal(t), live = createTerminal(t);
  await replay(old.terminal, "\x1b[?1003h");
  await write(live.terminal, "\x1b[?1003h\x1b[?1006h");
  reportMouse(old.terminal);
  reportMouse(live.terminal);
  assert.deepEqual(old.input, []);
  assert.deepEqual(live.input, ["\x1b[<35;12;8M"]);
  for (const reset of [async () => {
    live.terminal.reset();
    resetTerminalMouseProtocol(live.terminal);
  }, () => replay(live.terminal, "\x1bc")]) {
    await reset();
    await replay(live.terminal, "\x1b[?1003h");
    live.input.length = 0;
    reportMouse(live.terminal);
    assert.deepEqual(live.input, []);
    await write(live.terminal, "\x1b[?1006;1003h");
    await write(live.terminal, "\x1b[?1006l");
    assert.equal(reportMouse(live.terminal), "\x1b[MC,(");
    assert.equal(live.input.at(-1), "\x1b[MC,(");
  }
});

test("an old checkpoint keeps its unknown encoding even when tracking is off at the next save", async t => {
  const old = createTerminal(t);
  await replay(old.terminal, "saved view\x1b[?1003h");
  await write(old.terminal, "\x1b[?1003l");
  const addon = new SerializeAddon();
  old.terminal.loadAddon(addon);
  const restored = createTerminal(t);
  await replay(restored.terminal, old.protocol.serializeSnapshot(addon));
  assert.equal(restored.terminal.modes.mouseTrackingMode, "none");
  assert.equal(restored.terminal.buffer.active.getLine(0).translateToString(true), "saved view");
  await write(restored.terminal, "\x1b[?1003h");
  reportMouse(restored.terminal);
  assert.deepEqual(restored.input, []);
  await write(restored.terminal, "\x1b[?1006h");
  reportMouse(restored.terminal);
  assert.deepEqual(restored.input, ["\x1b[<35;12;8M"]);
});

test("real xterm reproduces historical queries becoming onData input without replay isolation", async t => {
  const { terminal, input } = createTerminal(t);
  await write(terminal, queries);
  assert.ok(input.length >= 6);
  assert.ok(input.includes("\x1b[?1;2c"));
  assert.ok(input.some(data => /^\x1b\[\d+;\d+R$/.test(data)));
});

test("replaying queries produces no PTY input and live queries still receive correct replies", async t => {
  const { terminal, input } = createTerminal(t);
  await replay(terminal, `restored history\r\n${queries}`);
  assert.deepEqual(input, []);
  assert.equal(terminal.options.disableStdin, false);
  await write(terminal, queries);
  assert.ok(input.length >= 6);
  input.length = 0;
  terminal.input("echo 正常输入\r", true);
  assert.deepEqual(input, ["echo 正常输入\r"]);
});

test("query fragments spanning historical chunks stay silent at every split", async t => {
  const { terminal, input } = createTerminal(t);
  for (let i = 1; i < queries.length; i++) {
    await replay(terminal, queries.slice(0, i));
    await replay(terminal, queries.slice(i));
    assert.deepEqual(input, [], `split ${i}`);
  }
});

test("overlapping asynchronous replay writes release stdin only after every callback", async t => {
  const { terminal, input } = createTerminal(t);
  const writes = Array.from({ length: 4 }, () => replay(terminal, `${"history\r\n".repeat(1000)}${queries}`));
  assert.equal(terminal.options.disableStdin, true);
  await Promise.all(writes);
  assert.deepEqual(input, []);
  assert.equal(terminal.options.disableStdin, false);
  terminal.input("test\r", true);
  assert.deepEqual(input, ["test\r"]);
});

test("a hidden or split terminal replay does not silence another terminal", async t => {
  const first = createTerminal(t), second = createTerminal(t);
  const restoring = replay(first.terminal, queries);
  await write(second.terminal, queries);
  await restoring;
  assert.deepEqual(first.input, []);
  assert.ok(second.input.length >= 6);
});

test("a previously read-only terminal stays read-only after replay", async t => {
  const { terminal, input } = createTerminal(t, { disableStdin: true });
  await replay(terminal, queries);
  assert.equal(terminal.options.disableStdin, true);
  terminal.input("test", true);
  assert.deepEqual(input, []);
});

test("write failures release the guard without permanently disabling normal input", async () => {
  const terminal = { options: { disableStdin: false }, write: () => { throw new Error("write failed"); } };
  assert.throws(() => writeTerminalReplay(terminal, queries, () => {}), /write failed/);
  assert.equal(terminal.options.disableStdin, false);
  terminal.write = (_text, done) => done();
  await replay(terminal, queries);
  assert.equal(terminal.options.disableStdin, false);
});

test("serialized normal and alternate buffers retain colors, modes, Unicode and cursor position", async t => {
  for (const alt of [false, true]) {
    const source = createTerminal(t).terminal;
    const original = new SerializeAddon();
    source.loadAddon(original);
    await write(source, `\x1b[32m历史 / history\x1b[0m\r\n${alt ? "\x1b[?1049h" : ""}\x1b[?1004h\x1b[?2004h\x1b[?1002h\x1b[3;5H测试`);
    const snapshot = original.serialize();
    const { terminal, input } = createTerminal(t);
    const restored = new SerializeAddon();
    terminal.loadAddon(restored);
    await replay(terminal, snapshot);
    assert.deepEqual(input, []);
    assert.equal(restored.serialize(), snapshot);
  }
});

test("the production ConPTY capability override also honors replay input isolation", async t => {
  const source = readFileSync(new URL("../src/components/XTermTerminal.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("terminal.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree).endsWith(".registerCsiHandler")
      && node.arguments[0]?.getText(tree) === '{ final: "c" }') handler = node.arguments[1].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(handler);
  const { terminal } = createTerminal(t);
  const writes = [];
  const callback = new Function("terminal", "terminalProcessManager", "sessionId", "reportPtyWriteError", `return (${handler});`)(
    terminal, { write: async (_id, data) => { writes.push(data); } }, "conpty", error => { throw error; },
  );
  terminal.parser.registerCsiHandler({ final: "c" }, callback);
  await replay(terminal, "\x1b[c");
  assert.deepEqual(writes, []);
  await write(terminal, "\x1b[c");
  assert.deepEqual(writes, ["\x1b[?61;4c"]);
});
