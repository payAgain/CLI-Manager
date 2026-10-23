export interface ScheduledTerminalWrite {
  token: symbol;
  isVisible: () => boolean;
  flush: () => void;
}

interface TerminalWriteSchedulerEnvironment {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (id: number) => void;
  now: () => number;
  isDocumentHidden: () => boolean;
}

const MAX_WRITES_PER_FRAME = 4;
const DISPATCH_BUDGET_MS = 4;
const BACKGROUND_WRITE_INTERVAL_MS = 100;
const VISIBLE_WRITE_BURST = 3;

/** Share output work fairly without making split panes wait one frame per pane. */
export class TerminalWriteScheduler {
  private readonly pending = new Map<symbol, ScheduledTerminalWrite>();
  private frameId: number | null = null;
  private timerId: number | null = null;
  private flushing = false;
  private visibleWriteBurst = 0;

  constructor(private readonly environment: TerminalWriteSchedulerEnvironment) {}

  request(entry: ScheduledTerminalWrite): void {
    this.pending.set(entry.token, entry);
    this.schedule();
  }

  cancel(token: symbol): void {
    this.pending.delete(token);
    if (this.pending.size === 0) {
      this.cancelWakeup();
      this.visibleWriteBurst = 0;
    }
  }

  private cancelWakeup(): void {
    if (this.frameId !== null) {
      this.environment.cancelFrame(this.frameId);
      this.frameId = null;
    }
    if (this.timerId !== null) {
      this.environment.clearTimer(this.timerId);
      this.timerId = null;
    }
  }

  private schedule(): void {
    if (this.flushing || this.frameId !== null || this.timerId !== null || this.pending.size === 0) return;
    if (!this.environment.isDocumentHidden()) {
      this.frameId = this.environment.requestFrame(() => this.flush(false));
    }
    // WebViews may suspend rAF while minimized or in the tray, sometimes before
    // visibilityState changes. Keep output acknowledgements moving at a bounded
    // rate; the first wakeup cancels the other so a batch cannot run twice.
    this.timerId = this.environment.setTimer(() => this.flush(true), BACKGROUND_WRITE_INTERVAL_MS);
  }

  private select(seen: Set<symbol>): ScheduledTerminalWrite | undefined {
    let visible: ScheduledTerminalWrite | undefined;
    let hidden: ScheduledTerminalWrite | undefined;
    for (const entry of this.pending.values()) {
      if (seen.has(entry.token)) continue;
      if (entry.isVisible()) visible ??= entry;
      else hidden ??= entry;
      if (visible && hidden) break;
    }
    return visible && (!hidden || this.visibleWriteBurst < VISIBLE_WRITE_BURST)
      ? visible
      : hidden ?? visible;
  }

  private flush(fromTimer: boolean): void {
    this.cancelWakeup();
    this.flushing = true;
    const startedAt = this.environment.now();
    const limit = fromTimer || this.environment.isDocumentHidden() ? 1 : MAX_WRITES_PER_FRAME;
    const seen = new Set<symbol>();
    try {
      while (seen.size < limit) {
        // This bounds synchronous dispatch/transform work. xterm parsing is
        // asynchronous and remains bounded separately by the per-write byte cap
        // and by the number of terminals dispatched in this turn.
        if (seen.size > 0 && this.environment.now() - startedAt >= DISPATCH_BUDGET_MS) break;
        const entry = this.select(seen);
        if (!entry) break;
        seen.add(entry.token);
        this.pending.delete(entry.token);
        this.visibleWriteBurst = entry.isVisible()
          ? Math.min(VISIBLE_WRITE_BURST, this.visibleWriteBurst + 1)
          : 0;
        entry.flush();
      }
    } finally {
      this.flushing = false;
      if (this.pending.size === 0) this.visibleWriteBurst = 0;
      this.schedule();
    }
  }
}
