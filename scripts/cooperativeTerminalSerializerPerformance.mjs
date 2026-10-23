// Real xterm buffers, Node CPU/task experiment; this does not measure desktop FPS.
// Run: node --expose-gc scripts/cooperativeTerminalSerializerPerformance.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import ts from "typescript";
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/xterm");
const { SerializeAddon } = require("@xterm/addon-serialize");
const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/cooperativeTerminalSerializer.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const api = {};
new Function("exports", compiled)(api);
const round = n => Number(n.toFixed(3));
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, cols: 120, rows: 32, attempts: 5 }));
for (const scrollback of [9000, 50000]) {
  const terminal = new Terminal({ cols: 120, rows: 32, scrollback, allowProposedApi: true });
  const addon = new SerializeAddon(); terminal.loadAddon(addon);
  const payload = Array.from({ length: scrollback + 32 }, (_, i) => `\x1b[32m${String(i).padStart(6)}\x1b[0m ${"output 中文 abcdef ".repeat(5)}`).join("\r\n");
  await new Promise(resolve => terminal.write(payload, resolve));
  const expected = addon.serialize();
  await api.createTerminalSerialization(terminal).run();
  const samples = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    global.gc?.();
    let start = performance.now();
    assert.equal(addon.serialize(), expected);
    const syncMs = performance.now() - start;
    global.gc?.();
    const slices = [];
    const job = api.createTerminalSerialization(terminal, undefined, {
      // setImmediate represents a real Node task. Wrapping each continuation
      // measures just the serializer's processing slice, including final join.
      scheduleTask(callback) {
        const handle = setImmediate(() => {
          const sliceStart = performance.now(); callback(); slices.push(performance.now() - sliceStart);
        });
        return () => clearImmediate(handle);
      },
    });
    start = performance.now();
    const sliceStart = performance.now();
    const running = job.run();
    slices.push(performance.now() - sliceStart);
    const value = await running;
    const slicedWallMs = performance.now() - start;
    assert.equal(value, expected);
    global.gc?.();
    let lastHeartbeat = performance.now();
    const heartbeatGaps = [];
    const timer = setInterval(() => {
      const tick = performance.now(); heartbeatGaps.push(tick - lastHeartbeat); lastHeartbeat = tick;
    }, 1);
    start = performance.now();
    assert.equal(await api.createTerminalSerialization(terminal).run(), expected);
    const defaultWallMs = performance.now() - start;
    heartbeatGaps.push(performance.now() - lastHeartbeat);
    clearInterval(timer);
    const sorted = [...slices].sort((a, b) => a - b);
    samples.push({ syncMs: round(syncMs), slicedWallMs: round(slicedWallMs), slicedCpuMs: round(slices.reduce((a,b) => a+b, 0)), slices: slices.length,
      maxSliceMs: round(sorted.at(-1)), p95SliceMs: round(sorted[Math.floor(sorted.length * 0.95)]), finalSliceMs: round(slices.at(-1)),
      defaultWallMs: round(defaultWallMs), heartbeats: heartbeatGaps.length, maxHeartbeatGapMs: round(Math.max(...heartbeatGaps)) });
  }
  console.log(JSON.stringify({ scrollback, lines: terminal.buffer.normal.length, snapshotBytes: Buffer.byteLength(expected), samples,
    medians: Object.fromEntries(Object.keys(samples[0]).map(key => [key, round(median(samples.map(sample => sample[key])))])) }));
  terminal.dispose();
}
