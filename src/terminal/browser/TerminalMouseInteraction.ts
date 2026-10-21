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

/** xterm emits one mouse report per wheel event, regardless of its delta size.
 * Repeat through its own event path so encodings, coordinates and trackpad
 * fractions remain owned by xterm. Ordinary history scrolling is unaffected.
 */
export function attachTerminalTuiWheel(
  terminal: Terminal,
  getMultiplier: () => number,
): { dispose(): void } {
  const element = terminal.element;
  const forwarded = new WeakSet<WheelEvent>();
  const onWheel = (event: WheelEvent) => {
    if (forwarded.has(event) || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || !event.deltaY) return;
    if (!isTerminalMouseInputSafe(terminal)) return;
    if (terminal.buffer.active.type !== "alternate" && terminal.modes.mouseTrackingMode === "none") return;
    const value = getMultiplier();
    const multiplier = Number.isFinite(value) ? Math.min(10, Math.max(1, Math.round(value))) : 1;
    if (multiplier === 1) return;
    const Wheel = element?.ownerDocument?.defaultView?.WheelEvent;
    const target = event.target ?? element;
    if (!Wheel || !target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    for (let index = 0; index < multiplier; index += 1) {
      const copy = new Wheel("wheel", {
        bubbles: true, cancelable: true, composed: true,
        deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
        clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
        altKey: event.altKey,
      });
      forwarded.add(copy);
      target.dispatchEvent(copy);
    }
  };
  element?.addEventListener("wheel", onWheel, { capture: true, passive: false });
  return { dispose: () => element?.removeEventListener("wheel", onWheel, true) };
}

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
