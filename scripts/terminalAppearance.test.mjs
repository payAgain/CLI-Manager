import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";

const { Terminal } = createRequire(import.meta.url)("@xterm/xterm");

function load(path) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(compiled, { exports, AbortController, queueMicrotask, console });
  return exports;
}
const { migrateDefaultTerminalAppearance: migrate } = load("../src/lib/terminalAppearanceMigration.ts");
const { getTerminalTheme, resolveTerminalThemeId, withTerminalTextColor } = load("../src/lib/terminalThemes.ts");
const { installTerminalMutationGate, mutateTerminalWhenReady } = load("../src/lib/terminalMutationGate.ts");
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

// Execute the production appearance effect against a real xterm buffer. Only
// browser renderer/layout callbacks are stubbed in this headless test.
const terminalSource = readFileSync(new URL("../src/components/XTermTerminal.tsx", import.meta.url), "utf8");
const terminalAst = ts.createSourceFile("XTermTerminal.tsx", terminalSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let appearanceEffect;
function findAppearanceEffect(node) {
  if (ts.isCallExpression(node) && node.expression.getText(terminalAst) === "useEffect"
    && node.arguments[0]?.getText(terminalAst).includes("terminal.options.theme =")) appearanceEffect = node.arguments[0];
  ts.forEachChild(node, findAppearanceEffect);
}
findAppearanceEffect(terminalAst);
assert.ok(appearanceEffect, "production appearance update must exist");
const appearanceCallback = ts.transpileModule(`const applyAppearance = ${appearanceEffect.getText(terminalAst)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const visible of [true, false]) test(`theme-only updates request a full repaint without resetting ${visible ? "visible" : "hidden"} terminal state`, async t => {
  const terminal = new Terminal({ cols: 80, rows: 12, allowProposedApi: true, fontSize: 14, fontFamily: "monospace", scrollback: 9000 });
  t.after(() => terminal.dispose());
  await new Promise(resolve => terminal.write("Keep this output 中文\r\n\x1b[?1049hAlternate TUI", resolve));
  terminal.reset = () => assert.fail("appearance updates must not reset the terminal");
  const gate = installTerminalMutationGate(terminal);
  t.after(() => gate.dispose());
  const before = { type: terminal.buffer.active.type, text: terminal.buffer.active.getLine(0).translateToString(), x: terminal.buffer.active.cursorX };
  const calls = { atlas: 0, normalized: 0, invalidated: 0, fit: [] };
  const environment = {
    terminalRef: { current: terminal }, withTerminalTextColor, getTerminalTheme, mutateTerminalWhenReady,
    terminalThemeName: "auto", resolvedTheme: "dark", lightThemePalette: "warm-paper", darkThemePalette: "carbon-black", terminalTextColor: "",
    getTerminalMinimumContrastRatio: () => 1, isTransparent: false, applyTransparency: theme => theme,
    background: { overlayDarken: 0 }, withVisibleSelectionTheme: theme => theme, searchOpen: false,
    syncWebglRenderer: () => false, fontSize: 14, effectiveFontFamily: "monospace", effectiveTerminalScrollbackRows: 9000,
    isVisibleRef: { current: visible }, clearWebglTextureAtlas: () => calls.atlas++,
    tuiColorSync: { normalize: () => calls.normalized++, schedule() {} },
    markViewportRefreshNeeded: () => calls.invalidated++, scheduleFit: (...args) => calls.fit.push(args),
  };
  const applyAppearance = () => new Function(...Object.keys(environment), appearanceCallback + "\napplyAppearance();")(...Object.values(environment));
  applyAppearance();
  assert.equal(terminal.options.theme.background, getTerminalTheme("auto", "dark").background);
  assert.equal(calls.invalidated, 1);
  assert.deepEqual(calls.fit, [[true, true]], "same-size/same-renderer changes still request a complete refresh");
  assert.equal(calls.atlas, Number(visible));
  assert.equal(calls.normalized, Number(visible), "hidden buffers avoid rendering work until visible");
  assert.deepEqual({ type: terminal.buffer.active.type, text: terminal.buffer.active.getLine(0).translateToString(), x: terminal.buffer.active.cursorX }, before);

  // Snapshot capture freezes buffer mutations. Changing scrollback and then
  // changing back must apply in order once capture releases the real gate.
  let enterCapture, releaseCapture;
  const entered = new Promise(resolve => { enterCapture = resolve; });
  const capture = gate.capture(() => {
    enterCapture();
    return new Promise(resolve => { releaseCapture = resolve; });
  }, new AbortController().signal);
  await entered;
  try {
    environment.effectiveTerminalScrollbackRows = 2000;
    applyAppearance();
    assert.equal(terminal.options.scrollback, 9000, "a capture must keep its buffer dimensions stable");
    environment.effectiveTerminalScrollbackRows = 9000;
    applyAppearance();
  } finally {
    releaseCapture();
    await capture;
  }
  await new Promise(resolve => terminal.write("", resolve));
  assert.equal(terminal.options.scrollback, 9000, "returning to the original setting must supersede the queued change");
  assert.deepEqual({ type: terminal.buffer.active.type, text: terminal.buffer.active.getLine(0).translateToString(), x: terminal.buffer.active.cursorX }, before);
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
