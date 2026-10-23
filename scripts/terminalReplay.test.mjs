import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import ts from "typescript";

const { Terminal: RealTerminal } = createRequire(import.meta.url)("@xterm/xterm");
const { SerializeAddon } = createRequire(import.meta.url)("@xterm/addon-serialize");

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-replay-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

globalThis.window = globalThis;
globalThis.document = { visibilityState: "visible" };
let nextRafId = 1;
const rafCallbacks = new Map();
globalThis.requestAnimationFrame = (callback) => {
  const id = nextRafId++;
  rafCallbacks.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
const windowListeners = new Map();
globalThis.addEventListener = (name, callback) => {
  if (!windowListeners.has(name)) windowListeners.set(name, new Set());
  windowListeners.get(name).add(callback);
};
globalThis.removeEventListener = (name, callback) => windowListeners.get(name)?.delete(callback);
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};

function flushNextAnimationFrame() {
  const callbacks = [...rafCallbacks.values()];
  rafCallbacks.clear();
  callbacks.forEach((callback) => callback(performance.now()));
}

function flushAnimationFrames() {
  while (rafCallbacks.size > 0) flushNextAnimationFrame();
}

writeFileSync(join(tempDir, "react.mjs"), "export const useRef = (value) => ({ current: value });\n");
writeFileSync(join(tempDir, "webgl.mjs"), `
export const instances = [];
export class WebglAddon {
  constructor() { this.disposed = false; instances.push(this); }
  onContextLoss() {}
  dispose() { this.disposed = true; }
  clearTextureAtlas() {}
}
`);
writeFileSync(join(tempDir, "visibility.mjs"), `
export const refreshCalls = [];
export function refreshTerminalViewport(terminal) {
  refreshCalls.push([0, terminal.rows - 1]);
}
export function resetVisibility() {
  refreshCalls.length = 0;
}
`);
writeFileSync(join(tempDir, "themes.mjs"), "export function isLightTerminalTheme() { return false; }\n");
writeFileSync(join(tempDir, "logger.mjs"), "export function logError() {} export function logWarn() {}\n");
writeFileSync(join(tempDir, "snapshot.mjs"), `
export const dirtyMarks = [];
export function markTerminalSnapshotDirty(sessionId, bytes = 0) { dirtyMarks.push({ sessionId, bytes }); }
`);
writeFileSync(join(tempDir, "resize.mjs"), `
export function shouldDebounceTerminalResize() { return false; }
export function isValidTerminalSize(cols, rows) {
  return Number.isInteger(cols) && cols >= 40 && Number.isInteger(rows) && rows >= 8;
}
export const cancelCalls = [];
export class TerminalResizeDebouncer {
  constructor(_visible, _terminal, resizeBoth) { this.resizeBoth = resizeBoth; }
  resize(cols, rows) { this.resizeBoth(cols, rows); }
  cancel() { cancelCalls.push(true); }
  dispose() {}
}
export function resetResizeStub() { cancelCalls.length = 0; }
`);
writeFileSync(join(tempDir, "resizeBarrier.mjs"), `
export class TerminalResizeRenderBarrier {
  begin() { return true; }
  noteContainerResize() {}
  cancel() {}
  dispose() {}
}
`);
writeFileSync(join(tempDir, "settings.mjs"), `
export const TERMINAL_FONT_SIZE_MAX = 32;
export const TERMINAL_FONT_SIZE_MIN = 8;
export const useSettingsStore = { getState: () => ({ fontSize: 14, update: async () => {} }) };
`);
writeFileSync(join(tempDir, "terminalStore.mjs"), `
export const useTerminalStore = {
  getState: () => ({ recordPtyOutputActivity() {} }),
};
`);
writeFileSync(join(tempDir, "manager.mjs"), `
const outputListeners = new Map();
export const resizeCalls = [];
export const replayAcknowledgments = [];
export const terminalProcessManager = {
  async subscribeOutput(sessionId, listener) {
    outputListeners.set(sessionId, listener);
    return () => { if (outputListeners.get(sessionId) === listener) outputListeners.delete(sessionId); };
  },
  async resize(sessionId, cols, rows) { resizeCalls.push({ sessionId, cols, rows }); },
  acknowledgeOutput(sessionId, sequence, charCount) {
    replayAcknowledgments.push({ sessionId, sequence, charCount });
  },
};
export function emitOutput(delivery, sessionId = "session-1") { outputListeners.get(sessionId)?.(delivery); }
export function resetManager() {
  outputListeners.clear();
  resizeCalls.length = 0;
  replayAcknowledgments.length = 0;
}
`);

const source = readFileSync(new URL("../src/hooks/useTerminalDisplay.ts", import.meta.url), "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "useTerminalDisplay.ts",
}).outputText
  .replace('from "react"', 'from "./react.mjs"')
  .replace('from "@xterm/addon-webgl"', 'from "./webgl.mjs"')
  .replace('from "../lib/terminalVisibility"', 'from "./visibility.mjs"')
  .replace('from "../lib/terminalThemes"', 'from "./themes.mjs"')
  .replace('from "../lib/logger"', 'from "./logger.mjs"')
  .replace('from "../lib/sessionSnapshotPersistence"', 'from "./snapshot.mjs"')
  .replace('from "../lib/terminalMutationGate"', 'from "./terminalMutationGate.mjs"')
  .replace('from "../lib/terminalReplayWriter"', `from ${JSON.stringify(pathToFileURL(join(tempDir, "terminalReplayWriter.mjs")).href)}`)
  .replace('from "../terminal/browser/TerminalResizeDebouncer"', 'from "./resize.mjs"')
  .replace('from "../terminal/browser/TerminalResizeRenderBarrier"', 'from "./resizeBarrier.mjs"')
  .replace('from "../terminal/browser/TerminalWriteScheduler"', 'from "./TerminalWriteScheduler.mjs"')
  .replace('from "../terminal/core/TerminalProcessManager"', 'from "./manager.mjs"')
  .replace('from "../stores/settingsStore"', 'from "./settings.mjs"')
  .replace('from "../stores/terminalStore"', 'from "./terminalStore.mjs"');
