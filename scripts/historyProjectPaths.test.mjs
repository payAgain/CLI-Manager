import test from "node:test";
import assert from "node:assert/strict";
import { resolveHistoryProjectPath } from "../src/lib/historyProjectPaths.ts";

test("history uses the checkout for local and WSL projects", () => {
  for (const environment_type of ["local", "wsl"]) {
    assert.equal(resolveHistoryProjectPath({
      environment_type, path: " D:/repo/worktree ", remote_path: "/unrelated/remote",
    }), "D:/repo/worktree");
  }
});

test("SSH history uses only the remote checkout", () => {
  assert.equal(resolveHistoryProjectPath({
    environment_type: "ssh", path: "D:/local-placeholder", remote_path: " /srv/project ",
  }), "/srv/project");
});

test("absent projects and blank paths leave history unscoped", () => {
  assert.equal(resolveHistoryProjectPath(null), "");
  assert.equal(resolveHistoryProjectPath(undefined), "");
  assert.equal(resolveHistoryProjectPath({environment_type: "ssh", path: "D:/local", remote_path: " "}), "");
});
