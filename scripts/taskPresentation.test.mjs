import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/taskPresentation.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } });
const { compareTaskActivity, taskProgress, backgroundTaskStatus } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
);

test("work needing action stays above running tasks and recent completed records", () => {
  const tasks = [
    { id: "finished", status: "done", updatedAt: 1000 },
    { id: "running-old", status: "running", updatedAt: 5 },
    { id: "failed", status: "failed", updatedAt: 8 },
    { id: "attention", status: "attention", updatedAt: 9 },
    { id: "running-new", status: "running", updatedAt: 10 },
    { id: "pending", status: "pending", updatedAt: 50 },
  ];
  const original = tasks.map(task => ({ ...task }));
  assert.deepEqual([...tasks].sort(compareTaskActivity).map(task => task.id), ["attention", "failed", "running-new", "running-old", "pending", "finished"]);
  assert.deepEqual(tasks, original);
});

test("a new task state moves the same record without changing equal-priority order", () => {
  const tasks = [
    { id: "first", status: "running", updatedAt: 10 },
    { id: "second", status: "running", updatedAt: 10 },
    { id: "third", status: "done", updatedAt: 20 },
  ];
  assert.deepEqual([...tasks].sort(compareTaskActivity).map(task => task.id), ["first", "second", "third"]);
  tasks[2].status = "failed";
  assert.deepEqual([...tasks].sort(compareTaskActivity).map(task => task.id), ["third", "first", "second"]);
});

test("only known finite progress becomes a percentage, including real zero", () => {
  for (const value of [null, undefined, NaN, Infinity, -Infinity]) assert.equal(taskProgress(value), null);
  assert.equal(taskProgress(0), 0);
  assert.equal(taskProgress(62.5), 62.5);
  assert.equal(taskProgress(-1), 0);
  assert.equal(taskProgress(101), 100);
});

test("daemon lifecycle fallback never overwrites a known task result or request for attention", () => {
  for (const taskStatus of ["running", "attention", "done", "failed"]) {
    for (const alive of [true, false]) assert.equal(backgroundTaskStatus({ taskStatus, alive }), taskStatus);
  }
  for (const taskStatus of [undefined, null, "none", "unrecognized"]) {
    assert.equal(backgroundTaskStatus({ taskStatus, alive: true }), "running");
    assert.equal(backgroundTaskStatus({ taskStatus, alive: false }), "done");
  }
});