const modulePath = join(tempDir, "useTerminalDisplay.mjs");
writeFileSync(join(tempDir, "TerminalWriteScheduler.mjs"), ts.transpileModule(
  readFileSync(new URL("../src/terminal/browser/TerminalWriteScheduler.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
).outputText);
writeFileSync(join(tempDir, "terminalReplayWriter.mjs"), ts.transpileModule(
  readFileSync(new URL("../src/lib/terminalReplayWriter.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
).outputText);
writeFileSync(join(tempDir, "terminalMutationGate.mjs"), ts.transpileModule(
  readFileSync(new URL("../src/lib/terminalMutationGate.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } },
).outputText);
writeFileSync(modulePath, transpiled, "utf8");

const { useTerminalDisplay } = await import(pathToFileURL(modulePath).href);
const snapshotStub = await import(pathToFileURL(join(tempDir, "snapshot.mjs")).href);
const managerStub = await import(pathToFileURL(join(tempDir, "manager.mjs")).href);
const resizeStub = await import(pathToFileURL(join(tempDir, "resize.mjs")).href);
const visibilityStub = await import(pathToFileURL(join(tempDir, "visibility.mjs")).href);
const webglStub = await import(pathToFileURL(join(tempDir, "webgl.mjs")).href);

class FakeTerminal {
  constructor(events) {
    this.events = events;
    this.options = { disableStdin: false };
    this.cols = 80;
    this.rows = 24;
    this.buffer = {
      normal: { length: 0 },
      active: { type: "normal", baseY: 0, cursorY: 0, viewportY: 0 },
    };
    this.writeCallbacks = [];
    this.resizeListeners = new Set();
    this.markers = new Set();
    this.reflowBaseYDelta = 0;
    this.reflowMarkerLineDelta = 0;
    this.viewportMaxScrollLine = 0;
  }

  write(text, callback) {
    this.events.push(`write:${text}`);
    this.writeCallbacks.push(callback);
  }

  async finishNextWrite() {
    const callback = this.writeCallbacks.shift();
    assert.ok(callback, "expected a pending xterm write callback");
    callback();
    await Promise.resolve();
  }

  resize(cols, rows) {
    const colsChanged = this.cols !== cols;
    this.cols = cols;
    this.rows = rows;
    if (colsChanged && this.reflowBaseYDelta > 0) {
      const wasAtBottom = this.buffer.active.viewportY === this.buffer.active.baseY;
      this.buffer.active.baseY += this.reflowBaseYDelta;
      if (wasAtBottom) {
        this.buffer.active.viewportY = this.buffer.active.baseY;
      }
      this.markers.forEach((marker) => {
        if (!marker.isDisposed) marker.line += this.reflowMarkerLineDelta;
      });
    }
    if (colsChanged) {
      const nextViewportMaxScrollLine = this.buffer.active.baseY;
      requestAnimationFrame(() => {
        this.viewportMaxScrollLine = nextViewportMaxScrollLine;
      });
    }
    this.events.push(`resize:${cols}x${rows}`);
    this.resizeListeners.forEach((listener) => listener({ cols, rows }));
  }

  registerMarker(cursorYOffset) {
    const marker = {
      line: this.buffer.active.baseY + this.buffer.active.cursorY + cursorYOffset,
      isDisposed: false,
      dispose: () => {
        marker.isDisposed = true;
        this.markers.delete(marker);
      },
    };
    this.markers.add(marker);
    return marker;
  }

  scrollToLine(line) {
    this.buffer.active.viewportY = Math.max(0, Math.min(line, this.viewportMaxScrollLine));
    this.events.push(`scroll:${this.buffer.active.viewportY}`);
  }

  scrollToBottom() {
    this.buffer.active.viewportY = this.buffer.active.baseY;
    this.events.push(`scroll-bottom:${this.buffer.active.viewportY}`);
  }

  onResize(listener) {
    this.resizeListeners.add(listener);
    return { dispose: () => this.resizeListeners.delete(listener) };
  }

  loadAddon() {}
}

function createDisplay(
  proposedDimensions = { cols: 120, rows: 30 },
  { sessionId = "session-1", isVisible = true, rendererEnabled = false, ownerDocument, terminalFactory = events => new FakeTerminal(events) } = {},
) {
  visibilityStub.resetVisibility();
  const events = [];
  const terminal = terminalFactory(events);
  const container = {
    offsetWidth: 1200,
    offsetHeight: 600,
    ownerDocument,
    addEventListener() {},
    removeEventListener() {},
  };
  const terminalRef = { current: terminal };
  const isVisibleRef = { current: isVisible };
  const display = useTerminalDisplay({
    sessionId,
    containerRef: { current: container },
    terminalRef,
    fitAddonRef: { current: { proposeDimensions: () => proposedDimensions } },
    isVisibleRef,
    isComposingRef: { current: false },
    lowMemoryMode: false,
    disableHardwareAcceleration: !rendererEnabled,
    linuxGraphicsDisableWebgl: !rendererEnabled,
    isTransparentRef: { current: false },
    normalizeOutputRef: { current: (text) => text },
    transformOutputRef: { current: (text) => text },
    onPtyOutputListenError: (error) => { throw error; },
  });
  const detachViewport = display.attachViewport(terminal);
  return { display, terminal, terminalRef, isVisibleRef, container, events, detachViewport };
}

function withRendererTimers(run) {
  const originalSet = window.setTimeout, originalClear = window.clearTimeout;
  const timers = new Map(); let nextId = 1;
  window.setTimeout = (callback, delay) => { const id = nextId++; timers.set(id, { callback, delay }); return id; };
  window.clearTimeout = id => timers.delete(id);
  try { run(timers); } finally { window.setTimeout = originalSet; window.clearTimeout = originalClear; }
}

test("normal mode releases an idle hidden renderer and recreates it without changing the terminal buffer", () => {
  withRendererTimers(timers => {
    const h = createDisplay(undefined, { rendererEnabled: true });
    const buffer = h.terminal.buffer;
    assert.equal(h.display.syncWebglRenderer(h.terminal, {}), true);
    const original = webglStub.instances.at(-1);
    h.isVisibleRef.current = false;
    h.display.scheduleHiddenWebglDispose(false);
    assert.equal([...timers.values()][0].delay, 30_000);
    h.display.clearHiddenWebglDisposeTimer();
    assert.equal(timers.size, 0, "a quick switch back cancels disposal");
    assert.equal(original.disposed, false);
    h.display.scheduleHiddenWebglDispose(false);
    [...timers.values()][0].callback();
    assert.equal(original.disposed, true);
    assert.equal(h.terminal.buffer, buffer);
    assert.deepEqual(h.events, []);
    h.isVisibleRef.current = true;
    assert.equal(h.display.syncWebglRenderer(h.terminal, {}), true);
    assert.notEqual(webglStub.instances.at(-1), original);
    h.display.disposeWebglRenderer();
    h.detachViewport();
  });
});

test("low memory mode uses 10 seconds and an already visible pane is never disposed", () => {
  withRendererTimers(timers => {
    const h = createDisplay(undefined, { rendererEnabled: true });
    h.display.syncWebglRenderer(h.terminal, {});
    const original = webglStub.instances.at(-1);
    h.isVisibleRef.current = false;
    h.display.scheduleHiddenWebglDispose(true);
    assert.equal([...timers.values()][0].delay, 10_000);
    h.isVisibleRef.current = true;
    [...timers.values()][0].callback();
    assert.equal(original.disposed, false);
    h.display.disposeWebglRenderer();
    h.detachViewport();
  });
});

test("minimize or tray hiding releases the visible pane renderer, foreground restores it and removes listeners on detach", () => {
  withRendererTimers(timers => {
    const listeners = new Map();
    const ownerDocument = {
      visibilityState: "visible",
      addEventListener(name, listener) { listeners.set(name, listener); },
      removeEventListener(name) { listeners.delete(name); },
    };
    const h = createDisplay(undefined, { rendererEnabled: true, ownerDocument });
    h.display.syncWebglRenderer(h.terminal, {});
    const original = webglStub.instances.at(-1);
    ownerDocument.visibilityState = "hidden";
    listeners.get("visibilitychange")();
    [...timers.values()][0].callback();
    assert.equal(original.disposed, true);
    ownerDocument.visibilityState = "visible";
    listeners.get("visibilitychange")();
    assert.equal(webglStub.instances.at(-1).disposed, false);
    assert.notEqual(webglStub.instances.at(-1), original);
    flushAnimationFrames();
    h.display.disposeWebglRenderer();
    h.detachViewport();
    assert.equal(listeners.size, 0);
  });
});

test("project restoration keeps its full repaint when ResizeObserver also requests a fit", () => {
  const { display, terminal, detachViewport } = createDisplay();
  terminal.cols = 120;
  terminal.rows = 30;
  display.scheduleFit(true, true);
  display.scheduleFit();
  flushAnimationFrames();
  assert.deepEqual(visibilityStub.refreshCalls, [[0, 29]]);
  detachViewport();
});

test("a queued immediate fit cannot resize a pane after switching away from its project", () => {
  const h = createDisplay();
  h.display.scheduleFit(true, true);
  h.isVisibleRef.current = false;
  flushAnimationFrames();
  assert.deepEqual(h.events, []);
  assert.deepEqual(visibilityStub.refreshCalls, []);
  h.isVisibleRef.current = true;
  h.display.scheduleFit(true, true);
  flushAnimationFrames();
  assert.deepEqual(h.events.filter(event => event.startsWith("resize:")), ["resize:120x30"]);
  assert.deepEqual(visibilityStub.refreshCalls, [[0, 29]]);
  h.detachViewport();
});

test("a zero-size project layout retains its repaint request until dimensions become available", () => {
  const h = createDisplay();
  h.terminal.cols = 120;
  h.terminal.rows = 30;
  h.container.offsetWidth = 0;
  h.display.scheduleFit(true, true);
  flushAnimationFrames();
  h.container.offsetWidth = 1200;
  h.display.scheduleFit();
  flushAnimationFrames();
  assert.deepEqual(visibilityStub.refreshCalls, [[0, 29]]);
  h.detachViewport();
});

test("immediate fit does not force a viewport refresh when dimensions are unchanged", () => {
  const { display, terminal, detachViewport } = createDisplay();
  terminal.cols = 120;
  terminal.rows = 30;

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.deepEqual(visibilityStub.refreshCalls, []);
  detachViewport();
});

test("explicit viewport refresh repaints the full grid when dimensions are unchanged", () => {
  const { display, terminal, detachViewport } = createDisplay();
  terminal.cols = 120;
  terminal.rows = 30;

  display.scheduleFit(true, true);
  flushAnimationFrames();

  assert.deepEqual(visibilityStub.refreshCalls, [[0, 29]]);
  detachViewport();
});

test("native maximize and foreground events refit and repaint without a container notification", () => {
  managerStub.resetManager();
  const dimensions = { cols: 80, rows: 24 };
  const h = createDisplay(dimensions);
  dimensions.cols = 180;
  dimensions.rows = 45;
  windowListeners.get("resize").forEach(callback => callback());
  flushAnimationFrames();
  assert.equal(h.terminal.cols, 180);
  assert.equal(h.terminal.rows, 45);
  assert.deepEqual(visibilityStub.refreshCalls, [[0, 44]]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 180, rows: 45 }]);

  windowListeners.get("focus").forEach(callback => callback());
  flushAnimationFrames();
  assert.deepEqual(visibilityStub.refreshCalls, [[0, 44], [0, 44]]);
  assert.equal(managerStub.resizeCalls.length, 1, "unchanged host dimensions are not sent again");
  h.detachViewport();
  assert.equal(windowListeners.get("resize").size, 0);
  assert.equal(windowListeners.get("focus").size, 0);
});

test("consecutive fit frames keep the live horizontal resize cadence pending", () => {
  resizeStub.resetResizeStub();
  const { display, detachViewport } = createDisplay({ cols: 100, rows: 24 });

  display.scheduleFit();
  flushNextAnimationFrame();
  display.scheduleFit();

  assert.equal(resizeStub.cancelCalls.length, 0);
  display.cancelScheduledFit();
  assert.equal(resizeStub.cancelCalls.length, 1);
  detachViewport();
});

test("horizontal reflow preserves the visible normal-buffer line", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.normal.length = 300;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.cursorY = 23;
  terminal.buffer.active.viewportY = 177;
  terminal.viewportMaxScrollLine = 277;
  terminal.reflowBaseYDelta = 300;
  terminal.reflowMarkerLineDelta = 177;

  display.scheduleFit(true, false);

  flushNextAnimationFrame();
  assert.deepEqual(events, ["resize:60x24"]);
  assert.equal(terminal.markers.size, 1);

  flushNextAnimationFrame();
  assert.deepEqual(events, ["resize:60x24"]);
  assert.equal(terminal.markers.size, 1);

  flushNextAnimationFrame();

  assert.equal(terminal.buffer.active.viewportY, 354);
  assert.deepEqual(events, ["resize:60x24", "scroll:354"]);
  assert.equal(terminal.markers.size, 0);
  detachViewport();
});

test("horizontal reflow restores live-bottom intent after asynchronous viewport drift", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.cursorY = 23;
  terminal.buffer.active.viewportY = 277;
  terminal.viewportMaxScrollLine = 277;
  terminal.reflowBaseYDelta = 300;

  display.scheduleFit(true, false);
  flushNextAnimationFrame();

  assert.equal(terminal.buffer.active.viewportY, 577);
  assert.deepEqual(events, ["resize:60x24", "scroll-bottom:577"]);

  // Reproduce the delayed DOM viewport event that can leave xterm at the top.
  terminal.buffer.active.viewportY = 0;
  flushNextAnimationFrame();
  assert.equal(terminal.buffer.active.viewportY, 0);

  flushNextAnimationFrame();
  assert.equal(terminal.buffer.active.viewportY, 577);
  assert.deepEqual(events, ["resize:60x24", "scroll-bottom:577", "scroll-bottom:577"]);
  detachViewport();
});

test("vertical resize does not force a live-bottom scroll", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 120, rows: 30 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.viewportY = 277;

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.deepEqual(events, ["resize:120x30"]);
  detachViewport();
});

test("alternate buffer resize does not force a live-bottom scroll", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.type = "alternate";

  display.scheduleFit(true, false);
  flushAnimationFrames();

  assert.deepEqual(events, ["resize:60x24"]);
  detachViewport();
});

