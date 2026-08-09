import type { Project } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseProjectEnvVars(project: Pick<Project, "env_vars">): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(project.env_vars || "{}");
    if (!isRecord(parsed)) return undefined;
    const entries = Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string");
    if (entries.length > 0) return Object.fromEntries(entries);
  } catch {
    // Ignore invalid env JSON and let terminal start without project env overrides.
  }
  return undefined;
}
