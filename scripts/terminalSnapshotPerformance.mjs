// Local CPU/cell-scan experiment; no browser, rendering or transport timing is claimed.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/terminalReplayWriter.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const api = {};
new Function("exports", compiled)(api);
const median = numbers => numbers.sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
function oldTail(text) {
  let count = 0;
  for (let i = text.length - 1; i >= 0; i--) if (text.charCodeAt(i) === 10 && ++count >= 2000) return text.slice(i + 1);
  return text;
}
function measure(run, count) {
  const samples = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    const start = performance.now();
    for (let i = 0; i < count; i++) run();
    samples.push(performance.now() - start);
  }
  return Number(median(samples).toFixed(3));
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, cols: 120, rows: 32 }));
for (const scrollback of [9000, 50000]) {
  const terminal = new Terminal({ cols: 120, rows: 32, scrollback, allowProposedApi: true });
  const protocol = api.trackTerminalMouseProtocol(terminal);
  const addon = new SerializeAddon();
  terminal.loadAddon(addon);
  const payload = Array.from({ length: scrollback + 32 }, (_, i) => `\x1b[32m${String(i).padStart(6)}\x1b[0m ${"output 中文 abcdef ".repeat(5)}`).join("\r\n");
  await new Promise(resolve => terminal.write(payload, resolve));
  const serialize = value => protocol.serializeSnapshot(addon, { scrollback: value });
  const baseline = () => oldTail(serialize());
  const tail = () => api.serializeTerminalSnapshots(terminal, serialize, 2000, false);
  const full = () => api.serializeTerminalSnapshots(terminal, serialize, 2000, true);
  baseline(); tail(); full();
  const prototype = Object.getPrototypeOf(terminal.buffer.normal.getLine(0));
  const original = prototype.getCell;
  let cells = 0;
  prototype.getCell = function(...args) { cells++; return original.apply(this, args); };
  baseline(); const beforeCells = cells;
  cells = 0; tail(); const tailCells = cells;
  cells = 0; full(); const fullCells = cells;
  prototype.getCell = original;
  console.log(JSON.stringify({ scrollback, bufferLines: terminal.buffer.normal.length, beforeCells, tailCells, fullCells,
    singleBeforeMs: measure(baseline, 1), singleTailMs: measure(tail, 1), singleFullAndTailMs: measure(full, 1) }));
  for (const count of [10, 30, 60]) {
    // Repeated scans of the same real xterm buffer isolate CPU; this does not
    // allocate N renderers or claim a desktop frame/latency measurement.
    console.log(JSON.stringify({ scrollback, count, sequentialBeforeMs: measure(baseline, count), sequentialTailMs: measure(tail, count) }));
  }
  protocol.dispose(); terminal.dispose();
}