test("cancelling a scheduled fit disposes a pending viewport marker", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.normal.length = 300;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.cursorY = 23;
  terminal.buffer.active.viewportY = 177;
  terminal.viewportMaxScrollLine = 277;
  terminal.reflowBaseYDelta = 300;
  terminal.reflowMarkerLineDelta = 177;

  display.scheduleFit(true, false);
  flushNextAnimationFrame();
  assert.equal(terminal.markers.size, 1);

  display.cancelScheduledFit();
  flushAnimationFrames();

  assert.deepEqual(events, ["resize:60x24"]);
  assert.equal(terminal.markers.size, 0);
  detachViewport();
});

test("cancelling a scheduled fit cancels pending live-bottom restoration", () => {
  const { display, terminal, events, detachViewport } = createDisplay({ cols: 60, rows: 24 });
  terminal.cols = 120;
  terminal.rows = 24;
  terminal.buffer.active.baseY = 277;
  terminal.buffer.active.viewportY = 277;
  terminal.reflowBaseYDelta = 300;

  display.scheduleFit(true, false);
  flushNextAnimationFrame();
  terminal.buffer.active.viewportY = 0;

  display.cancelScheduledFit();
  flushAnimationFrames();

  assert.equal(terminal.buffer.active.viewportY, 0);
  assert.deepEqual(events, ["resize:60x24", "scroll-bottom:577"]);
  detachViewport();
});

