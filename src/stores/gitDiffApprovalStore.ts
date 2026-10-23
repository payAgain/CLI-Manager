import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { getCliManagerDataPaths } from "../lib/appPaths";
import { isGitDiffApprovalInScope, normalizeGitDiffApprovals, type GitDiffApprovalRecords } from "../lib/gitDiffApproval";

interface GitDiffApprovalStore {
  loaded: boolean;
  records: GitDiffApprovalRecords;
  fingerprints: Record<string, string | null>;
  load: () => Promise<void>;
  observe: (key: string, fingerprint: string | null) => void;
  invalidateScope: (scope: string) => void;
  approve: (key: string, fingerprint: string) => Promise<void>;
  revoke: (key: string) => Promise<void>;
}

let storage: Promise<Store> | undefined;
let loading: Promise<void> | undefined;
let writes = Promise.resolve();

function getStorage(): Promise<Store> {
  return storage ??= getCliManagerDataPaths().then((paths) => Store.load(
    `${paths.dataDir}/git-diff-approvals.json`, { autoSave: false, defaults: {} },
  )).catch((error) => { storage = undefined; throw error; });
}

function serializeWrite(action: () => Promise<void>): Promise<void> {
  const result = writes.then(action);
  writes = result.catch(() => {});
  return result;
}

export const useGitDiffApprovalStore = create<GitDiffApprovalStore>((set, get) => ({
  loaded: false,
  records: {},
  fingerprints: {},
  load: () => {
    if (get().loaded) return Promise.resolve();
    return loading ??= getStorage().then(async (store) => {
      set({ records: normalizeGitDiffApprovals(await store.get("records")), loaded: true });
    }).finally(() => { loading = undefined; });
  },
  observe: (key, fingerprint) => set((state) => state.fingerprints[key] === fingerprint ? state : {
    fingerprints: Object.fromEntries([...Object.entries(state.fingerprints).filter(([candidate]) => candidate !== key), [key, fingerprint]].slice(-2_000)),
  }),
  invalidateScope: (scope) => set((state) => {
    const keys = Object.keys(state.fingerprints).filter((key) => isGitDiffApprovalInScope(key, scope));
    if (!keys.some((key) => state.fingerprints[key] !== null)) return state;
    const fingerprints = { ...state.fingerprints };
    for (const key of keys) fingerprints[key] = null;
    return { fingerprints };
  }),
  approve: (key, fingerprint) => serializeWrite(async () => {
    await get().load();
    if (get().fingerprints[key] !== fingerprint) throw new Error("git_diff_approval_changed");
    const records = normalizeGitDiffApprovals({ ...get().records, [key]: { fingerprint, approvedAt: Date.now() } });
    const store = await getStorage();
    await store.set("records", records);
    await store.save();
    set({ records });
  }),
  revoke: (key) => serializeWrite(async () => {
    await get().load();
    const records = { ...get().records };
    delete records[key];
    const store = await getStorage();
    await store.set("records", records);
    await store.save();
    set({ records });
  }),
}));
