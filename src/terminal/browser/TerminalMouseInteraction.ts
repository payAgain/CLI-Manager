import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import { isTerminalMouseInputSafe } from "../../lib/terminalReplayWriter";

export type TerminalMouseInteractionOptions = Pick<
  ITerminalOptions,
  "mouseEventsRequireAlt"
>;

/**
 * Keep mouse-aware TUIs aligned with standard terminal behavior: the
 * application receives unmodified mouse reports and Shift keeps text
 * selection available in xterm.
 */
export const createTerminalMouseInteractionOptions =
  (): TerminalMouseInteractionOptions => ({
    mouseEventsRequireAlt: false,
  });

/** A quarantined old mouse mode disables xterm's viewport wheel handler too.
 * Scroll local history in that case, and allow Shift+wheel to inspect history
 * in a mouse-aware TUI. Leave live application mouse handling intact otherwise.
 */
export function attachTerminalHistoryWheel(terminal: Terminal): { dispose(): void } {
  const element = terminal.element;
  let remainder = 0;
  const onWheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || event.defaultPrevented) return;
    const buffer = terminal.buffer.active;
    if (buffer.type !== "normal" || buffer.baseY <= 0) return;
    if (isTerminalMouseInputSafe(terminal) && !event.shiftKey) return;
    const delta = event.deltaY || (event.shiftKey ? event.deltaX : 0);
    if (!delta) return;
    const height = terminal.dimensions?.css.cell.height
      || (terminal.options.fontSize ?? 14) * (terminal.options.lineHeight ?? 1);
    const amount = event.deltaMode === 1 ? delta
      : event.deltaMode === 2 ? delta * terminal.rows : delta / height;
    if (Math.sign(amount) !== Math.sign(remainder)) remainder = 0;
    remainder += amount;
    const lines = Math.trunc(remainder);
    remainder -= lines;
    if (lines) terminal.scrollLines(lines);
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  element?.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return { dispose: () => element?.removeEventListener("wheel", onWheel, true) };
}
