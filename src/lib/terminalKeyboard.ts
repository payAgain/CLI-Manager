// Pure keyboard / paste-text helpers for the terminal. No xterm runtime
// dependency; these operate on KeyboardEvent and plain strings only.

export const terminalEventToCombo = (e: KeyboardEvent): string => {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  if (e.metaKey) parts.push("Meta");

  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return "";
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return parts.join("+");
};

export const terminalShortcutMatches = (e: KeyboardEvent, shortcut: string) => (
  shortcut.trim() !== "" && terminalEventToCombo(e) === shortcut
);

export const trimTerminalPasteBoundaryLineBreaks = (text: string) => (
  text.replace(/^(?:\r\n?|\n)+|(?:\r\n?|\n)+$/gu, "")
);

export const wrapTerminalPasteTextForCtrlShiftV = (text: string) => {
  const trimmed = trimTerminalPasteBoundaryLineBreaks(text);
  return /[\r\n]/u.test(trimmed) ? `'${trimmed}'` : trimmed;
};
