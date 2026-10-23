import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { toast, Toaster } from "sonner";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Sidebar } from "./components/sidebar";
import { TerminalTabs } from "./components/TerminalTabs";
import { CommandPalette } from "./components/CommandPalette";
import { NotificationInboxPanel } from "./components/NotificationInbox";
import { useNotificationInbox } from "./hooks/useNotificationInbox";
import { activateNotificationTarget } from "./lib/notificationInboxNavigation";
import type { SettingsTab } from "./components/SettingsModal";
const loadSettingsModal = () => import("./components/SettingsModal").then((module) => ({ default: module.SettingsModal }));
const SettingsModal = lazy(loadSettingsModal);
import { WorkspaceStatusBar } from "./components/WorkspaceStatusBar";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { CloseConfirmDialog } from "./components/CloseConfirmDialog";
import { RunningTasksExitDialog } from "./components/RunningTasksExitDialog";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { ExitProgressOverlay, type ExitPhase } from "./components/ExitProgressOverlay";
import { AppFailureState } from "./components/AppFailureState";
import { ExternalSessionSyncDialog } from "./components/ExternalSessionSyncDialog";
import {
  useSettingsStore,
  type ExitWithRunningTasksBehavior,
  type HookEventType,
} from "./stores/settingsStore";
import { useProjectStore } from "./stores/projectStore";
import { useSessionStore } from "./stores/sessionStore";
import { flushTerminalSnapshotsNow } from "./lib/sessionSnapshotPersistence";
import { useHistoryStore } from "./stores/historyStore";
import { useExternalSessionSyncStore } from "./stores/externalSessionSyncStore";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useReplayStore } from "./stores/replayStore";
import { useTerminalStore, type CliHookPayload } from "./stores/terminalStore";
import { useWorktreeStore } from "./stores/worktreeStore";
import { debugConsoleWarn } from "./lib/debugConsole";
import { createPerfMarker, logInfo, logWarn } from "./lib/logger";
import { getContrastRatioFromHex, MIN_APPLY_CONTRAST_RATIO } from "./lib/contrast";
import { translateCurrent, useI18n } from "./lib/i18n";
import { getOsPlatform } from "./lib/shell";
import { normalizeFontFamilyStack } from "./lib/systemFonts";
import { ALL_TERMINALS_SCOPE } from "./lib/terminalScope";
import { cleanupTerminalProcessesForExit } from "./lib/terminalExitCleanup";
import { shouldIncludeDaemonExitTask } from "./lib/terminalExitTask";
import { requestSidebarToggle } from "./lib/sidebarCommands";
import { startRuntimeDiagnostics } from "./lib/runtimeDiagnostics";
import { deliverHookNotification, suppressHookNotification } from "./lib/hookNotificationPolicy";
import { routeSubagentHook } from "./lib/subagentHookRouting";
import { getTerminalTheme, isLightTerminalTheme } from "./lib/terminalThemes";
import { resolveProjectForSession } from "./lib/terminalProject";
import { terminalProcessManager } from "./terminal/core/TerminalProcessManager";
import "./App.css";

const appStartAt =
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
let firstScreenPerfReported = false;
let firstScreenShown = false;
let startupBaseReady = false;
let deferredStartupTasksStarted = false;
// React StrictMode/初始化重入下，每个应用进程最多处理一次会话恢复（弹窗或自动）。
// 该守护确保恢复提示只在启动时刻触发一次，切设置页/切视图重渲染都不会再弹。
let sessionRestoreHandled = false;
let settingsModalPreloadStarted = false;
const COMPACT_WINDOW_WIDTH = 350;
const WINDOW_MIN_HEIGHT = 600;
const CLAUDE_QUESTION_TOOL_NAME = "AskUserQuestion";
const CODEX_QUESTION_TOOL_NAME = "request_user_input";
interface DaemonSessionMeta {
  sessionId: string;
  alive: boolean;
  taskStatus?: string | null;
}

const TERMINAL_PANEL_SEMANTIC_COLORS = {
  dark: {
    fg: "#ECECEC",
    dim: "#9CA0A6",
    green: "#3DD68C",
    yellow: "#E5C453",
    red: "#F25E5E",
    magenta: "#C77DBB",
    cyan: "#5AC8E0",
    blue: "#5B8DEF",
  },
  light: {
    fg: "#1F2937",
    dim: "#64748B",
    green: "#15803D",
    yellow: "#B45309",
    red: "#DC2626",
    magenta: "#9333EA",
    cyan: "#0891B2",
    blue: "#2563EB",
  },
} as const;
const STARTUP_STAGE_TIMEOUT_MS = 15_000;
const IN_TAURI = isTauri();
const SYSTEM_NOTIFICATION_ACTION_EVENT = "system-notification-action";
const MAX_SYSTEM_NOTIFICATION_DETAIL_LENGTH = 72;
type StartupStage = "settings" | "stores" | "projects";

