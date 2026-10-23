import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
const load = path => {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("exports", "require", compiled)(exports, require);
  return exports;
};
const { installTerminalMutationGate, mutateTerminalWhenReady } = load("../src/lib/terminalMutationGate.ts");
const { writeTerminalReplay } = load("../src/lib/terminalReplayWriter.ts");
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const microtasks = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const write = (terminal, value) => new Promise(resolve => terminal.write(value, resolve));
const row = (terminal, index = 0) => terminal.buffer.active.getLine(index)?.translateToString(true) ?? "";
const signal = () => new AbortController();

function fixture(t, options = {}, onDeferredError) {
  const terminal = new Terminal({ cols: 30, rows: 5, scrollback: 1000, allowProposedApi: true, ...options });
  const addon = new SerializeAddon(); terminal.loadAddon(addon);
  const trace = [];
  const nativeWrite = terminal.write.bind(terminal);
  terminal.write = (data, callback) => {
    trace.push(["write", typeof data === "string" ? data : Array.from(data)]);
    nativeWrite(data, () => { trace.push(["parsed", typeof data === "string" ? data : Array.from(data)]); callback?.(); });
  };
  for (const method of ["resize", "reset", "clear"]) {
    const native = terminal[method].bind(terminal);
    terminal[method] = (...args) => { trace.push([method, ...args]); return native(...args); };
  }
  const gate = installTerminalMutationGate(terminal, onDeferredError);
  t.after(() => { gate.dispose(); terminal.dispose(); });
  return { terminal, gate, addon, trace };
}

async function hold(gate, inspect = () => {}) {
  const entered = deferred(), release = deferred(), controller = signal();
  const capture = gate.capture(async currentSignal => {
    inspect(currentSignal); entered.resolve(currentSignal);
    await release.promise;
    return "capture-result";
  }, controller.signal);
  const currentSignal = await entered.promise;
  return { capture, release, controller, currentSignal };
}

test("real xterm drains pre-freeze writes and ACKs before capturing, while later output stays queued", { timeout: 3000 }, async t => {
  const { terminal, gate } = fixture(t), acknowledgements = [];
  terminal.write("before", () => acknowledgements.push("before"));
  const held = await hold(gate, () => {
    assert.equal(row(terminal), "before"); assert.deepEqual(acknowledgements, ["before"]);
  });
  const later = new Promise(resolve => terminal.write("-after", () => { acknowledgements.push("after"); resolve(); }));
  await turn(); assert.equal(row(terminal), "before"); assert.deepEqual(acknowledgements, ["before"]);
  held.release.resolve(); assert.equal(await held.capture, "capture-result"); await later;
  assert.equal(row(terminal), "before-after"); assert.deepEqual(acknowledgements, ["before", "after"]);
});

test("write, resize, reset, clear and direct cell mutations retain submission order across a capture", { timeout: 3000 }, async t => {
  const { terminal, gate, trace, addon } = fixture(t);
  await write(terminal, "initial"); const before = addon.serialize();
  const held = await hold(gate);
  trace.length = 0;
  const a = new Promise(resolve => terminal.write("A", () => { trace.push(["ack", "A"]); resolve(); }));
  terminal.resize(18, 6);
  terminal.reset();
  const b = new Promise(resolve => terminal.write("B", () => { trace.push(["ack", "B"]); resolve(); }));
  terminal.clear();
  mutateTerminalWhenReady(terminal, () => {
    const active = terminal.buffer.active;
    const line = active.getLine(0)._line, cell = active.getNullCell();
    line.loadCell(0, cell); cell.fg = (cell.fg & ~0x03ffffff) | 0x0300ff00; line.setCell(0, cell);
    trace.push(["mutate"]);
  });
  await turn();
  assert.equal(addon.serialize(), before); assert.equal(terminal.cols, 30); assert.equal(terminal.rows, 5);
  assert.deepEqual(trace, []);
  held.release.resolve(); await held.capture; await Promise.all([a, b]); await microtasks();
  assert.deepEqual(trace.map(item => item[0]), ["write", "parsed", "ack", "resize", "reset", "write", "parsed", "ack", "clear", "mutate"]);
  assert.equal(terminal.cols, 18); assert.equal(terminal.rows, 6); assert.equal(row(terminal), "B");
  assert.equal(terminal.buffer.active.getLine(0).getCell(0).getFgColor(), 0x00ff00);
});

