import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/sessionSnapshotPersistence.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("snapshots.ts", source, ts.ScriptTarget.Latest, true);
const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join("\n");
const compiled = ts.transpileModule(`${body}\nexports.tick = flushDirtySnapshots;`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const gateApi = {};
new Function("exports", ts.transpileModule(readFileSync(new URL("../src/lib/terminalMutationGate.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(gateApi);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

function harness(save = async () => {}) {
  const exports = {}, timers = new Set(), updates = [], errors = [], saves = [];
  let now = 0;
  const state = {
    sessions: [],
    updateSessionTerminalSnapshot(id, text) { updates.push({ id, text }); },
  };
  runInNewContext(compiled, {
    exports, AbortController, setTimeout, clearTimeout, queueMicrotask, Date: { now: () => now },
    useTerminalStore: { getState: () => state },
    useSessionStore: { getState: () => ({ saveSessions: async rows => { saves.push(rows); await save(rows); } }) },
    logError: (...args) => errors.push(args),
    setInterval: callback => { timers.add(callback); return callback; },
    clearInterval: timer => timers.delete(timer),
  });
  return {
    ...exports, timers, updates, errors, saves,
    advance: ms => { now += ms; },
    registerTerminalSnapshotSource(id, serialize, checkpoint) {
      return exports.registerTerminalSnapshotSource(id, async (signal, full) => {
        const capture = await serialize(signal, full);
        return typeof capture === "string"
          ? { snapshot: capture, checkpoint: full && checkpoint ? () => checkpoint(capture) : undefined }
          : capture;
      });
    },
  };
}

test("idle sources do not serialize and unregister stops the timer", async () => {
  const h = harness();
  let count = 0;
  assert.equal(h.timers.size, 0);
  const stop = h.registerTerminalSnapshotSource("a", () => { count++; return "text"; });
  assert.equal(h.timers.size, 1);
  await h.tick();
  assert.equal(count, 0);
  stop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.terminalSnapshotDiagnostics().sources, 0);
});

test("full checkpoint and independently replayable persisted tail stay separate", async () => {
  const h = harness(), checkpoints = [];
  const full = Array.from({ length: 5001 }, (_, i) => `line-${i}`).join("\n");
  const tail = full.split("\n").slice(-2000).join("\n");
  h.registerTerminalSnapshotSource("a", () => ({
    snapshot: tail, checkpoint: async () => { checkpoints.push(full); },
  }));
  h.markTerminalSnapshotDirty("a");
  await h.tick();
  assert.deepEqual(checkpoints, [full]);
  assert.equal(h.updates[0].text, full.split("\n").slice(-2000).join("\n"));
  assert.equal(h.saves.length, 1);
});

test("slow serialization coalesces periodic ticks and preserves newly dirty output", async () => {
  const h = harness(), wait = deferred();
  let count = 0;
  h.registerTerminalSnapshotSource("a", () => { count++; return count === 1 ? wait.promise : "latest"; });
  h.markTerminalSnapshotDirty("a");
  const first = h.tick();
  await settle();
  const ticks = Array.from({ length: 20 }, () => h.tick());
  h.markTerminalSnapshotDirty("a");
  await settle();
  assert.equal(count, 1);
  assert.equal(h.terminalSnapshotDiagnostics().flushing, true);
  wait.resolve("first");
  await Promise.all([first, ...ticks]);
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 1);
  await h.tick();
  assert.equal(count, 2);
  assert.equal(h.updates.at(-1).text, "latest");
});

test("exit/handoff during a periodic flush waits for a fresh forced pass", async () => {
  const h = harness(), firstBarrier = deferred(), secondBarrier = deferred();
  let count = 0, completed = false;
  h.registerTerminalSnapshotSource("a", () => ++count === 1 ? firstBarrier.promise : secondBarrier.promise);
  h.markTerminalSnapshotDirty("a");
  const tick = h.tick();
  await settle();
  const force = h.flushTerminalSnapshotsNow().then(() => { completed = true; });
  const duplicate = h.flushTerminalSnapshotsNow();
  firstBarrier.resolve("before-exit");
  await settle();
  assert.equal(count, 2);
  assert.equal(completed, false);
  secondBarrier.resolve("final");
  await Promise.all([tick, force, duplicate]);
  assert.equal(h.updates.at(-1).text, "final");
  assert.equal(count, 2);
  assert.equal(h.terminalSnapshotDiagnostics().flushing, false);
});

test("a force request before the queued flush starts is not lost", async () => {
  const h = harness();
  let count = 0;
  h.registerTerminalSnapshotSource("clean", () => { count++; return "final"; });
  await Promise.all([h.tick(), h.flushTerminalSnapshotsNow()]);
  assert.equal(count, 1);
});

test("force requests at every microtask boundary cannot miss the final state", async () => {
  for (let offset = 0; offset < 24; offset++) {
    const h = harness();
    let text = "before";
    h.registerTerminalSnapshotSource("a", () => text);
    h.markTerminalSnapshotDirty("a");
    const initial = h.tick();
    for (let turn = 0; turn < offset; turn++) await Promise.resolve();
    text = "final";
    await Promise.all([initial, h.flushTerminalSnapshotsNow()]);
    assert.equal(h.updates.at(-1).text, "final", `arrival at microtask ${offset}`);
  }
});

test("source replacement and old cleanup cannot delete or publish over the new source", async () => {
  const h = harness(), wait = deferred(), checkpoints = [];
  const oldStop = h.registerTerminalSnapshotSource("same", () => wait.promise, async () => checkpoints.push("old"));
  h.markTerminalSnapshotDirty("same");
  const tick = h.tick();
  await settle();
  const newStop = h.registerTerminalSnapshotSource("same", () => "new");
  oldStop();
  assert.equal(h.terminalSnapshotDiagnostics().sources, 1);
  wait.resolve("old");
  await tick;
  assert.deepEqual(checkpoints, []);
  assert.equal(h.updates.length, 0);
  await h.flushTerminalSnapshotsNow();
  assert.equal(h.updates[0].text, "new");
  newStop();
  assert.equal(h.timers.size, 0);
});

test("closing during checkpoint skips stale store updates and proceeds to the next terminal", async () => {
  const h = harness(), wait = deferred();
  const stop = h.registerTerminalSnapshotSource("closed", () => "stale", () => wait.promise);
  h.registerTerminalSnapshotSource("live", () => "current");
  const flush = h.flushTerminalSnapshotsNow();
  await settle();
  stop();
  wait.resolve();
  await flush;
  assert.deepEqual(h.updates.map(item => item.id), ["live"]);
});

test("serialization and checkpoint failures retry without blocking other terminals", async () => {
  const h = harness();
  let serializeCount = 0, checkpointCount = 0;
  h.registerTerminalSnapshotSource("serialize", () => {
    if (++serializeCount === 1) throw new Error("serialize failed");
    return "ok";
  });
  h.registerTerminalSnapshotSource("checkpoint", () => "ok", async () => {
    if (++checkpointCount === 1) throw new Error("checkpoint failed");
  });
  await h.flushTerminalSnapshotsNow();
  assert.equal(h.errors.length, 2);
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 2);
  await h.tick();
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 0);
  assert.equal(serializeCount, 2);
  assert.equal(checkpointCount, 2);
});

test("persistence failures mark saved sources dirty and retry without requiring new output", async () => {
  let attempts = 0;
  const h = harness(async () => { if (++attempts === 1) throw new Error("disk failed"); });
  h.registerTerminalSnapshotSource("a", () => "data");
  await h.flushTerminalSnapshotsNow();
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 1);
  await h.tick();
  assert.equal(attempts, 2);
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 0);
});