function isLikelyMacOs() {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

function preloadSettingsModal(): void {
  if (settingsModalPreloadStarted) return;
  settingsModalPreloadStarted = true;
  void loadSettingsModal().catch((err) => {
    settingsModalPreloadStarted = false;
    logWarn("Failed to preload settings modal", err);
  });
}

interface SubagentTranscriptAppendPayload {
  key: string;
  content: string;
  reset: boolean;
}

interface SystemNotificationActionPayload {
  tabId: string;
}

function canUseUiTextColor(textColor: string, backgroundColor: string): boolean {
  const ratio = getContrastRatioFromHex(textColor, backgroundColor);
  return ratio !== null && ratio >= MIN_APPLY_CONTRAST_RATIO;
}

function isQuestionRequestNotification(payload: CliHookPayload): boolean {
  return (
    payload.event === "Notification" &&
    ((payload.source === "claude" && payload.toolName === CLAUDE_QUESTION_TOOL_NAME) ||
      (payload.source === "codex" && payload.toolName === CODEX_QUESTION_TOOL_NAME))
  );
}

function getHookNotificationActionLabel(payload: CliHookPayload): string {
  if (isQuestionRequestNotification(payload)) return translateCurrent("notifications.hookToast.answer");
  return translateCurrent(payload.event === "PermissionRequest" ? "notifications.hookToast.handle" : "notifications.hookToast.view");
}

function getCliHookSourceName(payload: CliHookPayload): string {
  if (payload.source === "codex") return "Codex CLI";
  if (payload.source === "pi") return "Pi Agent";
  if (payload.source === "grok") return "Grok Build";
  return "Claude Code";
}

function getHookProjectName(payload: CliHookPayload, tabTitle?: string | null): string {
  const normalizedTitle = tabTitle?.trim();
  if (normalizedTitle) return normalizedTitle;

  const cwd = payload.cwd?.trim();
  if (cwd) {
    const normalizedCwd = cwd.replace(/[\\/]+$/, "");
    const cwdParts = normalizedCwd.split(/[\\/]+/).filter(Boolean);
    return cwdParts.length > 0 ? cwdParts[cwdParts.length - 1] : cwd;
  }

  return translateCurrent("notifications.system.unknownProject");
}

function isSystemNotificationEvent(eventType: CliHookPayload["event"]): eventType is HookEventType {
  return (
    eventType === "SessionStart" ||
    eventType === "UserPromptSubmit" ||
    eventType === "Notification" ||
    eventType === "Stop" ||
    eventType === "StopFailure" ||
    eventType === "PermissionRequest"
  );
}

function truncateSystemNotificationDetail(detail: string): string {
  if (detail.length <= MAX_SYSTEM_NOTIFICATION_DETAIL_LENGTH) return detail;
  return `${detail.slice(0, MAX_SYSTEM_NOTIFICATION_DETAIL_LENGTH - 3).trimEnd()}...`;
}

function getSystemNotificationBody(payload: CliHookPayload, projectName: string): string {
  const sourceName = getCliHookSourceName(payload);
  const detail = payload.message?.trim();
  const suffix = detail ? `: ${truncateSystemNotificationDetail(detail)}` : "";

  if (isQuestionRequestNotification(payload)) {
    return translateCurrent("notifications.system.question", { sourceName, projectName, suffix });
  }

  switch (payload.event) {
    case "Stop":
      return translateCurrent("notifications.system.stop", { sourceName, projectName, suffix });
    case "StopFailure":
      return translateCurrent("notifications.system.stopFailure", { sourceName, projectName, suffix });
    case "PermissionRequest":
      return translateCurrent("notifications.system.permissionRequest", { sourceName, projectName, suffix });
    case "Notification":
      return translateCurrent("notifications.system.notification", { sourceName, projectName, suffix });
    case "SessionStart":
      return translateCurrent("notifications.system.sessionStart", { sourceName, projectName, suffix });
    case "UserPromptSubmit":
      return translateCurrent("notifications.system.userPromptSubmit", { sourceName, projectName, suffix });
    default:
      return translateCurrent("notifications.system.default", { sourceName, projectName, suffix });
  }
}

async function focusMainWindow(): Promise<void> {
  if (!IN_TAURI) return;
  try {
    await invoke("app_show_main_window");
  } catch (err) {
    logWarn("Failed to show main window", err);
  }
}

// 后台任务模式（Issue #123 Phase 1）：退出时选择"转入后台继续执行"后置 true，
// 窗口重新获得焦点后清除。模块级标记，供 sendSystemNotification 切换通知策略。
let backgroundTaskModeActive = false;

async function isMainWindowFocused(): Promise<boolean> {
  if (!IN_TAURI) return false;
  try {
    return await getCurrentWindow().isFocused();
  } catch (err) {
    logWarn("Failed to read main window focus state", err);
    return false;
  }
}

async function clearTaskbarAttention(): Promise<void> {
  if (!IN_TAURI) return;
  try {
    await invoke("set_taskbar_attention", { mode: null });
  } catch (err) {
    debugConsoleWarn("[Taskbar Attention] Failed to clear:", err);
  }
}

async function sendTaskbarAttention(payload: CliHookPayload): Promise<void> {
  if (!IN_TAURI || !isSystemNotificationEvent(payload.event)) return;
  const settings = useSettingsStore.getState();
  if (!settings.taskbarAttentionEnabled || !settings.systemNotificationEvents[payload.event]) return;
  if (await isMainWindowFocused()) return;

  try {
    await invoke("set_taskbar_attention", {
      mode: settings.taskbarAttentionMode,
      flashCount: settings.taskbarAttentionMode === "finite"
        ? settings.taskbarAttentionFlashCount
        : undefined,
    });
  } catch (err) {
    debugConsoleWarn("[Taskbar Attention] Failed to start:", err);
  }
}

async function sendSystemNotification(payload: CliHookPayload, tabId: string | null, tabTitle?: string | null): Promise<void> {
  try {
    const settings = useSettingsStore.getState();
    if (!isSystemNotificationEvent(payload.event)) return;
    if (!tabId) return;
    // 后台任务模式保留总开关/事件开关的豁免；前台可见性仍统一检查。
    if (!backgroundTaskModeActive) {
      if (!settings.systemNotificationsEnabled) return;
      if (!settings.systemNotificationEvents[payload.event]) return;
    }

    const projectName = getHookProjectName(payload, tabTitle);
    const title = "CLI-Manager";
    const body = getSystemNotificationBody(payload, projectName);
    const actionLabel = getHookNotificationActionLabel(payload);

    await deliverHookNotification({
      suppressed: async () => {
        const appWindow = getCurrentWindow();
        const [focused, visible, minimized] = await Promise.all([
          appWindow.isFocused().catch(() => document.hasFocus()),
          appWindow.isVisible().catch(() => document.visibilityState === "visible"),
          appWindow.isMinimized().catch(() => false),
        ]);
        return suppressHookNotification({
          focused: focused || document.hasFocus(),
          visible,
          minimized,
          documentVisible: document.visibilityState === "visible",
          suppressWhileAppFocused: useSettingsStore.getState().suppressSystemNotificationsWhenFocused,
        });
      },
      permitted: async () => {
        const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
        return await isPermissionGranted() || await requestPermission() === "granted";
      },
      send: async () => {
        // Preferences can change while the OS permission dialog is open.
        const current = useSettingsStore.getState();
        if (!backgroundTaskModeActive && (!current.systemNotificationsEnabled || !current.systemNotificationEvents[payload.event as HookEventType])) return;
        try {
          await invoke("send_interactive_system_notification", { title, body, tabId, actionLabel });
        } catch (notificationErr) {
          const isWsl = await invoke<boolean>("is_wsl").catch(() => false);
          if (!isWsl) throw notificationErr;
          await invoke("send_notification_via_windows", { title, body });
        }
      },
    });
  } catch (err) {
    debugConsoleWarn("[System Notification] Failed to send:", err);
  }
}

function runDeferredStartupTasks(): void {
  if (!startupBaseReady || !firstScreenPerfReported || deferredStartupTasksStarted) return;
  deferredStartupTasksStarted = true;

  window.setTimeout(() => {
    void (async () => {
      await useProjectStore.getState().refreshProjectDiagnostics().catch((err) => {
        logWarn("Failed to refresh deferred project diagnostics", err);
      });
    })();

    window.setTimeout(() => {
      const startExternalSessionSync = () => {
        useExternalSessionSyncStore.getState().startMonitor();
      };
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(startExternalSessionSync, { timeout: 3000 });
      } else {
        startExternalSessionSync();
      }
    }, 5000);
  }, 0);
}

