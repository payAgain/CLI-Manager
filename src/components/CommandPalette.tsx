import { useState, useEffect, useMemo, useRef, useId, type KeyboardEvent } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/shallow";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { ArrowRight, FileText, Folder, GitBranch, LayoutGrid, Plus, Search, TerminalSquare, X } from "lucide-react";
import { toast } from "sonner";
import { useProjectStore } from "../stores/projectStore";
import { useTemplateStore } from "../stores/templateStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useSshHostStore } from "../stores/sshHostStore";
import { useHistoryStore } from "../stores/historyStore";
import { Dialog, DialogOverlay } from "./ui/dialog";
import { Input } from "./ui/input";
import { useI18n, type TranslationKey } from "../lib/i18n";
import { logError } from "../lib/logger";
import { openWindowsTerminal } from "../lib/externalTerminal";
import { buildQuickJumpTargets, isLiveQuickJumpTerminal, matchesQuickJumpQuery, quickJumpMatchScore, searchQuickJumpTargets, type QuickJumpTarget } from "../lib/quickJumpTargets";
import { activateQuickJumpTarget, requestQuickJumpCreate } from "../lib/quickJumpNavigation";
import { resolveQuickJumpFileProject, quickJumpFileContextKey } from "../lib/quickJumpFileContext";
import { openQuickJumpFile } from "../lib/quickJumpFiles";
import { useQuickJumpFiles } from "./command-palette/useQuickJumpFiles";
import { findWorktreeForSession, findWorktreeByPath } from "../lib/terminalProject";
import { resolveNewTerminalContext } from "../lib/newTerminal";
import { collectProjectIdsForGroup, sessionMatchesTerminalScope } from "../lib/terminalScope";
import { terminalProcessManager } from "../terminal/core/TerminalProcessManager";

export const useCommandPaletteStore = create<{
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
}>((set) => ({
  isOpen: false,
  open: () => set({ isOpen: true }),
  close: () => set({ isOpen: false }),
  toggle: () => set((s) => ({ isOpen: !s.isOpen })),
}));

type Category = "terminal" | "workspan" | "project" | "worktree" | "file" | "create" | "action" | "template";
interface PaletteItem {
  id: string;
  label: string;
  description: string;
  category: Category;
  intent: "navigate" | "create" | "open" | "run";
  kind?: QuickJumpTarget["kind"];
  active?: boolean;
  action: () => boolean | void | Promise<boolean | void>;
}
const CATEGORIES: Category[] = ["terminal", "workspan", "project", "worktree", "file", "create", "action", "template"];
const CATEGORY_KEYS: Record<Category, TranslationKey> = {
  terminal: "palette.terminals", workspan: "palette.workspans", project: "palette.projects",
  worktree: "palette.worktrees", file: "palette.files", create: "palette.create",
  action: "palette.actions", template: "palette.templates",
};
const ICONS = { terminal: TerminalSquare, workspan: LayoutGrid, project: Folder, worktree: GitBranch,
  file: FileText, create: Plus, action: ArrowRight, template: TerminalSquare };

/** Keep focus in the destination, rather than restoring the palette's old trigger. */
function focusDestination(): void {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (useCommandPaletteStore.getState().isOpen || document.querySelector('[role="dialog"]')) return;
    const pane = document.querySelector<HTMLElement>('.ui-terminal-pane[data-focused="true"]');
    const candidates = pane?.querySelectorAll<HTMLElement>('.xterm-helper-textarea, .monaco-editor textarea') ?? [];
    const input = Array.from(candidates).find(element => element.getClientRects().length > 0);
    (input ?? document.getElementById("main-content"))?.focus({ preventScroll: true });
  }));
}

