import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
function load(path, imports = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("exports", "require", compiled)(exports, name => imports[name] ?? require(name));
  return exports;
}
const { createTerminalSerialization } = load("../src/lib/cooperativeTerminalSerializer.ts");
const { installTerminalMutationGate, mutateTerminalWhenReady } = load("../src/lib/terminalMutationGate.ts");
const { trackTerminalMouseProtocol, resetTerminalMouseProtocol, writeTerminalReplay } = load("../src/lib/terminalReplayWriter.ts");
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const signal = () => new AbortController();
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
};
const visible = terminal => Array.from({ length: terminal.rows }, (_, i) =>
  terminal.buffer.active.getLine(terminal.buffer.active.baseY + i)?.translateToString(true) ?? "");

function manualScheduler() {
  const queue = [];
  let scheduled = 0;
  return {
    queue,
    get scheduled() { return scheduled; },
    options: { maxStepsPerTask: 1, scheduleTask(callback) {
      const task = { callback, cancelled: false };
      queue.push(task); scheduled++;
      return () => { task.cancelled = true; };
    } },
    tick() { const task = queue.shift(); if (task && !task.cancelled) task.callback(); },
    async waitForWork() {
      for (let i = 0; i < 100 && queue.length === 0; i++) await turn();
      assert.ok(queue.length, "capture reached a cooperative serialization slice");
    },
    async finish(promise) {
      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      for (let i = 0; i < 30000 && !settled; i++) {
        if (queue.length) this.tick();
        else await turn();
        await Promise.resolve();
      }
      assert.ok(settled, "capture completed within the bounded scheduler turns");
      return promise;
    },
    async until(predicate) {
      for (let i = 0; i < 30000 && !predicate(); i++) {
        if (queue.length) this.tick();
        else await turn();
        await Promise.resolve();
      }
      assert.ok(predicate(), "expected capture lifecycle transition occurred");
    },
  };
}

function fixture(t, options = {}, captureOptions = {}) {
  const terminal = new Terminal({ cols: 30, rows: 6, scrollback: 1000, allowProposedApi: true, ...options });
  const addon = new SerializeAddon(); terminal.loadAddon(addon);
  const mouse = trackTerminalMouseProtocol(terminal);
  const gate = installTerminalMutationGate(terminal);
  const scheduler = manualScheduler(), jobs = [];
  const { createTerminalCheckpointCapture } = load("../src/lib/terminalCheckpointCapture.ts", {
    "./cooperativeTerminalSerializer": { createTerminalSerialization(terminal, options) {
      const job = createTerminalSerialization(terminal, options, scheduler.options);
      jobs.push({ job, options });
      return job;
    } },
  });
  let sequence = 0, generation = 1, syncFallbacks = 0;
  const capture = createTerminalCheckpointCapture({
    terminal, gate, maxLines: 24,
    snapshotSuffix: mouse.snapshotSuffix,
    serializeSync: () => { syncFallbacks++; return mouse.serializeSnapshot(addon); },
    getSequence: () => sequence,
    getGeneration: () => generation,
    ...captureOptions,
  });
  t.after(() => { gate.dispose(); mouse.dispose(); terminal.dispose(); });
  return {
    terminal, addon, mouse, gate, capture, scheduler, jobs,
    get sequence() { return sequence; },
    set sequence(value) { sequence = value; },
    get generation() { return generation; },
    set generation(value) { generation = value; },
    get syncFallbacks() { return syncFallbacks; },
  };
}

async function restored(t, snapshot, cols, rows) {
  const terminal = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  const addon = new SerializeAddon(); terminal.loadAddon(addon);
  const mouse = trackTerminalMouseProtocol(terminal);
  t.after(() => { mouse.dispose(); terminal.dispose(); });
  await new Promise(resolve => writeTerminalReplay(terminal, snapshot, resolve));
  return { terminal, addon, mouse };
}

