import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-process-manager-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

writeFileSync(join(tempDir, "tauriCore.mjs"), `
let preparedCreate;
export function prepareCreate(value) { preparedCreate = value; }
export async function invoke(command) {
  if (command === "pty_prepare_create" && preparedCreate) {
    const result = preparedCreate;
    preparedCreate = undefined;
    return result;
  }
  throw new Error("unused invoke");
}
`);
writeFileSync(join(tempDir, "resourceDiagnosticsLog.mjs"), `
export const entries = [];
export function writeResourceDiagnostic(level, source, event, payload) {
  entries.push({ level, source, event, payload });
}
`);
writeFileSync(join(tempDir, "capabilities.mjs"), `
export class TerminalCapabilityStore {
  clear() {}
}
`);
writeFileSync(join(tempDir, "ptyHostSocket.mjs"), `
const listeners = new Map();
export const acknowledgments = [];
export const terminalColorUpdates = [];
export const checkpoints = [];
export const checkpointValidityChecks = [];
export const ptyHostSocket = {
  async connect() {},
  resetAfterDaemonRestart() {},
  subscribeOutput(sessionId, listener) {
    listeners.set(sessionId, listener);
    return () => listeners.delete(sessionId);
  },
  subscribeStatus() { return () => {}; },
  acknowledge(sessionId, sequence, charCount) {
    acknowledgments.push({ sessionId, sequence, charCount });
  },
  async close() {},
  async closeAll() {},
  async write() {},
  getLatestCommittedSequence() { return 0; },
  async checkpoint(sessionId, sequence, cols, rows, serializedState, isCurrent) {
    checkpointValidityChecks.push(isCurrent);
    checkpoints.push({ sessionId, sequence, cols, rows, serializedState });
  },
  async resize() {},
  async setTerminalColors(sessionId, colors) { terminalColorUpdates.push({ sessionId, colors }); },
  async attach() { return { attached: false, alive: false, replay: [] }; },
  async create() {},
};
export function emitOutput(sessionId, frame) {
  listeners.get(sessionId)?.(frame);
}
`);

const source = readFileSync(new URL("../src/terminal/core/TerminalProcessManager.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "TerminalProcessManager.ts",
}).outputText
  .replace('from "@tauri-apps/api/core"', 'from "./tauriCore.mjs"')
  .replace('from "../../lib/resourceDiagnosticsLog"', 'from "./resourceDiagnosticsLog.mjs"')
  .replace('from "../capabilities/TerminalCapabilityStore"', 'from "./capabilities.mjs"')
  .replace('from "../transport/PtyHostSocket"', 'from "./ptyHostSocket.mjs"');
const managerPath = join(tempDir, "TerminalProcessManager.mjs");
writeFileSync(managerPath, transpiled, "utf8");

const { TerminalProcessManager } = await import(pathToFileURL(managerPath).href);
const tauriStub = await import(pathToFileURL(join(tempDir, "tauriCore.mjs")).href);
const socketStub = await import(pathToFileURL(join(tempDir, "ptyHostSocket.mjs")).href);
const resourceLogStub = await import(pathToFileURL(join(tempDir, "resourceDiagnosticsLog.mjs")).href);

function frame(sequence, text) {
  return {
    kind: "output",
    sessionId: "session-1",
    sequence,
    cols: 80,
    rows: 24,
    data: new TextEncoder().encode(text),
  };
}

test("same-process snapshots are consumed once and stay isolated by session", async () => {
  const manager = new TerminalProcessManager();
  const snapshot = { cols: 178, rows: 36, serializedState: "prompt" };
  manager.saveDisplaySnapshot("project-a", snapshot);
  manager.saveDisplaySnapshot("project-b", { ...snapshot, serializedState: "other prompt" });
  assert.equal(manager.takeDisplaySnapshot("fresh-shell"), undefined);
  assert.deepEqual(manager.takeDisplaySnapshot("project-a"), snapshot);
  assert.equal(manager.takeDisplaySnapshot("project-a"), undefined);
  await manager.close("project-b");
  assert.equal(manager.takeDisplaySnapshot("project-b"), undefined);
  manager.saveDisplaySnapshot("project-c", snapshot);
  await manager.closeAll();
  assert.equal(manager.takeDisplaySnapshot("project-c"), undefined);
});