function frame(sequence, text, cols, rows, replayBatchEnd = false) {
  return {
    kind: sequence < 3 ? "replay" : "output",
    sessionId: "session-1",
    sequence,
    cols,
    rows,
    data: new TextEncoder().encode(text),
    replayBatchEnd,
  };
}

function delivery(frameValue, commits) {
  return {
    frame: frameValue,
    commit: (charCount) => commits.push({ sequence: frameValue.sequence, charCount }),
  };
}

test("live display remount keeps the prompt and ConPTY input on the same row", async () => {
  const prompt = "PS E:\\Work\\CLI-Manager> ";
  const options = { cols: 178, rows: 36, allowProposedApi: true, windowsPty: { backend: "conpty" } };
  let terminal = new RealTerminal(options);
  await new Promise(resolve => terminal.write(prompt + "\x1b[?1004h", resolve));
  for (let index = 0; index < 3; index++) {
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    const snapshot = { cols: terminal.cols, rows: terminal.rows, serializedState: serializer.serialize() };
    terminal.dispose();
    const h = createDisplay({ cols: 178, rows: 36 }, {
      terminalFactory: () => new RealTerminal({ ...options, cols: 80, rows: 24 }),
    });
    terminal = h.terminal;
    await new Promise(resolve => h.display.restoreDisplaySnapshot(snapshot, resolve));
    // Captured from the user's pwsh: it addresses the first row, column 25.
    await new Promise(resolve => terminal.write(
      "\x1b[?25l\x1b[1;25H\x1b[0m\x1b[97m1112\x1b[39;49m\x1b[0m\x1b[1;29H\x1b[?25h", resolve,
    ));
    assert.equal(terminal.buffer.active.getLine(0).translateToString(true), prompt + "1112");
    assert.equal(terminal.buffer.active.baseY, 0);
    assert.equal(terminal.buffer.active.cursorY, 0);
    assert.equal(terminal.buffer.active.cursorX, 28);
    assert.equal(terminal.buffer.active.getLine(1).translateToString(true), "");
    h.detachViewport();
  }
  terminal.dispose();
});

