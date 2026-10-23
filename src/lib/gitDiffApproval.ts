import type { Project } from "./types";

export type GitDiffApprovalStatus = "unreviewed" | "approved" | "changed" | "unverified";
export interface GitDiffApprovalRecord {
  fingerprint: string;
  approvedAt: number;
}
export type GitDiffApprovalRecords = Record<string, GitDiffApprovalRecord>;

function normalizePath(path: string, remote: boolean): string {
  const windows = !remote && (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\"));
  const value = (windows ? path.replace(/\\/g, "/") : path).replace(/\/+$/, "") || "/";
  if (remote) return value;
  return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}

/** Worktrees, nested repositories and identical remote paths on different hosts stay separate. */
export function gitDiffApprovalScope(project: Project, repositoryId: string): string {
  return JSON.stringify([
    project.environment_type,
    project.environment_type === "ssh" ? project.ssh_host_id : null,
    normalizePath(project.environment_type === "ssh" ? project.remote_path : project.path, project.environment_type === "ssh"),
    repositoryId ? normalizePath(repositoryId, project.environment_type === "ssh") : "",
  ]);
}

export function gitDiffApprovalKey(scope: string, filePath: string): string {
  return JSON.stringify([scope, filePath.replace(/^\/+/, "")]);
}

export function isGitDiffApprovalInScope(key: string, scope: string): boolean {
  try { return JSON.parse(key)?.[0] === scope; } catch { return false; }
}

/** Retain base blob/mode/path metadata and exact changed bytes with coordinates, not display context. */
export function canonicalGitDiff(content: string): string | null {
  if ((content.match(/^diff --git /gm) ?? []).length !== 1
    || /^(?:Binary files |GIT binary patch)/m.test(content)) return null;
  const parts: string[] = [];
  let oldLine = 0, newLine = 0, inHunk = false, changed = false, previousChanged = false;
  for (const line of content.split("\n")) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldLine = Number(header[1]); newLine = Number(header[2]); inHunk = true; previousChanged = false;
      continue;
    }
    if (!inHunk) { parts.push(line); continue; }
    if (line.startsWith("+")) {
      parts.push(`+${newLine++}:${line.slice(1)}`); changed = previousChanged = true;
    } else if (line.startsWith("-")) {
      parts.push(`-${oldLine++}:${line.slice(1)}`); changed = previousChanged = true;
    } else if (line.startsWith(" ")) {
      oldLine++; newLine++; previousChanged = false;
    } else if (line.startsWith("\\ No newline")) { if (previousChanged) parts.push(line); }
    else if (line !== "") return null;
  }
  return changed ? JSON.stringify(parts) : null;
}

export async function fingerprintGitDiff(content: string, contentFingerprint?: string): Promise<string | null> {
  const canonical = canonicalGitDiff(content);
  if (!canonical) return null;
  // Synthetic new-file patches need a raw-byte hash to distinguish encoding/BOM changes.
  if (!/^index [a-f0-9]+\.\.[a-f0-9]+/m.test(content) && !contentFingerprint) return null;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([canonical, contentFingerprint ?? null])));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getGitDiffApprovalStatus(
  record: GitDiffApprovalRecord | undefined,
  fingerprint: string | null | undefined,
): GitDiffApprovalStatus {
  if (!record) return "unreviewed";
  if (!fingerprint) return "unverified";
  return record.fingerprint === fingerprint ? "approved" : "changed";
}

export function normalizeGitDiffApprovals(value: unknown): GitDiffApprovalRecords {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([key, record]) => {
    if (key.length > 16_384 || !record || typeof record !== "object") return [];
    const { fingerprint, approvedAt } = record as GitDiffApprovalRecord;
    return typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint)
      && Number.isSafeInteger(approvedAt) && approvedAt > 0
      ? [[key, { fingerprint, approvedAt }] as const] : [];
  }).sort((a, b) => b[1].approvedAt - a[1].approvedAt).slice(0, 2_000));
}