test("uncommitted output is redelivered after display remount and ACKed once", async () => {
  const manager = new TerminalProcessManager();
  const firstDeliveries = [];
  const disposeFirst = await manager.subscribeOutput("session-1", (delivery) => firstDeliveries.push(delivery));
  socketStub.emitOutput("session-1", frame(1, "hello"));
  assert.equal(firstDeliveries.length, 1);

  disposeFirst();
  const secondDeliveries = [];
  await manager.subscribeOutput("session-1", (delivery) => secondDeliveries.push(delivery));
  assert.equal(secondDeliveries.length, 1);
  secondDeliveries[0].commit(5);

  assert.deepEqual(socketStub.acknowledgments, [
    { sessionId: "session-1", sequence: 1, charCount: 5 },
  ]);
  socketStub.emitOutput("session-1", frame(1, "hello"));
  assert.equal(secondDeliveries.length, 1);
});

test("committed output is not redelivered after display remount", async () => {
  const manager = new TerminalProcessManager();
  const firstDeliveries = [];
  const disposeFirst = await manager.subscribeOutput("session-committed", (delivery) => firstDeliveries.push(delivery));
  socketStub.emitOutput("session-committed", {
    ...frame(1, "committed"),
    sessionId: "session-committed",
  });
  firstDeliveries[0].commit("committed".length);
  disposeFirst();

  const secondDeliveries = [];
  await manager.subscribeOutput("session-committed", (delivery) => secondDeliveries.push(delivery));
  assert.equal(secondDeliveries.length, 0);
});

test("out-of-order write callbacks drain and ACK frames in sequence order", async () => {
  socketStub.acknowledgments.length = 0;
  const manager = new TerminalProcessManager();
  const deliveries = [];
  await manager.subscribeOutput("session-1", (delivery) => deliveries.push(delivery));
  socketStub.emitOutput("session-1", frame(2, "two"));
  socketStub.emitOutput("session-1", frame(3, "three"));

  deliveries[1].commit(5);
  assert.deepEqual(socketStub.acknowledgments, []);
  deliveries[0].commit(3);
  assert.deepEqual(socketStub.acknowledgments, [
    { sessionId: "session-1", sequence: 2, charCount: 3 },
    { sessionId: "session-1", sequence: 3, charCount: 5 },
  ]);
});

test("diagnostics track queued bytes and clear them after commit", async () => {
  const manager = new TerminalProcessManager();
  const deliveries = [];
  const dispose = await manager.subscribeOutput("session-diagnostics", (delivery) => deliveries.push(delivery));
  socketStub.emitOutput("session-diagnostics", {
    ...frame(10, "diagnostic-output"),
    sessionId: "session-diagnostics",
  });

  assert.deepEqual(manager.diagnosticsSnapshot(), {
    trackedSessions: 1,
    sessionsWithConsumers: 1,
    queuedFrames: 1,
    queuedBytes: "diagnostic-output".length,
    committedFrames: 0,
    topBacklogs: [{
      sessionId: "session-diagnostics",
      consumerAttached: true,
      queuedFrames: 1,
      queuedBytes: "diagnostic-output".length,
      committedFrames: 0,
      deliveredFrames: 1,
    }],
  });

  deliveries[0].commit("diagnostic-output".length);
  assert.equal(manager.diagnosticsSnapshot().queuedBytes, 0);
  assert.equal(manager.diagnosticsSnapshot().queuedFrames, 0);
  dispose();
  assert.equal(manager.diagnosticsSnapshot().sessionsWithConsumers, 0);
  await manager.close("session-diagnostics");
  assert.equal(manager.diagnosticsSnapshot().trackedSessions, 0);
});

