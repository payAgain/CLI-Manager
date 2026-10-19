import type { CreateProjectInput, Project, WorktreeRecord } from "./types";

function directoryPathKey(path: string): string {
  const normalized = path.replace(/\\/g, "/")
    .replace(/^\/\/\?\/UNC\//i, "//")
    .replace(/^\/\/\?\//, "")
    .replace(/\/+$/, "") || "/";
  const wsl = /^\/\/wsl(?:\.localhost|\$)\/([^/]+)(.*)$/i.exec(normalized);
  if (wsl) return `wsl://${wsl[1].toLowerCase()}${wsl[2]}`;
  return /^[a-z]:/i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function projectDirectoryDropGroup(
  treeKey: string | null,
  projects: Project[],
  worktrees: WorktreeRecord[],
): string | null {
  if (treeKey?.startsWith("g:")) return treeKey.slice(2);
  const projectId = treeKey?.startsWith("p:")
    ? treeKey.slice(2)
    : treeKey?.startsWith("wt:")
      ? worktrees.find((worktree) => worktree.id === treeKey.slice(3))?.project_id
      : null;
  return projects.find((project) => project.id === projectId)?.group_id ?? null;
}

interface DirectoryImportDependencies {
  getProjects: () => Project[];
  getPathKind: (path: string) => Promise<string>;
  createProject: (input: CreateProjectInput) => Promise<Project>;
}

export interface ProjectDirectoryImportResult {
  created: Project[];
  existing: Project[];
  invalid: string[];
  failed: { path: string; error: unknown }[];
}

export async function importProjectDirectories(
  paths: readonly string[],
  groupId: string | null,
  dependencies: DirectoryImportDependencies,
): Promise<ProjectDirectoryImportResult> {
  const result: ProjectDirectoryImportResult = { created: [], existing: [], invalid: [], failed: [] };
  const seen = new Set<string>();
  for (const path of paths) {
    if (!path) {
      result.invalid.push(path);
      continue;
    }
    const key = directoryPathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (await dependencies.getPathKind(path) !== "directory") {
        result.invalid.push(path);
        continue;
      }
      const existing = dependencies.getProjects().find((project) => (
        project.environment_type !== "ssh" && directoryPathKey(project.path) === key
      ));
      if (existing) {
        result.existing.push(existing);
        continue;
      }
      const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
      result.created.push(await dependencies.createProject({
        name: normalized.split("/").filter(Boolean).pop() || path,
        path,
        group_id: groupId,
        environment_type: /^\/\/wsl(?:\.localhost|\$)\//i.test(normalized) ? "wsl" : "local",
      }));
    } catch (error) {
      result.failed.push({ path, error });
    }
  }
  return result;
}
