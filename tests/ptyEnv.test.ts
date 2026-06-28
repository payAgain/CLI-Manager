import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPtyEnvVars, syncPtyEnvVarsTextForShell, withPtyEnvVarsTextDefaults } from "../src/lib/ptyEnv.ts";

describe("PTY env vars", () => {
  it("adds terminal capability defaults for macOS zsh", () => {
    assert.deepEqual(
      buildPtyEnvVars(null, "zsh", {
        os: "macos",
        shellRuntimeMonitoringEnabled: false,
      }),
      {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      }
    );
  });

  it("does not override explicit terminal capability values", () => {
    assert.deepEqual(
      buildPtyEnvVars({ TERM: "screen-256color", COLORTERM: "24bit" }, "zsh", {
        os: "macos",
        shellRuntimeMonitoringEnabled: false,
      }),
      {
        TERM: "screen-256color",
        COLORTERM: "24bit",
      }
    );
  });

  it("keeps Linux zsh environment unchanged", () => {
    assert.equal(
      buildPtyEnvVars(null, "zsh", {
        os: "linux",
        shellRuntimeMonitoringEnabled: false,
      }),
      null
    );
  });

  it("keeps shell runtime monitoring behavior for supported shells", () => {
    assert.deepEqual(
      buildPtyEnvVars(null, "cmd", {
        os: "windows",
        shellRuntimeMonitoringEnabled: true,
      }),
      {
        CLI_MANAGER_SHELL_RUNTIME_MONITORING: "1",
      }
    );
  });

  it("fills empty config env text for macOS zsh", () => {
    assert.equal(
      withPtyEnvVarsTextDefaults("{}", "zsh", "macos"),
      '{\n  "TERM": "xterm-256color",\n  "COLORTERM": "truecolor"\n}'
    );
  });

  it("does not replace existing config env text", () => {
    assert.equal(
      withPtyEnvVarsTextDefaults('{"FOO":"bar"}', "zsh", "macos"),
      '{"FOO":"bar"}'
    );
  });

  it("does not fill config env text for non-macOS zsh", () => {
    assert.equal(withPtyEnvVarsTextDefaults("{}", "zsh", "linux"), "{}");
  });

  it("does not fill config env text before a shell is selected", () => {
    assert.equal(withPtyEnvVarsTextDefaults("{}", "", "macos"), "{}");
  });

  it("removes auto zsh terminal capability defaults after switching away from macOS zsh", () => {
    const withDefaults = syncPtyEnvVarsTextForShell("{}", "zsh", "macos");

    assert.equal(syncPtyEnvVarsTextForShell(withDefaults, "bash", "macos"), "{}");
  });

  it("keeps user env vars after switching away from macOS zsh", () => {
    assert.equal(
      syncPtyEnvVarsTextForShell(
        '{\n  "FOO": "bar",\n  "TERM": "xterm-256color",\n  "COLORTERM": "truecolor"\n}',
        "bash",
        "macos"
      ),
      '{\n  "FOO": "bar"\n}'
    );
  });

  it("keeps explicit terminal capability values after switching away from macOS zsh", () => {
    assert.equal(
      syncPtyEnvVarsTextForShell('{"TERM":"screen-256color","COLORTERM":"24bit"}', "bash", "macos"),
      '{"TERM":"screen-256color","COLORTERM":"24bit"}'
    );
  });
});
