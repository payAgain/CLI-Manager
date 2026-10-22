import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const uri = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const compile = (path) => ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const db = new DatabaseSync(":memory:");
const patchFiles = new Map();
let currentPatch = "target patch";
const bind = (values) => values?.length ? [Object.fromEntries(values.map((value,index)=>[`$${index+1}`,value]))] : [];
globalThis.__replayRetentionFixture = {
  db: {
    select: async(sql,values)=>db.prepare(sql).all(...bind(values)),
    execute: async(sql,values)=>{const result=db.prepare(sql).run(...bind(values)); return {rowsAffected:Number(result.changes),lastInsertId:Number(result.lastInsertRowid)};},
  },
  invoke: async(command,args)=>{
    if(command==="git_get_worktree_snapshot")return {projectPath:"E:/app",head:"same-head",branch:"main",dirty:true,patch:currentPatch,files:[{path:"app.ts"}]};
    if(command==="file_write_text")patchFiles.set(args.relativePath,args.content);
    if(command==="file_read_text")return {content:patchFiles.get(args.relativePath)};
  },
};
const stubs = {
  "@tauri-apps/api/core": uri("export const invoke=globalThis.__replayRetentionFixture.invoke;"),
  zustand: import.meta.resolve("zustand"),
  "../lib/appPaths": uri("export const getCliManagerDataPaths=async()=>({dataDir:'fixture'});"),
  "../lib/db": uri("export const getDb=async()=>globalThis.__replayRetentionFixture.db;"),
  "../lib/debugConsole": uri("export const debugConsoleInfo=()=>{};export const debugConsoleWarn=()=>{};"),
  "../lib/i18n": uri("export const translateCurrent=(key)=>key;"),
  "../lib/logger": uri("export const logError=()=>{};export const logWarn=()=>{};"),
  "../lib/replayScope": uri(compile("../src/lib/replayScope.ts")),
};
let code=compile("../src/stores/replayStore.ts");
for (const [path,url] of Object.entries(stubs))code=code.replaceAll(`from "${path}"`, `from ${JSON.stringify(url)}`);
const {useReplayStore,readReplayEvents,readReplaySnapshot}=await import(uri(code));

test("restoring an old session advances the repository checkpoint and retains both legacy patches", async()=>{
  const store=useReplayStore.getState();
  await store.captureCodeSnapshot("old-session","E:/app","ToolStop");
  currentPatch="newer patch";
  await store.captureCodeSnapshot("new-session","E:/app","ToolStop");
  currentPatch="target patch";
  const restored=await store.captureCodeSnapshot("old-session","E:/app","rollback");
  assert.ok(restored,"an explicit restore cannot be deduplicated against the old session");
  const records=await readReplayEvents({kind:"snapshots",projectPath:"E:/app"});
  assert.equal(records.events.length,3);
  assert.equal(records.events[0].payload.reason,"rollback");
  assert.equal((await readReplaySnapshot(records.events[0])).payload.patch,"target patch");
  assert.equal((await readReplaySnapshot(records.events[1])).payload.patch,"newer patch");
  assert.equal((await readReplaySnapshot(records.events[2])).payload.patch,"target patch");
  assert.equal(await store.captureCodeSnapshot("old-session","E:/app","ToolStop"),null,"automatic duplicate captures stay suppressed");
  const fork=await store.captureCodeSnapshot("old-session","E:/app","fork");
  assert.ok(fork);
  assert.equal((await readReplayEvents({kind:"snapshots",projectPath:"E:/app"})).events[0].payload.reason,"fork");
  db.close();
  delete globalThis.__replayRetentionFixture;
});