test("deferred binary writes own their bytes and never observe producer buffer reuse", { timeout: 3000 }, async t => {
  const { terminal, gate } = fixture(t), held = await hold(gate);
  const bytes = new TextEncoder().encode("snapshot-safe");
  const parsed = write(terminal, bytes); bytes.fill(0x58);
  held.release.resolve(); await held.capture; await parsed;
  assert.equal(row(terminal), "snapshot-safe");
});

test("a queued resize cannot flush and acknowledge a later write ahead of an earlier one", { timeout: 3000 }, async t => {
  const { terminal, gate, trace } = fixture(t), held = await hold(gate), acks = [];
  trace.length = 0;
  const a = new Promise(resolve => terminal.write("one", () => { acks.push(["one", terminal.cols]); resolve(); }));
  terminal.resize(20, 5);
  const b = new Promise(resolve => terminal.write("two", () => { acks.push(["two", terminal.cols]); resolve(); }));
  terminal.resize(25, 5);
  held.release.resolve(); await held.capture; await Promise.all([a, b]); await microtasks();
  assert.deepEqual(acks, [["one", 30], ["two", 20]]);
  assert.deepEqual(trace.filter(item => item[0] === "write" || item[0] === "resize"), [["write", "one"], ["resize", 20, 5], ["write", "two"], ["resize", 25, 5]]);
  assert.equal(terminal.cols, 25); assert.equal(row(terminal), "onetwo");
});

test("aborting an active capture waits for its reader to stop before parsing queued output", { timeout: 3000 }, async t => {
  const { terminal, gate } = fixture(t), held = await hold(gate), acks = [];
  const rejected = assert.rejects(held.capture, /cancelled/);
  const parsed = new Promise(resolve => terminal.write("after-abort", () => { acks.push(1); resolve(); }));
  held.controller.abort(Error("cancelled")); await turn();
  assert.equal(held.currentSignal.aborted, true); assert.equal(row(terminal), ""); assert.deepEqual(acks, []);
  held.release.resolve(); await rejected; await parsed;
  assert.equal(row(terminal), "after-abort"); assert.deepEqual(acks, [1]);
});

test("aborted captures waiting behind another capture do not run or block subsequent writes", { timeout: 3000 }, async t => {
  const { terminal, gate } = fixture(t), held = await hold(gate), next = signal();
  let invoked = false;
  const capture = gate.capture(() => { invoked = true; }, next.signal);
  const rejected = assert.rejects(capture, /cancelled-before-start/);
  const parsed = write(terminal, "following");
  next.abort(Error("cancelled-before-start")); await rejected;
  held.release.resolve(); await held.capture; await parsed;
  assert.equal(invoked, false); assert.equal(row(terminal), "following");
});

test("dispose drops deferred mutations and callbacks without fake output ACKs, including late calls", { timeout: 3000 }, async t => {
  const { terminal, gate, trace } = fixture(t), held = await hold(gate), acks = [], mutations = [];
  const rejected = assert.rejects(held.capture, /disposed/);
  terminal.write("never-parsed", () => acks.push(1)); terminal.resize(10, 3); terminal.reset(); terminal.clear();
  mutateTerminalWhenReady(terminal, () => mutations.push(1));
  trace.length = 0; gate.dispose(); held.release.resolve(); await rejected; await turn();
  terminal.write("late", () => acks.push(2)); terminal.resize(11, 4);
  mutateTerminalWhenReady(terminal, () => mutations.push(2));
  await turn();
  assert.deepEqual(acks, []); assert.deepEqual(mutations, []); assert.deepEqual(trace, []); assert.equal(row(terminal), "");
  await assert.rejects(gate.capture(() => "late-capture", signal().signal), /disposed/);
});

test("disposing before the empty write barrier parses rejects without invoking capture", { timeout: 3000 }, async t => {
  const { terminal, gate } = fixture(t);
  let invoked = false;
  const capture = gate.capture(() => { invoked = true; }, signal().signal);
  const rejected = assert.rejects(capture, /disposed/);
  gate.dispose(); terminal.dispose(); await rejected; await turn();
  assert.equal(invoked, false);
});

