// Input protocols belong to a running PTY, not to the historical picture used
// when that PTY has exited and a fresh shell is created. In particular, restoring
// 1003 enables mouse-motion reports even after the replay write has completed.
const PRIVATE_INPUT_MODES = new Set([
  1, 66, 9, 997, 1000, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1016, 2004, 9001,
]);

/** Preserve display state and text while removing the previous process's input protocols. */
export function prepareTerminalScrollback(snapshot: string): string {
  return snapshot
    // The old PTY's unknown encoding must not quarantine a newly created one.
    .replace(/(?:\x1b\]|\x9d)777;CLIManagerMouseEncoding=unknown(?:\x07|\x1b\\|\x9c)/g, "")
    .replace(/(\x1b\[|\x9b)\?([\d;]+)([hl])/g, (_sequence, csi: string, params: string, final: string) => {
      const displayModes = params.split(";").filter(param => !PRIVATE_INPUT_MODES.has(Number(param)));
      return displayModes.length ? `${csi}?${displayModes.join(";")}${final}` : "";
    })
    // Legacy application keypad, Kitty keyboard and modifyOtherKeys protocols.
    .replace(/\x1b[=>]|(?:\x1b\[|\x9b)[=<>][\d;]*u|(?:\x1b\[|\x9b)>4(?:;\d+)?m/g, "");
}

/** Archive an exited PTY's picture and start a new PTY at screen row 1. */
export function createTerminalScrollbackReplay(snapshot: string, rows: number): string {
  // DECSTR resets the old display modes/margins without erasing history. Scroll
  // the entire old viewport into the normal buffer's scrollback, then home the
  // cursor: a fresh ConPTY/PSReadLine uses absolute positions starting at 1;1.
  // A single newline at the bottom leaves that screen origin out of sync.
  const freshScreen = `\x1b[!p\x1b[${rows};1H${"\r\n".repeat(rows)}\x1b[H`;
  // SerializeAddon emits normal history followed by an alternate-screen switch.
  // Archive both pictures in order; a new shell must not inherit an exited
  // TUI's alternate buffer (which has no scrollback). Live PTYs bypass this.
  return prepareTerminalScrollback(snapshot)
    .replace(/(?:\x1b\[|\x9b)\?(?:47|1047|1049)h/g, freshScreen)
    + freshScreen;
}
