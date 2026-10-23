import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { canonicalGitDiff, fingerprintGitDiff, getGitDiffApprovalStatus, gitDiffApprovalKey, gitDiffApprovalScope, normalizeGitDiffApprovals } from "../src/lib/gitDiffApproval.ts";
import { normalizeGitDiffPayload } from "../src/lib/gitDiffLimits.ts";

const headers = "diff --git a/a.txt b/a.txt\nindex aaaa111..bbbb222 100644\n--- a/a.txt\n+++ b/a.txt\n";
const small = headers + "@@ -3,3 +3,3 @@\n third\n-old\n+new\n fifth\n";
const wide = headers + "@@ -1,6 +1,6 @@\n first\n second\n third\n-old\n+new\n fifth\n sixth\n";
const project = (patch = {}) => ({ environment_type: "local", path: "/repo", remote_path: "", ssh_host_id: null, ...patch });

test("review fingerprints ignore display context while retaining exact changed text and base", async () => {
  assert.equal(await fingerprintGitDiff(small), await fingerprintGitDiff(wide));
  for (const changed of [small.replace("+new", "+NEW"), small.replace("aaaa111", "cccc333"), small.replace("100644", "100755"), small.replace("+new\n", "+new\r\n")]) {
    assert.notEqual(await fingerprintGitDiff(small), await fingerprintGitDiff(changed));
  }
});

test("merged and separate hunks produce the same fingerprint", async () => {
  const split = headers + "@@ -1 +1 @@\n-a\n+A\n@@ -5 +5 @@\n-e\n+E\n";
  const merged = headers + "@@ -1,5 +1,5 @@\n-a\n+A\n b\n c\n d\n-e\n+E\n";
  assert.equal(await fingerprintGitDiff(split), await fingerprintGitDiff(merged));
});

test("last newline differences are preserved; unchanged context newline markers are ignored", async () => {
  const regular = headers + "@@ -1 +1 @@\n-old\n+new\n";
  assert.notEqual(await fingerprintGitDiff(regular), await fingerprintGitDiff(regular + "\\ No newline at end of file\n"));
  assert.equal(await fingerprintGitDiff(small), await fingerprintGitDiff(small + "\\ No newline at end of file\n"));
});

test("synthetic file patches require raw-byte identity and detect encoding-only changes", async () => {
  const synthetic = "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n";
  assert.equal(await fingerprintGitDiff(synthetic), null);
  const first = await fingerprintGitDiff(synthetic, "a".repeat(64));
  assert.ok(first);
  assert.notEqual(first, await fingerprintGitDiff(synthetic, "b".repeat(64)));
});

test("legacy or unknown backend review versions never acquire approval capability", () => {
  const payload = { content: small, canRevertHunks: true };
  assert.equal(normalizeGitDiffPayload(payload).reviewVersion, undefined);
  assert.equal(normalizeGitDiffPayload({ ...payload, reviewVersion: 2 }).reviewVersion, undefined);
  assert.equal(normalizeGitDiffPayload({ ...payload, reviewVersion: 1 }).reviewVersion, 1);
  assert.equal(normalizeGitDiffPayload({ ...payload, contentFingerprint: "invalid" }).contentFingerprint, undefined);
  assert.equal(normalizeGitDiffPayload({ ...payload, contentFingerprint: "a".repeat(64) }).contentFingerprint, "a".repeat(64));
});

test("binary, empty, mode-only, malformed and multi-file diffs cannot be approved", () => {
  for (const content of ["", headers + "Binary files a/a.txt and b/a.txt differ\n", "diff --git a/a.txt b/a.txt\nold mode 100644\nnew mode 100755\n", small + small, headers + "@@ invalid @@\n-old\n+new\n"]) {
    assert.equal(canonicalGitDiff(content), null);
  }
});

test("approval identity isolates environments, worktrees, nested repositories and SSH hosts", () => {
  const base = gitDiffApprovalScope(project(), "/repo");
  assert.equal(base, gitDiffApprovalScope(project({ path: "/repo/" }), "/repo/"));
  for (const scope of [gitDiffApprovalScope(project({ environment_type: "wsl" }), "/repo"), gitDiffApprovalScope(project({ path: "/repo-wt" }), "/repo-wt"), gitDiffApprovalScope(project(), "/repo/nested")]) assert.notEqual(base, scope);
  const ssh = (host) => gitDiffApprovalScope(project({ environment_type: "ssh", ssh_host_id: host, remote_path: "/repo" }), "");
  assert.notEqual(ssh("one"), ssh("two"));
  const remote = (path) => gitDiffApprovalScope(project({ environment_type: "ssh", ssh_host_id: "one", remote_path: path }), "");
  assert.notEqual(remote("/Repo"), remote("/repo"));
  assert.notEqual(remote("/repo\\other"), remote("/repo/other"));
  assert.notEqual(remote("C:/Repo"), remote("c:/repo"));
  assert.notEqual(gitDiffApprovalKey(base, "A.ts"), gitDiffApprovalKey(base, "a.ts"));
  assert.notEqual(gitDiffApprovalKey(base, "a\\b.ts"), gitDiffApprovalKey(base, "a/b.ts"));
});

