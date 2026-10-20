import { create } from "zustand";
import { getDb } from "../lib/db";
import { normalizeHistoryCommand } from "../lib/commandHistory";
import type { CommandHistoryEntry } from "../lib/types";

const MAX_HISTORY = 1000;
const CLEANUP_INTERVAL = 50;
let addCounter = 0;

export interface CommandHistoryStorageStats {
  commandCount: number;
  storageBytes: number;
}

interface CommandHistoryStore {
  entries: CommandHistoryEntry[];
  revision: number;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  addCommand: (projectId: string | null, command: string, eventId?: string) => Promise<void>;
  getRecent: (projectId?: string | null, limit?: number) => Promise<CommandHistoryEntry[]>;
  getStorageStats: () => Promise<CommandHistoryStorageStats>;
  fetchAll: () => Promise<void>;
  cleanup: (projectId?: string) => Promise<void>;
}

function normalizeCount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export const useCommandHistoryStore = create<CommandHistoryStore>((set, get) => ({
  entries: [],
  searchQuery: "",
  revision: 0,

  setSearchQuery: (q) => set({ searchQuery: q }),

  addCommand: async (projectId, command, eventId) => {
    const trimmed = normalizeHistoryCommand(command);
    if (!trimmed) return;

    const db = await getDb();
    const id = eventId ?? crypto.randomUUID();
    const executedAt = Date.now().toString();
    const result = await db.execute(
      "INSERT OR IGNORE INTO command_history (id, project_id, command, executed_at) VALUES ($1, $2, $3, $4)",
      [id, projectId, trimmed, executedAt]
    );

    if (result.rowsAffected === 0) return;

    // Increment local cache without re-querying the DB
    const newEntry: CommandHistoryEntry = {
      id,
      project_id: projectId,
      command: trimmed,
      executed_at: executedAt,
    };
    const query = get().searchQuery.trim().toLowerCase();
    if (!query || trimmed.toLowerCase().includes(query)) {
      set((state) => ({ entries: [newEntry, ...state.entries.filter((entry) => entry.id !== id)].slice(0, 100), revision: state.revision + 1 }));
    } else {
      set((state) => ({ revision: state.revision + 1 }));
    }

    // Periodic FIFO cleanup; running it every command is wasteful
    addCounter++;
    if (addCounter >= CLEANUP_INTERVAL) {
      addCounter = 0;
      void (async () => {
        try {
          await db.execute(
            `DELETE FROM command_history WHERE id IN (
              SELECT id FROM command_history ORDER BY executed_at DESC, rowid DESC LIMIT -1 OFFSET $1
            )`,
            [MAX_HISTORY]
          );
        } catch {
          // best effort
        }
      })();
    }
  },

  getRecent: async (projectId, limit = 50) => {
    const db = await getDb();
    if (projectId) {
      return db.select<CommandHistoryEntry[]>(
        "SELECT * FROM command_history WHERE project_id = $1 ORDER BY executed_at DESC, rowid DESC LIMIT $2",
        [projectId, limit]
      );
    }
    return db.select<CommandHistoryEntry[]>(
      "SELECT * FROM command_history ORDER BY executed_at DESC, rowid DESC LIMIT $1",
      [limit]
    );
  },

  getStorageStats: async () => {
    const db = await getDb();
    const rows = await db.select<Array<{ command_count?: number | string; storage_bytes?: number | string }>>(
      `SELECT
        COUNT(*) AS command_count,
        COALESCE(SUM(
          length(CAST(id AS BLOB)) +
          length(CAST(COALESCE(project_id, '') AS BLOB)) +
          length(CAST(command AS BLOB)) +
          length(CAST(executed_at AS BLOB))
        ), 0) AS storage_bytes
      FROM command_history`
    );
    const row = rows[0] ?? {};
    return {
      commandCount: normalizeCount(row.command_count),
      storageBytes: normalizeCount(row.storage_bytes),
    };
  },

  fetchAll: async () => {
    const db = await getDb();
    const query = get().searchQuery.trim();
    let entries: CommandHistoryEntry[];
    if (query) {
      entries = await db.select<CommandHistoryEntry[]>(
        "SELECT * FROM command_history WHERE command LIKE $1 ORDER BY executed_at DESC, rowid DESC LIMIT 100",
        [`%${query}%`]
      );
    } else {
      entries = await db.select<CommandHistoryEntry[]>(
        "SELECT * FROM command_history ORDER BY executed_at DESC, rowid DESC LIMIT 100"
      );
    }
    set({ entries });
  },

  cleanup: async (projectId) => {
    const db = await getDb();
    if (projectId) await db.execute("DELETE FROM command_history WHERE project_id = $1", [projectId]);
    else await db.execute("DELETE FROM command_history");
    set((state) => ({ entries: projectId ? state.entries.filter((entry) => entry.project_id !== projectId) : [], revision: state.revision + 1 }));
  },
}));
