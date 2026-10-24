export interface HistoryResumeEnvironmentRuntime {
  environmentType?: string;
  wslDistro?: string;
}

function historyFileConfigRoot(source: string, filePath: string): string | undefined {
  const marker = source === "codex" ? "sessions" : source === "claude" ? "projects" : undefined;
  if (!marker) return undefined;
  const path = filePath.trim();
  if (!/^(?:\/|\\\\|[a-z]:[\\/])/i.test(path) || !/\.jsonl$/i.test(path)) return undefined;
  const separator = new RegExp(`[\\\\/]${marker}[\\\\/]`, /^[a-z]:[\\/]|^\\\\/i.test(path) ? "gi" : "g");
  const matches = [...path.matchAll(separator)];
  const match = matches[matches.length - 1];
  if (!match || match.index === undefined) return undefined;
  const tail = path.slice(match.index + match[0].length).split(/[\\/]/);
  if (tail.some(part => !part || part === "." || part === "..") || (source === "claude" && tail.length < 2)) return undefined;
  let root = path.slice(0, match.index);
  if (!root) root = path[0];
  if (/^[a-z]:$/i.test(root)) root += match[0][0];
  return root;
}

function rootForWsl(root: string, distro?: string): string {
  const path = root.replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
  const unc = path.match(/^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(\/.*)?$/i);
  if (unc) {
    if (!distro?.trim() || unc[1].toLowerCase() !== distro.trim().toLowerCase()) {
      throw new Error("history_resume_wsl_distro_mismatch");
    }
    return unc[2] || "/";
  }
  if (/^[a-z]:\//i.test(path)) return `/mnt/${path[0].toLowerCase()}${path.slice(2)}`;
  if (path.startsWith("//")) throw new Error("history_resume_wsl_source_path_unsupported");
  return path;
}

function forwardWslConfigRoot(existing: string | undefined, key: string): string {
  const entries: string[] = [];
  let included = false;
  for (const entry of existing?.split(":").filter(Boolean) ?? []) {
    const [name, flags] = entry.split("/", 2);
    if (name.toUpperCase() !== key) {
      entries.push(entry);
      continue;
    }
    if (included) continue;
    included = true;
    // The value is already a Linux path. /p would translate it again; /w
    // prevents Windows -> WSL delivery. Preserve other compatible flags.
    const remaining = flags?.replace(/[pw]/gi, "");
    entries.push(remaining ? `${key}/${remaining}` : key);
  }
  if (!included) entries.push(key);
  return entries.join(":");
}

/** Locate only the selected history's source root; never read/write provider configuration. */
export function resolveHistoryResumeEnvironment(
  session: { source: string; file_path: string },
  baseEnv?: Record<string, string>,
  runtime: HistoryResumeEnvironmentRuntime = {},
): Record<string, string> | undefined {
  if (runtime.environmentType === "ssh") return baseEnv;
  const source = session.source.trim().toLowerCase();
  const root = historyFileConfigRoot(source, session.file_path);
  if (!root) return baseEnv;
  if (/[\0\r\n]/.test(root)) throw new Error("history_resume_source_path_invalid");
  const key = source === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const wsl = runtime.environmentType === "wsl";
  return {
    ...baseEnv,
    [key]: wsl ? rootForWsl(root, runtime.wslDistro) : root,
    ...(wsl ? { WSLENV: forwardWslConfigRoot(baseEnv?.WSLENV, key) } : {}),
  };
}
