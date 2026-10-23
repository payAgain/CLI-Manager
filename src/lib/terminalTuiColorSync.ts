import type { Terminal } from "@xterm/xterm";
import { mutateTerminalWhenReady } from "./terminalMutationGate";
import {
  inspectTerminalTuiViewport,
  normalizeTerminalTuiComposerBackground,
} from "./terminalTuiDisplay";
import {
  isClaudeTerminalContext,
  isCodexTerminalContext,
  type TerminalCliContext,
} from "../terminal/browser/TerminalCliContext";

export interface TerminalTuiColorSyncOptions {
  isVisible: boolean;
  isTransparent: boolean;
  isLightTheme: boolean;
  terminalTextColor?: string;
  tuiUserColor?: string;
  tuiAssistantColor?: string;
  getContext: () => TerminalCliContext;
}

export interface TerminalTuiColorSyncController {
  normalize: (terminal: Terminal) => void;
  schedule: (terminal: Terminal | null) => void;
  reset: () => void;
  dispose: () => void;
}

export function createTerminalTuiColorSyncController(
  getOptions: () => TerminalTuiColorSyncOptions,
): TerminalTuiColorSyncController {
  let frameId: number | null = null;
  let tuiSessionDetected = false;
  let normalizationPending = false;
  let generation = 0;

  const normalizeNow = (terminal: Terminal) => {
    // A synchronous parse/theme update supersedes a queued scroll update.
    // Do not scan again on the render caused by our own cell normalization.
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    const options = getOptions();
    // Hidden terminals still parse every PTY frame, but their TUI color scan only
    // affects rendered cells. Defer that expensive work until the tab is visible.
    if (!options.isVisible) return;
    const context = options.getContext();
    const viewport = inspectTerminalTuiViewport(terminal);
    const codexContext = isCodexTerminalContext(context);
    const claudeContext = isClaudeTerminalContext(context);
    const hasContextualTuiPrompt = (
      (codexContext || claudeContext) && viewport.composerPrompt
    );
    if (viewport.known || hasContextualTuiPrompt) tuiSessionDetected = true;

    const isTuiCodexSession = tuiSessionDetected && (
      viewport.codex || codexContext
    );
    const isTuiClaudeSession = tuiSessionDetected && claudeContext;
    normalizeTerminalTuiComposerBackground(terminal, {
      shouldNormalize: options.isTransparent || ((isTuiCodexSession || isTuiClaudeSession) && options.isLightTheme),
      isTransparent: options.isTransparent,
      isLightTheme: options.isLightTheme,
      isTuiSession: tuiSessionDetected,
      isCodexSession: isTuiCodexSession,
      isClaudeSession: isTuiClaudeSession,
      terminalTextColor: options.terminalTextColor,
      tuiUserColor: options.tuiUserColor,
      tuiAssistantColor: options.tuiAssistantColor,
      hasKnownTuiSignature: viewport.known,
    });
  };

  const normalize = (terminal: Terminal) => {
    if (normalizationPending) return;
    normalizationPending = true;
    const currentGeneration = generation;
    mutateTerminalWhenReady(terminal, () => {
      if (generation !== currentGeneration) return;
      normalizationPending = false;
      normalizeNow(terminal);
    });
  };

  const schedule = (terminal: Terminal | null) => {
    if (!terminal || frameId !== null) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      normalize(terminal);
    });
  };

  const reset = () => {
    tuiSessionDetected = false;
    normalizationPending = false;
    generation++;
  };

  const dispose = () => {
    if (frameId !== null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    reset();
  };

  return { normalize, schedule, reset, dispose };
}