export function CommandPalette({ prepareCreate }: { prepareCreate?: () => Promise<boolean> } = {}) {
  const { isOpen, close } = useCommandPaletteStore();
  useEffect(() => {
    if (isOpen) void useProjectStore.getState().refreshWorktrees();
  }, [isOpen]);
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fileRetry, setFileRetry] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const selectionTouchedRef = useRef(false);
  const executingRef = useRef(false);
  const navigatedRef = useRef(false);
  const listId = useId();
  const { projects, worktrees, groups } = useProjectStore(useShallow(s => ({ projects: s.projects, worktrees: s.worktrees, groups: s.groups })));
  const { sessions, sessionStatuses, workspans, activeSessionId, activeWorkspanId, terminalScope } = useTerminalStore(useShallow(s => ({
    sessions: s.sessions, sessionStatuses: s.sessionStatuses, workspans: s.workspans,
    activeSessionId: s.activeSessionId, activeWorkspanId: s.activeWorkspanId, terminalScope: s.terminalScope,
  })));
  const { viewMode, workspanEnabled, useExternalTerminal, defaultShell, resolvedTheme, keyboardShortcuts } = useSettingsStore(useShallow(s => ({
    viewMode: s.viewMode, workspanEnabled: s.workspanEnabled, useExternalTerminal: s.useExternalTerminal,
    defaultShell: s.defaultShell, resolvedTheme: s.resolvedTheme, keyboardShortcuts: s.keyboardShortcuts,
  })));
  const hosts = useSshHostStore(s => s.hosts);
  const templateState = useTemplateStore();
  const fileProject = useMemo(() => resolveQuickJumpFileProject({
    projects, worktrees, sessions, activeSessionId, terminalScope, groups,
  }), [projects, worktrees, sessions, activeSessionId, terminalScope, groups]);
  const files = useQuickJumpFiles({ isOpen: isOpen && viewMode !== "compact", query, project: fileProject, retryKey: fileRetry });
  const fileScope = fileProject
    ? `${fileProject.name} · ${fileProject.environment_type === "ssh" ? fileProject.remote_path : fileProject.path}`
    : null;
  const activeSession = useMemo(() => {
    let session = sessions.find(item => item.id === activeSessionId) ?? null;
    const seen = new Set<string>();
    while (session?.kind === "subagent-transcript") {
      if (seen.has(session.id)) return null;
      seen.add(session.id);
      const parentId = session.subagent?.parentSessionId;
      session = sessions.find(item => item.id === parentId) ?? null;
    }
    const groupIds = terminalScope.kind === "group" ? collectProjectIdsForGroup(groups, projects, terminalScope.groupId) : null;
    return session && sessionMatchesTerminalScope(session, terminalScope, sessions, projects,
      new Map(projects.map(project => [project.id, project])), worktrees, groupIds) ? session : null;
  }, [sessions, activeSessionId, terminalScope, groups, projects, worktrees]);
  const liveInputSession = activeSession && isLiveQuickJumpTerminal(activeSession, sessionStatuses) ? activeSession : null;

  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setSelectedId(null);
    composingRef.current = false;
    selectionTouchedRef.current = false;
    navigatedRef.current = false;
    void templateState.fetchTemplates().catch(error => {
      logError("CommandPalette failed to load templates", error);
      toast.error(t("commandTemplate.loadFailed"));
    });
  }, [isOpen, templateState.fetchTemplates, t]);

  const targets = useMemo(() => isOpen ? buildQuickJumpTargets({
    projects, worktrees, sessions, sessionStatuses, workspans, activeSessionId, activeWorkspanId,
    workspanEnabled, includeTerminals: viewMode !== "compact", externalMode: viewMode === "compact" || useExternalTerminal,
  }) : [], [isOpen, projects, worktrees, sessions, sessionStatuses, workspans, activeSessionId, activeWorkspanId, workspanEnabled, viewMode, useExternalTerminal]);

  const items = useMemo<PaletteItem[]>(() => {
    if (!isOpen) return [];
    const result: PaletteItem[] = searchQuickJumpTargets(targets.map(target => {
      const host = hosts.find(item => item.id === target.sshHostId);
      const environment = target.environment === "ssh" ? `SSH${host ? ` · ${host.name}` : ""}`
        : target.environment === "wsl" ? "WSL" : target.environment ? t("workspace.localHost") : "";
      return { ...target, label: target.label || t("terminal.workspan.title", { count: target.sessionCount ?? 0 }),
        description: [environment, target.description].filter(Boolean).join(" · "),
        searchText: `${target.searchText} ${host?.name ?? ""} ${t(CATEGORY_KEYS[target.kind])} ${target.intent === "create" ? t("palette.newSession") : t("palette.switch")}` };
    }), query).map(target => ({
      id: target.id, label: target.label || t("terminal.workspan.title", { count: target.sessionCount ?? 0 }),
      description: [target.description, target.missing ? t("worktree.status.missing") : ""].filter(Boolean).join(" · "),
      category: target.intent === "create" ? "create" : target.kind, kind: target.kind,
      intent: target.intent, active: target.active,
      action: async () => {
        if (target.intent === "navigate") return activateQuickJumpTarget(target);
        if (prepareCreate && !await prepareCreate()) return false;
        return requestQuickJumpCreate(target);
      },
    }));
    if (viewMode !== "compact" && fileProject) {
      const contextKey = quickJumpFileContextKey(fileProject);
      for (const file of files.files) result.push({
        id: `file:${contextKey}:${file.path}`, label: file.name, description: file.path,
        category: "file", intent: "open", action: () => openQuickJumpFile(fileProject, file),
      });
    }
    const actions: PaletteItem[] = [];
    if (viewMode !== "compact" && !(useExternalTerminal && fileProject?.environment_type === "ssh")) actions.push({
      id: "action:new-terminal", label: t("palette.newTerminal"), description: fileScope ?? t("palette.defaultShell"),
      category: "create", intent: "create", kind: "terminal",
      action: async () => {
        const worktree = findWorktreeForSession(activeSession, sessions, worktrees)
          ?? (fileProject ? findWorktreeByPath(worktrees, fileProject.path) : null);
        if (worktree?.status === "missing") throw new Error(t("worktree.status.missing"));
        const context = resolveNewTerminalContext(activeSession, fileProject, worktree, defaultShell);
        if (useExternalTerminal) {
          if (context.remote) return false;
          await openWindowsTerminal([{ title: context.title, cwd: context.cwd, shell: context.shell, startupCmd: "" }]);
        } else {
          const sessionId = await useTerminalStore.getState().createSession(context.projectId, context.cwd, context.title, "",
            context.envVars, context.shell, undefined, context.worktreeId, context.sshHostId);
          activateQuickJumpTarget({ id: `navigate:terminal:${sessionId}`, kind: "terminal", intent: "navigate",
            sessionId, label: context.title, description: "", searchText: "", active: false });
        }
        useHistoryStore.getState().closeHistory();
      },
    });
    actions.push({
      id: "action:open-history", label: t("palette.openHistory"), description: keyboardShortcuts.sessionHistory,
      category: "action", intent: "open", action: () => {
        void useHistoryStore.getState().openHistory();
        useHistoryStore.getState().triggerGlobalSearchFocus();
      },
    });
    if (viewMode !== "compact" && liveInputSession) {
      const sessionId = liveInputSession.id;
      for (const direction of (useExternalTerminal ? [] : ["horizontal", "vertical"] as const)) actions.push({
        id: `action:split-${direction}`, label: t(direction === "horizontal" ? "palette.splitRight" : "palette.splitDown"),
        description: liveInputSession.title, category: "action", intent: "create",
        action: async () => {
          const state = useTerminalStore.getState();
          const session = state.sessions.find(item => item.id === sessionId);
          if (!session || !isLiveQuickJumpTerminal(session, state.sessionStatuses)) return false;
          await state.splitTerminal(sessionId, direction, { title: "Terminal", startupCmd: "" });
        },
      });
      actions.push({
        id: "action:unsplit", label: t("palette.unsplit"), description: liveInputSession.title,
        category: "action", intent: "run", action: async () => { await useTerminalStore.getState().unsplitTerminal(sessionId); },
      });
      const templates = templateState.getForContext(fileProject?.id ?? liveInputSession.projectId ?? null, sessionId);
      for (const template of templates) actions.push({
        id: `template:${template.id}`, label: template.name,
        description: `${liveInputSession.title} · ${template.command}`, category: "template", intent: "run",
        action: async () => {
          const state = useTerminalStore.getState();
          const session = state.sessions.find(item => item.id === sessionId);
          if (!session || !isLiveQuickJumpTerminal(session, state.sessionStatuses)) return false;
          await terminalProcessManager.write(sessionId, template.command + "\r");
        },
      });
    }
    actions.push({
      id: "action:toggle-theme", label: t(resolvedTheme === "dark" ? "palette.lightTheme" : "palette.darkTheme"),
      description: "", category: "action", intent: "run",
      action: () => { void useSettingsStore.getState().setTheme(resolvedTheme === "dark" ? "light" : "dark"); },
    });
    return [...result, ...actions.filter(item => matchesQuickJumpQuery(`${item.label} ${item.description}`, query))];
  }, [isOpen, targets, hosts, query, files.files, fileProject, fileScope, activeSession, liveInputSession, sessions,
    worktrees, defaultShell, viewMode, useExternalTerminal, resolvedTheme, keyboardShortcuts.sessionHistory, templateState, prepareCreate, t]);

  const sections = CATEGORIES.map(category => ({ category, items: items.filter(item => item.category === category) })).filter(section => section.items.length);
  if (query.trim()) {
    const score = (section: typeof sections[number]) => Math.min(...section.items.map(item => (
      quickJumpMatchScore(item.label, `${item.label} ${item.description}`, query) ?? 1000
    )));
    // Exact file names should outrank weak metadata matches. Creation stays explicit and last.
    sections.sort((left, right) => Number(left.category === "create") - Number(right.category === "create") || score(left) - score(right));
  }
  const orderedItems = sections.flatMap(section => section.items);
  const selectedItem = (selectionTouchedRef.current ? orderedItems.find(item => item.id === selectedId) : null) ?? orderedItems[0];
  const selectedIndex = selectedItem ? orderedItems.indexOf(selectedItem) : -1;
  useEffect(() => { setSelectedId(selectedItem?.id ?? null); }, [selectedItem?.id]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedItem?.id]);

  const execute = async (item: PaletteItem) => {
    if (executingRef.current) return;
    executingRef.current = true;
    navigatedRef.current = true;
    close();
    try {
      if (await item.action() === false) toast.error(t("palette.unavailable"));
      else if (item.id !== "action:open-history") focusDestination();
    } catch (error) {
      logError("CommandPalette action failed", { itemId: item.id, error });
      toast.error(t("palette.actionFailed"), { description: String(error) });
    } finally { executingRef.current = false; }
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const index = Math.max(0, Math.min(orderedItems.length - 1, selectedIndex + offset));
      selectionTouchedRef.current = true;
      setSelectedId(orderedItems[index]?.id ?? null);
    } else if (event.key === "Enter" && selectedItem) {
      event.preventDefault();
      void execute(selectedItem);
    }
  };
  const optionId = (id: string) => `${listId}-${encodeURIComponent(id)}`;

  return (
    <Dialog open={isOpen} onOpenChange={next => { if (!next) close(); }}>
      <DialogPrimitive.Portal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className="ui-surface-card fixed inset-x-4 top-[10vh] z-50 mx-auto flex max-h-[80vh] w-auto max-w-2xl flex-col overflow-hidden p-0 outline-none"
          onOpenAutoFocus={event => {
            event.preventDefault();
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
            inputRef.current?.focus();
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            if (navigatedRef.current) return;
            const previous = returnFocusRef.current;
            if (previous?.isConnected && previous.getClientRects().length > 0) previous.focus({ preventScroll: true });
            else focusDestination();
          }}
          onEscapeKeyDown={event => { if (composingRef.current || event.isComposing) event.preventDefault(); }}
        >
          <div className="flex shrink-0 items-center justify-between px-4 pb-2 pt-3">
            <DialogPrimitive.Title className="text-sm font-medium text-on-surface">{t("palette.title")}</DialogPrimitive.Title>
            <DialogPrimitive.Close className="ui-focus-ring rounded p-1 text-on-surface-variant hover:bg-surface-container-high" aria-label={t("palette.close")}>
              <X size={16} />
            </DialogPrimitive.Close>
          </div>
          <div className="shrink-0 border-b border-border px-3 pb-3">
            <div className="relative">
              <Search size={16} className="pointer-events-none absolute left-3 top-3 text-on-surface-variant" />
              <Input ref={inputRef} role="combobox" aria-expanded={isOpen} aria-controls={listId}
                aria-autocomplete="list" aria-activedescendant={selectedItem ? optionId(selectedItem.id) : undefined}
                aria-label={t("palette.searchLabel")} type="text" autoComplete="off" spellCheck={false}
                value={query} onChange={event => { selectionTouchedRef.current = false; setQuery(event.target.value); setSelectedId(null); }}
                onCompositionStart={() => { composingRef.current = true; }} onCompositionEnd={() => { composingRef.current = false; }}
                onKeyDown={handleKeyDown} placeholder={t(viewMode === "compact" ? "palette.compactPlaceholder" : "palette.placeholder")} className="h-10 pl-9 text-sm" />
            </div>
            <DialogPrimitive.Description className="mt-2 truncate px-1 text-xs text-on-surface-variant" title={viewMode === "compact" ? undefined : fileScope ?? undefined}>
              {viewMode === "compact" ? t("palette.filesStandardOnly")
                : fileScope ? t("palette.fileScope", { scope: fileScope }) : t("palette.selectWorkspaceForFiles")}
            </DialogPrimitive.Description>
          </div>
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
            <div id={listId} role="listbox" aria-label={t("palette.results")}>
              {sections.map(section => (
                <div key={section.category} role="group" aria-label={t(CATEGORY_KEYS[section.category])} className="pb-1">
                  <div className="px-2 pb-1 pt-3 text-xs font-medium text-on-surface-variant">{t(CATEGORY_KEYS[section.category])}</div>
                  {section.items.map(item => {
                    const Icon = ICONS[item.kind ?? item.category];
                    const selected = item.id === selectedItem?.id;
                    return (
                      <button key={item.id} type="button" role="option" tabIndex={-1} id={optionId(item.id)}
                        aria-selected={selected} data-intent={item.intent} data-category={item.category}
                        title={[item.label, item.description].filter(Boolean).join("\n")}
                        onMouseMove={() => { selectionTouchedRef.current = true; setSelectedId(item.id); }} onMouseDown={event => event.preventDefault()}
                        onClick={() => void execute(item)}
                        className={`flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-2 text-left ${selected ? "bg-surface-container-high text-on-surface" : "text-on-surface hover:bg-surface-container-high"}`}>
                        <Icon size={16} className="shrink-0 text-on-surface-variant" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{item.label}</span>
                          {item.description && <span className="mt-0.5 block truncate text-xs text-on-surface-variant">{item.description}</span>}
                        </span>
                        <span className="shrink-0 whitespace-nowrap text-xs text-on-surface-variant">
                          {item.intent === "create" ? t("palette.newSession") : item.intent === "navigate"
                            ? t(item.active ? "palette.current" : "palette.switch") : t(item.intent === "open" ? "palette.open" : "palette.run")}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            {files.loading && <p role="status" className="px-2 py-3 text-xs text-on-surface-variant">{t("palette.searchingFiles")}</p>}
            {files.error != null && <div role="status" className="flex items-center justify-between gap-2 px-2 py-3 text-xs text-on-surface-variant">
              <span>{t("palette.fileSearchFailed")}</span>
              <button type="button" className="ui-focus-ring shrink-0 rounded px-2 py-1 text-on-surface underline" onClick={() => setFileRetry(value => value + 1)}>{t("palette.retry")}</button>
            </div>}
            {!orderedItems.length && !files.loading && files.error == null && <p className="px-3 py-8 text-center text-sm text-on-surface-variant">{t("palette.noResults")}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-on-surface-variant">
            <span>{keyboardShortcuts.commandPalette || t("palette.noShortcut")}</span>
            <span>{t("palette.keyboardHint")}</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </Dialog>
  );
}