test("reset replaces prior diagnostics backlog", async () => {
  const manager = new TerminalProcessManager();
  await manager.subscribeOutput("session-reset", () => {});
  socketStub.emitOutput("session-reset", {
    ...frame(1, "stale-output"),
    sessionId: "session-reset",
  });
  socketStub.emitOutput("session-reset", {
    kind: "reset",
    sessionId: "session-reset",
    sequence: 0,
    cols: 80,
    rows: 24,
    data: new Uint8Array(),
  });

  const snapshot = manager.diagnosticsSnapshot();
  assert.equal(snapshot.queuedFrames, 1);
  assert.equal(snapshot.queuedBytes, 0);
});

test("backlog warning is deduplicated and can fire again after recovery", async () => {
  resourceLogStub.entries.length = 0;
  const manager = new TerminalProcessManager();
  const deliveries = [];
  await manager.subscribeOutput("session-warning", (delivery) => deliveries.push(delivery));
  const thresholdPayload = new Uint8Array(4 * 1024 * 1024);

  socketStub.emitOutput("session-warning", {
    ...frame(1, ""),
    sessionId: "session-warning",
    data: thresholdPayload,
  });
  socketStub.emitOutput("session-warning", {
    ...frame(2, "x"),
    sessionId: "session-warning",
  });
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "warn").length, 1);

  deliveries[0].commit(0);
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "info").length, 1);
  assert.equal(resourceLogStub.entries[1].event, "backlogRecovered");

  socketStub.emitOutput("session-warning", {
    ...frame(3, ""),
    sessionId: "session-warning",
    data: thresholdPayload,
  });
  assert.equal(resourceLogStub.entries.filter((entry) => entry.level === "warn").length, 2);
});

test("terminal color updates stay behind the process manager boundary", async () => {
  socketStub.terminalColorUpdates.length = 0;
  const manager = new TerminalProcessManager();
  await manager.setTerminalColors("session-colors", {
    foreground: "#FFFFFF",
    background: "#101010",
  });
  assert.deepEqual(socketStub.terminalColorUpdates, [{
    sessionId: "session-colors",
    colors: { foreground: "#FFFFFF", background: "#101010" },
  }]);
});

test("large output backlogs preserve ACK order, diagnostics and remount delivery after partial drains", async () => {
  socketStub.acknowledgments.length = 0;
  const manager = new TerminalProcessManager();
  const deliveries = [];
  const sessionId = "large-backlog";
  const dispose = await manager.subscribeOutput(sessionId, (delivery) => deliveries.push(delivery));
  for (let sequence = 1; sequence <= 6000; sequence += 1) {
    socketStub.emitOutput(sessionId, { ...frame(sequence, "x"), sessionId });
  }
  // Later callbacks may arrive first, but ACKs must advance a contiguous prefix.
  for (let index = 3999; index >= 1; index -= 1) deliveries[index].commit(1);
  assert.equal(socketStub.acknowledgments.length, 0);
  deliveries[0].commit(1);
  assert.equal(manager.diagnosticsSnapshot().queuedFrames, 2000);
  assert.equal(manager.diagnosticsSnapshot().queuedBytes, 2000);
  assert.equal(manager.diagnosticsSnapshot().topBacklogs[0].deliveredFrames, 2000);
  dispose();
  const remounted = [];
  await manager.subscribeOutput(sessionId, (delivery) => remounted.push(delivery));
  assert.equal(remounted.length, 2000);
  deliveries[4000].commit(1); // stale consumer must not commit after remount
  assert.equal(socketStub.acknowledgments.length, 4000);
  for (const delivery of remounted) delivery.commit(1);
  assert.deepEqual(socketStub.acknowledgments.map((ack) => ack.sequence),
    Array.from({ length: 6000 }, (_, index) => index + 1));
  assert.equal(manager.diagnosticsSnapshot().queuedFrames, 0);
  assert.equal(manager.diagnosticsSnapshot().queuedBytes, 0);
  socketStub.emitOutput(sessionId, { ...frame(6000, "x"), sessionId });
  assert.equal(remounted.length, 2000);
  socketStub.emitOutput(sessionId, { ...frame(6001, "next"), sessionId });
  remounted.at(-1).commit(4);
  assert.equal(socketStub.acknowledgments.at(-1).sequence, 6001);
  await manager.close(sessionId);
});

