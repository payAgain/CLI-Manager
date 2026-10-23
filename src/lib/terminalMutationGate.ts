import type { Terminal } from "@xterm/xterm";

type GatedTerminal = Pick<Terminal, "write" | "resize" | "reset" | "clear">;
type Operation = (() => boolean | void);

export interface TerminalMutationGate {
  /** Drain parsed writes, then keep the buffer stable until capture settles. */
  capture<T>(capture: (signal: AbortSignal) => T | Promise<T>, signal: AbortSignal): Promise<T>;
  mutate(mutation: () => void): void;
  /** Drop unparsed operations; never acknowledge output that was not parsed. */
  dispose(): void;
}

const gates = new WeakMap<object, TerminalMutationGate>();

/** Buffer mutations outside the public write/resize API (options and TUI cells). */
export function mutateTerminalWhenReady(terminal: object, mutation: () => void): void {
  const gate = gates.get(terminal);
  if (gate) gate.mutate(mutation);
  else mutation();
}

/**
 * Freeze BEFORE adding the raw write barrier: newly submitted writes must not
 * enter xterm's parser queue behind it. Existing writes drain normally. Release
 * queued writes one callback at a time so a following resize cannot flushSync a
 * large pending replay. Only this terminal waits; other terminals keep parsing.
 */
export function installTerminalMutationGate(
  terminal: GatedTerminal,
  onDeferredError: (error: unknown) => void = error => console.error("Deferred terminal mutation failed", error),
): TerminalMutationGate {
  const existing = gates.get(terminal);
  if (existing) return existing;
  const write = terminal.write.bind(terminal);
  const resize = terminal.resize.bind(terminal);
  const reset = terminal.reset.bind(terminal);
  const clear = terminal.clear.bind(terminal);
  let queue: Operation[] = [];
  let head = 0;
  let busy = false;
  let mutationDepth = 0;
  let disposed = false;
  const captures = new Set<AbortController>();

  const drain = () => {
    if (disposed) return;
    busy = true;
    while (head < queue.length) {
      const operation = queue[head++];
      // A write/capture owns the queue until its asynchronous completion.
      try {
        if (operation()) return;
      } catch (error) {
        // Deferred calls cannot throw back to their original caller. Report the
        // failure, then release later work instead of wedging the terminal queue.
        onDeferredError(error);
      }
    }
    queue = [];
    head = 0;
    busy = false;
  };
  const enqueue = (operation: Operation) => {
    queue.push(operation);
    if (!busy) drain();
  };
  const resume = () => queueMicrotask(drain);
  const mutate = (mutation: () => void) => {
    if (disposed) return;
    if (!busy || mutationDepth > 0) mutation();
    else enqueue(() => {
      mutationDepth++;
      try { mutation(); }
      finally { mutationDepth--; }
    });
  };

  terminal.write = (data, callback) => {
    if (disposed) return;
    if (!busy) {
      write(data, callback ? () => { if (!disposed) callback(); } : undefined);
      return;
    }
    // The producer may reuse a binary frame before the deferred parser sees it.
    const pending = typeof data === "string" ? data : data.slice();
    enqueue(() => {
      write(pending, () => {
        try { if (!disposed) callback?.(); }
        finally { resume(); }
      });
      return true;
    });
  };
  terminal.resize = (cols, rows) => mutate(() => resize(cols, rows));
  terminal.reset = () => mutate(reset);
  terminal.clear = () => mutate(clear);

  const gate: TerminalMutationGate = {
    mutate,
    capture<T>(capture: (signal: AbortSignal) => T | Promise<T>, signal: AbortSignal): Promise<T> {
      if (disposed || signal.aborted) return Promise.reject(new Error("Terminal snapshot source disposed"));
      const lifetime = new AbortController();
      captures.add(lifetime);
      const onSourceAbort = () => lifetime.abort(signal.reason);
      signal.addEventListener("abort", onSourceAbort, { once: true });
      return new Promise<T>((resolve, reject) => {
        let started = false;
        let capturing = false;
        let settled = false;
        const finish = (error: unknown, value?: T) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onSourceAbort);
          lifetime.signal.removeEventListener("abort", onAbort);
          captures.delete(lifetime);
          if (error !== undefined) reject(error);
          else resolve(value as T);
          if (started) resume();
        };
        const onAbort = () => {
          // Once capture is running it must observe cancellation and stop reading
          // before writes are resumed. A pending empty barrier can be abandoned.
          if (!capturing) finish(lifetime.signal.reason ?? new Error("Terminal snapshot source disposed"));
        };
        lifetime.signal.addEventListener("abort", onAbort, { once: true });
        enqueue(() => {
          if (settled) return;
          started = true;
          try {
            write("", () => queueMicrotask(() => {
              // Replay commits and onWriteParsed run after xterm's write callback.
              if (settled || lifetime.signal.aborted || disposed) return;
              capturing = true;
              try {
                Promise.resolve(capture(lifetime.signal)).then(
                  value => finish(lifetime.signal.aborted ? lifetime.signal.reason : undefined, value),
                  error => finish(error),
                );
              } catch (error) {
                finish(error);
              }
            }));
          } catch (error) {
            finish(error);
          }
          return true;
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const lifetime of captures) lifetime.abort(new Error("Terminal snapshot source disposed"));
      queue = [];
      head = 0;
      // Keep the WeakMap guard until GC: late theme/fit callbacks must not touch
      // the disposed terminal, or revive dropped output callbacks and ACKs.
    },
  };
  gates.set(terminal, gate);
  return gate;
}