test("snapshot restoration holds geometry and host resize until parsing finishes, including hidden panes", async () => {
  managerStub.resetManager();
  const h = createDisplay({ cols: 192, rows: 48 });
  let committed = false;
  h.display.restoreDisplaySnapshot({ cols: 178, rows: 36, serializedState: "snapshot" }, () => { committed = true; });
  h.display.scheduleFit(true, true);
  flushAnimationFrames();
  assert.deepEqual([h.terminal.cols, h.terminal.rows], [178, 36]);
  assert.deepEqual(managerStub.resizeCalls, []);
  assert.equal(h.terminal.options.disableStdin, true);
  h.isVisibleRef.current = false;
  h.display.suspendViewport();
  await h.terminal.finishNextWrite();
  assert.equal(committed, true);
  assert.equal(h.terminal.options.disableStdin, false);
  assert.deepEqual(managerStub.resizeCalls, []);
  h.isVisibleRef.current = true;
  h.display.scheduleFit(true, true);
  flushAnimationFrames();
  assert.deepEqual([h.terminal.cols, h.terminal.rows], [192, 48]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 192, rows: 48 }]);
  h.detachViewport();
});

test("live TUI remount preserves alternate screen and cursor coordinates", async () => {
  const original = new RealTerminal({ cols: 100, rows: 30, allowProposedApi: true });
  const serializer = new SerializeAddon();
  original.loadAddon(serializer);
  await new Promise(resolve => original.write("shell history\x1b[?1049h\x1b[4;8HTUI\x1b[10;12H", resolve));
  const snapshot = { cols: original.cols, rows: original.rows, serializedState: serializer.serialize() };
  original.dispose();
  const h = createDisplay({ cols: 100, rows: 30 }, {
    terminalFactory: () => new RealTerminal({ cols: 80, rows: 24, allowProposedApi: true }),
  });
  await new Promise(resolve => h.display.restoreDisplaySnapshot(snapshot, resolve));
  assert.equal(h.terminal.buffer.active.type, "alternate");
  assert.equal(h.terminal.buffer.active.getLine(3).translateToString(true), "       TUI");
  assert.deepEqual([h.terminal.buffer.active.cursorX, h.terminal.buffer.active.cursorY], [11, 9]);
  await new Promise(resolve => h.terminal.write("\x1b[?1049l", resolve));
  assert.equal(h.terminal.buffer.active.getLine(0).translateToString(true), "shell history");
  h.detachViewport();
  h.terminal.dispose();
});

test("initial replay fits the current container before releasing buffered live output", async () => {
  managerStub.resetManager();
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput({ waitForReplay: true });
  await output.ready;
  managerStub.emitOutput(delivery(frame(3, "live", 100, 25), commits));

  const replayPromise = output.completeReplay([
    frame(1, "replay", 90, 20, true),
  ]);
  await Promise.resolve();
  assert.deepEqual(events, ["resize:90x20", "write:replay"]);

  await terminal.finishNextWrite();
  assert.equal(await replayPromise, true);
  assert.deepEqual(events, [
    "resize:90x20",
    "write:replay",
    "resize:120x30",
    "scroll-bottom:0",
  ]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 120, rows: 30 }]);

  flushAnimationFrames();
  assert.deepEqual(events, [
    "resize:90x20",
    "write:replay",
    "resize:120x30",
    "scroll-bottom:0",
    "write:live",
    "scroll-bottom:0",
  ]);
  await terminal.finishNextWrite();
  assert.deepEqual(commits, [{ sequence: 3, charCount: 4 }]);
  output.dispose();
  detachViewport();
});

test("maximizing during an asynchronous replay keeps replay geometry until the PTY can follow", async () => {
  managerStub.resetManager();
  const dimensions = { cols: 100, rows: 25 };
  const h = createDisplay(dimensions);
  const output = h.display.attachPtyOutput({ waitForReplay: true });
  await output.ready;
  const replayPromise = output.completeReplay([frame(1, "prompt", 80, 24, true)]);
  await Promise.resolve();

  dimensions.cols = 180;
  dimensions.rows = 45;
  h.display.scheduleFit(true, true);
  flushAnimationFrames();
  assert.equal(h.terminal.cols, 80, "the pending historical write must use its recorded width");
  assert.equal(h.terminal.rows, 24);
  assert.deepEqual(managerStub.resizeCalls, []);

  await h.terminal.finishNextWrite();
  await replayPromise;
  flushAnimationFrames();
  assert.equal(h.terminal.cols, 180);
  assert.equal(h.terminal.rows, 45);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 180, rows: 45 }]);
  output.dispose();
  h.detachViewport();
});

