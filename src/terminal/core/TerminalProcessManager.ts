import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { TerminalCapabilityStore } from "../capabilities/TerminalCapabilityStore";
import {
  ptyHostSocket,
  type TerminalBinaryFrame,
} from "../transport/PtyHostSocket";

export interface TerminalClaudeProviderLaunchConfig {
  projectId: string;
  providerId: string;
  dbPath?: string;
}

export interface TerminalCodexProviderLaunchConfig {
  providerId: string;
  dbPath?: string;
  codexConfigDir?: string;
}

export interface TerminalCreateRequest extends Record<string, unknown> {
  cwd: string | null;
  envVars: Record<string, string> | null;
  shell: string | null;
  hookEnvEnabled: boolean;
  claudeProvider: TerminalClaudeProviderLaunchConfig | null;
  codexProvider: TerminalCodexProviderLaunchConfig | null;
}

interface PreparedTerminalCreate {
  sessionId: string;
  cwd: string | null;
  envVars: Record<string, string>;
  shell: string | null;
}

export interface TerminalStatusEvent {
  status: string;
  exit_code: number | null;
}

export interface TerminalAttachResult {
  attached: boolean;
  alive: boolean;
  cwd?: string | null;
  shell?: string | null;
  createdAtMs?: number;
  taskStatus?: string | null;
  taskUpdatedAtMs?: number | null;
  replay: TerminalBinaryFrame[];
}

export interface TerminalOutputDelivery {
  frame: TerminalBinaryFrame;
  commit: (charCount: number) => void;
}

interface QueuedOutputFrame {
  frame: TerminalBinaryFrame;
  committed: boolean;
  charCount: number;
}

interface TerminalOutputState {
  frames: QueuedOutputFrame[];
  sequences: Set<number>;
  consumer: ((delivery: TerminalOutputDelivery) => void) | null;
  consumerGeneration: number;
  deliveredCount: number;
  socketUnlisten: UnlistenFn | null;
  latestCommittedSequence: number;
}

/**
 * Owns the frontend side of the PTY process contract.
 *
 * Low-frequency launch preparation uses Tauri IPC; PTY create/write/resize/
 * close/output use the direct PtyHost WebSocket. Keeping all callers behind
 * this boundary prevents transport and lifecycle logic from leaking back into
 * components and stores.
 */
export class TerminalProcessManager {
  private readonly capabilities = new Map<string, TerminalCapabilityStore>();
  private readonly outputStates = new Map<string, TerminalOutputState>();

  getCapabilities(sessionId: string): TerminalCapabilityStore {
    let store = this.capabilities.get(sessionId);
    if (!store) {
      store = new TerminalCapabilityStore();
      this.capabilities.set(sessionId, store);
    }
    return store;
  }

  create(request: TerminalCreateRequest): Promise<string> {
    return invoke<PreparedTerminalCreate>("pty_prepare_create", request).then(async (prepared) => {
      const sessionId = prepared.sessionId;
      this.getCapabilities(sessionId);
      try {
        await ptyHostSocket.create(
          sessionId,
          prepared.cwd,
          prepared.envVars,
          prepared.shell,
        );
      } catch (error) {
        this.capabilities.delete(sessionId);
        throw error;
      }
      return sessionId;
    });
  }

  write(sessionId: string, data: string): Promise<void> {
    return ptyHostSocket.write(sessionId, data);
  }

  resize(sessionId: string, cols: number, rows: number): Promise<void> {
    return ptyHostSocket.resize(sessionId, cols, rows);
  }

  close(sessionId: string): Promise<void> {
    return ptyHostSocket.close(sessionId).finally(() => {
      this.clearOutputState(sessionId);
      this.capabilities.get(sessionId)?.clear();
      this.capabilities.delete(sessionId);
    });
  }