function App() {
  useNotificationInbox();
  const { language, t } = useI18n();
  const loadSettings = useSettingsStore((s) => s.load);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const terminalThemeName = useSettingsStore((s) => s.terminalThemeName);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const uiFontSize = useSettingsStore((s) => s.uiFontSize);
  const uiTextColor = useSettingsStore((s) => s.uiTextColor);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const closeBehavior = useSettingsStore((s) => s.closeBehavior);
  const exitWithRunningTasksBehavior = useSettingsStore((s) => s.exitWithRunningTasksBehavior);
  const debugMode = useSettingsStore((s) => s.debugMode);
  const projectScopedTerminalViewEnabled = useSettingsStore((s) => s.projectScopedTerminalViewEnabled);
  const lastSettingsTab = useSettingsStore((s) => s.lastSettingsTab);
  const updateSetting = useSettingsStore((s) => s.update);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsEverOpened, setSettingsEverOpened] = useState(false);
  const [settingsWindowExpanded, setSettingsWindowExpanded] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("general");
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [runningTasksDialogOpen, setRunningTasksDialogOpen] = useState(false);
  const [runningTasksCount, setRunningTasksCount] = useState(0);
  const [exitPhase, setExitPhase] = useState<ExitPhase | null>(null);
  const [exitNotice, setExitNotice] = useState<string | null>(null);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const terminalScope = useTerminalStore((s) => s.terminalScope);
  const setTerminalScope = useTerminalStore((s) => s.setTerminalScope);
  const [isMacOs, setIsMacOs] = useState(isLikelyMacOs);
  const [initError, setInitError] = useState<string | null>(null);
  const [startupStage, setStartupStage] = useState<StartupStage>("settings");
  const [startupReady, setStartupReady] = useState(false);
  const [restorePromptOpen, setRestorePromptOpen] = useState(false);
  // 启动时若检测到上次遗留的可恢复工作区标签，弹窗询问是否恢复（Issue #123）。
  const terminalFullscreenMaximizedRef = useRef(false);
  const restoreWindowWidthRef = useRef<number | null>(null);
  const closeBehaviorRef = useRef(closeBehavior);
  const exitTasksBehaviorRef = useRef(exitWithRunningTasksBehavior);
  const pendingExitDaemonSessionsCheckedRef = useRef(false);
  const pendingExitSourceRef = useRef("window close");
  const exitCleanupInProgressRef = useRef(false);

  const handleOpenSettings = useCallback((tab?: SettingsTab) => {
    const allowedTabs: readonly SettingsTab[] = [
      "general",
      "agents",
      "developer",
      "sidebar",
      "terminal-theme",
      "shortcuts",
      "templates",
      "ssh-hosts",
      "history-sources",
      "hooks",
      "about",
    ];
    const nextTab: SettingsTab = tab ?? (allowedTabs.includes(lastSettingsTab as SettingsTab) ? lastSettingsTab as SettingsTab : "general");
    preloadSettingsModal();
    setSettingsInitialTab(nextTab);
    if (tab && tab !== useSettingsStore.getState().lastSettingsTab) {
      void updateSetting("lastSettingsTab", tab);
    }
    setSettingsWindowExpanded(true);
    setSettingsOpen(true);
    setSettingsEverOpened(true);
  }, [lastSettingsTab, updateSetting]);

  const handleSettingsTabChange = useCallback((tab: SettingsTab) => {
    if (tab !== useSettingsStore.getState().lastSettingsTab) {
      void updateSetting("lastSettingsTab", tab);
    }
  }, [updateSetting]);

  const startupOpenSettingsRef = useRef(handleOpenSettings);
  const startupTranslateRef = useRef(t);
  useEffect(() => {
    startupOpenSettingsRef.current = handleOpenSettings;
    startupTranslateRef.current = t;
  }, [handleOpenSettings, t]);

  useEffect(() => {
    closeBehaviorRef.current = closeBehavior;
  }, [closeBehavior]);

  useEffect(() => {
    exitTasksBehaviorRef.current = exitWithRunningTasksBehavior;
  }, [exitWithRunningTasksBehavior]);

  useEffect(() => {
    if (!projectScopedTerminalViewEnabled) {
      setTerminalScope(ALL_TERMINALS_SCOPE);
    }
  }, [projectScopedTerminalViewEnabled, setTerminalScope]);

  useEffect(() => {
    if (!IN_TAURI) return;
    void getOsPlatform()
      .then((platform) => setIsMacOs(platform === "macos"))
      .catch((err) => logWarn("Failed to read OS platform for window sizing", err));
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    const handleF12 = (event: KeyboardEvent) => {
      if (event.key !== "F12") return;
      event.preventDefault();
      event.stopPropagation();
      if (!debugMode) return;
      void invoke("app_open_devtools").catch((err) => logWarn("Failed to open devtools", err));
    };
    window.addEventListener("keydown", handleF12, true);
    return () => window.removeEventListener("keydown", handleF12, true);
  }, [debugMode]);

  useEffect(() => {
    if (!IN_TAURI || !debugMode) return;
    return startRuntimeDiagnostics();
  }, [debugMode]);

  const handleToggleTerminalFullscreen = useCallback(async () => {
    const nextFullscreen = !terminalFullscreen;
    if (!IN_TAURI) {
      setTerminalFullscreen(nextFullscreen);
      return true;
    }

    try {
      const appWindow = getCurrentWindow();
      if (nextFullscreen) {
        const alreadyMaximized = await appWindow.isMaximized();
        terminalFullscreenMaximizedRef.current = !alreadyMaximized;
        if (!alreadyMaximized) await appWindow.toggleMaximize();
      } else if (terminalFullscreenMaximizedRef.current) {
        await appWindow.unmaximize();
        terminalFullscreenMaximizedRef.current = false;
      }
      setTerminalFullscreen(nextFullscreen);
      return true;
    } catch (err) {
      toast.error(nextFullscreen ? t("notifications.fullscreen.enterFailed") : t("notifications.fullscreen.exitFailed"), { description: String(err) });
      logWarn("Failed to toggle terminal fullscreen", err);
      return false;
    }
  }, [terminalFullscreen, t]);

  const handleToggleSidebarShortcut = useCallback(() => {
    if (terminalFullscreen) {
      handleToggleTerminalFullscreen();
      return;
    }
    requestSidebarToggle();
  }, [handleToggleTerminalFullscreen, terminalFullscreen]);

  const handleActivateHookNotificationTarget = useCallback(async (tabId: string) => {
    const terminalStore = useTerminalStore.getState();
    const targetSession = terminalStore.sessions.find((session) => session.id === tabId);
    if (!targetSession) {
      toast.warning(translateCurrent("notifications.system.targetClosed"));
      return;
    }

    useHistoryStore.getState().closeHistory();
    if (useSettingsStore.getState().projectScopedTerminalViewEnabled) {
      const projects = useProjectStore.getState().projects;
      const projectById = new Map(projects.map((project) => [project.id, project]));
      const targetProjectId = resolveProjectForSession(
        targetSession,
        terminalStore.sessions,
        projects,
        projectById
      )?.id ?? null;
      flushSync(() => {
        setTerminalScope(
          targetProjectId && targetSession.worktreeId
            ? { kind: "worktree", projectId: targetProjectId, worktreeId: targetSession.worktreeId }
            : targetProjectId
              ? { kind: "project", projectId: targetProjectId }
              : ALL_TERMINALS_SCOPE
        );
      });
    }
    terminalStore.setActive(tabId);

    // 只在窗口未聚焦时才切换窗口，避免 PermissionRequest 等事件在用户专注其他工作时强制打断
    const isFocused = await isMainWindowFocused();
    if (!isFocused) {
      await focusMainWindow();
    }
  }, []);


  useKeyboardShortcuts({
    onToggleSidebar: handleToggleSidebarShortcut,
    onToggleTerminalFullscreen: handleToggleTerminalFullscreen,
  });

  useEffect(() => {
    if (!IN_TAURI) return;
    const unlistenHook = listen<CliHookPayload>("claude-hook-notification", (event) => {
      void useReplayStore.getState().recordCliHookEvent(event.payload);
      const subagentStore = useTerminalStore.getState();
      if (routeSubagentHook(event.payload, {
        bind: (payload) => subagentStore.handleCliHookEvent(payload, { subagent: true }),
        open: (payload) => useTerminalStore.getState().openSubagentTranscript(payload),
        finish: (payload) => useTerminalStore.getState().finishSubagentTranscript(payload),
      })) return;
      const boundTabId = useTerminalStore.getState().handleCliHookEvent(event.payload);
      // 任务栏提醒独立于 Tab 绑定和系统 Toast；外部 Hook 也可以提醒。
      void sendTaskbarAttention(event.payload);
      // External hooks (no PTY tab env) still carry a synthetic tabId like external:grok:<session>.
      // Prefer the bound session; external hooks can still use OS notifications.
      const tabId = boundTabId ?? event.payload.tabId?.trim() ?? null;
      const terminalStore = useTerminalStore.getState();
      const tabTitle = boundTabId
        ? terminalStore.sessions.find((session) => session.id === boundTabId)?.title ?? null
        : null;
      // Hook alerts use the OS channel and the user's foreground suppression preference.
      void sendSystemNotification(event.payload, tabId, tabTitle);
    });
    const unlistenSystemNotification = listen<SystemNotificationActionPayload>(SYSTEM_NOTIFICATION_ACTION_EVENT, (event) => {
      void handleActivateHookNotificationTarget(event.payload.tabId);
    });
    const unlistenSshHookGap = listen<{ hostId: string; dropped: number }>("ssh-agent-hook-gap", (event) => {
      toast.warning(t("terminal.ssh.hookGap", { count: event.payload.dropped }));
    });
    // 子 Agent 转录 tail 增量：路由到对应转录面板。
    const unlistenTranscript = listen<SubagentTranscriptAppendPayload>("subagent-transcript-append", (event) => {
      const { key, content, reset } = event.payload;
      useTerminalStore.getState().appendSubagentTranscript(key, content, reset);
    });

    return () => {
      void unlistenHook.then((unlisten) => unlisten());
      void unlistenSystemNotification.then((unlisten) => unlisten());
      void unlistenSshHookGap.then((unlisten) => unlisten());
      void unlistenTranscript.then((unlisten) => unlisten());
    };
  }, [handleActivateHookNotificationTarget, t]);

  useEffect(() => {
    if (!IN_TAURI) return;
    let cancelled = false;
    const activate = async (sessionId: string) => {
      if (!sessionId || cancelled) return;
      try {
        const restored = await useTerminalStore.getState().attachDaemonSession(sessionId);
        if (!restored) {
          toast.warning(t("terminal.backgroundTasks.restoreFailed"));
          return;
        }
        await focusMainWindow();
      } catch (err) {
        logWarn("Failed to activate background session from hook", { sessionId, err });
      }
    };
    const unlisten = listen<string>("background-task-activate-requested", (event) => {
      void activate(event.payload);
    });
    const timer = window.setInterval(() => {
      if (!startupBaseReady) return;
      window.clearInterval(timer);
      void invoke<string | null>("take_pending_background_session").then((sessionId) => {
        if (sessionId) void activate(sessionId);
      });
    }, 100);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void unlisten.then((fn) => fn());
    };
  }, [t]);

  useEffect(() => {
    if (!IN_TAURI) return;
    const fallbackTimer = setTimeout(() => {
      if (!firstScreenShown) {
        firstScreenShown = true;
        void getCurrentWindow().show().catch((err) => logWarn("Failed to show window (fallback timeout)", err));
      }
    }, 3000);
    return () => clearTimeout(fallbackTimer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      setInitError(null);
      setStartupReady(false);
      startupBaseReady = false;

      const runStartupStage = async (stage: StartupStage, action: () => Promise<void>) => {
        if (!cancelled) setStartupStage(stage);
        const startedAt = performance.now();
        let timedOut = false;
        const timeoutId = window.setTimeout(() => {
          timedOut = true;
          logWarn("Application startup stage timed out", { stage, timeoutMs: STARTUP_STAGE_TIMEOUT_MS });
          if (!cancelled) setInitError(`startup_timeout:${stage}`);
        }, STARTUP_STAGE_TIMEOUT_MS);
        try {
          await action();
        } finally {
          window.clearTimeout(timeoutId);
          const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
          logInfo("Application startup stage completed", { stage, durationMs, timedOut });
          if (timedOut && !cancelled) setInitError(null);
        }
      };

      // 1. Tauri Store 初始化串行执行，避免插件在启动期发生并发读写竞态。
      await runStartupStage("settings", loadSettings);

      await runStartupStage("stores", async () => {
        await useSessionStore.getState().load().catch((err) => {
          logWarn("Failed to load persisted sessions during startup", err);
        });
      });

      // 2. 加载项目列表与 worktree 记录
      await runStartupStage("projects", async () => {
        await useProjectStore.getState().fetchAll("startup");
        await useWorktreeStore.getState().loadWorktrees();
        await useWorktreeStore.getState().markMissingWorktrees();
      });

      // 3. 恢复功能关闭时清理当前环境快照；开启时检测遗留标签，按恢复方式分流：
      //    - ask：启动时弹窗询问是否恢复（默认）
      //    - auto：静默直接恢复，不打扰
      //    注意：此处不再无条件 clear()。恢复执行器会优先 attach 仍存活的 daemon 会话，
      //    其余会话再按 CLI resume / Shell scrollback + 重建 PTY 分流处理。
      //    sessionRestoreHandled 守护保证恢复只在启动时刻触发一次——这是当年拆功能的根因
      //    （提示曾在切设置页时反复弹），务必保留。
      const persistedSessions = useSessionStore.getState().sessions;
      const { terminalSessionRestoreEnabled, terminalSessionRestoreMode } =
        useSettingsStore.getState();
      const hasRestorable = persistedSessions.some(
        (session) => (session.kind ?? "pty") === "pty"
      );
      if (!terminalSessionRestoreEnabled) {
        await useSessionStore.getState().clear().catch((err) => {
          logWarn("Failed to clear disabled terminal session restore snapshot", err);
        });
      } else if (!hasRestorable) {
        await useSessionStore.getState().clear().catch((err) => {
          logWarn("Failed to clear restored sessions during startup", err);
        });
      } else if (!sessionRestoreHandled && !cancelled) {
        sessionRestoreHandled = true;
        if (terminalSessionRestoreMode === "auto") {
          const { projects, projectHealth } = useProjectStore.getState();
          const projectMap = new Map(projects.map((project) => [project.id, project]));
          void useTerminalStore
            .getState()
            .restoreSessions(projectMap, projectHealth)
            .catch((err) => {
              logWarn("Failed to auto-restore terminal sessions", err);
              toast.error(startupTranslateRef.current("notifications.app.initFailed"), {
                description: String(err),
              });
            });
        } else {
          setRestorePromptOpen(true);
        }
      }

      startupBaseReady = true;
      if (!cancelled) {
        setStartupReady(true);
        setStartupStage("projects");
        runDeferredStartupTasks();
      }
    };

    // Let StrictMode run its setup/cleanup probe before starting non-cancellable store I/O.
    const startupTimer = window.setTimeout(() => {
      void init().catch((err) => {
        const message = err instanceof Error ? err.stack || err.message : String(err);
        logWarn("Application init failed", err);
        if (!cancelled) {
          setInitError(message);
        }
        toast.error(startupTranslateRef.current("notifications.app.initFailed"), { description: String(err) });
      });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(startupTimer);
    };
  }, [loadSettings]);

  // 用户确认恢复上次会话：重建全部标签并 attach 或重建 PTY；CLI 走原生 resume，普通 shell 贴回历史画面。
  const handleConfirmRestoreSessions = useCallback(() => {
    setRestorePromptOpen(false);
    const { projects, projectHealth } = useProjectStore.getState();
    const projectMap = new Map(projects.map((project) => [project.id, project]));
    void useTerminalStore
      .getState()
      .restoreSessions(projectMap, projectHealth)
      .catch((err) => {
        logWarn("Failed to restore terminal sessions", err);
        toast.error(t("notifications.app.initFailed"), { description: String(err) });
      });
  }, [t]);

  // 用户拒绝恢复：清除本次工作区恢复快照（不动 session_meta / 历史记录），避免下次继续询问同一批旧标签。
  const handleRejectRestoreSessions = useCallback(() => {
    setRestorePromptOpen(false);
    void useSessionStore.getState().clear().catch((err) => {
      logWarn("Failed to clear restored sessions after user rejected restore", err);
    });
    // Phase 2：拒绝恢复 = 不要这批旧标签。daemon 中对应会话若还在跑，
    // 必须一并关闭，否则成为无人认领的后台任务且阻止 daemon 空闲自灭。
    void terminalProcessManager.closeAll().catch((err) => {
      logWarn("Failed to close daemon sessions after user rejected restore", err);
    });
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
    document.documentElement.setAttribute("data-light-palette", lightThemePalette);
    document.documentElement.setAttribute("data-dark-palette", darkThemePalette);
    document.documentElement.setAttribute("lang", language);
  }, [resolvedTheme, lightThemePalette, darkThemePalette, language]);

  useEffect(() => {
    const root = document.documentElement.style;
    const terminalTheme = getTerminalTheme(
      terminalThemeName,
      resolvedTheme,
      lightThemePalette,
      darkThemePalette
    );
    const terminalThemeBackground =
      terminalTheme.background ?? (resolvedTheme === "dark" ? "#0c0e10" : "#ffffff");
    const terminalThemeForeground =
      terminalTheme.foreground ?? (resolvedTheme === "dark" ? "#f8fafc" : "#1e293b");
    const terminalThemeAccent =
      terminalTheme.blue ?? terminalTheme.cursor ?? terminalThemeForeground;
    const terminalThemeMuted =
      terminalTheme.brightBlack ?? terminalTheme.white ?? terminalThemeForeground;
    const terminalThemeSelection =
      terminalTheme.selectionBackground ?? terminalThemeAccent;
    const terminalPanelSemanticColors =
      TERMINAL_PANEL_SEMANTIC_COLORS[isLightTerminalTheme(terminalTheme) ? "light" : "dark"];

    root.setProperty("--terminal-theme-background", terminalThemeBackground);
    root.setProperty("--terminal-theme-foreground", terminalThemeForeground);
    root.setProperty("--terminal-theme-muted", terminalThemeMuted);
    root.setProperty("--terminal-theme-accent", terminalThemeAccent);
    root.setProperty("--terminal-theme-selection", terminalThemeSelection);
    root.setProperty("--term-panel-bg", "var(--terminal-theme-background, #0c0e10)");
    root.setProperty(
      "--term-panel-card",
      "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 91%, var(--term-panel-fg, #ececec) 9%)"
    );
    root.setProperty(
      "--term-panel-card-inner",
      "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 87%, var(--term-panel-fg, #ececec) 13%)"
    );
    root.setProperty(
      "--term-panel-border",
      "color-mix(in srgb, var(--term-panel-fg, #ececec) 14%, transparent)"
    );
    root.setProperty("--term-panel-fg", terminalPanelSemanticColors.fg);
    root.setProperty("--term-panel-dim", terminalPanelSemanticColors.dim);
    root.setProperty("--term-panel-green", terminalPanelSemanticColors.green);
    root.setProperty("--term-panel-yellow", terminalPanelSemanticColors.yellow);
    root.setProperty("--term-panel-red", terminalPanelSemanticColors.red);
    root.setProperty("--term-panel-magenta", terminalPanelSemanticColors.magenta);
    root.setProperty("--term-panel-cyan", terminalPanelSemanticColors.cyan);
    root.setProperty("--term-panel-blue", terminalPanelSemanticColors.blue);
    root.setProperty(
      "--term-panel-track",
      "color-mix(in srgb, var(--terminal-theme-background, #0c0e10) 94%, var(--term-panel-fg, #ececec) 6%)"
    );
  }, [
    darkThemePalette,
    lightThemePalette,
    resolvedTheme,
    terminalThemeName,
  ]);

  useEffect(() => {
    const root = document.documentElement.style;
    const computedStyle = getComputedStyle(document.documentElement);
    const canApplyUiTextColor =
      uiTextColor !== "" && canUseUiTextColor(uiTextColor, computedStyle.getPropertyValue("--bg-primary"));

    if (canApplyUiTextColor) {
      root.setProperty("--text-primary", uiTextColor);
      root.setProperty("--text-secondary", `color-mix(in srgb, ${uiTextColor} 85%, var(--bg-primary))`);
      root.setProperty("--text-muted", `color-mix(in srgb, ${uiTextColor} 60%, var(--bg-primary))`);
    } else {
      root.removeProperty("--text-primary");
      root.removeProperty("--text-secondary");
      root.removeProperty("--text-muted");
    }
  }, [darkThemePalette, lightThemePalette, resolvedTheme, uiTextColor]);

  useEffect(() => {
    const effectiveUiFontFamily = normalizeFontFamilyStack(uiFontFamily);
    if (uiFontFamily) {
      document.documentElement.style.setProperty("--font-ui-sans", effectiveUiFontFamily);
      document.documentElement.style.setProperty("--font-ui-mono", effectiveUiFontFamily);
      document.documentElement.style.fontFamily = effectiveUiFontFamily;
    } else {
      document.documentElement.style.removeProperty("--font-ui-sans");
      document.documentElement.style.removeProperty("--font-ui-mono");
      document.documentElement.style.fontFamily = "";
    }

    const styleId = "ui-font-family-override";
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    if (uiFontFamily) {
      styleEl.textContent = `
        html, body, #root, button, input, select, textarea, optgroup,
        [class*="font-sans"], [class*="font-mono"], code, pre, kbd, samp,
        .ui-mono, .ui-dev-label {
          font-family: ${effectiveUiFontFamily} !important;
        }
        .xterm, .xterm *, .xterm-helper-textarea {
          font-family: var(--terminal-font-family, "Cascadia Code", Consolas, monospace) !important;
        }
      `;
    } else {
      styleEl.textContent = "";
    }
  }, [uiFontFamily]);

  useEffect(() => {
    const root = document.documentElement.style;
    const bodySize = uiFontSize;
    const metaSize = Math.max(9, bodySize - 1);
    const microSize = Math.max(8, bodySize - 2);
    const textSmSize = bodySize + 1;
    const textBaseSize = bodySize + 3;

    root.setProperty("--font-size-ui", `${bodySize}px`);
    root.setProperty("--font-size-body", `${bodySize}px`);
    root.setProperty("--font-size-section-title", `${bodySize}px`);
    root.setProperty("--font-size-meta", `${metaSize}px`);
    root.setProperty("--font-size-micro", `${microSize}px`);
    root.setProperty("--font-size-app-title", `${bodySize + 2}px`);
    root.setProperty("--text-xs", `${metaSize}px`);
    root.setProperty("--text-sm", `${textSmSize}px`);
    root.setProperty("--text-base", `${textBaseSize}px`);
    root.setProperty("--mantine-font-size-xs", `${metaSize}px`);
    root.setProperty("--mantine-font-size-sm", `${textSmSize}px`);
    root.setProperty("--mantine-font-size-md", `${textBaseSize}px`);
    root.setProperty("--mantine-font-size-lg", `${bodySize + 5}px`);
    root.setProperty("--mantine-font-size-xl", `${bodySize + 7}px`);

    const styleId = "ui-font-size-override";
    let styleEl = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = styleId;
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      body {
        font-size: var(--font-size-body) !important;
        line-height: var(--line-height-body) !important;
      }
    `;
  }, [uiFontSize]);

  // 跟随系统主题：监听放在 effect 中，确保挂载/卸载严格成对，避免 store.load 中残留 listener
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => useSettingsStore.getState().syncSystemTheme();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const exitApp = useCallback(async (source: string): Promise<boolean> => {
    logInfo("exit: terminating app", { source });
    try {
      await invoke("app_exit");
      return true;
    } catch (err) {
      logWarn(`Failed to exit application from ${source}`, err);
      return false;
    }
  }, []);

  const getExitRunningTaskIds = useCallback(async (source: string) => {
    const terminalState = useTerminalStore.getState();
    const includeFinished = useSettingsStore.getState().backgroundIncludeFinishedTasks;
    // Issue #142：开关开启时，运行完毕/失败的 CLI 会话也参与退出拦截与转入后台。
    const foregroundRunningIds = terminalState.getExitTaskSessionIds(includeFinished);
    const foregroundSessionIds = new Set(terminalState.sessions.map((session) => session.id));
    let daemonAliveIds: string[] = [];
    let daemonFinishedIds: string[] = [];
    let daemonSessionsChecked = false;
    try {
      const daemonSessions = await invoke<DaemonSessionMeta[]>("pty_daemon_sessions");
      daemonSessionsChecked = true;
      daemonAliveIds = daemonSessions
        .filter((session) => (
          session.alive
          && !foregroundSessionIds.has(session.sessionId)
          && shouldIncludeDaemonExitTask(session, includeFinished)
        ))
        .map((session) => session.sessionId);
      // 后台已完成但仍可回放的 daemon 会话：仅在开关开启时纳入（避免默认退出被已完成任务打扰）
      if (includeFinished) {
        daemonFinishedIds = daemonSessions
          .filter((session) => {
            if (foregroundSessionIds.has(session.sessionId)) return false;
            if (session.alive) return false;
            return shouldIncludeDaemonExitTask(session, true);
          })
          .map((session) => session.sessionId);
      }
      logInfo("exit: daemon sessions checked", {
        source,
        includeFinished,
        foregroundRunningCount: foregroundRunningIds.length,
        backgroundDaemonAliveCount: daemonAliveIds.length,
        backgroundDaemonFinishedCount: daemonFinishedIds.length,
        daemonSessionCount: daemonSessions.length,
      });
    } catch (err) {
      logWarn("exit: failed to query daemon sessions", { source, err });
    }
    return {
      runningIds: Array.from(new Set([...foregroundRunningIds, ...daemonAliveIds, ...daemonFinishedIds])),
      daemonSessionsChecked,
    };
  }, []);

  const runExitCleanup = useCallback(async (
    source: string,
    options?: { closePty?: boolean; closeAllPty?: boolean }
  ) => {
    if (exitCleanupInProgressRef.current) return;
    exitCleanupInProgressRef.current = true;
    const closePty = options?.closePty ?? true;
    const closeAllPty = options?.closeAllPty ?? true;
    const ptySessionIds = useTerminalStore
      .getState()
      .sessions
      .filter((session) => (session.kind ?? "pty") === "pty")
      .map((session) => session.id);
    logInfo("exit: cleanup started", {
      source,
      closePty,
      ptySessionCount: ptySessionIds.length,
      ptySessionIds,
    });
    let canExit = false;
    try {
      // 全程保持窗口可见并显示进度遮罩；destroy 前不复位 exitPhase。
      flushSync(() => {
        setExitNotice(null);
        setExitPhase("closing");
      });
      // Issue #123：正常退出前把各终端最终画面强制落盘，供下次启动问询式恢复。
      // 必须在 PtyHost closeAll 之前，避免关闭 PTY 触发的重绘/清屏影响 serialize 结果；
      // 此处不再 clear() 工作区快照——那会让"关闭后恢复"永远拿不到数据。
      await flushTerminalSnapshotsNow();
      await useSessionStore.getState().freezeForExit(useTerminalStore.getState().sessions);
      // Phase 2：daemon 模式"转入后台"时 closePty=false——PTY 留在守护进程里继续跑，
      // 快照仍落盘作为 daemon 也挂掉时的最终兜底。
      const terminalCleanup = await cleanupTerminalProcessesForExit(
        { closePty, closeAllPty, foregroundSessionIds: ptySessionIds },
        {
          closeAll: () => terminalProcessManager.closeAll(),
          close: (sessionId) => terminalProcessManager.close(sessionId),
          shutdownDaemonIfIdle: () => invoke<boolean>("pty_daemon_shutdown_if_idle"),
        },
      );
      if (terminalCleanup.closeAllError) {
        logWarn("Failed to close all PTY sessions before exit", {
          source,
          err: terminalCleanup.closeAllError,
        });
      }
      for (const failure of terminalCleanup.foregroundCloseErrors) {
        logWarn("Failed to close foreground PTY session before exit", {
          source,
          sessionId: failure.sessionId,
          err: failure.error,
        });
      }
      if (closePty) {
        logInfo("exit: PTY cleanup completed", {
          source,
          closeAllPty,
          requestedCount: ptySessionIds.length,
          failedForegroundCount: terminalCleanup.foregroundCloseErrors.length,
          daemonStopped: terminalCleanup.daemonStopped,
        });
      }
      if (!terminalCleanup.canExit) {
        logWarn("exit: daemon shutdown failed, keeping application open", {
          source,
          err: terminalCleanup.shutdownError,
        });
        return;
      }
      canExit = true;
    } catch (err) {
      logWarn("exit: cleanup failed, keeping application open", { source, err });
    } finally {
      logInfo("exit: cleanup finished", { source, closePty, canExit });
      if (canExit && await exitApp(source)) return;
      exitCleanupInProgressRef.current = false;
      useSessionStore.getState().resumePersistence();
      flushSync(() => {
        setExitPhase(null);
        setExitNotice(null);
      });
    }
  }, [exitApp]);

  // Issue #123 Phase 1/2：转入后台。
  // daemon 可用 → 真退出应用，任务由守护进程续跑（下次启动 attach 回放）；
  // daemon 不可用 → 托盘常驻降级：仅隐藏窗口，严禁触碰退出链路
  // （runExitCleanup / PtyHost closeAll）——PTY、hook server、快照节流全部存活。
  const minimizeToTray = useCallback(async () => {
    try {
      await getCurrentWindow().hide();
      backgroundTaskModeActive = true;
    } catch (err) {
      logWarn("Failed to hide window for tray mode", err);
    }
  }, []);

  const enterBackgroundTaskMode = useCallback(async () => {
    let daemonActive = false;
    try {
      daemonActive = await invoke<boolean>("pty_daemon_active");
    } catch (err) {
      logWarn("Failed to query pty daemon state", err);
    }
    logInfo("exit: background task mode requested", { daemonActive });
    if (daemonActive) {
      await runExitCleanup("background daemon", { closePty: false });
      return;
    }
    try {
      await minimizeToTray();
      return;
    } catch (err) {
      // hide 失败时保持窗口可见即可，绝不能误走退出链路杀任务。
      logWarn("Failed to hide window for background task mode", err);
    }
  }, [minimizeToTray, runExitCleanup]);

  // 所有"退出应用"入口（closeBehavior=exit、关闭弹窗选退出、托盘退出）必须经此守卫：
  // 无运行中任务且 daemon 查询成功 → 清理全部空闲 PTY 后退出；有任务 → 按设置分流。
  // daemon 查询失败 → 仅关闭前台 PTY，不能以“未知”等同“无后台任务”。
  const requestExitGuardedByRunningTasks = useCallback(async (
    source: string,
    prechecked?: { runningIds: string[]; daemonSessionsChecked: boolean },
  ) => {
    const { runningIds, daemonSessionsChecked } =
      prechecked ?? await getExitRunningTaskIds(source);
    logInfo("exit: guarded request evaluated", {
      source,
      runningCount: runningIds.length,
      runningIds,
      daemonSessionsChecked,
      behavior: exitTasksBehaviorRef.current,
    });
    if (runningIds.length === 0) {
      await runExitCleanup(source, { closeAllPty: daemonSessionsChecked });
      return;
    }
    const behavior = exitTasksBehaviorRef.current;
    if (behavior === "background") {
      await enterBackgroundTaskMode();
      return;
    }
    if (behavior === "minimize") {
      await minimizeToTray();
      return;
    }
    if (behavior === "discard") {
      await runExitCleanup(source, {
        closeAllPty: daemonSessionsChecked,
      });
      return;
    }
    pendingExitSourceRef.current = source;
    pendingExitDaemonSessionsCheckedRef.current = daemonSessionsChecked;
    setRunningTasksCount(runningIds.length);
    // 托盘退出时窗口可能处于隐藏态，弹窗前必须先恢复窗口。
    await focusMainWindow();
    setRunningTasksDialogOpen(true);
  }, [enterBackgroundTaskMode, getExitRunningTaskIds, minimizeToTray, runExitCleanup]);

  const persistExitTaskBehaviorBeforeAction = useCallback(async (
    remember: boolean,
    behavior: Exclude<ExitWithRunningTasksBehavior, "ask">,
  ) => {
    if (!remember) return;
    try {
      await updateSetting("exitWithRunningTasksBehavior", behavior);
    } catch (err) {
      logWarn("Failed to remember exit behavior before action", { behavior, err });
    }
  }, [updateSetting]);

  const handleRunningTasksDialogBackground = useCallback(async (remember: boolean) => {
    setRunningTasksDialogOpen(false);
    logInfo("exit: running task dialog selected background", {
      source: pendingExitSourceRef.current,
      remember,
      runningCount: runningTasksCount,
    });
    await persistExitTaskBehaviorBeforeAction(remember, "background");
    await enterBackgroundTaskMode();
  }, [enterBackgroundTaskMode, persistExitTaskBehaviorBeforeAction, runningTasksCount]);

  const handleRunningTasksDialogMinimize = useCallback(async (remember: boolean) => {
    setRunningTasksDialogOpen(false);
    logInfo("exit: running task dialog selected minimize", {
      source: pendingExitSourceRef.current,
      remember,
      runningCount: runningTasksCount,
    });
    await persistExitTaskBehaviorBeforeAction(remember, "minimize");
    await minimizeToTray();
  }, [minimizeToTray, persistExitTaskBehaviorBeforeAction, runningTasksCount]);

  const handleRunningTasksDialogDiscard = useCallback(async (remember: boolean) => {
    setRunningTasksDialogOpen(false);
    logInfo("exit: running task dialog selected discard", {
      source: pendingExitSourceRef.current,
      remember,
      runningCount: runningTasksCount,
    });
    await persistExitTaskBehaviorBeforeAction(remember, "discard");
    await runExitCleanup(pendingExitSourceRef.current, {
      closeAllPty: pendingExitDaemonSessionsCheckedRef.current,
    });
  }, [persistExitTaskBehaviorBeforeAction, runExitCleanup, runningTasksCount]);

  // 窗口重新获得焦点（托盘左键 / 通知点击唤回）即退出后台任务模式。
  useEffect(() => {
    if (!IN_TAURI) return;
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        backgroundTaskModeActive = false;
        void clearTaskbarAttention();
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!IN_TAURI) return;
    const unlistenPromise = listen("tray-quit-requested", async () => {
      await requestExitGuardedByRunningTasks("tray quit");
    });
    const unlistenNative = listen("app-quit-requested", async () => {
      await requestExitGuardedByRunningTasks("native quit");
    });

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
      void unlistenNative.then((unlisten) => unlisten());
    };
  }, [requestExitGuardedByRunningTasks]);

  // 关闭窗口拦截：根据 closeBehavior 决定最小化到托盘 / 直接退出 / 弹窗询问
  useEffect(() => {
    if (!IN_TAURI) return;
    const appWindow = getCurrentWindow();
    let unlistenPromise: Promise<() => void> | null = null;

    unlistenPromise = appWindow.onCloseRequested(async (event) => {
      const behavior = closeBehaviorRef.current;
      logInfo("exit: window close requested", { behavior });
      if (behavior === "minimize") {
        event.preventDefault();
        try {
          await appWindow.hide();
        } catch (err) {
          logWarn("Failed to hide window on close", err);
        }
        return;
      }
      if (behavior === "exit") {
        event.preventDefault();
        await requestExitGuardedByRunningTasks("window close");
        return;
      }
      event.preventDefault();
      const { runningIds, daemonSessionsChecked } = await getExitRunningTaskIds("window close");
      logInfo("exit: close ask evaluated", {
        runningCount: runningIds.length,
        runningIds,
      });
      if (runningIds.length > 0) {
        await requestExitGuardedByRunningTasks("window close", {
          runningIds,
          daemonSessionsChecked,
        });
      } else {
        setCloseDialogOpen(true);
      }
    });

    return () => {
      unlistenPromise?.then((fn) => fn()).catch(() => {});
    };
  }, [getExitRunningTaskIds, requestExitGuardedByRunningTasks]);

  const handleCloseDialogMinimize = useCallback(
    (remember: boolean) => {
      setCloseDialogOpen(false);
      if (remember) {
        void updateSetting("closeBehavior", "minimize");
      }
      void minimizeToTray();
    },
    [minimizeToTray, updateSetting]
  );

  const handleCloseDialogExit = useCallback(
    (remember: boolean) => {
      setCloseDialogOpen(false);
      if (remember) {
        void updateSetting("closeBehavior", "exit");
      }
      void (async () => {
        await requestExitGuardedByRunningTasks("close dialog");
      })();
    },
    [requestExitGuardedByRunningTasks, updateSetting]
  );

  useEffect(() => {
    if (!IN_TAURI || isMacOs) return;
    const appWindow = getCurrentWindow();
    void (async () => {
      try {
        const shouldPreserveWindowBounds =
          (await appWindow.isMaximized()) || (await appWindow.isFullscreen());
        if (shouldPreserveWindowBounds) return;
        if (viewMode !== "compact") {
          if (restoreWindowWidthRef.current && restoreWindowWidthRef.current > COMPACT_WINDOW_WIDTH) {
            await appWindow.setSize(
              new LogicalSize(restoreWindowWidthRef.current, Math.max(window.innerHeight, WINDOW_MIN_HEIGHT))
            );
          }
          await appWindow.setMinSize(new LogicalSize(800, WINDOW_MIN_HEIGHT));
          restoreWindowWidthRef.current = null;
          return;
        }
        if (restoreWindowWidthRef.current == null) {
          restoreWindowWidthRef.current = window.innerWidth;
        }
        if (settingsWindowExpanded) {
          await appWindow.setMinSize(new LogicalSize(800, WINDOW_MIN_HEIGHT));
          const targetWidth = Math.max(restoreWindowWidthRef.current ?? 800, 800);
          await appWindow.setSize(
            new LogicalSize(targetWidth, Math.max(window.innerHeight, WINDOW_MIN_HEIGHT))
          );
          return;
        }
        // Closing settings in compact mode used to force an immediate native window shrink,
        // which caused a visible flash on some platforms. Restore the smaller min width but
        // keep the current width until the user resizes or changes view mode.
        await appWindow.setMinSize(new LogicalSize(COMPACT_WINDOW_WIDTH, WINDOW_MIN_HEIGHT));
      } catch (err) {
        logWarn("Failed to adjust window size", err);
      }
    })();
  }, [isMacOs, viewMode, settingsWindowExpanded]);

  useEffect(() => {
    if (!settingsLoaded || !startupReady || firstScreenPerfReported) return;
    let raf1 = 0;
    let raf2 = 0;
    const stopPerf = createPerfMarker("app.first_screen", {
      bootElapsedMs:
        (typeof performance !== "undefined" && typeof performance.now === "function"
          ? performance.now()
          : Date.now()) - appStartAt,
    });
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (firstScreenPerfReported) return;
        firstScreenPerfReported = true;
        stopPerf({
          resolvedTheme,
          viewMode,
        });
        runDeferredStartupTasks();
        if (IN_TAURI && !firstScreenShown) {
          firstScreenShown = true;
          void getCurrentWindow().show().catch((err) => logWarn("Failed to show window after first screen", err));
        }
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [handleOpenSettings, resolvedTheme, settingsLoaded, startupReady, viewMode]);

  if (initError) {
    return (
      <AppFailureState
        title={t("app.init.failedTitle")}
        description={t("app.init.failedDescription")}
        detail={initError}
        primaryAction={{
          label: t("common.retry"),
          onClick: () => window.location.reload(),
        }}
      />
    );
  }

  if (!settingsLoaded || !startupReady) {
    const stageLabel = startupStage === "settings"
      ? t("app.init.loadingSettings")
      : startupStage === "stores"
        ? t("app.init.loadingStores")
        : t("app.init.loadingProjects");
    return (
      <div className="ui-workspace-shell flex h-screen items-center justify-center px-6" role="status" aria-live="polite">
        <div className="flex max-w-sm items-center gap-3 text-on-surface-variant">
          <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true" />
          <div>
            <div className="text-sm font-medium text-on-surface">{t("app.init.loading")}</div>
            <div className="mt-1 text-xs text-text-muted">{stageLabel}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ui-workspace-shell flex h-screen flex-col">
      <a href="#main-content" className="skip-link">
        {t("app.skipToMain")}
      </a>
      {(!terminalFullscreen || viewMode === "compact") && <WindowTitleBar />}
      {viewMode === "compact" ? (
        <div id="main-content" className="flex min-h-0 flex-1" tabIndex={-1}>
          <Sidebar
            onOpenSettings={handleOpenSettings}
            compactMode
            projectScopedTerminalViewEnabled={projectScopedTerminalViewEnabled}
            terminalScope={terminalScope}
            onTerminalScopeChange={setTerminalScope}
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {!terminalFullscreen && (
            <Sidebar
              onOpenSettings={handleOpenSettings}
              projectScopedTerminalViewEnabled={projectScopedTerminalViewEnabled}
              terminalScope={terminalScope}
              onTerminalScopeChange={setTerminalScope}
            />
          )}
          <main id="main-content" className="ui-main-shell flex min-w-0 flex-1 flex-col" tabIndex={-1}>
            <TerminalTabs
              fullscreen={terminalFullscreen}
              onToggleFullscreen={handleToggleTerminalFullscreen}
              projectScopedTerminalViewEnabled={projectScopedTerminalViewEnabled}
              terminalScope={terminalScope}
            />
          </main>
        </div>
      )}
      <WorkspaceStatusBar terminalScope={projectScopedTerminalViewEnabled ? terminalScope : undefined} />
      <CommandPalette prepareCreate={async () => !terminalFullscreen || await handleToggleTerminalFullscreen()} />
      <NotificationInboxPanel onOpenTarget={activateNotificationTarget} />
      <ExternalSessionSyncDialog />
      <Suspense fallback={null}>
        {settingsEverOpened && (
            <SettingsModal
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
            onAfterClose={() => {
              setSettingsWindowExpanded(false);
            }}
            initialTab={settingsInitialTab}
            onActiveTabChange={handleSettingsTabChange}
          />
        )}

      </Suspense>
      <CloseConfirmDialog
        open={closeDialogOpen}
        onMinimize={handleCloseDialogMinimize}
        onExit={handleCloseDialogExit}
        onClose={() => setCloseDialogOpen(false)}
      />
      <RunningTasksExitDialog
        open={runningTasksDialogOpen}
        runningCount={runningTasksCount}
        onBackground={handleRunningTasksDialogBackground}
        onMinimize={handleRunningTasksDialogMinimize}
        onDiscard={handleRunningTasksDialogDiscard}
        onClose={() => setRunningTasksDialogOpen(false)}
      />
      <ConfirmDialog
        open={restorePromptOpen}
        title={t("terminal.restore.promptTitle")}
        message={t("terminal.restore.promptDescription")}
        confirmText={t("terminal.restore.confirm")}
        cancelText={t("terminal.restore.reject")}
        confirmAutoFocus
        contentClassName="w-[calc(100vw-2rem)] max-w-[460px]"
        onConfirm={handleConfirmRestoreSessions}
        onClose={handleRejectRestoreSessions}
      />
      {exitPhase && <ExitProgressOverlay phase={exitPhase} notice={exitNotice} />}
      <Toaster
        theme={resolvedTheme}
        position="bottom-right"
        closeButton
        expand
        toastOptions={{
          classNames: {
            toast: "border border-border bg-bg-secondary text-text-primary",
            description: "text-text-secondary",
          },
        }}
      />
    </div>
  );
}

export default App;
