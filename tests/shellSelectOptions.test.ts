import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShellSelectOptions } from "../src/lib/shellSelectOptions.ts";

describe("shell select options", () => {
  it("does not add an empty option before a new-terminal shell is selected", () => {
    const options = buildShellSelectOptions({
      shell: "",
      osPlatform: "macos",
    });

    assert.ok(options.length > 0);
    assert.ok(options.every((option) => option.value !== ""));
  });

  it("keeps a custom shell option when editing existing custom values", () => {
    assert.deepEqual(
      buildShellSelectOptions({
        shell: "/opt/custom-shell",
        osPlatform: "macos",
      })[0],
      { value: "/opt/custom-shell", label: "/opt/custom-shell（当前自定义）" }
    );
  });
});
