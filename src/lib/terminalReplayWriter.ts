import type { Terminal } from "@xterm/xterm";

type ReplayTerminal = Pick<Terminal, "options" | "write">;

const replayInputGuards = new WeakMap<ReplayTerminal, { count: number; disableStdin: boolean | undefined }>();

/**
 * Historical terminal queries must never produce new PTY input. xterm parses
 * writes asynchronously and can emit replies through onData (or an addon), so
 * keep stdin disabled until parsing has left its write callback. In xterm 6,
 * resizing inside that callback flushes the still-current chunk recursively.
 * Callers serialize replay before live output to retain live query responses.
 */
export function writeTerminalReplay(terminal: ReplayTerminal, data: string, onCommitted: () => void): void {
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
