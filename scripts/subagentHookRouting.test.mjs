import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function load(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022,
  } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}
const { routeSubagentHook } = await load("../src/lib/subagentHookRouting.ts");
const { resolveCliHookTarget } = await load("../src/stores/terminalHookBinding.ts");
const event = (overrides = {}) => ({
  source: "codex", event: "SubagentStart", tabId: "old-tab", sessionId: "parent-thread",
  agentId: "child-thread", cwd: "E:/work/project", ...overrides,
});
function harness(candidates = [{ id: "restored-pane", source: "codex", cliSessionId: "parent-thread", paths: ["E:/work/project"] }]) {
  const calls = [];
  return { calls, handlers: {
    bind: payload => resolveCliHookTarget({
      rawTabId: payload.tabId, primaryTabId: payload.tabId, source: payload.source,
      cwd: payload.cwd, sessionId: payload.sessionId, environmentType: payload.environmentType,
      wslDistroName: payload.wslDistroName, receivedAt: 10000, candidates,
    }).tabId,
    open: async payload => { calls.push(["open", payload]); },
    finish: payload => { calls.push(["finish", payload]); },
  } };
}

test("Codex child start uses the restored parent's bound identity", () => {
  const {calls,handlers} = harness();
  assert.equal(routeSubagentHook(event(), handlers), true);
  assert.equal(calls[0][1].tabId, "restored-pane");
  assert.equal(calls[0][1].agentId, "child-thread");
});

test("Codex child stop upgrades the transcript and finishes the same resolved pane", async () => {
  const {calls,handlers} = harness();
  routeSubagentHook(event({event:"SubagentStop",agentTranscriptPath:"E:/codex/child.jsonl"}), handlers);
  await Promise.resolve();
  assert.deepEqual(calls.map(([action,payload])=>[action,payload.tabId]), [["open","restored-pane"],["finish","restored-pane"]]);
});

test("Codex child turn callbacks bypass parent task and notification processing", () => {
  for (const name of ["SessionStart","UserPromptSubmit","Stop"]) {
    const {handlers} = harness();
    assert.equal(routeSubagentHook(event({event:name}),handlers),true);
    assert.equal(routeSubagentHook(event({event:name,agentId:null}),handlers),false);
  }
});

test("WSL callbacks bind their original pane without window focus or visibility", () => {
  const {calls,handlers} = harness([{id:"wsl-pane",source:"codex",paths:["//wsl.localhost/Ubuntu/home/me/project"]}]);
  routeSubagentHook(event({tabId:"external:codex:parent-thread",cwd:"/home/me/project",wslDistroName:"Ubuntu"}),handlers);
  assert.equal(calls[0][1].tabId,"wsl-pane");
});

test("ambiguous same-project terminals and other windows never open an unrelated pane", () => {
  const {calls,handlers} = harness([
    {id:"a",source:"codex",paths:["E:/work/project"]},
    {id:"b",source:"codex",paths:["E:/work/project"]},
  ]);
  assert.equal(routeSubagentHook(event(),handlers),true);
  assert.equal(calls.length,0);
});

test("SSH stays on the remote Hook route", () => {
  const {calls,handlers}=harness();
  assert.equal(routeSubagentHook(event({environmentType:"ssh"}),handlers),false);
  assert.equal(calls.length,0);
});

test("Claude stop without a child path finishes its bound parent without a new subscription", () => {
  const {calls,handlers}=harness([{id:"claude-pane",source:"claude",cliSessionId:"parent-thread",paths:[]}]);
  routeSubagentHook(event({source:"claude",event:"SubagentStop"}),handlers);
  assert.deepEqual(calls.map(([action,payload])=>[action,payload.tabId]),[["finish","claude-pane"]]);
});
