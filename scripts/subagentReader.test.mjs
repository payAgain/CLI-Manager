import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const source = readFileSync(new URL("../src/lib/subagentTranscript.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } });
const { parseSubagentTranscript, mergeSubagentMessages, buildSubagentReaderSections: sections } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
);
const message = (role, text) => ({ type: "response_item", payload: { type: "message", role, content: [{ type: "input_text", text }] } });
const reasoning = text => ({ type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text }] } });
const tool = (id, output) => ({ type: "response_item", payload: output === undefined
  ? { type: "function_call", call_id: id, name: "read_file", arguments: '{"path":"src/components/TerminalTabs.tsx"}' }
  : { type: "function_call_output", call_id: id, output } });
const lines = records => records.map(record => JSON.stringify(record)).join("\n") + "\n";
const flatten = rows => rows.flatMap(row => row.kind === "task" ? [row.message] : row.parts.flatMap(part => part.messages));
const chronology = [
  message("user", "Compare terminal and workspace behavior"),
  reasoning("Inspect source directories"), tool("read-1"), tool("read-1", "Flat source layout"),
  message("assistant", "HEAD uses a flat layout. Let me read upstream entry points."),
  message("assistant", "This additional explanation belongs to the same response."),
  reasoning("Inspect the upstream feature modules"), tool("read-2"), tool("read-2", "Feature modules located"),
  message("assistant", "Upstream groups the implementation into features."),
  reasoning("Check the matching behavior before concluding"),
  message("assistant", "## Findings\n\n**Retained:** panes, tabs, and PTY sessions.\n\n```ts\nconst pane = true;\n```\n\n| Area | Result |\n| --- | --- |\n| PTY | Retained |"),
];

test("a task has one continuous answer with all intermediate text around its evidence", () => {
  const parsed = mergeSubagentMessages([], parseSubagentTranscript(lines(chronology)).messages);
  const rows = sections(parsed);
  assert.deepEqual(rows.map(row => row.kind), ["task", "response"]);
  assert.deepEqual(rows[1].parts.map(part => part.kind), ["activity", "text", "activity", "text", "activity", "text"]);
  assert.equal(rows[1].parts[1].messages.length, 2, "consecutive assistant fragments share a text run without repeated role headings");
  assert.deepEqual(flatten(rows), parsed, "no intermediate response, thought, tool output or Markdown content is discarded");
});

test("real user follow-ups start a new task and never merge two answers", () => {
  const parsed = mergeSubagentMessages([], parseSubagentTranscript(lines([
    ...chronology, message("user", "Now check WSL session restore"), message("assistant", "WSL keeps its distribution boundary."),
  ])).messages);
  const rows = sections(parsed);
  assert.deepEqual(rows.map(row => row.kind), ["task", "response", "task", "response"]);
  assert.equal(rows[3].parts[0].messages[0].text, "WSL keeps its distribution boundary.");
  assert.deepEqual(flatten(rows), parsed);
});

test("incremental tools and assistant appends retain section, process and fragment anchors", () => {
  let cursor;
  let nextId = 1;
  let messages = [];
  let responseId;
  let processId;
  for (const record of chronology) {
    const parsed = parseSubagentTranscript(lines([record]), nextId, cursor);
    cursor = parsed.cursor;
    nextId = parsed.nextId;
    messages = mergeSubagentMessages(messages, parsed.messages);
    const rows = sections(messages);
    assert.deepEqual(flatten(rows), messages);
    const response = rows.find(row => row.kind === "response");
    if (!response) continue;
    responseId ??= response.id;
    processId ??= response.parts[0].id;
    assert.equal(response.id, responseId, "the answer component keeps manual folding state as more fragments arrive");
    assert.equal(response.parts[0].id, processId, "pending tool results update their existing process disclosure");
    for (const part of response.parts) assert.equal(part.id, part.messages[0].id);
  }
  const firstProcess = sections(messages)[1].parts[0];
  assert.equal(firstProcess.pendingCount, 0);
  assert.equal(firstProcess.messages[1].output, "Flat source layout");
});

test("partial or capped transcripts preserve leading evidence instead of inventing a task", () => {
  const messages = mergeSubagentMessages([], parseSubagentTranscript(lines(chronology.slice(1))).messages);
  const rows = sections(messages);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "response");
  assert.equal(rows[0].parts[0].kind, "activity");
  assert.deepEqual(flatten(rows), messages);
});

test("the render cap cannot remount an answer and reset the reader's manual folding", () => {
  const messages = mergeSubagentMessages([], parseSubagentTranscript(lines(chronology)).messages);
  const original = sections(messages);
  const answerId = original[1].id;
  const cappedMessages = messages.slice(4);
  const capped = sections(cappedMessages, original);
  assert.equal(capped[0].kind, "response");
  assert.equal(capped[0].id, answerId, "overlapping original message identities retain the answer disclosure key");
  assert.equal(capped[0].parts[0].id, original[1].parts[1].id, "a capped text run keeps surviving message components mounted");
  assert.deepEqual(flatten(capped), cappedMessages);
  const furtherCapped = sections(cappedMessages.slice(1), capped);
  assert.equal(furtherCapped[0].id, answerId);
  assert.equal(furtherCapped[0].parts[0].id, original[1].parts[2].id, "the next surviving process disclosure also keeps its original key");
  assert.deepEqual(flatten(furtherCapped), cappedMessages.slice(1));
});

test("building reader sections never mutates the parse cache or source messages", () => {
  const messages = mergeSubagentMessages([], parseSubagentTranscript(lines(chronology)).messages);
  messages.forEach(Object.freeze);
  Object.freeze(messages);
  assert.deepEqual(flatten(sections(messages)), messages);
});
