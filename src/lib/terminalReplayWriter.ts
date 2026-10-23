import type { Terminal } from "@xterm/xterm";
import type { ISerializeOptions } from "@xterm/addon-serialize";


/** Bound the scan before visiting cells; keep each result independently replayable. */
export function serializeTerminalSnapshots(
  terminal: Pick<Terminal, "buffer" | "rows">,
  serialize: (scrollback?: number) => string,
  maxLines: number,
  full: boolean,
): { snapshot: string; serialized?: string } {
  const rows = terminal.rows;
  const altRows = terminal.buffer.active.type === "alternate" ? rows : 0;
  const scrollback = Math.max(0, maxLines - rows - altRows);
  const serialized = full ? serialize() : undefined;
  const snapshot = serialized !== undefined && terminal.buffer.normal.length <= rows + scrollback
    ? serialized : serialize(scrollback);
  return { snapshot, serialized };
}

type ReplayTerminal = Pick<Terminal, "options" | "write">;

const replayInputGuards = new WeakMap<ReplayTerminal, { count: number; disableStdin: boolean | undefined }>();

interface MouseProtocolState {
  encoding: "DEFAULT" | "SGR" | "SGR_PIXELS";
  encodingKnown: boolean;
  inputSafe: boolean;
  replayDepth: number;
}

const mouseProtocols = new WeakMap<object, MouseProtocolState>();
const UNKNOWN_MOUSE_ENCODING = "CLIManagerMouseEncoding=unknown";

export function resetTerminalMouseProtocol(terminal: object): void {
  const state = mouseProtocols.get(terminal);
  if (!state) return;
  state.encoding = "DEFAULT";
  state.encodingKnown = false;
  state.inputSafe = true;
}

/**
 * SerializeAddon preserves mouse tracking, but omits its wire encoding. An SGR
 * TUI restored from that snapshot otherwise receives legacy CSI M bytes. Observe
 * the same parsed mode commands as xterm, including fragmented replay writes.
 */
export function trackTerminalMouseProtocol(terminal: Pick<Terminal, "parser">) {
  const state: MouseProtocolState = {
    encoding: "DEFAULT", encodingKnown: false, inputSafe: true, replayDepth: 0,
  };
  mouseProtocols.set(terminal, state);
  const observeModes = (enabled: boolean, params: (number | number[])[]) => {
    for (const mode of params) {
      if (mode === 1006 || mode === 1016) {
        state.encoding = enabled ? (mode === 1006 ? "SGR" : "SGR_PIXELS") : "DEFAULT";
        state.encodingKnown = true;
        state.inputSafe = true;
      } else if (mode === 9 || mode === 1000 || mode === 1002 || mode === 1003) {
        // Live applications may intentionally use legacy encoding. Historical
        // tracking alone cannot tell us whether the old serializer lost SGR.
        if (state.replayDepth === 0 && state.inputSafe) state.encodingKnown = true;
        if (enabled) state.inputSafe = state.encodingKnown;
      }
    }
    return false;
  };
  const subscriptions = [
    terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, params => observeModes(true, params)),
    terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, params => observeModes(false, params)),
    terminal.parser.registerEscHandler({ final: "c" }, () => {
      resetTerminalMouseProtocol(terminal);
      return false;
    }),
    terminal.parser.registerOscHandler(777, data => {
      if (data !== UNKNOWN_MOUSE_ENCODING) return false;
      state.encodingKnown = false;
      state.inputSafe = false;
      return true;
    }),
  ];
  const snapshotSuffix = () => {
    // Do not turn an incomplete old checkpoint into an explicit legacy one.
    if (!state.inputSafe) return `\x1b]777;${UNKNOWN_MOUSE_ENCODING}\x07`;
    return state.encoding === "SGR_PIXELS" ? "\x1b[?1016h"
      : state.encoding === "SGR" ? "\x1b[?1006h" : "\x1b[?1006l";
  };
  return {
    snapshotSuffix,
    serializeSnapshot(serializer: { serialize(options?: ISerializeOptions): string }, options?: ISerializeOptions): string {
      return serializer.serialize(options) + snapshotSuffix();
    },
    dispose() {
      subscriptions.forEach(subscription => subscription.dispose());
      mouseProtocols.delete(terminal);
    },
  };
}

/** Quarantine only mouse reports whose encoding was lost in an old checkpoint. */
export function isTerminalMouseInputSafe(terminal: object): boolean {
  return mouseProtocols.get(terminal)?.inputSafe !== false;
}

export function canForwardTerminalBinaryInput(terminal: object, data: string): boolean {
  return isTerminalMouseInputSafe(terminal)
    || data.length !== 6 || !data.startsWith("\x1b[M");
}

/**
 * Historical terminal queries must never produce new PTY input. xterm parses
 * writes asynchronously and can emit replies through onData (or an addon), so
 * keep stdin disabled until parsing has left its write callback. In xterm 6,
 * resizing inside that callback flushes the still-current chunk recursively.
 * Callers serialize replay before live output to retain live query responses.
 */
export function writeTerminalReplay(terminal: ReplayTerminal, data: string, onCommitted: () => void): void {
  const mouseProtocol = mouseProtocols.get(terminal);
  if (mouseProtocol) mouseProtocol.replayDepth++;
  let guard = replayInputGuards.get(terminal);
  if (!guard) {
    guard = { count: 0, disableStdin: terminal.options.disableStdin };
    replayInputGuards.set(terminal, guard);
  }
  guard.count++;
  terminal.options.disableStdin = true;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (mouseProtocol) mouseProtocol.replayDepth--;
    if (--guard.count === 0) {
      replayInputGuards.delete(terminal);
      terminal.options.disableStdin = guard.disableStdin;
    }
  };
  let committed = false;
  try {
    terminal.write(data, () => {
      if (committed) return;
      committed = true;
      queueMicrotask(() => {
        release();
        onCommitted();
      });
    });
  } catch (error) {
    release();
    throw error;
  }
}
