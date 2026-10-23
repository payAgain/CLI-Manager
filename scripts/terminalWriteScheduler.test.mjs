import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/terminal/browser/TerminalWriteScheduler.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
runInNewContext(compiled, { exports });
const { TerminalWriteScheduler } = exports;

function harness() {
  let now = 0, nextId = 0, hidden = false;
  const frames = new Map(), timers = new Map();
  const scheduler = new TerminalWriteScheduler({
    requestFrame: callback => { const id = ++nextId; frames.set(id, callback); return id; },
    cancelFrame: id => frames.delete(id),
    setTimer: (callback, delay) => { const id = ++nextId; timers.set(id, { callback, due: now + delay }); return id; },
    clearTimer: id => timers.delete(id),
    now: () => now,
    isDocumentHidden: () => hidden,
  });
  return {
    scheduler, frames, timers,
    setHidden: value => { hidden = value; },
    spend: ms => { now += ms; },
    frame() {
      now += 1000 / 60;
      for (const [id, callback] of [...frames]) {
        if (!frames.delete(id)) continue;
        callback();
      }
    },
    timer() {
      const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      assert.ok(next, "expected a timer wakeup");
      const [id, { callback, due }] = next;
      timers.delete(id);
      now = due;
      callback();
    },
  };
}

test("four split panes can consume pending output in the same animation frame", () => {
  const h = harness(), writes = [];
  for (let i = 0; i < 4; i++) h.scheduler.request({ token: Symbol(), isVisible: () => true, flush: () => writes.push(i) });
  h.frame();
  assert.deepEqual(writes, [0, 1, 2, 3]);
  assert.equal(h.frames.size, 0);
  assert.equal(h.timers.size, 0);
});

test("a burst across twenty panes yields between bounded groups of writes", () => {
  const h = harness(), writes = [];
  for (let i = 0; i < 20; i++) h.scheduler.request({ token: Symbol(), isVisible: () => true, flush: () => writes.push(i) });
  for (let i = 1; i <= 5; i++) {
    h.frame();
    assert.equal(writes.length, i * 4);
  }
  assert.deepEqual(writes, Array.from({ length: 20 }, (_, i) => i));
  assert.equal(h.timers.size, 0);
});

test("expensive dispatch work yields when the frame budget is exhausted", () => {
  const h = harness(), writes = [];
  for (let i = 0; i < 4; i++) h.scheduler.request({
    token: Symbol(), isVisible: () => true,
    flush: () => { writes.push(i); h.spend(4); },
  });
  h.frame();
  assert.deepEqual(writes, [0]);
  h.frame();
  assert.deepEqual(writes, [0, 1]);
});

test("synchronous reset/no-op callbacks cannot dispatch the same terminal twice in a frame", () => {
  const h = harness(), writes = [];
  const entry = { token: Symbol(), isVisible: () => true, flush: () => { writes.push("again"); h.scheduler.request(entry); } };
  h.scheduler.request(entry);
  h.frame();
  assert.deepEqual(writes, ["again"]);
  assert.equal(h.frames.size, 1);
  h.frame();
  assert.deepEqual(writes, ["again", "again"]);
  h.scheduler.cancel(entry.token);
  assert.equal(h.frames.size + h.timers.size, 0);
});

test("continuous foreground and background output both make fair progress", () => {
  const h = harness(), writes = [];
  for (let i = 0; i < 20; i++) {
    const entry = {
      token: Symbol(), isVisible: () => i < 4,
      flush: () => { writes.push(i); h.scheduler.request(entry); },
    };
    h.scheduler.request(entry);
  }
  for (let i = 0; i < 16; i++) h.frame();
  assert.deepEqual(writes.slice(0, 4), [0, 1, 2, 4]);
  for (let i = 0; i < 4; i++) assert.equal(writes.filter(id => id === i).length, 12);
  for (let i = 4; i < 20; i++) assert.equal(writes.filter(id => id === i).length, 1);
});

test("document hiding and suspended rAF keep acknowledgements moving at one write per timer", () => {
  for (const hidden of [false, true]) {
    const h = harness(), writes = [];
    h.setHidden(hidden);
    for (let i = 0; i < 8; i++) h.scheduler.request({ token: Symbol(), isVisible: () => true, flush: () => writes.push(i) });
    const staleFrame = [...h.frames.keys()][0];
    h.timer();
    assert.deepEqual(writes, [0]);
    if (staleFrame !== undefined) assert.equal(h.frames.has(staleFrame), false);
    h.timer();
    assert.deepEqual(writes, [0, 1]);
    if (hidden) assert.equal(h.frames.size, 0);
    h.setHidden(false);
    h.timer();
    assert.deepEqual(writes, [0, 1, 2]);
    h.frame();
    assert.deepEqual(writes, [0, 1, 2, 3, 4, 5, 6]);
    h.frame();
    assert.deepEqual(writes, [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.equal(h.frames.size + h.timers.size, 0);
  }
});

test("visibility is checked at dispatch and a cancelled terminal never writes", () => {
  const h = harness(), writes = [];
  let visible = false;
  const token = Symbol();
  h.scheduler.request({ token, isVisible: () => visible, flush: () => writes.push("cancelled") });
  h.scheduler.request({ token: Symbol(), isVisible: () => visible, flush: () => writes.push("now-visible") });
  h.scheduler.cancel(token);
  visible = true;
  h.frame();
  assert.deepEqual(writes, ["now-visible"]);
});

test("replacing a pending token does not duplicate work or leave timer handles after cancellation", () => {
  const h = harness(), token = Symbol(), writes = [];
  h.scheduler.request({ token, isVisible: () => true, flush: () => writes.push("old") });
  h.scheduler.request({ token, isVisible: () => true, flush: () => writes.push("new") });
  h.frame();
  assert.deepEqual(writes, ["new"]);
  h.scheduler.request({ token, isVisible: () => true, flush: () => writes.push("cancelled") });
  h.scheduler.cancel(token);
  assert.equal(h.frames.size + h.timers.size, 0);
});