for (const alternate of [false, true]) {
  test(`full and bounded ${alternate ? "alternate" : "normal"} pictures freeze geometry, mouse mode and sequence across slices`, { timeout: 5000 }, async t => {
    const state = fixture(t), { terminal, addon, mouse, capture, scheduler, jobs } = state;
    await write(terminal, Array.from({ length: 140 }, (_, i) => `\x1b[3${i % 7}mhistory-${i} 界\x1b[0m\r\n`).join(""));
    if (alternate) await write(terminal, "normal-cursor\x1b[?1049h\x1b[Halt-screen界\x1b[3;9H");
    state.sequence = 70;
    terminal.write("pre-freeze\x1b[?1003h\x1b[?1006h", () => { state.sequence = 71; });
    const pending = capture.capture(signal().signal, true);
    await scheduler.waitForWork();
    const expectedFull = mouse.serializeSnapshot(addon);
    const scrollback = Math.max(0, 24 - terminal.rows - (alternate ? terminal.rows : 0));
    const expectedTail = mouse.serializeSnapshot(addon, { scrollback });
    const expectedVisible = visible(terminal), acknowledgements = [];
    const first = new Promise(resolve => terminal.write("\x1b[?1016h-new-output", () => {
      acknowledgements.push("first"); state.sequence = 72; resolve();
    }));
    terminal.resize(21, 8);
    const second = new Promise(resolve => terminal.write("-after-resize", () => {
      acknowledgements.push("second"); state.sequence = 73; resolve();
    }));
    scheduler.tick(); scheduler.tick(); await microtasks();
    assert.equal(terminal.cols, 30); assert.equal(terminal.rows, 6); assert.equal(state.sequence, 71);
    assert.equal(mouse.snapshotSuffix(), "\x1b[?1006h"); assert.deepEqual(acknowledgements, []);
    assert.equal(addon.serialize() + mouse.snapshotSuffix(), expectedFull);
    const picture = await scheduler.finish(pending);
    assert.deepEqual(picture, { snapshot: expectedTail, serialized: expectedFull, cols: 30, rows: 6, sequence: 71, generation: 1 });
    assert.equal(jobs.length, 2, "a long buffer uses one full scan and one independently replayable bounded scan");
    assert.deepEqual(jobs[1].options, { scrollback });
    await Promise.all([first, second]); await microtasks();
    assert.deepEqual(acknowledgements, ["first", "second"]); assert.equal(state.sequence, 73);
    assert.equal(terminal.cols, 21); assert.equal(terminal.rows, 8);
    const replay = await restored(t, picture.snapshot, picture.cols, picture.rows);
    assert.deepEqual(visible(replay.terminal), expectedVisible);
    assert.equal(replay.terminal.buffer.active.type, alternate ? "alternate" : "normal");
    assert.equal(replay.mouse.snapshotSuffix(), "\x1b[?1006h");
    assert.ok(replay.terminal.buffer.normal.length + (alternate ? picture.rows : 0) <= 24);
  });
}

test("small full pictures share one scan and a subsequent tail-only request omits the full checkpoint", { timeout: 3000 }, async t => {
  const state = fixture(t), { terminal, mouse, addon, capture, scheduler, jobs } = state;
  await write(terminal, "small\x1b[?1000h\x1b[?1016h"); state.sequence = 9;
  const expected = mouse.serializeSnapshot(addon);
  const full = await scheduler.finish(capture.capture(signal().signal, true));
  assert.equal(full.snapshot, expected); assert.equal(full.serialized, expected); assert.equal(full.sequence, 9);
  assert.equal(jobs.length, 1);
  await write(terminal, "-new"); state.sequence = 10;
  const tail = await scheduler.finish(capture.capture(signal().signal, false));
  assert.equal(tail.serialized, undefined); assert.equal(tail.snapshot, mouse.serializeSnapshot(addon));
  assert.equal(tail.sequence, 10); assert.equal(jobs.length, 2);
});

for (const phase of ["full", "tail"]) {
  test(`unmount during the ${phase} scan finishes the existing full picture and immediately drops queued ACKs`, { timeout: 5000 }, async t => {
    const state = fixture(t), { terminal, addon, mouse, capture, gate, scheduler, jobs } = state;
    await write(terminal, "\x1b[32mhistory界\x1b[0m\r\n".repeat(180) + "\x1b[?1003h\x1b[?1006h");
    const expected = mouse.serializeSnapshot(addon), controller = signal();
    const pending = capture.capture(controller.signal, true);
    const rejected = assert.rejects(pending, /disposed/);
    await scheduler.waitForWork();
    if (phase === "tail") {
      for (let i = 0; i < 10000 && jobs.length === 1; i++) { scheduler.tick(); await Promise.resolve(); }
      assert.equal(jobs.length, 2);
    } else {
      scheduler.tick(); scheduler.tick();
    }
    const acknowledgements = [], mutations = [];
    terminal.write("not-in-picture", () => acknowledgements.push(1)); terminal.resize(18, 9);
    mutateTerminalWhenReady(terminal, () => mutations.push(1));
    assert.equal(capture.finishForDispose(), expected);
    assert.equal(state.syncFallbacks, 0, "unmount reuses the already scanned portion/full result");
    assert.equal(terminal.cols, 30); assert.equal(terminal.rows, 6);
    await rejected;
    while (scheduler.queue.length) scheduler.tick();
    await turn();
    terminal.write("late-output", () => acknowledgements.push(2));
    mutateTerminalWhenReady(terminal, () => mutations.push(2));
    await assert.rejects(gate.capture(() => "late", signal().signal), /disposed/);
    assert.deepEqual(acknowledgements, []); assert.deepEqual(mutations, []);
    assert.equal(mouse.serializeSnapshot(addon), expected);
  });
}

