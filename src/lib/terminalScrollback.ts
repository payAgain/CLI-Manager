// Input protocols belong to a running PTY, not to the historical picture used
// when that PTY has exited and a fresh shell is created. In particular, restoring
// 1003 enables mouse-motion reports even after the replay write has completed.
const PRIVATE_INPUT_MODES = new Set([
  1, 66, 9, 997, 1000, 1002, 1003, 1004, 1005, 1006, 1007, 1015, 1016, 2004, 9001,
]);

/** Preserve display state and text while removing the previous process's input protocols. */
export function prepareTerminalScrollback(snapshot: string): string {
  return snapshot
    .replace(/(\x1b\[|\x9b)\?([\d;]+)([hl])/g, (_sequence, csi: string, params: string, final: string) => {
      const displayModes = params.split(";").filter(param => !PRIVATE_INPUT_MODES.has(Number(param)));
      return displayModes.length ? `${csi}?${displayModes.join(";")}${final}` : "";
    })
    // Legacy application keypad, Kitty keyboard and modifyOtherKeys protocols.
    .replace(/\x1b[=>]|(?:\x1b\[|\x9b)[=<>][\d;]*u|(?:\x1b\[|\x9b)>4(?:;\d+)?m/g, "");
}
