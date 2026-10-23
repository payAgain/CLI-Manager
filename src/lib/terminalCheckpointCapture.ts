import type { Terminal } from "@xterm/xterm";
import { createTerminalSerialization, type TerminalSerializationJob } from "./cooperativeTerminalSerializer";
import type { TerminalMutationGate } from "./terminalMutationGate";

export interface TerminalCheckpointPicture {
  snapshot: string;
  serialized?: string;
  cols: number;
  rows: number;
  sequence: number;
  generation: number | undefined;
}

/** Owns a consistent picture, geometry, mouse encoding and committed watermark. */
export function createTerminalCheckpointCapture(options: {
  terminal: Terminal;
  gate: TerminalMutationGate;
  maxLines: number;
  snapshotSuffix: () => string;
  serializeSync: () => string;
  getSequence: () => number;
  getGeneration?: () => number | undefined;
  waitForReset?: (signal: AbortSignal) => Promise<void>;
  isResetPending?: () => boolean;
}) {
  const { terminal, gate, maxLines, snapshotSuffix, serializeSync, getSequence } = options;
  const getGeneration = options.getGeneration ?? (() => 0);
  let activeFull: { job: TerminalSerializationJob; suffix: string } | undefined;

  return {
    async capture(signal: AbortSignal, full: boolean): Promise<TerminalCheckpointPicture> {
      for (let attempt = 0; attempt < 2; attempt++) {
        // Do not hold the gate while waiting for a reset still in the PTY/rAF
        // scheduler: that reset needs to parse before its confirmation can resolve.
        if (options.waitForReset) await options.waitForReset(signal);
        const generation = getGeneration();
        const picture = await gate.capture(async captureSignal => {
          if (options.isResetPending?.()) return undefined;
          const cols = terminal.cols;
          const rows = terminal.rows;
          const sequence = getSequence();
          const suffix = snapshotSuffix();
          const altRows = terminal.buffer.active.type === "alternate" ? rows : 0;
          const scrollback = Math.max(0, maxLines - rows - altRows);
          try {
            let serialized: string | undefined;
            if (full) {
              const job = createTerminalSerialization(terminal);
              activeFull = { job, suffix };
              serialized = await job.run(captureSignal) + suffix;
            }
            const snapshot = serialized !== undefined && terminal.buffer.normal.length <= rows + scrollback
              ? serialized
              : await createTerminalSerialization(terminal, { scrollback }).run(captureSignal) + suffix;
            return { snapshot, serialized, cols, rows, sequence, generation };
          } finally {
            activeFull = undefined;
          }
        }, signal);
        if (picture && getGeneration() === generation && !options.isResetPending?.()) return picture;
        // A reset can arrive while the barrier is pending, before its buffer reset
        // is parsed. Retry behind those queued mutations, never upload old text
        // with the new stream's zero watermark.
      }
      throw new Error("Terminal output stream changed during checkpoint capture");
    },
    /** React unmount cannot await. Continue an in-flight full scan when possible. */
    finishForDispose(): string {
      try {
        return activeFull ? activeFull.job.finishSync() + activeFull.suffix : serializeSync();
      } finally {
        // Stop callbacks/ACKs immediately in layout cleanup, before passive cleanup
        // can run. The retained picture must not be followed by unrecorded output.
        gate.dispose();
      }
    },
  };
}
