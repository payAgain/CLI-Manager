import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(path) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { exports });
  return exports;
}
const { migrateDefaultTerminalAppearance: migrate } = load("../src/lib/terminalAppearanceMigration.ts");
const { getTerminalTheme, resolveTerminalThemeId, withTerminalTextColor } = load("../src/lib/terminalThemes.ts");
const old = {
  terminalThemeName: "forestNightDark", terminalThemeMode: "independent",
  lightThemePalette: "emerald-mist", darkThemePalette: "terminal-green",
};

test("the previous default migrates once and retains font, text and background customization", () => {
  const settings = { ...old, fontSize: 15, terminalTextColor: "#abcdef", terminalBackground: { enabled: true, imagePath: "image.png" } };
  const before = structuredClone(settings);
  const result = { ...settings, ...migrate(settings) };
  assert.deepEqual(settings, before);
  assert.equal(result.terminalThemeMode, "system");
  assert.equal(result.terminalThemeName, "auto");
  assert.equal(getTerminalTheme(result.terminalThemeName, "dark", result.lightThemePalette, result.darkThemePalette).background, "#242424");
  assert.equal(result.fontSize, 15);
  assert.equal(result.terminalTextColor, "#abcdef");
  assert.equal(result.terminalBackground, settings.terminalBackground);
  assert.equal(migrate({ ...result, ...old }), null, "a subsequent explicit return to green is preserved");
});

test("new profiles use neutral defaults and custom themes/palettes remain untouched", () => {
  assert.deepEqual(Object.keys(migrate({})), ["terminalAppearanceVersion"]);
  for (const settings of [
    { ...old, terminalThemeName: "nord" },
    { ...old, terminalThemeName: "auto", terminalThemeMode: "system" },
    { ...old, darkThemePalette: "github-dark" },
    { ...old, lightThemePalette: "apple-mono" },
  ]) {
    assert.deepEqual(Object.keys(migrate(settings)), ["terminalAppearanceVersion"]);
  }
  assert.equal(migrate({ terminalAppearanceVersion: 2 }), null);
});

test("older settings with a persisted mode or palette but no preset name also migrate", () => {
  for (const settings of [
    { terminalThemeMode: "independent" },
    { darkThemePalette: "terminal-green" },
    { lightThemePalette: "emerald-mist" },
    { ...old, terminalThemeName: undefined },
  ]) {
    const result = { ...settings, ...migrate(settings) };
    assert.equal(result.terminalThemeName, "auto");
    assert.equal(result.terminalThemeMode, "system");
    assert.equal(result.darkThemePalette, "carbon-black");
    assert.equal(result.lightThemePalette, "warm-paper");
  }
});

test("shared auto resolution follows light/dark appearance; independent themes stay independent", () => {
  assert.equal(resolveTerminalThemeId("auto", "dark"), "cliManagerDark");
  assert.equal(resolveTerminalThemeId("auto", "light"), "cliManagerLight");
  assert.equal(resolveTerminalThemeId("nord", "light"), "nord");
  assert.equal(resolveTerminalThemeId("forestNightDark", "light"), "forestNightDark");
  assert.equal(resolveTerminalThemeId("auto", "dark", "warm-paper", "github-dark"), "githubDark");
  assert.equal(withTerminalTextColor(getTerminalTheme("auto", "dark"), "#abcdef").foreground, "#abcdef");
});

const luminance = hex => {
  const channels = hex.slice(1).match(/../g).map(s => {
    const value = parseInt(s, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels.reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
};
const contrast = (a, b) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
};

test("default text, dim ANSI text and semantic colors are readable on both neutral backgrounds", () => {
  for (const mode of ["light", "dark"]) {
    const theme = getTerminalTheme("auto", mode);
    assert.ok(contrast(theme.foreground, theme.background) >= 10);
    for (const key of ["brightBlack", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"]) {
      assert.ok(contrast(theme[key], theme.background) >= 4.5, `${mode} ${key} must have at least 4.5:1 contrast`);
    }
    assert.ok(contrast(theme.selectionForeground, theme.selectionBackground) >= 4.5);
  }
});
