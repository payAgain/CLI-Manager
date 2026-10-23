import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, ProjectFileEntry } from "../../lib/types";
import { quickJumpFileContextKey } from "../../lib/quickJumpFileContext";
import { createQuickJumpFileSearch, getQuickJumpOpenFiles, type QuickJumpFileSearchState } from "../../lib/quickJumpFiles";
import { useFileExplorerStore } from "../../stores/fileExplorerStore";

interface QuickJumpFilesOptions {
  isOpen: boolean;
  query: string;
  project: Project | null;
  retryKey?: number;
}

interface QuickJumpFilesState {
  files: ProjectFileEntry[];
  loading: boolean;
  error: unknown | null;
}

const EMPTY_STATE: QuickJumpFilesState = { files: [], loading: false, error: null };

export function useQuickJumpFiles({ isOpen, query, project, retryKey = 0 }: QuickJumpFilesOptions): QuickJumpFilesState {
  const [state, setState] = useState<QuickJumpFileSearchState | null>(null);
  const search = useMemo(() => createQuickJumpFileSearch(setState), []);
  const projectRef = useRef(project);
  projectRef.current = project;
  const contextKey = quickJumpFileContextKey(project);
  const normalizedQuery = query.trim().replace(/\\/g, "/");
  const editorProject = useFileExplorerStore((snapshot) => snapshot.project);
  const openFiles = useFileExplorerStore((snapshot) => snapshot.openFiles);
  const editorWorkspaces = useFileExplorerStore((snapshot) => snapshot.editorWorkspaces);
  const recentFiles = useMemo(() => getQuickJumpOpenFiles(project, {
    project: editorProject, openFiles, editorWorkspaces,
  }), [project, editorProject, openFiles, editorWorkspaces]);

  useEffect(() => {
    if (isOpen && projectRef.current && normalizedQuery) search.search(projectRef.current, normalizedQuery);
    else search.cancel();
    return search.cancel;
  }, [contextKey, isOpen, normalizedQuery, retryKey, search]);

  if (!isOpen || !project) return EMPTY_STATE;
  if (!normalizedQuery) return { files: recentFiles, loading: false, error: null };
  // Hide old rows synchronously, before the effect for a new workspace/query runs.
  if (state?.contextKey !== contextKey || state.query !== normalizedQuery) {
    return { files: [], loading: true, error: null };
  }
  return { files: state.files, loading: state.loading, error: state.error };
}
