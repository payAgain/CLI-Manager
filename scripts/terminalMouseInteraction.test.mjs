import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const tempDir = mkdtempSync(join(tmpdir(), "cli-manager-terminal-mouse-"));
process.on("exit", () => rmSync(tempDir, { recursive: true, force: true }));

const source = readFileSync(
  new URL("../src/terminal/browser/TerminalMouseInteraction.ts", import.meta.url),
  "utf8",
);
const replayPath = join(tempDir, "terminalReplayWriter.mjs");
writeFileSync(replayPath, ts.transpileModule(readFileSync(new URL("../src/lib/terminalReplayWriter.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "TerminalMouseInteraction.ts",
}).outputText.replace('"../../lib/terminalReplayWriter"', '"./terminalReplayWriter.mjs"');
const modulePath = join(tempDir, "TerminalMouseInteraction.mjs");
writeFileSync(modulePath, transpiled, "utf8");

const { attachTerminalHistoryWheel, attachTerminalTuiWheel, createTerminalMouseInteractionOptions } = await import(
  pathToFileURL(modulePath).href
);
const { trackTerminalMouseProtocol, writeTerminalReplay } = await import(pathToFileURL(replayPath).href);
const { createRequire } = await import("node:module");
const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

async function wheelTerminal(t, modes) {
  const terminal = new Terminal({ cols: 80, rows: 10, scrollback: 100, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const listeners = new Map();
  // Use the actual xterm buffer/parser and scrolling; only the DOM event target is stubbed.
  terminal._core.element = {
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: type => listeners.delete(type),
  };
  const protocol = trackTerminalMouseProtocol(terminal);
  t.after(() => protocol.dispose());
  await new Promise(resolve => writeTerminalReplay(terminal,
    Array.from({ length: 70 }, (_, i) => `line ${i}\r\n`).join("") + modes, resolve));
  const attachment = attachTerminalHistoryWheel(terminal);
  t.after(() => attachment.dispose());
  return { terminal, attachment, listeners, wheel(overrides = {}) {
    const event = { deltaY: -3, deltaX: 0, deltaMode: 1, ctrlKey: false, metaKey: false, shiftKey: false,
      defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; },
      ...overrides };
    listeners.get("wheel")?.(event);
    return event;
  } };
}

test("quarantined old Agent mouse modes scroll actual local history instead of swallowing the wheel", async t => {
  const h = await wheelTerminal(t, "\x1b[?1003h");
  const before = h.terminal.buffer.active.viewportY;
  const event = h.wheel();
  assert.equal(h.terminal.buffer.active.viewportY, before - 3);
  assert.equal(event.stopped, true);
  assert.equal(event.defaultPrevented, true);
  h.wheel({ deltaY: 2 });
  assert.equal(h.terminal.buffer.active.viewportY, before - 1);
});

test("live mouse-aware TUIs keep the wheel and Shift allows inspection of local history", async t => {
  const h = await wheelTerminal(t, "\x1b[?1003h\x1b[?1006h");
  const before = h.terminal.buffer.active.viewportY;
  assert.equal(h.wheel().defaultPrevented, false);
  assert.equal(h.terminal.buffer.active.viewportY, before);
  assert.equal(h.wheel({ shiftKey: true }).stopped, true);
  assert.equal(h.terminal.buffer.active.viewportY, before - 3);
});

test("trackpad fractions accumulate, direction changes reset them, and Ctrl zoom remains untouched", async t => {
  const h = await wheelTerminal(t, "\x1b[?1003h");
  const before = h.terminal.buffer.active.viewportY;
  for (let i = 0; i < 4; i++) h.wheel({ deltaY: -0.3 });
  assert.equal(h.terminal.buffer.active.viewportY, before - 1);
  h.wheel({ deltaY: 0.8 });
  assert.equal(h.terminal.buffer.active.viewportY, before - 1);
  h.wheel({ deltaY: 0.3 });
  assert.equal(h.terminal.buffer.active.viewportY, before);
  assert.equal(h.wheel({ ctrlKey: true }).defaultPrevented, false);
  h.attachment.dispose();
  assert.equal(h.listeners.size, 0);
});

test("alternate-screen applications are not converted to local history scrolling", async t => {
  const h = await wheelTerminal(t, "\x1b[?1049h\x1b[?1003h");
  assert.equal(h.terminal.buffer.active.type, "alternate");
  assert.equal(h.wheel().defaultPrevented, false);
});

class TestWheelEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    for (const key of ["deltaX", "deltaY", "deltaZ", "deltaMode", "clientX", "clientY", "screenX", "screenY", "altKey", "ctrlKey", "shiftKey", "metaKey"]) {
      this[key] = init[key] ?? (key.endsWith("Key") ? false : 0);
    }
  }
}

class TestDomEventTarget extends EventTarget {
  removeEventListener(type, listener, options) {
    // Node 22's EventTarget does not normalize a boolean capture option like a
    // browser does. Preserve DOM removal semantics for the terminal fixture.
    super.removeEventListener(type, listener, typeof options === "boolean" ? { capture: options } : options);
  }
}

async function tuiWheelTerminal(t, modes, initialMultiplier = 3) {
  const terminal = new Terminal({ cols: 80, rows: 10, allowProposedApi: true });
  t.after(() => terminal.dispose());
  const element = new TestDomEventTarget();
  element.ownerDocument = { defaultView: { WheelEvent: TestWheelEvent } };
  terminal._core.element = element;
  const protocol = trackTerminalMouseProtocol(terminal);
  t.after(() => protocol.dispose());
  await new Promise(resolve => writeTerminalReplay(terminal, modes, resolve));
  const options = { multiplier: initialMultiplier };
  const attachment = attachTerminalTuiWheel(terminal, () => options.multiplier);
  t.after(() => attachment.dispose());
  const delivered = [];
  element.addEventListener("wheel", event => delivered.push(event));
  return { terminal, options, attachment, delivered, wheel(overrides = {}) {
    delivered.length = 0;
    const event = new TestWheelEvent("wheel", { deltaY: -90, deltaMode: 0, clientX: 135, clientY: 72,
      bubbles: true, cancelable: true, ...overrides });
    element.dispatchEvent(event);
    return event;
  } };
}

test("TUI wheel repeats enter xterm's own event path with original direction, coordinates and pixel fractions", async t => {
  const h = await tuiWheelTerminal(t, "\x1b[?1003h\x1b[?1006h");
  h.wheel({ deltaY: -0.4, altKey: true });
  assert.equal(h.delivered.length, 3);
  assert.deepEqual(h.delivered.map(e => [e.deltaY, e.deltaMode, e.clientX, e.clientY, e.altKey]), Array(3).fill([-0.4, 0, 135, 72, true]));
  h.options.multiplier = 5;
  h.wheel({ deltaY: 2, deltaMode: 1 });
  assert.equal(h.delivered.length, 5, "speed updates without recreating the terminal");
  assert.ok(h.delivered.every(e => e.deltaY === 2 && e.deltaMode === 1));
});

test("TUI speed leaves normal history and modifier gestures untouched", async t => {
  const h = await tuiWheelTerminal(t, "\x1b[?1003h\x1b[?1006h");
  for (const modifier of ["ctrlKey", "metaKey", "shiftKey"]) {
    const original = h.wheel({ [modifier]: true });
    assert.deepEqual(h.delivered, [original]);
    assert.equal(original.defaultPrevented, false);
  }
  await new Promise(resolve => h.terminal.write("\x1b[?1003l", resolve));
  const original = h.wheel();
  assert.deepEqual(h.delivered, [original]);
});

test("1x, invalid values and disposal preserve original wheel delivery; excessive values are bounded", async t => {
  const h = await tuiWheelTerminal(t, "\x1b[?1049h");
  for (const value of [1, 0, -2, Number.NaN]) {
    h.options.multiplier = value;
    const original = h.wheel();
    assert.deepEqual(h.delivered, [original]);
  }
  h.options.multiplier = 999;
  h.wheel();
  assert.equal(h.delivered.length, 10);
  h.attachment.dispose();
  const original = h.wheel();
  assert.deepEqual(h.delivered, [original]);
});

test("old quarantined mouse modes never gain new live reports through wheel acceleration", async t => {
  const h = await tuiWheelTerminal(t, "\x1b[?1049h\x1b[?1003h");
  const original = h.wheel();
  assert.deepEqual(h.delivered, [original]);
  assert.equal(original.defaultPrevented, false);
});

test("mouse-aware TUIs receive unmodified click and drag reports", () => {
  assert.deepEqual(createTerminalMouseInteractionOptions(), {
    mouseEventsRequireAlt: false,
  });
});

test("XTermTerminal delegates mouse policy to the browser module", () => {
  const terminalComponentSource = readFileSync(
    new URL("../src/components/XTermTerminal.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    terminalComponentSource,
    /\.\.\.createTerminalMouseInteractionOptions\(\)/,
  );
  assert.doesNotMatch(terminalComponentSource, /mouseEventsRequireAlt/);
});
