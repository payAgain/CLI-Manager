import { useTerminalStore } from "../stores/terminalStore";
import { useSessionStore } from "../stores/sessionStore";
import { logError } from "./logger";

const SNAPSHOT_THROTTLE_MS = 10_000;
const CHECKPOINT_THROTTLE_MS = 60_000;
// Request an early full checkpoint well before the daemon's 2 MiB ring +
// 10 MiB spool fills. This trigger is driven by committed bytes, not a poll.
const CHECKPOINT_OUTPUT_BYTES = 4 * 1024 * 1024;
export const SNAPSHOT_MAX_LINES = 2000;

export interface TerminalSnapshotCapture {
  /** Independently replayable, bounded tail (including modes and alt screen). */
  snapshot: string;
  /** A full snapshot with geometry and sequence captured in the same write barrier. */
  checkpoint?: () => Promise<void>;
  /** A daemon reset may invalidate an otherwise complete captured picture. */
  isCurrent?: () => boolean;
}

interface SnapshotSource {
  serialize: (signal: AbortSignal, full: boolean) => TerminalSnapshotCapture | Promise<TerminalSnapshotCapture>;
  lifetime: AbortController;
  revision: number;
  persistedRevision: number;
  checkpointRevision: number;
  checkpointAt: number;
  outputBytes: number;
  checkpointRetry: boolean;
}

const sources = new Map<string, SnapshotSource>();
let timer: ReturnType<typeof setInterval> | null = null;
let earlyCheckpointTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight: Promise<void> | null = null;
let forceFlushPending = false;

function needsPersistence(source: SnapshotSource): boolean {
  return source.revision !== source.persistedRevision;
}

function needsCheckpoint(source: SnapshotSource): boolean {
  return source.checkpointRetry || (source.revision !== source.checkpointRevision && (
    source.outputBytes >= CHECKPOINT_OUTPUT_BYTES
    || Date.now() - source.checkpointAt >= CHECKPOINT_THROTTLE_MS
  ));
}

export function terminalSnapshotDiagnostics() {
  return {
    sources: sources.size,
    dirtySources: [...sources.values()].filter(source => needsPersistence(source) || source.checkpointRetry).length,
    flushing: flushInFlight !== null,
    forceFlushPending,
  };
}

/** Register on mount; only the matching lifetime may publish or clear its revisions. */
export function registerTerminalSnapshotSource(
  sessionId: string,
  serialize: SnapshotSource["serialize"],
): () => void {
  sources.get(sessionId)?.lifetime.abort();
  const source: SnapshotSource = {
    serialize, lifetime: new AbortController(), revision: 0, persistedRevision: 0,
    checkpointRevision: 0, checkpointAt: -Infinity, outputBytes: 0, checkpointRetry: false,
  };
  sources.set(sessionId, source);
  if (timer === null) timer = setInterval(() => { void flushDirtySnapshots(); }, SNAPSHOT_THROTTLE_MS);
  return () => {
    source.lifetime.abort();
    if (sources.get(sessionId) !== source) return;
    sources.delete(sessionId);
    if (sources.size === 0) {
      if (timer !== null) clearInterval(timer);
      if (earlyCheckpointTimer !== null) clearTimeout(earlyCheckpointTimer);
      timer = null;
      earlyCheckpointTimer = null;
    }
  };
}

/** Call after parsing/ACK, never when output is only queued outside xterm. */
export function markTerminalSnapshotDirty(sessionId: string, outputBytes = 0): void {
  const source = sources.get(sessionId);
  if (!source) return;
  source.revision++;
  const previousBytes = source.outputBytes;
  source.outputBytes += Math.max(0, outputBytes);
  if (previousBytes < CHECKPOINT_OUTPUT_BYTES && source.outputBytes >= CHECKPOINT_OUTPUT_BYTES) {
    scheduleEarlyCheckpoint();
  }
}

function scheduleEarlyCheckpoint(): void {
  if (earlyCheckpointTimer !== null) return;
  earlyCheckpointTimer = setTimeout(() => {
    earlyCheckpointTimer = null;
    void flushSnapshots(false, true);
  }, 0);
}