  closeAll(): Promise<void> {
    return ptyHostSocket.closeAll().finally(() => {
      [...this.outputStates.keys()].forEach((sessionId) => this.clearOutputState(sessionId));
      this.capabilities.forEach((store) => store.clear());
      this.capabilities.clear();
    });
  }

  attach(sessionId: string): Promise<TerminalAttachResult> {
    return ptyHostSocket.attach(sessionId);
  }

  async subscribeOutput(sessionId: string, listener: (delivery: TerminalOutputDelivery) => void): Promise<UnlistenFn> {
    await ptyHostSocket.connect();
    const state = this.getOutputState(sessionId);
    if (!state.socketUnlisten) {
      state.socketUnlisten = ptyHostSocket.subscribeOutput(sessionId, (frame) => {
        this.enqueueOutputFrame(sessionId, frame);
      });
    }
    state.consumerGeneration += 1;
    const generation = state.consumerGeneration;
    state.consumer = listener;
    state.deliveredCount = 0;
    this.deliverPendingOutput(sessionId, state);
    return () => {
      const current = this.outputStates.get(sessionId);
      if (!current || current.consumerGeneration !== generation) return;
      current.consumer = null;
      current.consumerGeneration += 1;
      current.deliveredCount = 0;
    };
  }

  async subscribeStatus(sessionId: string, listener: (payload: TerminalStatusEvent) => void): Promise<UnlistenFn> {
    await ptyHostSocket.connect();
    return ptyHostSocket.subscribeStatus(sessionId, listener);
  }

  acknowledgeOutput(sessionId: string, sequence: number, charCount: number): void {
    ptyHostSocket.acknowledge(sessionId, sequence, charCount);
  }

  private getOutputState(sessionId: string): TerminalOutputState {
    let state = this.outputStates.get(sessionId);
    if (!state) {
      state = {
        frames: [],
        sequences: new Set(),
        consumer: null,
        consumerGeneration: 0,
        deliveredCount: 0,
        socketUnlisten: null,
        latestCommittedSequence: 0,
      };
      this.outputStates.set(sessionId, state);
    }
    return state;
  }

  private enqueueOutputFrame(sessionId: string, frame: TerminalBinaryFrame): void {
    const state = this.getOutputState(sessionId);
    if (frame.sequence <= state.latestCommittedSequence || state.sequences.has(frame.sequence)) return;
    state.sequences.add(frame.sequence);
    state.frames.push({ frame, committed: false, charCount: 0 });
    this.deliverPendingOutput(sessionId, state);
  }

  private deliverPendingOutput(sessionId: string, state: TerminalOutputState): void {
    const consumer = state.consumer;
    if (!consumer) return;
    const generation = state.consumerGeneration;
    while (state.deliveredCount < state.frames.length) {
      const queued = state.frames[state.deliveredCount];
      state.deliveredCount += 1;
      consumer({
        frame: queued.frame,
        commit: (charCount) => {
          const current = this.outputStates.get(sessionId);
          if (!current || current.consumerGeneration !== generation || queued.committed) return;
          queued.committed = true;
          queued.charCount = Math.max(0, charCount);
          this.drainCommittedOutput(sessionId, current);
        },
      });
    }
  }

  private drainCommittedOutput(sessionId: string, state: TerminalOutputState): void {
    while (state.frames[0]?.committed) {
      const [queued] = state.frames.splice(0, 1);
      state.sequences.delete(queued.frame.sequence);
      state.deliveredCount = Math.max(0, state.deliveredCount - 1);
      state.latestCommittedSequence = Math.max(
        state.latestCommittedSequence,
        queued.frame.sequence,
      );
      ptyHostSocket.acknowledge(
        sessionId,
        queued.frame.sequence,
        queued.frame.kind === "output" ? queued.charCount : 0,
      );
    }
  }

  private clearOutputState(sessionId: string): void {
    const state = this.outputStates.get(sessionId);
    state?.socketUnlisten?.();
    this.outputStates.delete(sessionId);
  }
}

export const terminalProcessManager = new TerminalProcessManager();