test("unmount during a tail-only capture falls back to a full synchronous picture and aborts its scan", { timeout: 3000 }, async t => {
  const state = fixture(t), { terminal, addon, mouse, capture, scheduler } = state;
  await write(terminal, "history\r\n".repeat(90));
  const expected = mouse.serializeSnapshot(addon);
  const pending = capture.capture(signal().signal, false), rejected = assert.rejects(pending, /disposed/);
  await scheduler.waitForWork();
  assert.equal(capture.finishForDispose(), expected); assert.equal(state.syncFallbacks, 1);
  await rejected;
  while (scheduler.queue.length) scheduler.tick();
});

test("aborting a sliced capture publishes no partial result and resumes queued writes, resize and the next capture", { timeout: 5000 }, async t => {
  const state = fixture(t), { terminal, addon, mouse, capture, scheduler } = state;
  await write(terminal, "history\r\n".repeat(120)); state.sequence = 1;
  const controller = signal(), pending = capture.capture(controller.signal, true);
  const rejected = assert.rejects(pending, /cancelled-by-source/);
  await scheduler.waitForWork();
  const acknowledgements = [];
  const parsed = new Promise(resolve => terminal.write("after-cancel\x1b[?1003h\x1b[?1016h", () => {
    acknowledgements.push(2); state.sequence = 2; resolve();
  }));
  terminal.resize(24, 7);
  scheduler.tick(); controller.abort(Error("cancelled-by-source"));
  assert.deepEqual(acknowledgements, []);
  await rejected; await parsed; await microtasks();
  assert.deepEqual(acknowledgements, [2]); assert.equal(terminal.cols, 24); assert.equal(terminal.rows, 7);
  while (scheduler.queue.length) scheduler.tick();
  const expected = mouse.serializeSnapshot(addon);
  const next = await scheduler.finish(capture.capture(signal().signal, true));
  assert.equal(next.serialized, expected); assert.equal(next.sequence, 2); assert.equal(next.cols, 24); assert.equal(next.rows, 7);
  assert.ok(next.snapshot.endsWith("\x1b[?1016h"));
});

for (const during of ["barrier", "scan"]) {
  test(`a streamed reset arriving during the ${during} keeps mouse reset and reset ACK after the captured picture`, { timeout: 5000 }, async t => {
    const state = fixture(t), { terminal, addon, mouse, capture, scheduler } = state;
    await write(terminal, "old-history\r\n".repeat(80) + "\x1b[?1003h\x1b[?1006h"); state.sequence = 55;
    const expected = mouse.serializeSnapshot(addon), acknowledgements = [];
    const pending = capture.capture(signal().signal, true);
    await microtasks();
    if (during === "scan") await scheduler.waitForWork();
    // The display's reset frame has no parser callback: its side effects follow
    // the patched reset as a separate gated operation, including its commit.
    terminal.resize(20, 8);
    terminal.reset();
    mutateTerminalWhenReady(terminal, () => {
      resetTerminalMouseProtocol(terminal); state.sequence = 0; acknowledgements.push("reset");
    });
    const afterReset = new Promise(resolve => terminal.write("new-stream", () => {
      state.sequence = 1; acknowledgements.push("output"); resolve();
    }));
    await scheduler.waitForWork();
    assert.equal(mouse.snapshotSuffix(), "\x1b[?1006h"); assert.equal(state.sequence, 55);
    assert.deepEqual(acknowledgements, []); assert.equal(terminal.cols, 30);
    const picture = await scheduler.finish(pending);
    assert.equal(picture.serialized, expected); assert.equal(picture.sequence, 55);
    assert.equal(picture.cols, 30); assert.equal(picture.rows, 6);
    await afterReset;
    assert.deepEqual(acknowledgements, ["reset", "output"]); assert.equal(state.sequence, 1);
    assert.equal(mouse.snapshotSuffix(), "\x1b[?1006l"); assert.equal(terminal.cols, 20);
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), "new-stream");
  });
}