test("unverified approvals remain pending; changed content requires re-review", () => {
  const record = { fingerprint: "a".repeat(64), approvedAt: 123 };
  assert.equal(getGitDiffApprovalStatus(undefined, record.fingerprint), "unreviewed");
  assert.equal(getGitDiffApprovalStatus(record, undefined), "unverified");
  assert.equal(getGitDiffApprovalStatus(record, null), "unverified");
  assert.equal(getGitDiffApprovalStatus(record, record.fingerprint), "approved");
  assert.equal(getGitDiffApprovalStatus(record, "b".repeat(64)), "changed");
});

test("persistent records reject malformed data and stay bounded", () => {
  assert.deepEqual(normalizeGitDiffApprovals({ invalid: { fingerprint: "oops", approvedAt: 1 } }), {});
  const records = Object.fromEntries(Array.from({ length: 2005 }, (_, index) => [`key-${index}`, { fingerprint: "a".repeat(64), approvedAt: index + 1 }]));
  const bounded = normalizeGitDiffApprovals(records);
  assert.equal(Object.keys(bounded).length, 2000);
  assert.equal(bounded["key-0"], undefined);
  assert.ok(bounded["key-2004"]);
});

let storeSerial = 0;
async function mockStore(initial = {}) {
  const state = { saved: structuredClone(initial), staged: initial, saves: 0, failSave: false };
  const mock = { get: async () => state.saved, set: async (_key, records) => { state.staged = structuredClone(records); }, save: async () => { state.saves++; if (state.beforeSave) await state.beforeSave(); if (state.failSave) throw new Error("disk full"); state.saved = structuredClone(state.staged); } };
  globalThis.__approvalMockStore = { load: async () => mock };
  let source = readFileSync(new URL("../src/stores/gitDiffApprovalStore.ts", import.meta.url), "utf8")
    .replace('import { Store } from "@tauri-apps/plugin-store";', 'const Store = globalThis.__approvalMockStore;')
    .replace('import { getCliManagerDataPaths } from "../lib/appPaths";', 'const getCliManagerDataPaths = async () => ({ dataDir: "/test" });')
    .replace('"../lib/gitDiffApproval"', JSON.stringify(new URL("../src/lib/gitDiffApproval.ts", import.meta.url).href))
    .replace('"zustand"', JSON.stringify(import.meta.resolve("zustand")));
  source += `\n// instance ${++storeSerial}`;
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
  return { store: module.useGitDiffApprovalStore, disk: state };
}

test("reload keeps persistent approval but never assumes current content is verified", async () => {
  const record = { fingerprint: "a".repeat(64), approvedAt: 123 };
  const { store } = await mockStore({ file: record });
  await store.getState().load();
  assert.deepEqual(store.getState().records.file, record);
  assert.equal(getGitDiffApprovalStatus(store.getState().records.file, store.getState().fingerprints.file), "unverified");
});

test("approval writes serialize without dropping another file; revoke survives reload", async () => {
  const { store, disk } = await mockStore();
  const hash = "a".repeat(64);
  store.getState().observe("one", hash); store.getState().observe("two", hash);
  await Promise.all([store.getState().approve("one", hash), store.getState().approve("two", hash)]);
  assert.equal(Object.keys(disk.saved).length, 2);
  await store.getState().revoke("one");
  assert.equal(disk.saved.one, undefined);
  assert.equal(disk.saved.two.fingerprint, hash);
});

test("stale approval and failed persistence never produce successful approval state", async () => {
  const { store, disk } = await mockStore();
  const hash = "a".repeat(64);
  await assert.rejects(store.getState().approve("one", hash), /changed/);
  store.getState().observe("one", hash); disk.failSave = true;
  await assert.rejects(store.getState().approve("one", hash), /disk full/);
  assert.equal(store.getState().records.one, undefined);
  assert.equal(disk.saved.one, undefined);
});

test("existing Git refresh invalidates only that repository and does no writes", async () => {
  const { store, disk } = await mockStore();
  const one = gitDiffApprovalKey("one", "file"), two = gitDiffApprovalKey("two", "file");
  store.getState().observe(one, "a"); store.getState().observe(two, "b");
  store.getState().invalidateScope("one");
  assert.equal(store.getState().fingerprints[one], null);
  assert.equal(store.getState().fingerprints[two], "b");
  assert.equal(disk.saves, 0);
});

test("a newer observation arriving during persistence never inherits the old approval", async () => {
  const { store, disk } = await mockStore();
  let release, saving;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { saving = resolve; });
  disk.beforeSave = async () => { saving(); await gate; };
  const oldHash = "a".repeat(64), newHash = "b".repeat(64);
  store.getState().observe("one", oldHash);
  const pending = store.getState().approve("one", oldHash);
  await started;
  store.getState().observe("one", newHash);
  release(); await pending;
  assert.equal(getGitDiffApprovalStatus(store.getState().records.one, store.getState().fingerprints.one), "changed");
});
