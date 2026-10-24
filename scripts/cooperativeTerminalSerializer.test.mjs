import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
const compiled = ts.transpileModule(
  readFileSync(new URL("../src/lib/cooperativeTerminalSerializer.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const api = {};
new Function("exports", compiled)(api);
const { createTerminalSerialization } = api;
const write = (terminal, text) => new Promise(resolve => terminal.write(text, resolve));
function setup(t, options = {}) {
  const terminal = new Terminal({ cols: 40, rows: 8, scrollback: 400, allowProposedApi: true, ...options });
  const addon = new SerializeAddon();
  terminal.loadAddon(addon);
  t.after(() => terminal.dispose());
  return { terminal, addon };
}
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
  };
}

test("copied state machine stays pinned to the reviewed xterm/addon versions", () => {
  assert.equal(require("@xterm/xterm/package.json").version, "6.1.0-beta.288");
  assert.equal(require("@xterm/addon-serialize/package.json").version, "0.15.0-beta.288");
});

const cases = [
  ["empty buffer", ""],
  ["wrapped ASCII and CJK", "abc界中文😀e\u0301".repeat(200)],
  ["colors, flags, underline variants and current attributes", "plain\x1b[31;44;1;2;3;4;5;7;8;9;53mstyled\x1b[0m\r\n\x1b[38;2;1;2;3;48;5;199mRGB/palette\x1b[4:3;58:2::30:40:50m波浪\x1b[4:2;58:5:9m双线\x1b[0m\r\n\x1b[35;46m"],
  ["BCE empty cells, erasure and cursor fixup", "\x1b[41m\x1b[2J\x1b[Habc\x1b[5Cdef\r\n\x1b[42m\x1b[Kxyz\x1b[0m\x1b[4;17H"],
  ["alternate screen and saved normal cursor", "history\r\n".repeat(100) + "\x1b[32mnormal\x1b[?1049h\x1b[H\x1b[34malternate界\x1b[4;15H\x1b[43m "],
  ["modes and nondefault scrolling region", "history\r\n".repeat(15) + "\x1b[2;7r\x1b[?1;66;2004;6;45;1004;1003h\x1b[4h\x1b[?7;25l"],
];
for (const [name, payload] of cases) {
  test(`byte-identical to pinned upstream: ${name}`, async t => {
    const { terminal, addon } = setup(t);
    await write(terminal, payload);
    for (const options of [undefined, { scrollback: 0 }, { scrollback: 3 }, { excludeAltBuffer: true }, { excludeModes: true }, { range: { start: 0, end: 5 } }, { range: { start: { line: 1 }, end: { line: 4 } } }]) {
      const expected = addon.serialize(options);
      assert.equal(await createTerminalSerialization(terminal, options).run(), expected);
      assert.equal(createTerminalSerialization(terminal, options).finishSync(), expected);
    }
  });
}

test("each mouse tracking mode is identical to upstream", async t => {
  for (const code of [9, 1000, 1002, 1003]) {
    const { terminal, addon } = setup(t);
    await write(terminal, `mouse\x1b[?${code}h\x1b[?1006h`);
    assert.equal(await createTerminalSerialization(terminal).run(), addon.serialize());
  }
});

test("Unicode 11 / grapheme cells and resize reflow retain upstream output", async t => {
  const { terminal, addon } = setup(t, { cols: 21 });
  // Match the WebView's atob path. The beta addon's Node Buffer decoder ignores
  // pooled buffers' byteOffset on some supported Node versions.
  const browserUnicodeAddon = { exports: {} };
  new Function("module", "exports", "Buffer", readFileSync(require.resolve("@xterm/addon-unicode-graphemes"), "utf8"))(
    browserUnicodeAddon, browserUnicodeAddon.exports, undefined,
  );
  const { UnicodeGraphemesAddon } = browserUnicodeAddon.exports;
  terminal.loadAddon(new UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = "15-graphemes";
  await write(terminal, "中e\u0301👩‍💻🏳️‍🌈👨‍👩‍👧‍👦".repeat(60));
  terminal.resize(13, 11);
  assert.equal(await createTerminalSerialization(terminal).run(), addon.serialize());
});

test("seeded cursor/edit/wrap combinations match original state machine", async t => {
  let seed = 0x2468abcd;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let round = 0; round < 12; round++) {
    const { terminal, addon } = setup(t, { cols: 17 + round, rows: 6 + round % 3 });
    const fragments = ["中文😀e\u0301", " abcdefghijklmnop ", "\r\n", "\r", "\n", "\x1b[2K", "\x1b[K", "\x1b[3C", "\x1b[2D", "\x1b[1A", "\x1b[2B", "\x1b[2P", "\x1b[3@", "\x1b[31;44m", "\x1b[0m", "\x1b[4:3;58:5:7m"];
    let payload = "";
    for (let i = 0; i < 500; i++) payload += fragments[next() % fragments.length];
    await write(terminal, payload);
    assert.equal(await createTerminalSerialization(terminal).run(), addon.serialize(), `seeded round ${round}`);
  }
});

test("very wide rows and final assembly yield without changing ANSI", async t => {
  const { terminal, addon } = setup(t, { cols: 1024, rows: 8 });
  await write(terminal, "\x1b[32m" + "界abc".repeat(4000));
  const scheduler = manualScheduler();
  const job = createTerminalSerialization(terminal, undefined, scheduler.options);
  const result = job.run();
  let ticks = 0;
  while (scheduler.queue.length) { scheduler.tick(); ticks++; }
  assert.ok(ticks > terminal.buffer.normal.length * 3, "wide rows split at 256 cells");
  assert.equal(await result, addon.serialize());
});

test("finishSync resumes the existing scan, resolves run and cancels its scheduled task", async t => {
  const { terminal, addon } = setup(t);
  await write(terminal, "\x1b[32m中文 output\x1b[0m\r\n".repeat(250));
  const prototype = Object.getPrototypeOf(terminal.buffer.normal.getLine(0));
  const getCell = prototype.getCell;
  let cells = 0;
  prototype.getCell = function(...args) { cells++; return getCell.apply(this, args); };
  t.after(() => { prototype.getCell = getCell; });
  const expected = addon.serialize();
  const originalCells = cells;
  cells = 0;
  const scheduler = manualScheduler();
  const controller = new AbortController();
  const job = createTerminalSerialization(terminal, undefined, scheduler.options);
  const running = job.run(controller.signal);
  assert.strictEqual(job.run(controller.signal), running);
  scheduler.tick(); scheduler.tick();
  assert.ok(cells > 0 && cells < originalCells);
  assert.equal(job.finishSync(), expected);
  assert.equal(cells, originalCells, "all previously scanned cells are reused");
  controller.abort();
  while (scheduler.queue.length) scheduler.tick();
  assert.equal(await running, expected);
  assert.equal(job.finishSync(), expected);
  assert.equal(cells, originalCells);
});

test("finishSync before run caches a result including the empty string", async t => {
  const { terminal, addon } = setup(t);
  const job = createTerminalSerialization(terminal);
  const expected = addon.serialize();
  assert.equal(job.finishSync(), expected);
  assert.equal(await job.run(), expected);
});

test("abort stops queued scans, rejects immediately and cannot publish a partial snapshot", async t => {
  const { terminal } = setup(t);
  await write(terminal, "history\r\n".repeat(200));
  const scheduler = manualScheduler();
  const controller = new AbortController();
  const job = createTerminalSerialization(terminal, undefined, scheduler.options);
  const running = job.run(controller.signal);
  const rejected = assert.rejects(running, { name: "AbortError" });
  scheduler.tick();
  const scheduledBeforeAbort = scheduler.scheduled;
  controller.abort();
  await rejected;
  while (scheduler.queue.length) scheduler.tick();
  assert.equal(scheduler.scheduled, scheduledBeforeAbort);
  assert.throws(() => job.finishSync(), { name: "AbortError" });
});

test("an already aborted signal does not scan any cells", async t => {
  const { terminal } = setup(t);
  const controller = new AbortController();
  controller.abort();
  const scheduler = manualScheduler();
  await assert.rejects(createTerminalSerialization(terminal, undefined, scheduler.options).run(controller.signal), { name: "AbortError" });
  assert.equal(scheduler.scheduled, 0);
});

test("a serializer failure rejects, cancels pending work and makes sync finish fail too", async t => {
  const { terminal } = setup(t);
  const buffer = terminal.buffer.normal;
  buffer.getLine = () => { throw new Error("read failed"); };
  const job = createTerminalSerialization(terminal);
  await assert.rejects(job.run(), /read failed/);
  assert.throws(() => job.finishSync(), /read failed/);
});

test("default scheduling permits a timer while scanning a large terminal", async t => {
  const { terminal, addon } = setup(t, { scrollback: 5000, cols: 120, rows: 32 });
  await write(terminal, "output 界".repeat(10).concat("\r\n").repeat(5000));
  let completed = false;
  const timer = new Promise(resolve => setTimeout(() => resolve(!completed), 0));
  const result = createTerminalSerialization(terminal).run().then(value => { completed = true; return value; });
  assert.equal(await timer, true, "serialization must yield to an independent event-loop task");
  assert.equal(await result, addon.serialize());
});