test("replay commit microtasks and parser-batch side effects settle before the capture sees sequence and screen", { timeout: 3000 }, async t => {
  const { terminal, gate, addon } = fixture(t), input = [], order = [];
  let sequence = 0, parsedBatches = 0;
  terminal.onData(data => input.push(data));
  terminal.onWriteParsed(() => { parsedBatches++; order.push("parsed-batch"); });
  writeTerminalReplay(terminal, "replay\x1b[?1003h\x1b[?1006h\x1b[6n", () => { sequence = 42; order.push("commit"); });
  const captured = await gate.capture(() => {
    order.push("capture");
    return { sequence, screen: addon.serialize(), parsedBatches, disabled: terminal.options.disableStdin, mouse: terminal.modes.mouseTrackingMode };
  }, signal().signal);
  assert.equal(captured.sequence, 42); assert.ok(captured.parsedBatches > 0);
  assert.equal(captured.disabled, false); assert.equal(captured.mouse, "any"); assert.deepEqual(input, []);
  assert.ok(captured.screen.includes("replay")); assert.ok(order.indexOf("capture") > order.indexOf("commit"));
  assert.ok(order.indexOf("capture") > order.indexOf("parsed-batch"));
});

test("captures serialize per terminal while another terminal can continue parsing", { timeout: 3000 }, async t => {
  const a = fixture(t), b = fixture(t), held = await hold(a.gate), events = [];
  const second = a.gate.capture(() => { events.push("second"); return row(a.terminal); }, signal().signal);
  await write(b.terminal, "independent"); assert.equal(row(b.terminal), "independent"); assert.deepEqual(events, []);
  held.release.resolve(); await held.capture; assert.equal(await second, ""); assert.deepEqual(events, ["second"]);
});

test("synchronous and asynchronous capture failures release the gate for real output", { timeout: 3000 }, async t => {
  for (const capture of [() => { throw Error("capture-failed"); }, async () => { throw Error("capture-failed"); }]) {
    const { terminal, gate } = fixture(t);
    await assert.rejects(gate.capture(capture, signal().signal), /capture-failed/);
    await write(terminal, "recovered"); assert.equal(row(terminal), "recovered");
  }
});

test("a deferred mutation failure is reported and later writes and captures still complete", { timeout: 3000 }, async t => {
  const errors = [];
  const { terminal, gate } = fixture(t, {}, error => errors.push(error));
  const held = await hold(gate), failure = Error("deferred-cell-mutation-failed"), acknowledgements = [];
  mutateTerminalWhenReady(terminal, () => { throw failure; });
  const parsed = new Promise(resolve => terminal.write("still-parses", () => { acknowledgements.push("output"); resolve(); }));
  terminal.resize(24, 6);
  const following = gate.capture(() => ({ line: row(terminal), cols: terminal.cols, acks: [...acknowledgements] }), signal().signal);
  assert.deepEqual(errors, []);
  held.release.resolve(); await held.capture; await parsed;
  assert.deepEqual(await following, { line: "still-parses", cols: 24, acks: ["output"] });
  assert.deepEqual(errors, [failure]);
  await write(terminal, "-continues");
  assert.equal(row(terminal), "still-parses-continues");
});

test("a synchronous gated mutation applies nested resize/reset/clear immediately while its write remains deferred", { timeout: 3000 }, async t => {
  const { terminal, gate } = fixture(t);
  await write(terminal, "before");
  const held = await hold(gate), events = [], parsed = deferred();
  mutateTerminalWhenReady(terminal, () => {
    terminal.resize(22, 7);
    assert.equal(terminal.cols, 22); assert.equal(terminal.rows, 7);
    terminal.reset(); assert.equal(row(terminal), "");
    terminal.write("after-transaction", () => { events.push("ack"); parsed.resolve(); });
    assert.equal(row(terminal), "", "nested writes must not enter the parser during the synchronous transaction");
    terminal.clear();
    mutateTerminalWhenReady(terminal, () => { events.push("nested"); });
    events.push("transaction-end");
  });
  assert.deepEqual(events, []); assert.equal(terminal.cols, 30); assert.equal(row(terminal), "before");
  held.release.resolve(); await held.capture; await parsed.promise;
  assert.deepEqual(events, ["nested", "transaction-end", "ack"]);
  assert.equal(row(terminal), "after-transaction"); assert.equal(terminal.cols, 22);
});
