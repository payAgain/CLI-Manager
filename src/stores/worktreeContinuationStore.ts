import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { useTerminalStore } from "./terminalStore";
import { useProjectStore } from "./projectStore";
import { useSessionStore } from "./sessionStore";
import { terminalProcessManager } from "../terminal/core/TerminalProcessManager";
import { findWorkspanBySession } from "./terminalWorkspan";
import { findPaneLeafBySession } from "./terminalPaneTree";
import { executeWorktreeContinuation, planWorktreeContinuation, worktreeConversationIdentity, WorktreeContinuationError } from "../lib/worktreeConversation";

interface ContinuationIntent { sourceId: string; conversationId: string; }
export const useWorktreeContinuationStore = create<{
  intent: ContinuationIntent | null;
  pending: boolean;
  open: (sourceId: string) => void;
  dismiss: () => void;
  continueIn: (worktreeId: string | null) => Promise<string>;
}>((set, get) => ({
  intent: null, pending: false,
  open: sourceId => {
    if (get().pending) return;
    const source = useTerminalStore.getState().sessions.find(session => session.id === sourceId);
    const project = useProjectStore.getState().projects.find(project => project.id === (source?.workspace?.projectId ?? source?.projectId));
    set({ intent: { sourceId, conversationId: source ? worktreeConversationIdentity(source, project).sessionId ?? "" : "" } });
  },
  dismiss: () => { if (!get().pending) set({ intent: null }); },
  continueIn: async worktreeId => {
    if (get().pending) throw new WorktreeContinuationError("busy");
    const intent = get().intent;
    const state = useTerminalStore.getState();
    const source = state.sessions.find(session => session.id === intent?.sourceId);
    const catalog = useProjectStore.getState();
    const project = catalog.projects.find(project => project.id === (source?.workspace?.projectId ?? source?.projectId));
    if (!source || !intent) throw new WorktreeContinuationError("sourceChanged");
    if (!project) throw new WorktreeContinuationError("unbound");
    const worktree = worktreeId ? catalog.worktrees.find(tree => tree.id === worktreeId) : null;
    if (worktreeId && !worktree) throw new WorktreeContinuationError("missingTarget");
    const plan = planWorktreeContinuation(source, project, worktree ?? null, intent.conversationId);
    const owner = findWorkspanBySession(state.workspans, source.id);
    const paneId = owner ? findPaneLeafBySession(owner.paneTree, source.id)?.id : undefined;
    const assertCurrent = () => {
      const current = useTerminalStore.getState();
      const liveSource = current.sessions.find(session => session.id === source.id);
      const identity = liveSource && worktreeConversationIdentity(liveSource, project);
      if (!identity || identity.sessionId !== plan.conversationId || identity.tool !== plan.tool) throw new WorktreeContinuationError("sourceChanged");
      const latestCatalog = useProjectStore.getState();
      const latestProject = latestCatalog.projects.find(item => item.id === project.id);
      const latestTarget = worktreeId ? latestCatalog.worktrees.find(item => item.id === worktreeId) : null;
      if (!latestProject || (worktreeId && (!latestTarget || latestTarget.status !== "active"))
        || (latestTarget?.path ?? latestProject.path) !== plan.cwd) throw new WorktreeContinuationError("missingTarget");
      if (current.sessions.some(session => {
        if (session.id === source.id || current.sessionStatuses[session.id] !== "running") return false;
        const other = worktreeConversationIdentity(session);
        return other.sessionId === plan.conversationId && other.tool === plan.tool;
      })) throw new WorktreeContinuationError("busy");
    };
    const restoreSource = async () => {
      // Closed PTYs cannot be running; keep a retryable exact conversation instead of stale process evidence.
      useTerminalStore.setState(current => ({
        sessions: current.sessions.map(session => session.id === source.id ? { ...plan.source, runtimeAgent: undefined } : session),
        sessionStatuses: { ...current.sessionStatuses, [source.id]: "exited" },
      }));
      await useSessionStore.getState().saveSessions(useTerminalStore.getState().sessions, true);
    };
    set({ pending: true });
    try {
      const id = await executeWorktreeContinuation({
        preflight: async () => {
          const exists = await invoke<boolean[]>("check_paths_exist", { paths: [plan.cwd] });
          if (!exists[0]) throw new WorktreeContinuationError("missingTarget");
          assertCurrent();
        },
        saveRecovery: () => useSessionStore.getState().saveSessions(useTerminalStore.getState().sessions, true),
        stopSource: async () => {
          assertCurrent();
          const current = useTerminalStore.getState();
          if (current.sessionStatuses[source.id] !== "exited" && current.sessionStatuses[source.id] !== "error") {
            await terminalProcessManager.close(source.id);
          }
          current.statusListeners[source.id]?.();
          useTerminalStore.setState(current => {
            const statusListeners = { ...current.statusListeners };
            delete statusListeners[source.id];
            return { statusListeners };
          });
          await restoreSource();
        },
        openTarget: async () => {
          assertCurrent();
          return useTerminalStore.getState().createSession(project.id, plan.cwd, source.title, plan.startupCmd,
            plan.envVars, source.shell ?? project.shell, paneId, worktree?.id, undefined, plan.conversationId,
            undefined, undefined, undefined, { waitForStartup: true, conversationResumeTarget: plan.conversationResumeTarget });
        },
        removeSource: async () => {
          await useTerminalStore.getState().closeSession(source.id);
          await useSessionStore.getState().saveSessions(useTerminalStore.getState().sessions, true);
        },
        restoreSource,
      });
      useTerminalStore.getState().setTerminalScope(worktree
        ? { kind: "worktree", projectId: project.id, worktreeId: worktree.id }
        : { kind: "project", projectId: project.id });
      useTerminalStore.getState().setActive(id);
      set({ intent: null });
      return id;
    } finally { set({ pending: false }); }
  },
}));
