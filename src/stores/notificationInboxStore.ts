import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { inboxTargetKey, type InboxEntry, type InboxPage, type InboxUnreadTarget } from "../lib/notificationInbox";

interface InboxState {
  isOpen: boolean; unreadOnly: boolean; entries: InboxEntry[]; unreadTargets: InboxUnreadTarget[];
  unreadCount: number; latestSequence: number; nextBefore: number | null; trimmedCount: number;
  loading: boolean; mutating: boolean; error: string | null; initialized: boolean;
  persistenceError: boolean;
  manualUnreadTargets: ReadonlySet<string>;
  pageBefore: number | null; pageHistory: Array<number | null>;
  open: () => void; close: () => void; setUnreadOnly: (value: boolean) => void;
  refresh: () => Promise<void>; loadMore: () => Promise<void>;
  previousPage: () => void; showLatest: () => void;
  setRead: (entry: InboxEntry, read: boolean) => Promise<boolean>;
  markAllRead: () => Promise<void>; clearRead: () => Promise<void>;
  readTargets: (targets: InboxUnreadTarget[]) => Promise<void>;
  releaseManualUnread: (keys: string[]) => void;
}

let loadVersion = 0;
let refreshing: Promise<void> | null = null;
let refreshAgain = false;
let mutations = Promise.resolve();
const manualUnreadVersions = new Map<string, number>();
let manualUnreadVersion = 0;

async function mutate(action: () => Promise<void>): Promise<boolean> {
  const run = mutations.catch(() => {}).then(async () => {
    useNotificationInboxStore.setState({ mutating: true, error: null });
    try { await action(); await useNotificationInboxStore.getState().refresh(); return true; }
    catch (error) { useNotificationInboxStore.setState({ error: String(error) }); return false; }
    finally { useNotificationInboxStore.setState({ mutating: false }); }
  });
  mutations = run.then(() => {});
  return run;
}

export const useNotificationInboxStore = create<InboxState>((set, get) => ({
  isOpen: false, unreadOnly: false, entries: [], unreadTargets: [], unreadCount: 0,
  latestSequence: 0, nextBefore: null, trimmedCount: 0, loading: false, mutating: false,
  error: null, initialized: false, manualUnreadTargets: new Set(),
  persistenceError: false,
  pageBefore: null, pageHistory: [],
  open: () => { set({ isOpen: true, pageBefore: null, pageHistory: [] }); void get().refresh(); },
  close: () => set({ isOpen: false }),
  setUnreadOnly: value => { if (get().unreadOnly === value) return; loadVersion++; set({ unreadOnly: value, entries: [], pageBefore: null, pageHistory: [] }); void get().refresh(); },
  showLatest: () => { loadVersion++; set({ pageBefore: null, pageHistory: [] }); void get().refresh(); },
  previousPage: () => {
    const history = [...get().pageHistory];
    if (!history.length) return;
    loadVersion++; set({ pageBefore: history.pop() ?? null, pageHistory: history }); void get().refresh();
  },
  refresh: () => {
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        const version = ++loadVersion, unreadOnly = get().unreadOnly, before = get().pageBefore;
        set({ loading: true });
        try {
          const page = await invoke<InboxPage>("notification_inbox_list", { before, unreadOnly, limit: 50 });
          if (version === loadVersion) set({ ...page, initialized: true, error: null });
        } catch (error) { if (version === loadVersion) set({ error: String(error) }); }
        finally { if (version === loadVersion) set({ loading: false }); }
      } while (refreshAgain);
    })().finally(() => { refreshing = null; });
    return refreshing;
  },
  loadMore: async () => {
    const { nextBefore, loading, pageBefore, pageHistory } = get();
    if (!nextBefore || loading) return;
    loadVersion++; set({ pageBefore: nextBefore, pageHistory: [...pageHistory, pageBefore] });
    await get().refresh();
  },
  setRead: async (entry, read) => {
    const key = inboxTargetKey(entry), wasLocked = get().manualUnreadTargets.has(key);
    const version = read ? manualUnreadVersions.get(key) : ++manualUnreadVersion;
    if (!read) {
      manualUnreadVersions.set(key, version!);
      set({ manualUnreadTargets: new Set([...get().manualUnreadTargets, key]) });
    }
    const success = await mutate(() => invoke("notification_inbox_set_read", { eventIds: [entry.eventId], read }));
    if (manualUnreadVersions.get(key) === version && ((read && success) || (!read && !success && !wasLocked))) {
      get().releaseManualUnread([key]);
    }
    return success;
  },
  markAllRead: async () => {
    const throughSequence = get().latestSequence;
    const locks = new Map(manualUnreadVersions);
    if (await mutate(() => invoke("notification_inbox_mark_all_read", { throughSequence }))) {
      get().releaseManualUnread([...locks].filter(([key, version]) => manualUnreadVersions.get(key) === version).map(([key]) => key));
    }
  },
  clearRead: async () => { await mutate(() => invoke("notification_inbox_clear_read")); },
  readTargets: async targets => {
    const allowed = targets.filter(target => !get().manualUnreadTargets.has(inboxTargetKey(target)));
    if (!allowed.length) return;
    await mutate(async () => {
      for (const target of allowed) {
        // Manual unread can arrive while a previous mutation is completing.
        if (get().manualUnreadTargets.has(inboxTargetKey(target))) continue;
        await invoke("notification_inbox_mark_target_read", { target, throughSequence: target.latestSequence });
      }
    });
  },
  releaseManualUnread: keys => {
    const next = new Set(get().manualUnreadTargets);
    for (const key of keys) { next.delete(key); manualUnreadVersions.delete(key); }
    if (next.size !== get().manualUnreadTargets.size) set({ manualUnreadTargets: next });
  },
}));
