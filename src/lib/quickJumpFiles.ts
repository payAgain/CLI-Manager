import { invoke } from "@tauri-apps/api/core";
import type { Project, ProjectFileEntry } from "./types";
import { buildSshRemoteFileContext, releaseSshRemoteFileContext } from "./sshRemoteFiles";
import { isSameProjectFileContext, isSameProjectFileLocation } from "./terminalProject";
import { quickJumpFileContextKey } from "./quickJumpFileContext";
import { quickJumpMatchScore } from "./quickJumpTargets";
import { useFileExplorerStore, type ActiveProjectFile } from "../stores/fileExplorerStore";
import { useTerminalStore } from "../stores/terminalStore";
import { useHistoryStore } from "../stores/historyStore";

export const QUICK_JUMP_FILE_LIMIT = 40;
export const QUICK_JUMP_FILE_DEBOUNCE_MS = 180;

export interface QuickJumpFileSearchState {
  contextKey: string;
  query: string;
  files: ProjectFileEntry[];
  loading: boolean;
  error: unknown | null;
}

interface FileWorkspaceSnapshot {
  project: Project | null;
  openFiles: ActiveProjectFile[];
  editorWorkspaces: Array<{ project: Project; openFiles: ActiveProjectFile[] }>;
}

export function getQuickJumpOpenFiles(project: Project | null, state: FileWorkspaceSnapshot): ProjectFileEntry[] {
  if (!project) return [];
  const files = isSameProjectFileLocation(state.project, project)
    ? state.openFiles
    : state.editorWorkspaces.find((workspace) => isSameProjectFileLocation(workspace.project, project))?.openFiles ?? [];
  return files.slice(0, QUICK_JUMP_FILE_LIMIT).map((file) => ({
    path: file.path, name: file.name, kind: "file", sizeBytes: file.sizeBytes, modifiedMs: file.modifiedMs,
  }));
}

function normalizeFiles(entries: ProjectFileEntry[], query: string): ProjectFileEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (entry.kind !== "file" || seen.has(entry.path)) return false;
    seen.add(entry.path);
    return true;
  }).map((entry, index) => ({
    entry, index, score: quickJumpMatchScore(entry.name, entry.path, query) ?? Infinity,
  })).sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, QUICK_JUMP_FILE_LIMIT).map(({ entry }) => entry);
}

interface PendingSearch {
  project: Project;
  query: string;
  contextKey: string;
  ready: boolean;
}

/** One request in flight, with only the most recent debounced query waiting behind it. */
export function createQuickJumpFileSearch(onChange: (state: QuickJumpFileSearchState) => void) {
  let pending: PendingSearch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  const emit = (request: PendingSearch, files: ProjectFileEntry[], loading: boolean, error: unknown = null) => {
    if (pending !== request) return;
    onChange({ contextKey: request.contextKey, query: request.query, files, loading, error });
  };

  const run = async () => {
    const request = pending;
    if (inFlight || !request?.ready) return;
    inFlight = true;
    let remoteContext: Awaited<ReturnType<typeof buildSshRemoteFileContext>> | null = null;
    try {
      let entries: ProjectFileEntry[];
      if (request.project.environment_type === "ssh") {
        remoteContext = await buildSshRemoteFileContext(request.project);
        // A palette query must never release the sidebar/editor's SSH consumer.
        remoteContext.consumerId += `:quick-jump:${crypto.randomUUID()}`;
        if (pending !== request) return;
        const result = await invoke<{ entries: Array<{
          name: string; relativePath: string; kind: string; sizeBytes: number; modifiedMs?: number | null;
        }> }>("ssh_remote_file_search", {
          consumerId: remoteContext.consumerId,
          sshLaunch: remoteContext.launch,
          rootPath: remoteContext.rootPath,
          query: request.query,
          content: false,
        });
        entries = (result.entries ?? []).map((entry) => ({
          name: entry.name, path: entry.relativePath, kind: entry.kind === "directory" ? "directory" : "file",
          sizeBytes: entry.sizeBytes, modifiedMs: entry.modifiedMs,
        }));
      } else {
        entries = await invoke<ProjectFileEntry[]>("file_search", {
          rootPath: request.project.path, query: request.query,
        });
      }
      emit(request, normalizeFiles(entries, request.query), false);
    } catch (error) {
      emit(request, [], false, error);
    } finally {
      if (remoteContext) await releaseSshRemoteFileContext(remoteContext).catch(() => undefined);
      inFlight = false;
      // Finished requests stay in pending to own their results, but must not run again.
      if (pending === request) request.ready = false;
      if (pending?.ready) void run();
    }
  };

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
  };

  return {
    search(project: Project, query: string) {
      cancel();
      const trimmed = query.trim().replace(/\\/g, "/");
      if (!trimmed) return;
      const request: PendingSearch = {
        project, query: trimmed, contextKey: quickJumpFileContextKey(project), ready: false,
      };
      pending = request;
      emit(request, [], true);
      timer = setTimeout(() => {
        timer = null;
        if (pending !== request) return;
        request.ready = true;
        void run();
      }, QUICK_JUMP_FILE_DEBOUNCE_MS);
    },
    // Existing IPC calls cannot be interrupted; suppress their results and all queued work.
    cancel,
  };
}

/** Retain editor buffers and verify context after each asynchronous boundary. */
export async function openQuickJumpFile(project: Project, entry: ProjectFileEntry): Promise<boolean> {
  if (entry.kind !== "file") return false;
  await useFileExplorerStore.getState().openProject(project);
  let state = useFileExplorerStore.getState();
  if (!isSameProjectFileContext(state.project, project)) return false;
  if (project.environment_type === "ssh" && !state.remoteFileContext) {
    throw new Error("ssh_file_context_unavailable");
  }
  state.clearSearchNavigationTarget();
  await state.openFile(entry);
  state = useFileExplorerStore.getState();
  if (!isSameProjectFileContext(state.project, project)) return false;
  useHistoryStore.getState().closeHistory();
  useTerminalStore.getState().openFileEditorPane(project);
  return true;
}