test("reset and replay boundaries drain correctly after a partially consumed queue", async () => {
  socketStub.acknowledgments.length = 0;
  const manager = new TerminalProcessManager();
  const deliveries = [];
  const sessionId = "reset-after-drain";
  await manager.subscribeOutput(sessionId, (delivery) => deliveries.push(delivery));
  for (let sequence = 1; sequence <= 10; sequence += 1) {
    socketStub.emitOutput(sessionId, { ...frame(sequence, "x"), sessionId });
  }
  deliveries[0].commit(1);
  socketStub.emitOutput(sessionId, {
    ...frame(0, ""), sessionId, kind: "reset",
  });
  deliveries.at(-1).commit(0);
  socketStub.emitOutput(sessionId, {
    ...frame(0, ""), sessionId, kind: "replay", replayBatchEnd: true,
  });
  deliveries.at(-1).commit(0);
  socketStub.emitOutput(sessionId, { ...frame(20, "new"), sessionId });
  deliveries.at(-1).commit(3);
  assert.deepEqual(socketStub.acknowledgments.map((ack) => ack.sequence), [1, 20]);
  assert.equal(manager.diagnosticsSnapshot().queuedFrames, 0);
  await manager.close(sessionId);
});


test("checkpoint uses the sequence captured with its picture even if newer output commits", async () => {
  const manager = new TerminalProcessManager(), deliveries = [];
  const stop = await manager.subscribeOutput("capture-boundary", delivery => deliveries.push(delivery));
  socketStub.emitOutput("capture-boundary", { ...frame(1, "before"), sessionId: "capture-boundary" });
  deliveries[0].commit(6);
  const capturedSequence = manager.getCommittedOutputSequence("capture-boundary");
  socketStub.emitOutput("capture-boundary", { ...frame(2, "after"), sessionId: "capture-boundary" });
  deliveries[1].commit(5);
  assert.equal(manager.getCommittedOutputSequence("capture-boundary"), 2);
  await manager.checkpoint("capture-boundary", 120, 36, "picture before", capturedSequence);
  assert.deepEqual(socketStub.checkpoints.at(-1), {
    sessionId: "capture-boundary", sequence: 1, cols: 120, rows: 36, serializedState: "picture before",
  });
  stop();
});


test("initial attach replay advances checkpoint sequence without live output and reset clears it", async () => {
  const manager = new TerminalProcessManager(), deliveries = [];
  const stop = await manager.subscribeOutput("quiet-attach", delivery => deliveries.push(delivery));
  manager.acknowledgeOutput("quiet-attach", 900, 0);
  manager.acknowledgeOutput("quiet-attach", 901, 0);
  await manager.checkpoint("quiet-attach", 80, 24, "complete attach picture");
  assert.equal(socketStub.checkpoints.at(-1).sequence, 901);
  socketStub.emitOutput("quiet-attach", { ...frame(901, "duplicate"), sessionId: "quiet-attach" });
  assert.equal(deliveries.length, 0);
  socketStub.emitOutput("quiet-attach", { ...frame(0, ""), kind: "reset", sessionId: "quiet-attach" });
  deliveries[0].commit(0);
  assert.equal(manager.getCommittedOutputSequence("quiet-attach"), 0);
  socketStub.emitOutput("quiet-attach", { ...frame(700, "replay"), kind: "replay", sessionId: "quiet-attach" });
  deliveries[1].commit(0);
  assert.equal(manager.getCommittedOutputSequence("quiet-attach"), 700);
  stop();
});

