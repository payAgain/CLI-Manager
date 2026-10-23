import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import type { TerminalSession, PersistedSplit } from "../lib/types";
import { getCliManagerDataPaths } from "../lib/appPaths";
import { singleFlight } from "../lib/singleFlight";
import { persistTerminalSession } from "../lib/terminalConversationRestore";
import { withTerminalSnapshot } from "../lib/terminalSnapshotCache";
import {
  migrateTerminalWorkspans,
  sanitizeTerminalWorkspans,
  type TerminalWorkspan,
} from "./terminalWorkspan";

interface SessionStore {
  sessions: TerminalSession[];
  splits: PersistedSplit[];
  activeSessionId: string | null;
  workspans: TerminalWorkspan[];
  activeWorkspanId: string | null;
  loaded: boolean;

  load: () => Promise<void>;
  saveSessions: (sessions: TerminalSession[], flush?: boolean) => Promise<void>;
  freezeForExit: (sessions: TerminalSession[]) => Promise<void>;
  resumePersistence: () => void;
  saveSplits: (splits: PersistedSplit[]) => Promise<void>;
  saveActiveSessionId: (id: string | null) => Promise<void>;
  saveWorkspans: (workspans: TerminalWorkspan[], activeWorkspanId: string | null, sessions: TerminalSession[]) => Promise<void>;
  clear: () => Promise<void>;
}

function isPersistableSession(session: TerminalSession): boolean {
  return session.kind !== "subagent-transcript" && session.kind !== "file-editor" && session.kind !== "synced-history";
}

let store: Store | null = null;
let persistenceQueue = Promise.resolve();
let persistenceFrozen = false;

// All callers enter the queue synchronously, so an older save cannot overtake
// the final exit snapshot or an explicit discard.
function enqueuePersistence(write: () => Promise<void>): Promise<void> {
  persistenceQueue = persistenceQueue.catch(() => {}).then(write);
  return persistenceQueue;
}

function saveSessionSnapshot(sessions: TerminalSession[], flush = false): Promise<void> {
  const persistable = sessions.filter(isPersistableSession)
    .map((session) => persistTerminalSession(withTerminalSnapshot(session)));
  return enqueuePersistence(async () => {
    const s = await getStore();
    await s.set("sessions", persistable);
    if (flush) await s.save();
    useSessionStore.setState({ sessions: persistable });
  });
}

async function getStore() {
  if (!store) {
    const paths = await getCliManagerDataPaths();
    store = await Store.load(paths.sessionsStorePath, { autoSave: 0, defaults: {} });
  }
  return store;
}

export const useSessionStore = create<SessionStore>(() => ({
  sessions: [],
  splits: [],
  activeSessionId: null,
  workspans: [],
  activeWorkspanId: null,
  loaded: false,

  load: singleFlight(async () => {
    const s = await getStore();
    const sessions = (await s.get<TerminalSession[]>("sessions")) ?? [];
    const splits = (await s.get<PersistedSplit[]>("splits")) ?? [];
    const activeSessionId = await s.get<string>("activeSessionId");
    const workspans = migrateTerminalWorkspans(await s.get<unknown>("workspans"));
    const storedActiveWorkspanId = await s.get<unknown>("activeWorkspanId");
    const activeWorkspanId = typeof storedActiveWorkspanId === "string"
      && workspans.some((workspan) => workspan.id === storedActiveWorkspanId)
      ? storedActiveWorkspanId
      : null;

    useSessionStore.setState({
      sessions,
      splits,
      activeSessionId: activeSessionId ?? null,
      workspans,
      activeWorkspanId,
      loaded: true,
    });
  }),

  saveSessions: (sessions, flush) => persistenceFrozen ? Promise.resolve() : saveSessionSnapshot(sessions, flush),

  freezeForExit: (sessions) => {
    // Capture before closing PTYs. Their exit/Hook events must not erase the
    // conversation we are about to reopen at the next launch.
    persistenceFrozen = true;
    return saveSessionSnapshot(sessions, true);
  },

  resumePersistence: () => { persistenceFrozen = false; },

  saveSplits: (splits) => persistenceFrozen ? Promise.resolve() : enqueuePersistence(async () => {
    const s = await getStore();
    await s.set("splits", splits);
    useSessionStore.setState({ splits });
  }),

  saveActiveSessionId: (id) => persistenceFrozen ? Promise.resolve() : enqueuePersistence(async () => {
    const s = await getStore();
    if (id === null) {
      await s.set("activeSessionId", null);
    } else {
      await s.set("activeSessionId", id);
    }
    useSessionStore.setState({ activeSessionId: id });
  }),

  saveWorkspans: (workspans, activeWorkspanId, sessions) => {
    if (persistenceFrozen) return Promise.resolve();
    const validSessionIds = new Set(sessions.filter(isPersistableSession).map((session) => session.id));
    const persistableWorkspans = sanitizeTerminalWorkspans(workspans, validSessionIds);
    const resolvedActiveWorkspanId = activeWorkspanId
      && persistableWorkspans.some((workspan) => workspan.id === activeWorkspanId)
      ? activeWorkspanId
      : persistableWorkspans[0]?.id ?? null;
    return enqueuePersistence(async () => {
      const s = await getStore();
      await s.set("workspans", persistableWorkspans);
      await s.set("activeWorkspanId", resolvedActiveWorkspanId);
      useSessionStore.setState({
        workspans: persistableWorkspans,
        activeWorkspanId: resolvedActiveWorkspanId,
      });
    });
  },

  clear: () => enqueuePersistence(async () => {
    const s = await getStore();
    await s.set("sessions", []);
    await s.set("splits", []);
    await s.set("activeSessionId", null);
    await s.set("workspans", []);
    await s.set("activeWorkspanId", null);
    await s.save();
    useSessionStore.setState({
      sessions: [],
      splits: [],
      activeSessionId: null,
      workspans: [],
      activeWorkspanId: null,
    });
  }),
}));