test("replay ending at the visible grid still synchronizes the PTY dimensions", async () => {
  managerStub.resetManager();
  const h = createDisplay({ cols: 180, rows: 45 });
  const output = h.display.attachPtyOutput({ waitForReplay: true });
  await output.ready;
  const replayPromise = output.completeReplay([frame(1, "prompt", 180, 45, true)]);
  await h.terminal.finishNextWrite();
  await replayPromise;
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 180, rows: 45 }]);
  output.dispose();
  h.detachViewport();
});

test("real xterm finishes its async historical parser before applying the maximized grid", async () => {
  managerStub.resetManager();
  const dimensions = { cols: 80, rows: 24 };
  const h = createDisplay(dimensions, {
    terminalFactory: () => new RealTerminal({ cols: 80, rows: 24, allowProposedApi: true }),
  });
  let releaseParser;
  let parserStarted = false;
  h.terminal.parser.registerOscHandler(777, () => {
    parserStarted = true;
    return new Promise(resolve => { releaseParser = () => resolve(true); });
  });
  const output = h.display.attachPtyOutput({ waitForReplay: true });
  await output.ready;
  const replayPromise = output.completeReplay([
    frame(1, "\x1b]777;pause\x07PS E:\\Work\\CLI-Manager> ", 80, 24, true),
  ]);
  for (let i = 0; i < 100 && !parserStarted; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(parserStarted, true);
  dimensions.cols = 180;
  dimensions.rows = 45;
  windowListeners.get("resize").forEach(callback => callback());
  flushAnimationFrames();
  assert.equal(h.terminal.cols, 80);
  assert.equal(h.terminal.options.disableStdin, true);

  releaseParser();
  await replayPromise;
  flushAnimationFrames();
  assert.equal(h.terminal.cols, 180);
  assert.equal(h.terminal.rows, 45);
  assert.equal(h.terminal.buffer.active.getLine(0).translateToString(true), "PS E:\\Work\\CLI-Manager> ");
  assert.equal(h.terminal.options.disableStdin, false);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 180, rows: 45 }]);
  output.dispose();
  h.detachViewport();
  h.terminal.dispose();
});

test("actual initial daemon replay cannot send historical query responses into the attached PTY", async t => {
  managerStub.resetManager();
  const terminal = new RealTerminal({ allowProposedApi: true });
  t.after(() => terminal.dispose());
  const h = createDisplay(undefined, { terminalFactory: () => terminal });
  const input = [];
  terminal.onData(data => input.push(data));
  const output = h.display.attachPtyOutput({ waitForReplay: true });
  t.after(() => { output.dispose(); h.detachViewport(); });
  await output.ready;
  await output.completeReplay([frame(1, "history\x1b[c\x1b[6n", 90, 20, true)]);
  assert.deepEqual(input, []);
  managerStub.emitOutput(delivery(frame(3, "\x1b[c", 90, 20), []));
  flushAnimationFrames();
  await new Promise(resolve => terminal.write("", resolve));
  assert.deepEqual(input, ["\x1b[?1;2c"]);
});

test("actual reconnect reset and streamed replay suppress split queries, then restore live replies", { timeout: 4000 }, async t => {
  managerStub.resetManager();
  const terminal = new RealTerminal({ allowProposedApi: true });
  t.after(() => terminal.dispose());
  const h = createDisplay(undefined, { terminalFactory: () => terminal, isVisible: false });
  const input = [];
  terminal.onData(data => input.push(data));
  const output = h.display.attachPtyOutput();
  t.after(() => { output.dispose(); h.detachViewport(); });
  await output.ready;
  managerStub.emitOutput(delivery({ ...frame(0, "", 80, 24), kind: "reset" }, []));
  managerStub.emitOutput(delivery(frame(1, "history\x1b[", 90, 20), []));
  managerStub.emitOutput(delivery(frame(2, "c\x1b[6n", 90, 20, true), []));
  for (let i = 0; i < 3; i++) {
    flushAnimationFrames();
    await new Promise(resolve => terminal.write("", resolve));
  }
  assert.deepEqual(input, []);
  assert.equal(terminal.options.disableStdin, false);
  managerStub.emitOutput(delivery(frame(3, "\x1b[c", 90, 20), []));
  flushAnimationFrames();
  await new Promise(resolve => terminal.write("", resolve));
  assert.deepEqual(input, ["\x1b[?1;2c"]);
});

test("reconnect replay restores historical sizes serially and fits before live output", async () => {
  managerStub.resetManager();
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput();
  await output.ready;

  managerStub.emitOutput(delivery(frame(1, "one", 90, 20), commits));
  managerStub.emitOutput(delivery(frame(2, "two", 100, 25, true), commits));
  managerStub.emitOutput(delivery(frame(3, "live", 100, 25), commits));

  flushAnimationFrames();
  assert.deepEqual(events, ["resize:90x20", "write:one"]);
  await terminal.finishNextWrite();
  flushAnimationFrames();
  assert.deepEqual(events, ["resize:90x20", "write:one", "resize:100x25", "write:two"]);
  await terminal.finishNextWrite();
  assert.deepEqual(events, [
    "resize:90x20",
    "write:one",
    "resize:100x25",
    "write:two",
    "resize:120x30",
    "scroll-bottom:0",
  ]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 120, rows: 30 }]);

  flushAnimationFrames();
  assert.deepEqual(events.slice(-2), ["write:live", "scroll-bottom:0"]);
  await terminal.finishNextWrite();
  assert.deepEqual(commits, [
    { sequence: 1, charCount: 3 },
    { sequence: 2, charCount: 3 },
    { sequence: 3, charCount: 4 },
  ]);
  output.dispose();
  detachViewport();
});

