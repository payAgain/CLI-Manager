import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const exports = {};
const compiled = ts.transpileModule(readFileSync(new URL("../src/lib/historyResumeEnvironment.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function("exports", compiled)(exports);
const resolve = exports.resolveHistoryResumeEnvironment;
const session = (source, file_path) => ({ source, file_path });

test("native Codex resumes use the selected history root for default and custom locations", () => {
  for (const [file, root] of [
    ["/Users/me/.codex/sessions/2026/10/24/rollout-chat.jsonl", "/Users/me/.codex"],
    ["/data/codex-personal/sessions/rollout-chat.jsonl", "/data/codex-personal"],
    ["C:\\Users\\me\\.codex\\sessions\\2026\\rollout-chat.jsonl", "C:\\Users\\me\\.codex"],
    ["D:/agent data/CODEX/SESSIONS/rollout-chat.jsonl", "D:/agent data/CODEX"],
  ]) {
    assert.deepEqual(resolve(session("codex", file)), { CODEX_HOME: root });
  }
});

test("Claude history selects only CLAUDE_CONFIG_DIR and preserves unrelated environment", () => {
  const original = Object.freeze({ CLAUDE_CONFIG_DIR: "/wrong", CODEX_HOME: "/keep-codex", MODEL: "custom" });
  const result = resolve(session("claude", "/profiles/claude-team/projects/-work-repo/chat.jsonl"), original);
  assert.deepEqual(result, { CLAUDE_CONFIG_DIR: "/profiles/claude-team", CODEX_HOME: "/keep-codex", MODEL: "custom" });
  assert.notEqual(result, original);
  assert.equal(original.CLAUDE_CONFIG_DIR, "/wrong");
  assert.deepEqual(resolve(session(" CLAUDE ", "\\\\server\\share\\claude\\projects\\repo\\chat.jsonl")), {
    CLAUDE_CONFIG_DIR: "\\\\server\\share\\claude",
  });
});

test("nonstandard paths and other sources retain existing environment without guessing a root", () => {
  const original = Object.freeze({ CODEX_HOME: "/configured", WSLENV: "KEEP/p" });
  for (const value of [
    session("codex", "sessions/chat.jsonl"),
    session("codex", "/exports/chat.jsonl"),
    session("codex", "/archive/sessions/../chat.jsonl"),
    session("codex", "/archive/sessions/chat.json"),
    session("claude", "/claude/projects/chat.jsonl"),
    session("grok", "/grok/sessions/chat.jsonl"),
    session("pi", "/pi/sessions/chat.jsonl"),
  ]) assert.equal(resolve(value, original), original, JSON.stringify(value));
  assert.equal(resolve(session("codex", "/exports/chat.jsonl")), undefined);
});

test("WSL UNC history roots are converted only for the requested distribution", () => {
  for (const [path, distro, root] of [
    ["\\\\wsl$\\Ubuntu\\home\\me\\.codex\\sessions\\chat.jsonl", "Ubuntu", "/home/me/.codex"],
    ["//wsl.localhost/ubuntu/home/me/claude/projects/repo/chat.jsonl", "Ubuntu", "/home/me/claude"],
    ["\\\\?\\UNC\\wsl.localhost\\Ubuntu\\home\\me\\.codex\\sessions\\chat.jsonl", "ubuntu", "/home/me/.codex"],
  ]) {
    const source = path.includes("projects") ? "claude" : "codex";
    const key = source === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
    assert.deepEqual(resolve(session(source, path), undefined, { environmentType: "wsl", wslDistro: distro }), {
      [key]: root, WSLENV: key,
    });
    assert.throws(() => resolve(session(source, path), undefined, { environmentType: "wsl", wslDistro: "Debian" }), /history_resume_wsl_distro_mismatch/);
    assert.throws(() => resolve(session(source, path), undefined, { environmentType: "wsl" }), /history_resume_wsl_distro_mismatch/);
  }
});

test("WSL drive paths become Linux mount paths and native Windows paths remain unchanged", () => {
  const value = session("codex", "C:\\Users\\me\\custom codex\\sessions\\chat.jsonl");
  assert.deepEqual(resolve(value, undefined, { environmentType: "wsl" }), {
    CODEX_HOME: "/mnt/c/Users/me/custom codex", WSLENV: "CODEX_HOME",
  });
  assert.deepEqual(resolve(value, undefined, { environmentType: "local" }), {
    CODEX_HOME: "C:\\Users\\me\\custom codex",
  });
  assert.deepEqual(resolve(session("claude", "/home/me/.claude/projects/repo/chat.jsonl"), undefined, { environmentType: "wsl" }), {
    CLAUDE_CONFIG_DIR: "/home/me/.claude", WSLENV: "CLAUDE_CONFIG_DIR",
  });
});

test("WSL forwarding preserves unrelated entries and compatible source flags without translating twice", () => {
  const original = Object.freeze({ WSLENV: "KEEP/p:CODEX_HOME/pwu:LIST/l:codex_home/w:TAIL", CODEX_HOME: "/old", TOKEN: "retained" });
  const result = resolve(session("codex", "/home/me/custom/sessions/chat.jsonl"), original, { environmentType: "wsl" });
  assert.deepEqual(result, {
    WSLENV: "KEEP/p:CODEX_HOME/u:LIST/l:TAIL", CODEX_HOME: "/home/me/custom", TOKEN: "retained",
  });
  assert.equal(original.WSLENV, "KEEP/p:CODEX_HOME/pwu:LIST/l:codex_home/w:TAIL");
  assert.deepEqual(resolve(session("claude", "/home/me/claude/projects/repo/chat.jsonl"), { WSLENV: "OTHER/p" }, { environmentType: "wsl" }), {
    WSLENV: "OTHER/p:CLAUDE_CONFIG_DIR", CLAUDE_CONFIG_DIR: "/home/me/claude",
  });
});

test("SSH source location remains owned by remote preflight and malformed local roots are rejected", () => {
  const original = Object.freeze({ CODEX_HOME: "/remote/from-preflight" });
  assert.equal(resolve(session("codex", "/local/sessions/chat.jsonl"), original, { environmentType: "ssh" }), original);
  assert.throws(() => resolve(session("codex", "\\\\server\\share\\codex\\sessions\\chat.jsonl"), undefined, { environmentType: "wsl" }), /history_resume_wsl_source_path_unsupported/);
  for (const control of ["\0", "\r", "\n"]) {
    assert.throws(() => resolve(session("codex", `/home/bad${control}root/sessions/chat.jsonl`)), /history_resume_source_path_invalid/);
  }
});