async function flushDirtySnapshots(): Promise<void> {
  await flushSnapshots(false);
}

/** Exit always captures complete, current pictures, including hidden terminals. */
export async function flushTerminalSnapshotsNow(): Promise<void> {
  await flushSnapshots(true);
}

function flushSnapshots(force: boolean, checkpointOnly = false): Promise<void> {
  if (flushInFlight) {
    if (force) forceFlushPending = true;
    return flushInFlight;
  }
  const flight = Promise.resolve().then(async () => {
    try {
      let forcePass = force || forceFlushPending;
      do {
        forceFlushPending = false;
        await flushSnapshotPass(forcePass, checkpointOnly && !forcePass);
        forcePass = forceFlushPending;
      } while (forcePass);
    } finally {
      flushInFlight = null;
      // Output can cross the byte threshold during an upload or another source's
      // write barrier. Do not lose that request merely because a flush was active.
      if ([...sources.values()].some(source => !source.checkpointRetry && source.outputBytes >= CHECKPOINT_OUTPUT_BYTES)) {
        scheduleEarlyCheckpoint();
      }
    }
  });
  flushInFlight = flight;
  return flight;
}

async function flushSnapshotPass(force: boolean, checkpointOnly: boolean): Promise<void> {
  const updated = new Map<string, { source: SnapshotSource; revision: number }>();
  let processed = false;
  // A stable pass cannot be extended indefinitely by terminals mounting during it.
  for (const [sessionId, source] of [...sources]) {
    const full = force || needsCheckpoint(source);
    if (!force && !(checkpointOnly ? full : needsPersistence(source) || full)) continue;
    // Microtasks alone do not give input/rendering a turn. Each source holds its
    // own mutation gate while scanning in slices; also yield between terminals.
    if (processed) await new Promise<void>(resolve => setTimeout(resolve, 0));
    processed = true;
    if (sources.get(sessionId) !== source) continue;
    const revision = source.revision;
    const outputBytes = source.outputBytes;
    try {
      const capture = await source.serialize(source.lifetime.signal, full);
      if (sources.get(sessionId) !== source) continue;
      if (capture.isCurrent?.() === false) {
        if (full) source.checkpointRetry = true;
        continue;
      }
      if (full) {
        try {
          await capture.checkpoint?.();
          if (sources.get(sessionId) !== source) continue;
          source.checkpointRevision = revision;
          source.checkpointAt = Date.now();
          source.outputBytes = Math.max(0, source.outputBytes - outputBytes);
          source.checkpointRetry = false;
        } catch (err) {
          if (sources.get(sessionId) === source) {
            source.checkpointRetry = true;
            logError("Failed to upload terminal checkpoint", { sessionId, err });
          }
        }
      }
      if (sources.get(sessionId) !== source) continue;
      if (capture.isCurrent?.() === false) {
        if (full) source.checkpointRetry = true;
        continue;
      }
      useTerminalStore.getState().updateSessionTerminalSnapshot(sessionId, capture.snapshot);
      updated.set(sessionId, { source, revision });
    } catch (err) {
      if (sources.get(sessionId) === source && !source.lifetime.signal.aborted) {
        // A clean forced capture also needs to retry after serialization failure.
        if (source.revision === source.persistedRevision) source.revision++;
        if (full) source.checkpointRetry = true;
        logError("Failed to serialize terminal snapshot for throttled persistence", { sessionId, err });
      }
    }
  }

  if (updated.size === 0) return;
  try {
    await useSessionStore.getState().saveSessions(useTerminalStore.getState().sessions);
    for (const [sessionId, { source, revision }] of updated) {
      if (sources.get(sessionId) === source) source.persistedRevision = revision;
    }
  } catch (err) {
    for (const [sessionId, { source }] of updated) {
      if (sources.get(sessionId) === source && source.revision === source.persistedRevision) source.revision++;
    }
    logError("Failed to persist throttled terminal snapshots", { err });
  }
}