test("resize-only reconnect replay is applied locally before current-size fit", async () => {
  managerStub.resetManager();
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput();
  await output.ready;

  managerStub.emitOutput(delivery(frame(2, "", 100, 25, true), commits));
  managerStub.emitOutput(delivery(frame(3, "live", 100, 25), commits));
  flushAnimationFrames();

  assert.deepEqual(events, [
    "resize:100x25",
    "resize:120x30",
    "scroll-bottom:0",
    "write:live",
    "scroll-bottom:0",
  ]);
  assert.deepEqual(managerStub.resizeCalls, [{ sessionId: "session-1", cols: 120, rows: 30 }]);
  assert.deepEqual(commits, [{ sequence: 2, charCount: 0 }]);
  await terminal.finishNextWrite();
  assert.deepEqual(commits, [
    { sequence: 2, charCount: 0 },
    { sequence: 3, charCount: 4 },
  ]);
  output.dispose();
  detachViewport();
});

test("continuous live output yields between bounded xterm writes", async () => {
  managerStub.resetManager();
  const { display, terminal, events, detachViewport } = createDisplay();
  const commits = [];
  const output = display.attachPtyOutput();
  await output.ready;
  const firstText = "a".repeat(40 * 1024);
  const secondText = "b".repeat(40 * 1024);

  managerStub.emitOutput(delivery(frame(3, firstText, 120, 30), commits));
  managerStub.emitOutput(delivery(frame(4, secondText, 120, 30), commits));
  flushNextAnimationFrame();

  assert.deepEqual(events, [`write:${firstText}`]);
  assert.deepEqual(commits, []);
  await terminal.finishNextWrite();
  assert.deepEqual(commits, [
    { sequence: 3, charCount: firstText.length },
  ]);
  flushNextAnimationFrame();
  assert.deepEqual(events, [`write:${firstText}`, `write:${secondText}`]);
  await terminal.finishNextWrite();
  assert.deepEqual(commits, [
    { sequence: 3, charCount: firstText.length },
    { sequence: 4, charCount: secondText.length },
  ]);
  output.dispose();
  detachViewport();
});

test("multiple terminals start output together while each terminal waits for its own parser", async () => {
  managerStub.resetManager();
  const first = createDisplay(undefined, { sessionId: "session-1" });
  const second = createDisplay(undefined, { sessionId: "session-2" });
  const firstOutput = first.display.attachPtyOutput();
  const secondOutput = second.display.attachPtyOutput();
  await Promise.all([firstOutput.ready, secondOutput.ready]);

  managerStub.emitOutput(delivery(frame(1, "first", 120, 30), []), "session-1");
  managerStub.emitOutput(delivery(frame(1, "second", 120, 30), []), "session-2");
  flushNextAnimationFrame();

  const writeCount = [...first.events, ...second.events]
    .filter((event) => event.startsWith("write:"))
    .length;
  assert.equal(writeCount, 2);
  assert.equal(first.terminal.writeCallbacks.length, 1);
  assert.equal(second.terminal.writeCallbacks.length, 1);
  managerStub.emitOutput(delivery(frame(3, "more-first", 120, 30), []), "session-1");
  flushNextAnimationFrame();
  assert.equal(first.terminal.writeCallbacks.length, 1);
  assert.equal(first.events.filter((event) => event.startsWith("write:")).length, 1);
  await first.terminal.finishNextWrite();
  flushNextAnimationFrame();
  assert.equal(first.events.filter((event) => event.startsWith("write:")).length, 2);
  await first.terminal.finishNextWrite();
  await second.terminal.finishNextWrite();
  firstOutput.dispose();
  secondOutput.dispose();
  first.detachViewport();
  second.detachViewport();
});

test("hidden terminal is not starved by continuous visible output", async () => {
  managerStub.resetManager();
  const visible = createDisplay(undefined, { sessionId: "visible", isVisible: true });
  const hidden = createDisplay(undefined, { sessionId: "hidden", isVisible: false });
  const visibleOutput = visible.display.attachPtyOutput();
  const hiddenOutput = hidden.display.attachPtyOutput();
  await Promise.all([visibleOutput.ready, hiddenOutput.ready]);
  const visibleCommits = [];
  const hiddenCommits = [];

  for (let sequence = 1; sequence <= 4; sequence += 1) {
    managerStub.emitOutput(
      delivery(frame(sequence, String(sequence).repeat(40 * 1024), 120, 30), visibleCommits),
      "visible",
    );
  }
  managerStub.emitOutput(delivery(frame(1, "background", 120, 30), hiddenCommits), "hidden");

  flushNextAnimationFrame();
  assert.deepEqual(
    hidden.events.filter((event) => event.startsWith("write:")),
    ["write:background"],
  );
  await hidden.terminal.finishNextWrite();
  assert.deepEqual(hiddenCommits, [{ sequence: 1, charCount: 10 }]);
  for (let index = 0; index < 4; index += 1) {
    await visible.terminal.finishNextWrite();
    flushNextAnimationFrame();
  }
  assert.equal(visibleCommits.length, 4);

  visibleOutput.dispose();
  hiddenOutput.dispose();
  visible.detachViewport();
  hidden.detachViewport();
});


