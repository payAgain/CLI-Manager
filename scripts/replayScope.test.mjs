import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/replayScope.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildReplayEventQuery } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE ai_replay_sessions(session_key TEXT PRIMARY KEY, cli_session_id TEXT, source TEXT);
    CREATE TABLE ai_replay_events(id INTEGER PRIMARY KEY, session_key TEXT, kind TEXT, title TEXT, detail TEXT, tags_json TEXT, payload_json TEXT);`);
  db.prepare("INSERT INTO ai_replay_sessions VALUES (?,?,?)").run("reused-tab", "new-cli", "codex");
  const add = (id, payload, { key = "reused-tab", kind = "tool", title = "read_file", detail = "" } = {}) => {
    db.prepare("INSERT INTO ai_replay_events VALUES (?,?,?,?,?,?,?)").run(id, key, kind, title, detail, "[]", JSON.stringify(payload));
  };
  const query = (scope, options) => {
    const { sql, values } = buildReplayEventQuery(scope, options);
    return db.prepare(sql).all(Object.fromEntries(values.map((value, index) => [`$${index + 1}`, value]))).map(row => row.id);
  };
  return { db, add, query };
}
const history = (cliSessionId, rest = {}) => ({ kind: "history", cliSessionId, source: "codex", remote: false, ...rest });

test("events stay with their original CLI after the terminal starts a different session", () => {
  const { db, add, query } = fixture();
  add(1, {sessionId:"old-cli", source:"codex"});
  add(2, {sessionId:"new-cli", source:"codex"});
  add(3, {sessionId:"old-cli", source:"claude"});
  assert.deepEqual(query(history("old-cli")), [1]);
  assert.deepEqual(query(history("new-cli")), [2]);
  assert.deepEqual(query({kind:"terminal",sessionKey:"reused-tab"}), [3,2,1]);
  db.close();
});
test("same session identifiers on local and two SSH hosts cannot mix", () => {
  const { db, add, query } = fixture();
  add(1, {sessionId:"cli",source:"codex"});
  add(2, {sessionId:"cli",source:"codex",environmentType:"ssh",remoteHostId:"host-a"});
  add(3, {sessionId:"cli",source:"codex",environmentType:"ssh",remoteHostId:"host-b"});
  assert.deepEqual(query(history("cli")), [1]);
  assert.deepEqual(query(history("cli", {remote:true,remoteHostId:"host-a"})), [2]);
  assert.deepEqual(query(history("cli", {remote:true})), []);
  db.close();
});
test("legacy events without per-event identity remain readable via stored session identity", () => {
  const { db, add, query } = fixture();
  add(1, {});
  assert.deepEqual(query(history("new-cli")), [1]);
  assert.deepEqual(query({kind:"terminal",sessionKey:"missing"}), []);
  db.close();
});
test("snapshots use the saved path, cover old sessions and isolate worktrees", () => {
  const { db, add, query } = fixture();
  add(1, {projectPath:"E:\\Work\\App\\",patch:"inline legacy patch"}, {kind:"snapshot",key:"closed-old-tab"});
  add(2, {projectPath:"e:/work/app",patchPath:"replay-snapshots/old.patch"}, {kind:"snapshot"});
  add(3, {projectPath:"E:/Work/App-worktree",patch:"other"}, {kind:"snapshot"});
  add(4, {projectPath:"e:/work/app",environmentType:"ssh"}, {kind:"snapshot"});
  assert.deepEqual(query({kind:"snapshots",projectPath:"E:/Work/App"}), [2,1]);
  db.close();
});
test("WSL aliases share snapshots while Linux path case and distributions stay isolated", () => {
  const { db, add, query } = fixture();
  add(1, {projectPath:"\\\\wsl$\\Ubuntu\\home\\dev\\App"}, {kind:"snapshot"});
  add(2, {projectPath:"//wsl.localhost/Ubuntu/home/dev/app"}, {kind:"snapshot"});
  add(3, {projectPath:"//wsl.localhost/Debian/home/dev/App"}, {kind:"snapshot"});
  assert.deepEqual(query({kind:"snapshots",projectPath:"//wsl.localhost/Ubuntu/home/dev/App"}), [1]);
  db.close();
});
test("older snapshots and filtered logs do not depend on the 200-event live cache", () => {
  const { db, add, query } = fixture();
  add(1, {projectPath:"E:/Work/App"}, {kind:"snapshot"});
  for (let id=2; id<=250; id++) add(id, {}, {title:id===2 ? "literal [x].* %" : "read_file"});
  assert.deepEqual(query({kind:"snapshots",projectPath:"E:/Work/App"}), [1]);
  assert.deepEqual(query({kind:"terminal",sessionKey:"reused-tab"}, {query:"[x].* %"}), [2]);
  assert.equal(query({kind:"terminal",sessionKey:"reused-tab"}, {limit:100}).length, 101);
  assert.equal(query({kind:"terminal",sessionKey:"reused-tab"}, {limit:300}).length, 250);
  db.close();
});
