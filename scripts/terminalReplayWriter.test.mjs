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
const { writeTerminalReplay } = exports;
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));
const replay = (terminal, text) => new Promise(resolve => writeTerminalReplay(terminal, text, resolve));
const queries = "\x1b[c\x1b[>c\x1b[5n\x1b[6n\x1b[?6n\x1b[?25$p\x1bP$qm\x1b\\";

function createTerminal(t, options = {}) {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true, ...options });
  t.after(() => terminal.dispose());
  const input = [];
  terminal.onData(data => input.push(data));
  terminal.onBinary(data => input.push(data));
  return { terminal, input };
}

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
