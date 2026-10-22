import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/subagentPresentation.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } });
const { resolveSubagentPresentation: present, subagentTaskSummary: summary } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
);
const base = { agentId: "a9b8e57a73cccf47e", fallbackTitle: "Subagent" };

test("machine IDs stay secondary even inside legacy generated titles", () => {
  const generatedTitle = `${base.agentId} (Compare upstream)`;
  const session = { title: generatedTitle, subagent: { agentId: base.agentId, generatedTitle, agentType: base.agentId } };
  assert.deepEqual(present({ ...base, session, recordTitle: base.agentId }), { title: "Subagent", shortId: "a9b8e57a…" });
  assert.equal(present({ ...base, session, taskSummary: "Check terminal lifecycle" }).title, "Check terminal lifecycle");
});

test("a user rename wins over late lifecycle nicknames and task previews", () => {
  const session = { title: "My review", subagent: { generatedTitle: "Explore (Parent)", agentType: "Explore" } };
  assert.equal(present({ ...base, session, nickname: "Feynman", taskSummary: "Inspect sources" }).title, "My review");
  assert.equal(present({ ...base, session: { ...session, title: "Explore (Parent)" }, nickname: "Feynman" }).title, "Feynman");
});

test("discovered task titles and real agent names remain readable without parent duplication", () => {
  assert.equal(present({ ...base, recordTitle: "检查任务栏的焦点状态" }).title, "检查任务栏的焦点状态");
  assert.equal(present({ ...base, session: { title: "Explore (Parent)", subagent: { generatedTitle: "Explore (Parent)", agentType: "Explore" } } }).title, "Explore");
  assert.equal(present({ ...base, agentId: "abc" }).shortId, "abc");
});

test("task previews remove Markdown styling and reject injected context headers", () => {
  assert.equal(summary("\n## Inspect **terminal** `focus`\nFull details"), "Inspect terminal focus");
  for (const text of ["<environment_context>\nMetadata", "# AGENTS.md instructions", "You are an AI assistant", ""]) assert.equal(summary(text), undefined);
});

test("repository environment prefaces cannot become generated task identities", () => {
  const context = "Repo: E:\\Work\\CLI-Manager\nBranch: master";
  assert.equal(summary(context), undefined);
  assert.equal(summary(`${context}\n\nCompare the upstream terminal implementation`), "Compare the upstream terminal implementation");
  assert.equal(summary("Repo: inspect how project paths are resolved"), "Repo: inspect how project paths are resolved");
  const session = { title: `${context.split("\n")[0]} (Parent)`, subagent: { generatedTitle: `${context.split("\n")[0]} (Parent)`, agentType: context.split("\n")[0] } };
  assert.equal(present({ ...base, session, recordTitle: context.split("\n")[0] }).title, "Subagent");
});
