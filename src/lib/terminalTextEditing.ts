// Cursor-relative text editing on the input shadow buffer. Pure string math
// keyed by grapheme index (via Array.from), no xterm runtime dependency.
// Extracted from XTermTerminal.

export const getTextCursorLength = (text: string) => Array.from(text).length;

export const sliceTextByCursor = (text: string, start: number, end?: number) => (
  Array.from(text).slice(start, end).join("")
);

export const clampTextCursorIndex = (text: string, index: number) => (
  Math.min(Math.max(0, index), getTextCursorLength(text))
);

export const insertTextAtCursor = (text: string, cursorIndex: number, insertion: string) => {
  const chars = Array.from(text);
  const index = Math.min(Math.max(0, cursorIndex), chars.length);
  chars.splice(index, 0, ...Array.from(insertion));
  return chars.join("");
};

export const removeTextBeforeCursor = (text: string, cursorIndex: number) => {
  const chars = Array.from(text);
  const index = Math.min(Math.max(0, cursorIndex), chars.length);
  if (index <= 0) return { text, cursorIndex: index };
  chars.splice(index - 1, 1);
  return { text: chars.join(""), cursorIndex: index - 1 };
};

export const removeTextAtCursor = (text: string, cursorIndex: number) => {
  const chars = Array.from(text);
  const index = Math.min(Math.max(0, cursorIndex), chars.length);
  if (index >= chars.length) return { text, cursorIndex: index };
  chars.splice(index, 1);
  return { text: chars.join(""), cursorIndex: index };
};

export const repeatControlSequence = (sequence: string, count: number) => (
  count > 0 ? sequence.repeat(count) : ""
);
