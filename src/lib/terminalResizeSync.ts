export const PTY_RESIZE_GROW_DELAY_MS = 180;
export const PTY_RESIZE_SHRINK_DELAY_MS = 3000;
export const PTY_RESIZE_INPUT_IDLE_MS = 1200;
export const PTY_RESIZE_PASTE_IDLE_MS = 4000;
export const PTY_RESIZE_MAX_DEFER_MS = 10000;

export interface TerminalResizeDimensions {
  cols: number;
  rows: number;
}

export type TerminalResizeInputKind = "input" | "paste";

export type TerminalResizeLogEvent =
  | {
      kind: "resize_requested";
      sessionId: string;
      cols: number;
      rows: number;
      reason: "grow" | "shrink" | "initial";
    }
  | {
      kind: "resize_scheduled";
      sessionId: string;
      cols: number;
      rows: number;
      delayMs: number;
      baseDelayMs: number;
      guardRemainingMs: number;
      elapsedMs: number;
      trigger: string;
    }
  | {
      kind: "resize_emitted";
      sessionId: string;
      cols: number;
      rows: number;
      elapsedMs: number;
    }
  | {
      kind: "resize_skipped";
      sessionId: string;
      cols: number;
      rows: number;
      reason: "duplicate" | "invalid" | "disposed";
    }
  | {
      kind: "input_guard";
      sessionId: string;
      inputKind: TerminalResizeInputKind;
      guardUntilMs: number;
      holdMs: number;
    };

interface TerminalResizeSyncOptions {
  sessionId: string;
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (timerId: number) => void;
  emitResize: (dimensions: TerminalResizeDimensions) => void;
  log: (event: TerminalResizeLogEvent) => void;
}

export interface TerminalResizeSyncController {
  requestResize: (dimensions: TerminalResizeDimensions) => void;
  noteInput: (kind: TerminalResizeInputKind) => void;
  dispose: () => void;
}

const sameDimensions = (
  left: TerminalResizeDimensions | null,
  right: TerminalResizeDimensions | null
) => Boolean(left && right && left.cols === right.cols && left.rows === right.rows);

export function createTerminalResizeSync(options: TerminalResizeSyncOptions): TerminalResizeSyncController {
  let disposed = false;
  let timerId: number | null = null;
  let pending: TerminalResizeDimensions | null = null;
  let pendingSinceMs = 0;
  let inputGuardUntilMs = 0;
  let lastEmitted: TerminalResizeDimensions | null = null;

  const clearTimer = () => {
    if (timerId === null) return;
    options.clearTimeout(timerId);
    timerId = null;
  };

  const schedule = (trigger: string) => {
    if (!pending || disposed) return;
    clearTimer();

    const now = options.now();
    const elapsedMs = Math.max(0, now - pendingSinceMs);
    const guardRemainingMs = Math.max(0, inputGuardUntilMs - now);
    const isShrink = Boolean(lastEmitted && pending.cols < lastEmitted.cols);
    const baseDelayMs = isShrink ? PTY_RESIZE_SHRINK_DELAY_MS : PTY_RESIZE_GROW_DELAY_MS;
    const unclampedDelayMs = Math.max(baseDelayMs, guardRemainingMs);
    const remainingDeferMs = Math.max(0, PTY_RESIZE_MAX_DEFER_MS - elapsedMs);
    const delayMs = Math.min(unclampedDelayMs, remainingDeferMs);

    options.log({
      kind: "resize_scheduled",
      sessionId: options.sessionId,
      cols: pending.cols,
      rows: pending.rows,
      delayMs,
      baseDelayMs,
      guardRemainingMs,
      elapsedMs,
      trigger,
    });

    timerId = options.setTimeout(flush, delayMs);
  };

  const flush = () => {
    timerId = null;
    if (!pending) return;
    if (disposed) {
      options.log({
        kind: "resize_skipped",
        sessionId: options.sessionId,
        cols: pending.cols,
        rows: pending.rows,
        reason: "disposed",
      });
      pending = null;
      return;
    }

    const now = options.now();
    const elapsedMs = Math.max(0, now - pendingSinceMs);
    const guardRemainingMs = Math.max(0, inputGuardUntilMs - now);
    if (guardRemainingMs > 0 && elapsedMs < PTY_RESIZE_MAX_DEFER_MS) {
      schedule("input_guard_active");
      return;
    }

    const dimensions = pending;
    pending = null;
    pendingSinceMs = 0;

    if (sameDimensions(dimensions, lastEmitted)) {
      options.log({
        kind: "resize_skipped",
        sessionId: options.sessionId,
        cols: dimensions.cols,
        rows: dimensions.rows,
        reason: "duplicate",
      });
      return;
    }

    lastEmitted = dimensions;
    options.log({
      kind: "resize_emitted",
      sessionId: options.sessionId,
      cols: dimensions.cols,
      rows: dimensions.rows,
      elapsedMs,
    });
    options.emitResize(dimensions);
  };

  return {
    requestResize: (dimensions) => {
      if (disposed) {
        options.log({
          kind: "resize_skipped",
          sessionId: options.sessionId,
          cols: dimensions.cols,
          rows: dimensions.rows,
          reason: "disposed",
        });
        return;
      }
      if (!Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows) || dimensions.cols <= 0 || dimensions.rows <= 0) {
        options.log({
          kind: "resize_skipped",
          sessionId: options.sessionId,
          cols: dimensions.cols,
          rows: dimensions.rows,
          reason: "invalid",
        });
        return;
      }

      const reason = lastEmitted === null
        ? "initial"
        : dimensions.cols < lastEmitted.cols
          ? "shrink"
          : "grow";
      options.log({
        kind: "resize_requested",
        sessionId: options.sessionId,
        cols: dimensions.cols,
        rows: dimensions.rows,
        reason,
      });

      if (sameDimensions(dimensions, lastEmitted)) {
        pending = null;
        pendingSinceMs = 0;
        clearTimer();
        options.log({
          kind: "resize_skipped",
          sessionId: options.sessionId,
          cols: dimensions.cols,
          rows: dimensions.rows,
          reason: "duplicate",
        });
        return;
      }

      if (!pending) {
        pendingSinceMs = options.now();
      }
      pending = dimensions;
      schedule("resize_requested");
    },

    noteInput: (kind) => {
      const now = options.now();
      const holdMs = kind === "paste" ? PTY_RESIZE_PASTE_IDLE_MS : PTY_RESIZE_INPUT_IDLE_MS;
      inputGuardUntilMs = Math.max(inputGuardUntilMs, now + holdMs);
      options.log({
        kind: "input_guard",
        sessionId: options.sessionId,
        inputKind: kind,
        guardUntilMs: inputGuardUntilMs,
        holdMs,
      });
      if (pending) {
        schedule("input_guard_updated");
      }
    },

    dispose: () => {
      disposed = true;
      clearTimer();
      pending = null;
      pendingSinceMs = 0;
    },
  };
}
