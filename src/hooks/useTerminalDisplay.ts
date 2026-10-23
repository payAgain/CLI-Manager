import { useRef, type RefObject } from "react";
import type { IMarker, ITheme, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { refreshTerminalViewport } from "../lib/terminalVisibility";
import { isLightTerminalTheme } from "../lib/terminalThemes";
import { logError, logWarn } from "../lib/logger";
import { markTerminalSnapshotDirty } from "../lib/sessionSnapshotPersistence";
import { resetTerminalMouseProtocol, writeTerminalReplay } from "../lib/terminalReplayWriter";
import { isValidTerminalSize, TerminalResizeDebouncer } from "../terminal/browser/TerminalResizeDebouncer";
import { TerminalResizeRenderBarrier } from "../terminal/browser/TerminalResizeRenderBarrier";
import { TerminalWriteScheduler } from "../terminal/browser/TerminalWriteScheduler";
import {
  terminalProcessManager,
  type TerminalOutputDelivery,
  type TerminalDisplaySnapshot,
} from "../terminal/core/TerminalProcessManager";
import type { TerminalBinaryFrame } from "../terminal/transport/PtyHostSocket";
import {
  TERMINAL_FONT_SIZE_MAX,
  TERMINAL_FONT_SIZE_MIN,
  useSettingsStore,
} from "../stores/settingsStore";
import { useTerminalStore } from "../stores/terminalStore";

const HIDDEN_WEBGL_DISPOSE_DELAY_MS = 30_000;
const LOW_MEMORY_WEBGL_DISPOSE_DELAY_MS = 10_000;
const PTY_LIVE_WRITE_BATCH_BYTES = 64 * 1024;
const terminalWriteScheduler = new TerminalWriteScheduler({
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimer: (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (id) => window.clearTimeout(id),
  now: () => performance.now(),
  isDocumentHidden: () => document.visibilityState === "hidden",
});

type NormalizeTerminalOutput = (text: string, recordHistory?: boolean) => string;
type TransformTerminalOutput = (text: string) => string;
type AfterTerminalWrite = (terminal: Terminal) => void;

export interface TerminalOutputDiagnostics {
  onFrame(frame: TerminalBinaryFrame, rawText: string, normalizedText: string): void;
  onWriteCommitted(terminal: Terminal, writtenText: string): void;
  reset(): void;
}

interface PendingTerminalWrite {
  text: string;
  charCount: number;
  byteLength: number;
  commit: ((charCount: number) => void) | null;
  replay: boolean;
  replayBatchEnd: boolean;
  cols: number;
  rows: number;
  reset: boolean;
}

type PendingViewportRestore =
  | {
    kind: "bottom";
    terminal: Terminal;
  }
  | {
    kind: "marker";
    marker: IMarker;
    terminal: Terminal;
  };

interface UseTerminalDisplayOptions {
  sessionId: string;
  containerRef: RefObject<HTMLDivElement | null>;
  terminalRef: RefObject<Terminal | null>;
  fitAddonRef: RefObject<FitAddon | null>;
  isVisibleRef: RefObject<boolean>;
  isComposingRef: RefObject<boolean>;
  lowMemoryMode: boolean;
  disableHardwareAcceleration: boolean;
  linuxGraphicsDisableWebgl: boolean;
  isTransparentRef: RefObject<boolean>;
  normalizeOutputRef: RefObject<NormalizeTerminalOutput>;
  transformOutputRef: RefObject<TransformTerminalOutput>;
  afterTerminalWriteRef: RefObject<AfterTerminalWrite | null>;
  outputDiagnosticsRef?: RefObject<TerminalOutputDiagnostics | null>;
  onPtyOutputListenError: (err: unknown) => void;
  onViewportRefreshNeeded?: () => void;
}

export interface UseTerminalDisplayResult {
  syncWebglRenderer: (terminal: Terminal, theme: ITheme) => boolean;
  scheduleHiddenWebglDispose: (lowMemoryMode?: boolean) => void;
  clearHiddenWebglDisposeTimer: () => void;
  clearWebglTextureAtlas: () => void;
  disposeWebglRenderer: () => boolean;
  scheduleFit: (immediateResize?: boolean, forceViewportRefresh?: boolean) => void;
  scheduleViewportRefresh: () => void;
  markViewportRefreshNeeded: () => void;
  enqueueActiveWrite: (text: string, onCommitted?: () => void) => void;
  restoreDisplaySnapshot: (snapshot: TerminalDisplaySnapshot, onCommitted: () => void) => void;
  attachPtyOutput: (options?: { waitForReplay?: boolean }) => {
    ready: Promise<void>;
    completeReplay: (replay: TerminalBinaryFrame[]) => Promise<boolean>;
    dispose: () => void;
  };
  attachViewport: (terminal: Terminal) => () => void;
  resetOutputState: () => void;
  cancelScheduledFit: () => void;
  suspendViewport: () => void;
  resetViewportRefreshState: () => void;
}

export function useTerminalDisplay({
  sessionId,
  containerRef,
  terminalRef,
  fitAddonRef,
  isVisibleRef,
  isComposingRef,
  lowMemoryMode,
  disableHardwareAcceleration,
  linuxGraphicsDisableWebgl,
  isTransparentRef,
  normalizeOutputRef,
  transformOutputRef,
  afterTerminalWriteRef,
  outputDiagnosticsRef,
  onPtyOutputListenError,
  onViewportRefreshNeeded,
}: UseTerminalDisplayOptions): UseTerminalDisplayResult {
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const webglDisposeTimerRef = useRef<number | null>(null);
  const webglContextLostRef = useRef(false);
  const fitRafRef = useRef<number | null>(null);
  const pendingFitRef = useRef({ immediateResize: false, forceViewportRefresh: false });
  const needsViewportRefreshRef = useRef(false);
  const ptyPendingChunksRef = useRef<PendingTerminalWrite[]>([]);
  const ptyWriteScheduleTokenRef = useRef(Symbol(sessionId));
  const ptyWriteInProgressRef = useRef(false);
  const ptyUnlistenRef = useRef<UnlistenFn | null>(null);
  const lastObservedSizeRef = useRef<{ width: number; height: number } | null>(null);
  const resizeDebouncerRef = useRef<TerminalResizeDebouncer | null>(null);
  const resizeRenderBarrierRef = useRef<TerminalResizeRenderBarrier | null>(null);
  const viewportRestoreRafRef = useRef<number | null>(null);
  const pendingViewportRestoreRef = useRef<PendingViewportRestore | null>(null);
  const forwardPtyResizeRef = useRef(true);
  const lastPtySizeRef = useRef<string | null>(null);
  const rendererOptionsRef = useRef({ disableHardwareAcceleration, linuxGraphicsDisableWebgl, lowMemoryMode });
  rendererOptionsRef.current = { disableHardwareAcceleration, linuxGraphicsDisableWebgl, lowMemoryMode };
  const isRendererVisible = () => isVisibleRef.current
    && containerRef.current?.ownerDocument?.visibilityState !== "hidden";

  const cancelPendingViewportRestore = () => {
    if (viewportRestoreRafRef.current !== null) {
      cancelAnimationFrame(viewportRestoreRafRef.current);
      viewportRestoreRafRef.current = null;
    }
    const pending = pendingViewportRestoreRef.current;
    pendingViewportRestoreRef.current = null;
    if (pending?.kind === "marker" && !pending.marker.isDisposed) pending.marker.dispose();
  };

  const scheduleViewportRestore = (pending: PendingViewportRestore) => {
    pendingViewportRestoreRef.current = pending;
    viewportRestoreRafRef.current = requestAnimationFrame(() => {
      if (pendingViewportRestoreRef.current !== pending) return;
      viewportRestoreRafRef.current = requestAnimationFrame(() => {
        viewportRestoreRafRef.current = null;
        if (pendingViewportRestoreRef.current !== pending) return;
        pendingViewportRestoreRef.current = null;
        try {
          if (terminalRef.current !== pending.terminal) return;
          if (pending.kind === "bottom") {
            pending.terminal.scrollToBottom();
          } else if (!pending.marker.isDisposed) {
            pending.terminal.scrollToLine(pending.marker.line);
          }
        } finally {
          if (pending.kind === "marker" && !pending.marker.isDisposed) pending.marker.dispose();
        }
      });
    });
  };

  const clearHiddenWebglDisposeTimer = () => {
    if (webglDisposeTimerRef.current === null) return;
    window.clearTimeout(webglDisposeTimerRef.current);
    webglDisposeTimerRef.current = null;
  };

  const disposeWebglRenderer = () => {
    if (!webglAddonRef.current) return false;
    webglAddonRef.current.dispose();
    webglAddonRef.current = null;
    return true;
  };

  const canUseWebglRenderer = (theme: ITheme) => (
    !rendererOptionsRef.current.disableHardwareAcceleration
    && !rendererOptionsRef.current.linuxGraphicsDisableWebgl
    && !webglContextLostRef.current
    && !isTransparentRef.current
    && !isLightTerminalTheme(theme)
  );

  const createWebglAddon = () => {
    // The live-resize barrier copies the last committed renderer frame before
    // xterm reallocates its canvas. WebKit clears non-preserved WebGL drawing
    // buffers after compositing, which otherwise produces an empty snapshot.
    const addon = new WebglAddon({ preserveDrawingBuffer: true });
    addon.onContextLoss(() => {
      webglContextLostRef.current = true;
      addon.dispose();
      if (webglAddonRef.current === addon) {
        webglAddonRef.current = null;
      }
      logWarn("Terminal WebGL context lost; keeping the default renderer for this session", { sessionId });
    });
    return addon;
  };

  const syncWebglRenderer = (terminal: Terminal, theme: ITheme) => {
    if (!canUseWebglRenderer(theme)) {
      return disposeWebglRenderer();
    }
    if (!isRendererVisible()) return false;
    if (webglAddonRef.current) return false;
    try {
      const addon = createWebglAddon();
      terminal.loadAddon(addon);
      webglAddonRef.current = addon;
      return true;
    } catch {
      return false;
    }
  };

  const scheduleHiddenWebglDispose = (lowMemory = false) => {
    clearHiddenWebglDisposeTimer();
    if (!webglAddonRef.current) return;
    webglDisposeTimerRef.current = window.setTimeout(() => {
      webglDisposeTimerRef.current = null;
      if (isRendererVisible()) return;
      if (disposeWebglRenderer()) {
        needsViewportRefreshRef.current = true;
        onViewportRefreshNeeded?.();
      }
    }, lowMemory ? LOW_MEMORY_WEBGL_DISPOSE_DELAY_MS : HIDDEN_WEBGL_DISPOSE_DELAY_MS);
  };

  const clearWebglTextureAtlas = () => {
    webglAddonRef.current?.clearTextureAtlas();
  };

  const handleTerminalWriteCommitted = (terminal: Terminal) => {
    afterTerminalWriteRef.current?.(terminal);
  };

  const enqueueActiveWrite = (text: string, onCommitted?: () => void) => {
    if (!text) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.write(transformOutputRef.current(text), () => {
      if (terminalRef.current !== terminal) return;
      handleTerminalWriteCommitted(terminal);
      onCommitted?.();
    });
  };

  const restoreDisplaySnapshot = (snapshot: TerminalDisplaySnapshot, onCommitted: () => void) => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    // Keep snapshot cursor coordinates tied to their original grid until the
    // asynchronous parser has finished, including while the pane is hidden.
    forwardPtyResizeRef.current = false;
    lastPtySizeRef.current = null;
    try {
      terminal.resize(snapshot.cols, snapshot.rows);
      writeTerminalReplay(terminal, snapshot.serializedState, () => {
        if (terminalRef.current !== terminal) return;
        forwardPtyResizeRef.current = true;
        fitWhenStable(true);
        onCommitted();
      });
    } catch (error) {
      forwardPtyResizeRef.current = true;
      throw error;
    }
  };

  const attachPtyOutput = (options: { waitForReplay?: boolean } = {}) => {
    const textDecoder = new TextDecoder("utf-8");
    let cancelled = false;
    let waitingForReplay = options.waitForReplay === true;
    const bufferedLivePayloads: TerminalOutputDelivery[] = [];
    const finishReplayBatch = () => {
      forwardPtyResizeRef.current = true;
      fitWhenStable(true);
    };
    const schedulePendingWrite = () => {
      if (
        cancelled
        || ptyWriteInProgressRef.current
        || ptyPendingChunksRef.current.length === 0
      ) {
        return;
      }
      terminalWriteScheduler.request({
        token: ptyWriteScheduleTokenRef.current,
        isVisible: () => isVisibleRef.current,
        flush: flushPendingWrites,
      });
    };
    const flushPendingWrites = () => {
      if (cancelled || ptyWriteInProgressRef.current) return;
      const terminal = terminalRef.current;
      if (!terminal) return;
      const first = ptyPendingChunksRef.current.shift();
      if (!first) return;
      const pending = [first];
      if (!first.replay && !first.reset) {
        let pendingBytes = first.byteLength;
        // Keep each live write bounded at complete PTY frame boundaries so a
        // continuous producer cannot monopolize the WebView main thread.
        while (
          ptyPendingChunksRef.current[0]
          && !ptyPendingChunksRef.current[0].replay
          && !ptyPendingChunksRef.current[0].reset
        ) {
          const next = ptyPendingChunksRef.current[0];
          if (
            pending.length > 0
            && pendingBytes + next.byteLength > PTY_LIVE_WRITE_BATCH_BYTES
          ) {
            break;
          }
          pending.push(ptyPendingChunksRef.current.shift()!);
          pendingBytes += next.byteLength;
        }
      } else {
        forwardPtyResizeRef.current = false;
        lastPtySizeRef.current = null;
        if (
          first.cols > 0
          && first.rows > 0
          && (terminal.cols !== first.cols || terminal.rows !== first.rows)
        ) {
          terminal.resize(first.cols, first.rows);
        }
      }
      const combined = pending.map((chunk) => chunk.text).join("");
      const commitPending = () => {
        pending.forEach((chunk) => chunk.commit?.(chunk.charCount));
        if (first.replay && first.replayBatchEnd) finishReplayBatch();
      };
      if (first.reset) {
        outputDiagnosticsRef?.current?.reset();
        terminal.reset();
        resetTerminalMouseProtocol(terminal);
        commitPending();
        schedulePendingWrite();
        return;
      }
      if (!combined) {
        commitPending();
        schedulePendingWrite();
        return;
      }
      ptyWriteInProgressRef.current = true;
      const transformed = transformOutputRef.current(combined);
      const onCommitted = () => {
        ptyWriteInProgressRef.current = false;
        if (cancelled || terminalRef.current !== terminal) return;
        outputDiagnosticsRef?.current?.onWriteCommitted(terminal, transformed);
        handleTerminalWriteCommitted(terminal);
        commitPending();
        schedulePendingWrite();
      };
      if (first.replay) {
        writeTerminalReplay(terminal, transformed, onCommitted);
      } else {
        terminal.write(transformed, onCommitted);
      }
    };
    const queuePayload = (delivery: TerminalOutputDelivery, markSnapshotDirty: boolean) => {
      const payload = delivery.frame;
      const rawText = textDecoder.decode(payload.data, { stream: true });
      const text = normalizeOutputRef.current(rawText, payload.kind === "output");
      outputDiagnosticsRef?.current?.onFrame(payload, rawText, text);
      if (!text && payload.kind !== "replay" && payload.kind !== "reset") {
        delivery.commit(rawText.length);
        return;
      }
      if (markSnapshotDirty) {
        markTerminalSnapshotDirty(sessionId);
        useTerminalStore.getState().recordPtyOutputActivity(sessionId);
      }
      ptyPendingChunksRef.current.push({
        text,
        charCount: rawText.length,
        byteLength: payload.data.byteLength,
        commit: delivery.commit,
        replay: payload.kind === "replay",
        replayBatchEnd: payload.replayBatchEnd === true,
        cols: payload.cols,
        rows: payload.rows,
        reset: payload.kind === "reset",
      });
      schedulePendingWrite();
    };
    const ready = terminalProcessManager.subscribeOutput(sessionId, (delivery) => {
      if (cancelled) return;
      if (waitingForReplay) {
        bufferedLivePayloads.push(delivery);
        return;
      }
      queuePayload(delivery, true);
    }).then((fn) => {
      if (cancelled) {
        fn();
      } else {
        ptyUnlistenRef.current = fn;
      }
    });
    void ready.catch(onPtyOutputListenError);

    const completeReplay = async (replay: TerminalBinaryFrame[]) => {
      if (cancelled || !waitingForReplay) return false;
      const terminal = terminalRef.current;
      if (!terminal) return false;
      forwardPtyResizeRef.current = false;
      lastPtySizeRef.current = null;
      try {
        for (const entry of replay) {
          if (cancelled || terminalRef.current !== terminal) return false;
          if (entry.cols > 0 && entry.rows > 0 && (terminal.cols !== entry.cols || terminal.rows !== entry.rows)) {
            terminal.resize(entry.cols, entry.rows);
          }
          const rawText = textDecoder.decode(entry.data, { stream: true });
          const text = normalizeOutputRef.current(rawText);
          outputDiagnosticsRef?.current?.onFrame(entry, rawText, text);
          if (!text) {
            terminalProcessManager.acknowledgeOutput(sessionId, entry.sequence, 0);
            continue;
          }
          await new Promise<void>((resolve) => {
            const transformed = transformOutputRef.current(text);
            writeTerminalReplay(terminal, transformed, () => {
              if (terminalRef.current === terminal) {
                outputDiagnosticsRef?.current?.onWriteCommitted(terminal, transformed);
                handleTerminalWriteCommitted(terminal);
                terminalProcessManager.acknowledgeOutput(sessionId, entry.sequence, 0);
              }
              resolve();
            });
          });
        }
      } finally {
        forwardPtyResizeRef.current = true;
      }
      fitWhenStable(true);
      waitingForReplay = false;
      bufferedLivePayloads.splice(0).forEach((delivery) => queuePayload(delivery, true));
      return true;
    };
    const dispose = () => {
      cancelled = true;
      bufferedLivePayloads.length = 0;
      forwardPtyResizeRef.current = true;
      terminalWriteScheduler.cancel(ptyWriteScheduleTokenRef.current);
      ptyPendingChunksRef.current = [];
      ptyWriteInProgressRef.current = false;
      ptyUnlistenRef.current?.();
      ptyUnlistenRef.current = null;
    };
    return { ready, completeReplay, dispose };
  };

  const syncPtySize = (terminal: Terminal) => {
    const { cols, rows } = terminal;
    if (!forwardPtyResizeRef.current || !isVisibleRef.current || !isValidTerminalSize(cols, rows)) return;
    const pixelWidth = terminal.dimensions?.css.canvas.width;
    const pixelHeight = terminal.dimensions?.css.canvas.height;
    const sizeKey = `${cols}:${rows}:${pixelWidth ?? 0}:${pixelHeight ?? 0}`;
    if (lastPtySizeRef.current === sizeKey) return;
    lastPtySizeRef.current = sizeKey;
    terminalProcessManager.resize(
      sessionId,
      cols,
      rows,
      pixelWidth ? Math.round(pixelWidth) : undefined,
      pixelHeight ? Math.round(pixelHeight) : undefined,
    ).catch((err) => {
      if (lastPtySizeRef.current === sizeKey) lastPtySizeRef.current = null;
      logError("PTY resize failed in terminal display", { sessionId, cols, rows, err });
    });
  };

  const attachViewport = (terminal: Terminal) => {
    const container = containerRef.current;
    if (!container) return () => {};
    lastPtySizeRef.current = null;
    const resizeDisposable = terminal.onResize(() => syncPtySize(terminal));
    const wheelListenerOptions = { passive: false, capture: true } as const;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const current = useSettingsStore.getState().fontSize;
      const next = Math.min(
        TERMINAL_FONT_SIZE_MAX,
        Math.max(TERMINAL_FONT_SIZE_MIN, current + (event.deltaY > 0 ? -1 : 1)),
      );
      if (next !== current) {
        void useSettingsStore.getState().update("fontSize", next);
      }
    };
    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      const lastSize = lastObservedSizeRef.current;
      if (lastSize && Math.abs(lastSize.width - width) < 2 && Math.abs(lastSize.height - height) < 2) {
        return;
      }
      lastObservedSizeRef.current = { width, height };
      resizeRenderBarrierRef.current?.noteContainerResize();
      scheduleFit();
    });
    // Native maximize/restore and foreground transitions can invalidate the
    // renderer even when the final grid or observed container size is unchanged.
    const onWindowLayout = () => scheduleFit(true, true);
    const ownerDocument = container.ownerDocument;
    const onDocumentVisibility = () => {
      if (ownerDocument.visibilityState === "hidden") {
        scheduleHiddenWebglDispose(rendererOptionsRef.current.lowMemoryMode);
      } else if (isVisibleRef.current) {
        clearHiddenWebglDisposeTimer();
        syncWebglRenderer(terminal, terminal.options.theme ?? {});
        scheduleFit(true, true);
      }
    };
    ownerDocument?.addEventListener("visibilitychange", onDocumentVisibility);
    window.addEventListener("resize", onWindowLayout);
    window.addEventListener("focus", onWindowLayout);
    container.addEventListener("wheel", onWheel, wheelListenerOptions);
    resizeObserver.observe(container);
    return () => {
      resizeDisposable.dispose();
      container.removeEventListener("wheel", onWheel, wheelListenerOptions);
      resizeObserver.disconnect();
      window.removeEventListener("resize", onWindowLayout);
      window.removeEventListener("focus", onWindowLayout);
      ownerDocument?.removeEventListener("visibilitychange", onDocumentVisibility);
      clearHiddenWebglDisposeTimer();
      lastObservedSizeRef.current = null;
      lastPtySizeRef.current = null;
      resizeDebouncerRef.current?.dispose();
      resizeDebouncerRef.current = null;
      resizeRenderBarrierRef.current?.dispose();
      resizeRenderBarrierRef.current = null;
      cancelPendingViewportRestore();
    };
  };

  const resetOutputState = () => {
    cancelPendingViewportRestore();
    terminalWriteScheduler.cancel(ptyWriteScheduleTokenRef.current);
    ptyPendingChunksRef.current = [];
    ptyWriteInProgressRef.current = false;
    forwardPtyResizeRef.current = true;
    lastPtySizeRef.current = null;
    outputDiagnosticsRef?.current?.reset();
  };

  const resizeTerminal = (terminal: Terminal, cols: number, rows: number) => {
    const container = containerRef.current;
    if (!isVisibleRef.current || !container || container.offsetWidth <= 0 || container.offsetHeight <= 0) return;
    if (terminal.cols === cols && terminal.rows === rows) return;
    cancelPendingViewportRestore();
    const shouldGuardHorizontalShrink = (
      cols < terminal.cols
      && !needsViewportRefreshRef.current
      && isVisibleRef.current
      && container !== null
    );
    if (shouldGuardHorizontalShrink && container) {
      let barrier = resizeRenderBarrierRef.current;
      if (!barrier) {
        barrier = new TerminalResizeRenderBarrier();
        resizeRenderBarrierRef.current = barrier;
      }
      barrier.begin(terminal, container);
    }
    const buffer = terminal.buffer.active;
    const isHorizontalReflow = cols !== terminal.cols;
    const wasAtLiveBottom = (
      isHorizontalReflow
      && buffer.type === "normal"
      && buffer.viewportY === buffer.baseY
    );
    // Horizontal reflow changes physical row indexes; a marker follows the logical viewport line.
    const viewportMarker = (
      isHorizontalReflow
      && buffer.type === "normal"
      && buffer.viewportY < buffer.baseY
    )
      ? terminal.registerMarker(buffer.viewportY - buffer.baseY - buffer.cursorY)
      : undefined;
    terminal.resize(cols, rows);
    resizeRenderBarrierRef.current?.noteContainerResize();
    if (wasAtLiveBottom) {
      // Reassert xterm's live-follow intent before and after its asynchronous DOM viewport sync.
      terminal.scrollToBottom();
      scheduleViewportRestore({ kind: "bottom", terminal });
    } else if (viewportMarker) {
      scheduleViewportRestore({ kind: "marker", marker: viewportMarker, terminal });
    }
  };

  const getResizeDebouncer = () => {
    let debouncer = resizeDebouncerRef.current;
    if (debouncer) return debouncer;
    debouncer = new TerminalResizeDebouncer(
      () => isVisibleRef.current,
      () => terminalRef.current,
      (cols, rows) => {
        const terminal = terminalRef.current;
        if (terminal) resizeTerminal(terminal, cols, rows);
      },
      (cols) => {
        const terminal = terminalRef.current;
        if (terminal) resizeTerminal(terminal, cols, terminal.rows);
      },
      (rows) => {
        const terminal = terminalRef.current;
        if (terminal) resizeTerminal(terminal, terminal.cols, rows);
      },
    );
    resizeDebouncerRef.current = debouncer;
    return debouncer;
  };

  const fitWhenStable = (immediateResize = false, forceViewportRefresh = immediateResize) => {
    if (forceViewportRefresh) needsViewportRefreshRef.current = true;
    const container = containerRef.current;
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    if (!container || !fitAddon || !terminal) return;
    // Historical escape sequences and cursor positions must be parsed with
    // their recorded geometry. Refit once the entire replay has committed.
    if (!forwardPtyResizeRef.current || !isVisibleRef.current || isComposingRef.current) return;
    if (container.offsetWidth <= 0 || container.offsetHeight <= 0) return;

    const dims = fitAddon.proposeDimensions();
    if (!dims || !isValidTerminalSize(dims.cols, dims.rows)) return;
    getResizeDebouncer().resize(dims.cols, dims.rows, immediateResize);
    // Replay can already end at these dimensions without firing onResize.
    // Synchronize the host explicitly, including after a failed resize request.
    syncPtySize(terminal);
    if (forceViewportRefresh || needsViewportRefreshRef.current) {
      refreshTerminalViewport(terminal);
      needsViewportRefreshRef.current = false;
    }
  };

  const cancelFitFrame = () => {
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
      fitRafRef.current = null;
    }
  };

  const cancelFitRequest = () => {
    cancelFitFrame();
    pendingFitRef.current = { immediateResize: false, forceViewportRefresh: false };
    resizeDebouncerRef.current?.cancel();
  };

  const suspendViewport = () => {
    cancelFitRequest();
    resizeRenderBarrierRef.current?.cancel();
    needsViewportRefreshRef.current = true;
  };

  const cancelScheduledFit = () => {
    cancelFitRequest();
    cancelPendingViewportRestore();
    resizeRenderBarrierRef.current?.cancel();
  };

  const scheduleFit = (immediateResize = false, forceViewportRefresh = immediateResize) => {
    // ResizeObserver and visibility restoration can request layout in the same
    // frame. A routine fit must never downgrade the required full repaint.
    pendingFitRef.current.immediateResize ||= immediateResize;
    pendingFitRef.current.forceViewportRefresh ||= forceViewportRefresh;
    if (fitRafRef.current !== null) return;
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = null;
      const pending = pendingFitRef.current;
      pendingFitRef.current = { immediateResize: false, forceViewportRefresh: false };
      fitWhenStable(pending.immediateResize, pending.forceViewportRefresh);
    });
  };

  const scheduleViewportRefresh = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const terminal = terminalRef.current;
        if (!terminal) return;
        refreshTerminalViewport(terminal);
        scheduleFit(true);
      });
    });
  };

  const markViewportRefreshNeeded = () => {
    needsViewportRefreshRef.current = true;
  };

  const resetViewportRefreshState = () => {
    needsViewportRefreshRef.current = false;
  };

  return {
    syncWebglRenderer,
    scheduleHiddenWebglDispose,
    clearHiddenWebglDisposeTimer,
    clearWebglTextureAtlas,
    disposeWebglRenderer,
    scheduleFit,
    scheduleViewportRefresh,
    markViewportRefreshNeeded,
    enqueueActiveWrite,
    restoreDisplaySnapshot,
    attachPtyOutput,
    attachViewport,
    resetOutputState,
    cancelScheduledFit,
    suspendViewport,
    resetViewportRefreshState,
  };
}