test("disposed xterm write barriers cancel, release the flight, and ignore late callbacks", async () => {
  const h = harness();
  let callback, serialized = 0;
  const gate = gateApi.installTerminalMutationGate({
    write: (_text, done) => { callback = done; }, resize() {}, reset() {}, clear() {},
  });
  const stop = h.registerTerminalSnapshotSource("a", signal => gate.capture(
    () => { serialized++; return "old"; }, signal,
  ));
  const flight = h.flushTerminalSnapshotsNow();
  await settle();
  stop();
  await flight;
  callback();
  assert.equal(serialized, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.terminalSnapshotDiagnostics().flushing, false);
  h.registerTerminalSnapshotSource("next", () => "next");
  await h.flushTerminalSnapshotsNow();
  assert.equal(h.updates[0].text, "next");
});

test("routine saves scan tails while full checkpoints follow a separate cadence, including quiet buffers", async () => {
  const h = harness(), requests = [], checkpoints = [];
  h.registerTerminalSnapshotSource("local", (_signal, full) => {
    requests.push(full);
    return { snapshot: "tail", checkpoint: full ? async () => { checkpoints.push("complete"); } : undefined };
  });
  h.markTerminalSnapshotDirty("local");
  await h.tick();
  for (let tick = 1; tick <= 5; tick++) {
    h.advance(10_000);
    h.markTerminalSnapshotDirty("local");
    await h.tick();
  }
  assert.deepEqual(requests, [true, false, false, false, false, false]);
  h.advance(10_000);
  await h.tick();
  assert.equal(requests.at(-1), true, "a persisted tail must not hide an overdue full checkpoint");
  assert.equal(checkpoints.length, 2);
  await h.flushTerminalSnapshotsNow();
  assert.equal(requests.at(-1), true);
  assert.equal(checkpoints.length, 3, "exit captures even an otherwise clean/hidden terminal");
});