test("reset capture waiters resolve only when the latest reset is committed, without polling", async () => {
  const manager = new TerminalProcessManager(), deliveries = [];
  const sessionId = "reset-wait";
  await manager.subscribeOutput(sessionId, delivery => deliveries.push(delivery));
  const firstGeneration = manager.getOutputGeneration(sessionId);
  assert.equal(manager.isOutputResetPending(sessionId), false);
  await manager.awaitOutputReset(sessionId, new AbortController().signal);
  socketStub.emitOutput(sessionId, { ...frame(0, ""), sessionId, kind: "reset" });
  const firstReset = deliveries.at(-1);
  const firstResetGeneration = manager.getOutputGeneration(sessionId);
  assert.ok(firstResetGeneration > firstGeneration);
  let settled = 0;
  const originalSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => { throw new Error("reset waiting must not poll"); };
  try {
    const waiters = [1, 2].map(() => manager.awaitOutputReset(sessionId, new AbortController().signal).then(() => settled++));
    await Promise.resolve();
    assert.equal(settled, 0);
    socketStub.emitOutput(sessionId, { ...frame(0, ""), sessionId, kind: "reset" });
    assert.ok(manager.getOutputGeneration(sessionId) > firstResetGeneration);
    firstReset.commit(0);
    await Promise.resolve();
    assert.equal(settled, 0, "an obsolete reset callback must not wake the current generation");
    assert.equal(manager.isOutputResetPending(sessionId), true);
    deliveries.at(-1).commit(0);
    await Promise.all(waiters);
    assert.equal(settled, 2);
    assert.equal(manager.isOutputResetPending(sessionId), false);
  } finally {
    globalThis.setInterval = originalSetInterval;
    await manager.close(sessionId);
  }
});

test("reset wait abort removes only that waiter and remount can commit the retained reset", async () => {
  const manager = new TerminalProcessManager(), deliveries = [], remounted = [];
  const sessionId = "reset-remount";
  const stop = await manager.subscribeOutput(sessionId, delivery => deliveries.push(delivery));
  socketStub.emitOutput(sessionId, { ...frame(0, ""), sessionId, kind: "reset" });
  const controller = new AbortController();
  const rejected = assert.rejects(manager.awaitOutputReset(sessionId, controller.signal), { name: "AbortError" });
  controller.abort();
  await rejected;
  await assert.rejects(manager.awaitOutputReset(sessionId, controller.signal), { name: "AbortError" });
  stop();
  let settled = false;
  const waiting = manager.awaitOutputReset(sessionId, new AbortController().signal).then(() => { settled = true; });
  await manager.subscribeOutput(sessionId, delivery => remounted.push(delivery));
  deliveries[0].commit(0);
  await Promise.resolve();
  assert.equal(settled, false, "unmounted consumer cannot ACK a reset");
  remounted[0].commit(0);
  await waiting;
  assert.equal(settled, true);
  await manager.close(sessionId);
});

test("closing rejects reset waiters immediately even while backend close is pending", async () => {
  const manager = new TerminalProcessManager(), deliveries = [];
  const sessionId = "reset-close";
  await manager.subscribeOutput(sessionId, delivery => deliveries.push(delivery));
  socketStub.emitOutput(sessionId, { ...frame(0, ""), sessionId, kind: "reset" });
  const originalClose = socketStub.ptyHostSocket.close;
  let releaseClose;
  socketStub.ptyHostSocket.close = () => new Promise(resolve => { releaseClose = resolve; });
  try {
    const rejected = assert.rejects(manager.awaitOutputReset(sessionId, new AbortController().signal), /session closed/);
    const closing = manager.close(sessionId);
    await rejected;
    assert.equal(manager.getOutputGeneration(sessionId), undefined);
    await assert.rejects(manager.awaitOutputReset(sessionId, new AbortController().signal), /session closed/);
    deliveries[0].commit(0);
    releaseClose();
    await closing;
  } finally {
    socketStub.ptyHostSocket.close = originalClose;
  }
});

