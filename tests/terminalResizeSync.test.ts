import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTerminalResizeSync,
  PTY_RESIZE_GROW_DELAY_MS,
  PTY_RESIZE_INPUT_IDLE_MS,
  PTY_RESIZE_PASTE_IDLE_MS,
  PTY_RESIZE_SHRINK_DELAY_MS,
  type TerminalResizeLogEvent,
} from "../src/lib/terminalResizeSync.ts";

type Timer = {
  id: number;
  dueAt: number;
  callback: () => void;
};

const createFakeClock = () => {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, Timer>();

  const runDueTimers = () => {
    let ran = true;
    while (ran) {
      ran = false;
      const due = [...timers.values()]
        .filter((timer) => timer.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
      for (const timer of due) {
        if (!timers.delete(timer.id)) continue;
        timer.callback();
        ran = true;
      }
    }
  };

  return {
    now: () => now,
    setTimeout: (callback: () => void, delayMs: number) => {
      const id = nextId;
      nextId += 1;
      timers.set(id, { id, dueAt: now + delayMs, callback });
      return id;
    },
    clearTimeout: (id: number) => {
      timers.delete(id);
    },
    advance: (ms: number) => {
      now += ms;
      runDueTimers();
    },
    timerCount: () => timers.size,
  };
};

describe("terminal resize sync", () => {
  it("debounces growth and emits the latest dimensions once", () => {
    const clock = createFakeClock();
    const emitted: Array<{ cols: number; rows: number }> = [];
    const controller = createTerminalResizeSync({
      sessionId: "s1",
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      emitResize: (dims) => emitted.push(dims),
      log: () => {},
    });

    controller.requestResize({ cols: 100, rows: 30 });
    controller.requestResize({ cols: 110, rows: 31 });
    clock.advance(PTY_RESIZE_GROW_DELAY_MS - 1);
    assert.deepEqual(emitted, []);

    clock.advance(1);
    assert.deepEqual(emitted, [{ cols: 110, rows: 31 }]);
  });

  it("defers shrink and cancels it when size returns before the guard expires", () => {
    const clock = createFakeClock();
    const emitted: Array<{ cols: number; rows: number }> = [];
    const logs: TerminalResizeLogEvent[] = [];
    const controller = createTerminalResizeSync({
      sessionId: "s1",
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      emitResize: (dims) => emitted.push(dims),
      log: (event) => logs.push(event),
    });

    controller.requestResize({ cols: 111, rows: 43 });
    clock.advance(PTY_RESIZE_GROW_DELAY_MS);
    assert.deepEqual(emitted, [{ cols: 111, rows: 43 }]);

    controller.requestResize({ cols: 63, rows: 43 });
    clock.advance(PTY_RESIZE_SHRINK_DELAY_MS - 1);
    assert.deepEqual(emitted, [{ cols: 111, rows: 43 }]);

    controller.requestResize({ cols: 111, rows: 43 });
    clock.advance(PTY_RESIZE_GROW_DELAY_MS);
    assert.deepEqual(emitted, [{ cols: 111, rows: 43 }]);
    assert(logs.some((event) => event.kind === "resize_skipped" && event.reason === "duplicate"));
  });

  it("keeps shrink pending while paste/input is active", () => {
    const clock = createFakeClock();
    const emitted: Array<{ cols: number; rows: number }> = [];
    const controller = createTerminalResizeSync({
      sessionId: "s1",
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      emitResize: (dims) => emitted.push(dims),
      log: () => {},
    });

    controller.requestResize({ cols: 111, rows: 43 });
    clock.advance(PTY_RESIZE_GROW_DELAY_MS);
    controller.requestResize({ cols: 63, rows: 43 });
    clock.advance(PTY_RESIZE_SHRINK_DELAY_MS - PTY_RESIZE_PASTE_IDLE_MS / 2);

    controller.noteInput("paste");
    clock.advance(PTY_RESIZE_PASTE_IDLE_MS - 1);
    assert.deepEqual(emitted, [{ cols: 111, rows: 43 }]);

    controller.noteInput("input");
    clock.advance(PTY_RESIZE_INPUT_IDLE_MS - 1);
    assert.deepEqual(emitted, [{ cols: 111, rows: 43 }]);
  });

  it("disposes pending timers without emitting", () => {
    const clock = createFakeClock();
    const emitted: Array<{ cols: number; rows: number }> = [];
    const controller = createTerminalResizeSync({
      sessionId: "s1",
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      emitResize: (dims) => emitted.push(dims),
      log: () => {},
    });

    controller.requestResize({ cols: 90, rows: 24 });
    assert.equal(clock.timerCount(), 1);
    controller.dispose();
    clock.advance(PTY_RESIZE_GROW_DELAY_MS);
    assert.deepEqual(emitted, []);
    assert.equal(clock.timerCount(), 0);
  });
});
