export interface TerminalViewportRefresher {
  rows: number;
  refresh(start: number, end: number): void;
}

export interface TerminalVisibilityRestoreInput {
  wasVisible: boolean;
  isVisible: boolean;
  inactiveBufferLength: number;
  activeWriteQueueLength: number;
  activeWriteRafScheduled: boolean;
}

export interface TerminalVisibilityRestorePlan {
  shouldFlushInactiveBuffer: boolean;
  shouldRefreshViewport: boolean;
  shouldResumeActiveWriteQueue: boolean;
}

export interface TerminalRenderRange {
  start: number;
  end: number;
}

export function refreshTerminalViewport(
  terminal: TerminalViewportRefresher | null | undefined,
): boolean {
  if (!terminal || terminal.rows <= 0) return false;
  terminal.refresh(0, terminal.rows - 1);
  return true;
}

export function didRenderFullTerminalViewport(
  range: TerminalRenderRange,
  rows: number,
): boolean {
  return rows > 0 && range.start <= 0 && range.end >= rows - 1;
}

export function planTerminalVisibilityRestore(
  input: TerminalVisibilityRestoreInput,
): TerminalVisibilityRestorePlan {
  const becameVisible = !input.wasVisible && input.isVisible;
  return {
    shouldFlushInactiveBuffer: becameVisible && input.inactiveBufferLength > 0,
    shouldRefreshViewport: becameVisible,
    shouldResumeActiveWriteQueue: becameVisible && input.activeWriteQueueLength > 0 && !input.activeWriteRafScheduled,
  };
}
