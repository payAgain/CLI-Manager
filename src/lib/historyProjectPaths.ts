import type { Project } from "./types";

export function resolveHistoryProjectPath(project: Project | null | undefined): string {
  if (!project) return "";
  return (project.environment_type === "ssh" ? project.remote_path : project.path).trim();
}