test("byte threshold triggers a full checkpoint without waiting for the periodic timer", async () => {
  const h = harness(), requests = [];
  let resolveCheckpoint;
  const uploaded = new Promise(resolve => { resolveCheckpoint = resolve; });
  const stop = h.registerTerminalSnapshotSource("ssh", (_signal, full) => {
    requests.push(full);
    return { snapshot: "tail", checkpoint: full ? async () => resolveCheckpoint() : undefined };
  });
  h.markTerminalSnapshotDirty("ssh", 4 * 1024 * 1024);
  await uploaded;
  await settle();
  assert.deepEqual(requests, [true]);
  assert.equal(h.saves.length, 1);
  stop();
});

test("bytes crossing the threshold during upload trigger a second complete capture", async () => {
  const h = harness(), first = deferred(), second = deferred();
  let captures = 0;
  const stop = h.registerTerminalSnapshotSource("wsl", () => ({
    snapshot: `capture-${++captures}`,
    checkpoint: async () => { if (captures === 1) await first.promise; else second.resolve(); },
  }));
  h.markTerminalSnapshotDirty("wsl", 4 * 1024 * 1024);
  await new Promise(resolve => setTimeout(resolve, 0));
  h.markTerminalSnapshotDirty("wsl", 4 * 1024 * 1024);
  first.resolve();
  await second.promise;
  await settle();
  assert.equal(captures, 2);
  stop();
});

test("output committed while persistence is pending stays dirty after that save", async () => {
  const saved = deferred(), h = harness(() => saved.promise);
  h.registerTerminalSnapshotSource("pane", () => "picture");
  h.markTerminalSnapshotDirty("pane");
  const tick = h.tick();
  await settle();
  h.markTerminalSnapshotDirty("pane");
  saved.resolve();
  await tick;
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 1);
  await h.tick();
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 0);
});

test("failed early checkpoints back off to the normal retry rather than spinning timers", async () => {
  const h = harness();
  let attempts = 0;
  const stop = h.registerTerminalSnapshotSource("offline", () => ({
    snapshot: "saved tail",
    checkpoint: async () => { attempts++; throw new Error("offline"); },
  }));
  h.markTerminalSnapshotDirty("offline", 4 * 1024 * 1024);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(attempts, 1);
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 1);
  await h.tick();
  assert.equal(attempts, 2);
  stop();
});

test("multi-terminal saves give rendering/input a task between complete captures", async () => {
  const h = harness(), order = [];
  h.registerTerminalSnapshotSource("one", () => { order.push("one"); return "one"; });
  h.registerTerminalSnapshotSource("two", () => { order.push("two"); return "two"; });
  setTimeout(() => order.push("input"), 0);
  await h.flushTerminalSnapshotsNow();
  assert.deepEqual(order, ["one", "input", "two"]);
});

test("a reset invalidating a completed capture skips upload and local publication, then retries", async () => {
  const h = harness();
  let valid = false, uploaded = 0;
  h.registerTerminalSnapshotSource("reset", () => ({
    snapshot: valid ? "current" : "stale",
    isCurrent: () => valid,
    checkpoint: async () => { uploaded++; },
  }));
  h.markTerminalSnapshotDirty("reset");
  await h.tick();
  assert.equal(uploaded, 0);
  assert.deepEqual(h.updates, []);
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 1);
  valid = true;
  await h.tick();
  assert.equal(uploaded, 1);
  assert.equal(h.updates.at(-1).text, "current");
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 0);
});

test("a stream changed while uploading cannot publish its stale snapshot or consume the retry", async () => {
  const h = harness(), upload = deferred();
  let generation = 1, captures = 0;
  h.registerTerminalSnapshotSource("reset", () => {
    const capturedGeneration = generation;
    const first = captures++ === 0;
    return {
      snapshot: `picture-${capturedGeneration}`,
      isCurrent: () => capturedGeneration === generation,
      checkpoint: first ? () => upload.promise : async () => {},
    };
  });
  h.markTerminalSnapshotDirty("reset");
  const flight = h.tick();
  await settle();
  generation++;
  h.markTerminalSnapshotDirty("reset");
  upload.resolve();
  await flight;
  assert.deepEqual(h.updates, []);
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 1);
  await h.tick();
  assert.equal(captures, 2);
  assert.equal(h.updates.at(-1).text, "picture-2");
  assert.equal(h.terminalSnapshotDiagnostics().dirtySources, 0);
});