function resetFixture(t) {
  let pending = false, resetReady, waits = 0;
  const state = fixture(t, {}, {
    waitForReset: async () => { waits++; if (pending) await resetReady.promise; },
    isResetPending: () => pending,
  });
  return {
    ...state,
    // Keep the fixture's accessors when observing the manager's simulated state.
    state,
    get waits() { return waits; },
    get resetPending() { return pending; },
    receiveReset() {
      state.generation++; state.sequence = 0;
      pending = true; resetReady = deferred();
    },
    async parseResetAndReplay(text) {
      state.terminal.resize(20, 8);
      state.terminal.reset();
      mutateTerminalWhenReady(state.terminal, () => {
        resetTerminalMouseProtocol(state.terminal);
        pending = false; resetReady.resolve();
      });
      await new Promise(resolve => writeTerminalReplay(state.terminal, text, () => { state.sequence = 7; resolve(); }));
    },
  };
}

for (const during of ["before-capture", "barrier", "scan"]) {
  test(`a daemon reset received ${during} waits for delayed display reset outside the gate and returns only the new stream`, { timeout: 5000 }, async t => {
    const reset = resetFixture(t), { state, terminal, gate, addon, mouse, capture, scheduler, jobs } = reset;
    await write(terminal, "old-stream\r\n".repeat(80) + "\x1b[?1003h\x1b[?1006h"); state.sequence = 55;
    if (during === "before-capture") reset.receiveReset();
    const pending = capture.capture(signal().signal, true);
    if (during === "scan") await scheduler.waitForWork();
    else await microtasks();
    if (during !== "before-capture") reset.receiveReset();
    await scheduler.until(() => reset.waits === (during === "before-capture" ? 1 : 2));
    await microtasks();
    assert.equal(reset.resetPending, true);
    assert.equal(jobs.length, during === "scan" ? 2 : 0, "pending reset never exposes old text as a current snapshot");
    let free = false;
    mutateTerminalWhenReady(terminal, () => { free = true; });
    assert.equal(free, true, "waiting for the display's delayed reset cannot hold the mutation gate");
    // Emulate the next rAF delivering a reset/replay after the manager has
    // already changed its stream generation and zeroed the watermark.
    const replay = reset.parseResetAndReplay("new-stream\x1b[?1002h\x1b[?1016h");
    const picture = await scheduler.finish(pending);
    await replay;
    assert.equal(picture.serialized, mouse.serializeSnapshot(addon));
    assert.ok(picture.serialized.includes("new-stream")); assert.ok(!picture.serialized.includes("old-stream"));
    assert.equal(picture.sequence, 7); assert.equal(picture.generation, 2);
    assert.equal(picture.cols, 20); assert.equal(picture.rows, 8);
    assert.ok(picture.snapshot.endsWith("\x1b[?1016h"));
    await gate.capture(() => "still-usable", signal().signal);
  });
}

test("two stream replacements during successive scans fail the bounded retry without publishing either stale picture", { timeout: 5000 }, async t => {
  const reset = resetFixture(t), { state, terminal, capture, scheduler, jobs } = reset;
  await write(terminal, "first-stream\r\n".repeat(80)); state.sequence = 99;
  const pending = capture.capture(signal().signal, true);
  const rejected = assert.rejects(pending, /stream changed during checkpoint capture/);
  await scheduler.waitForWork(); reset.receiveReset();
  await scheduler.until(() => reset.waits === 2); await microtasks();
  const replay = reset.parseResetAndReplay("second-stream\r\n".repeat(80));
  await scheduler.until(() => jobs.length === 3); await replay;
  reset.receiveReset();
  await scheduler.finish(rejected);
  assert.equal(reset.waits, 2, "capture retries once instead of looping during repeated resets");
  assert.equal(reset.resetPending, true);
  await reset.parseResetAndReplay("third-stream");
  assert.equal(terminal.buffer.active.getLine(0).translateToString(true), "third-stream");
});