test("closeAll rejects all pending reset waits and recreated state has a fresh generation", async () => {
  const manager = new TerminalProcessManager();
  const previous = [];
  const waits = [];
  for (const sessionId of ["reset-all-a", "reset-all-b"]) {
    await manager.subscribeOutput(sessionId, () => {});
    socketStub.emitOutput(sessionId, { ...frame(0, ""), sessionId, kind: "reset" });
    previous.push(manager.getOutputGeneration(sessionId));
    waits.push(assert.rejects(manager.awaitOutputReset(sessionId, new AbortController().signal), /session closed/));
  }
  await manager.closeAll();
  await Promise.all(waits);
  await manager.subscribeOutput("reset-all-a", () => {});
  assert.ok(manager.getOutputGeneration("reset-all-a") > Math.max(...previous));
  assert.equal(manager.isOutputResetPending("reset-all-a"), false);
  await manager.closeAll();
});

test("reset commit clears late pre-reset attach ACKs and ignores old stream commits", async () => {
  const manager = new TerminalProcessManager(), deliveries = [];
  const sessionId = "reset-commit-sequence";
  await manager.subscribeOutput(sessionId, delivery => deliveries.push(delivery));
  socketStub.emitOutput(sessionId, { ...frame(800, "old"), sessionId });
  socketStub.emitOutput(sessionId, { ...frame(0, ""), sessionId, kind: "reset" });
  manager.acknowledgeOutput(sessionId, 900, 0);
  deliveries[0].commit(3);
  deliveries[1].commit(0);
  assert.equal(manager.getCommittedOutputSequence(sessionId), 0);
  socketStub.emitOutput(sessionId, { ...frame(700, "replay"), sessionId, kind: "replay" });
  deliveries[2].commit(0);
  assert.equal(manager.getCommittedOutputSequence(sessionId), 700);
  await manager.close(sessionId);
});

test("checkpoint forwards its validity guard through the transport await boundary", async () => {
  const manager = new TerminalProcessManager();
  const isCurrent = () => false;
  await manager.checkpoint("guard-forward", 80, 24, "picture", 42, isCurrent);
  assert.strictEqual(socketStub.checkpointValidityChecks.at(-1), isCurrent);
});

test("daemon replacement invalidates old output generations and rejects reset waiters", async () => {
  const manager = new TerminalProcessManager();
  const sessionId = "old-daemon-reset";
  await manager.subscribeOutput(sessionId, () => {});
  socketStub.emitOutput(sessionId, { ...frame(0, ""), sessionId, kind: "reset" });
  const rejected = assert.rejects(manager.awaitOutputReset(sessionId, new AbortController().signal), /session closed/);
  tauriStub.prepareCreate({ sessionId: "new-daemon-session", cwd: null, envVars: {}, shell: null, sshLaunch: null, daemonRestarted: true });
  const created = await manager.create({ cwd: null, envVars: null, shell: null, hookEnvEnabled: false, sshLaunch: null, terminalColors: { foreground: "#fff", background: "#000" } });
  await rejected;
  assert.equal(created, "new-daemon-session");
  assert.equal(manager.getOutputGeneration(sessionId), undefined);
  assert.equal(manager.diagnosticsSnapshot().trackedSessions, 0);
  socketStub.emitOutput(sessionId, { ...frame(9, "stale"), sessionId });
  assert.equal(manager.diagnosticsSnapshot().trackedSessions, 0, "the old daemon listener was removed");
});

test("an old consumer cleanup cannot detach a recreated session state", async () => {
  const manager = new TerminalProcessManager();
  const sessionId = "recreated-consumer";
  const oldStop = await manager.subscribeOutput(sessionId, () => {});
  await manager.close(sessionId);
  const deliveries = [];
  const newStop = await manager.subscribeOutput(sessionId, delivery => deliveries.push(delivery));
  oldStop();
  socketStub.emitOutput(sessionId, { ...frame(1, "new daemon output"), sessionId });
  assert.equal(deliveries.length, 1);
  deliveries[0].commit(17);
  assert.equal(manager.getCommittedOutputSequence(sessionId), 1);
  newStop();
  await manager.close(sessionId);
});