test("snapshot dirtiness follows parsed output and ACKs, never the external pending queue", async () => {
  managerStub.resetManager();
  snapshotStub.dirtyMarks.length = 0;
  const h = createDisplay(undefined, { sessionId: "snapshot-boundary", isVisible: false });
  const output = h.display.attachPtyOutput();
  await output.ready;
  const commits = [];
  managerStub.emitOutput(delivery(frame(1, "a".repeat(40 * 1024), 120, 30), commits), "snapshot-boundary");
  managerStub.emitOutput(delivery(frame(2, "b".repeat(40 * 1024), 120, 30), commits), "snapshot-boundary");
  assert.deepEqual(snapshotStub.dirtyMarks, [], "receiving a queued frame must not mark a picture ready");
  flushNextAnimationFrame();
  assert.deepEqual(snapshotStub.dirtyMarks, [], "a submitted but unparsed write is still not in the picture");
  await h.terminal.finishNextWrite();
  assert.equal(commits.length, 1);
  assert.deepEqual(snapshotStub.dirtyMarks, [{ sessionId: "snapshot-boundary", bytes: 40 * 1024 }]);
  snapshotStub.dirtyMarks.length = 0; // model a periodic snapshot of the first parsed write
  flushNextAnimationFrame();
  await h.terminal.finishNextWrite();
  assert.equal(commits.length, 2);
  assert.deepEqual(snapshotStub.dirtyMarks, [{ sessionId: "snapshot-boundary", bytes: 40 * 1024 }],
    "the later parsed write needs another save even if its receive event preceded the prior save");
  output.dispose();
  h.detachViewport();
});


test("a quiet daemon replay and resize-only replay still schedule persistence", async () => {
  for (const text of ["restored without new live output", ""]) {
    managerStub.resetManager();
    snapshotStub.dirtyMarks.length = 0;
    const h = createDisplay(undefined, { sessionId: "quiet-replay", isVisible: false });
    const output = h.display.attachPtyOutput({ waitForReplay: true });
    await output.ready;
    const replay = output.completeReplay([frame(7, text, 120, 30, "replay")]);
    if (text) await h.terminal.finishNextWrite();
    await replay;
    assert.ok(snapshotStub.dirtyMarks.some(mark => mark.sessionId === "quiet-replay"));
    assert.equal(snapshotStub.dirtyMarks.reduce((sum, mark) => sum + mark.bytes, 0), 0,
      "historical replay should not count again toward the new-output byte threshold");
    output.dispose();
    h.detachViewport();
  }
});

test("resizing an otherwise idle display makes its new geometry eligible for persistence", () => {
  snapshotStub.dirtyMarks.length = 0;
  const h = createDisplay(undefined, { sessionId: "idle-resize" });
  h.terminal.resize(100, 35);
  assert.deepEqual(snapshotStub.dirtyMarks, [{ sessionId: "idle-resize", bytes: 0 }]);
  h.detachViewport();
});

test("production reset and resize-only replay defer their ACK and mouse changes until capture releases", { timeout: 4000 }, async t => {
  managerStub.resetManager();
  const { installTerminalMutationGate } = await import(pathToFileURL(join(tempDir, "terminalMutationGate.mjs")).href);
  const { trackTerminalMouseProtocol } = await import(pathToFileURL(join(tempDir, "terminalReplayWriter.mjs")).href);
  const h = createDisplay(undefined, {
    isVisible: false,
    terminalFactory: () => new RealTerminal({ cols: 80, rows: 24, allowProposedApi: true }),
  });
  const protocol = trackTerminalMouseProtocol(h.terminal);
  const gate = installTerminalMutationGate(h.terminal);
  const output = h.display.attachPtyOutput();
  t.after(() => { output.dispose(); gate.dispose(); protocol.dispose(); h.detachViewport(); h.terminal.dispose(); });
  await output.ready;
  await new Promise(resolve => h.terminal.write("old screen\x1b[?1006h", resolve));
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = gate.capture(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, new AbortController().signal);
  await started;
  const commits = [];
  managerStub.emitOutput(delivery({ ...frame(0, "", 90, 25), kind: "reset" }, commits));
  managerStub.emitOutput(delivery(frame(1, "", 100, 30, true), commits));
  flushAnimationFrames();
  assert.equal(h.terminal.cols, 80);
  assert.equal(h.terminal.buffer.active.getLine(0).translateToString(true), "old screen");
  assert.equal(protocol.snapshotSuffix(), "\x1b[?1006h");
  assert.deepEqual(commits, []);
  release(); await held;
  for (let i = 0; i < 12; i++) await Promise.resolve();
  flushAnimationFrames();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(h.terminal.cols, 100);
  assert.equal(h.terminal.rows, 30);
  assert.equal(h.terminal.buffer.active.getLine(0).translateToString(true), "");
  assert.equal(protocol.snapshotSuffix(), "\x1b[?1006l");
  assert.deepEqual(commits.map(entry => entry.sequence), [0, 1]);
});

test("production initial resize-only replay cannot acknowledge a grid still held by a snapshot", { timeout: 4000 }, async t => {
  managerStub.resetManager();
  const { installTerminalMutationGate } = await import(pathToFileURL(join(tempDir, "terminalMutationGate.mjs")).href);
  const h = createDisplay(undefined, {
    isVisible: false,
    terminalFactory: () => new RealTerminal({ cols: 80, rows: 24, allowProposedApi: true }),
  });
  const gate = installTerminalMutationGate(h.terminal);
  const output = h.display.attachPtyOutput({ waitForReplay: true });
  t.after(() => { output.dispose(); gate.dispose(); h.detachViewport(); h.terminal.dispose(); });
  await output.ready;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = gate.capture(async () => { entered(); await new Promise(resolve => { release = resolve; }); }, new AbortController().signal);
  await started;
  // An earlier queued fit must not make the replay skip its recorded grid just
  // because it currently equals the still-frozen terminal's dimensions.
  h.terminal.resize(110, 31);
  const replay = output.completeReplay([frame(2, "", 80, 24, true)]);
  await Promise.resolve();
  assert.equal(h.terminal.cols, 80);
  assert.deepEqual(managerStub.replayAcknowledgments, []);
  release(); await held; await replay;
  assert.equal(h.terminal.cols, 80);
  assert.equal(h.terminal.rows, 24);
  assert.equal(managerStub.replayAcknowledgments.at(-1).sequence, 2);
});
