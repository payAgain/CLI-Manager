// Pure shell path helpers: quoting and joining paths per shell/OS. Depends only
// on the pure shell-key normalizers in ./shell, not on any xterm runtime.

import { normalizeShellForOs, normalizeShellKey, type OsPlatform, type ShellKey } from "./shell";

export const normalizeShellForKnownOs = (
  shell: string | null | undefined,
  os: OsPlatform,
): ShellKey | undefined => (
  os === "unknown" ? normalizeShellKey(shell) : normalizeShellForOs(shell, os)
);

export const quoteShellPath = (path: string, shell: string | null | undefined) => {
  const normalized = normalizeShellKey(shell);
  if (normalized === "cmd") return `"${path.replace(/"/g, "\"\"")}"`;
  if (normalized === "powershell" || normalized === "pwsh") return `'${path.replace(/'/g, "''")}'`;
  return `'${path.replace(/'/g, "'\\''")}'`;
};

export const formatShellPathList = (paths: string[], shell: string | null | undefined) => (
  paths.filter(Boolean).map((path) => quoteShellPath(path, shell)).join(" ")
);

export const joinLocalPath = (rootPath: string, relativePath: string) => {
  const normalizedRelativePath = relativePath.replace(/^[/\\]+/u, "");
  if (/[\\/]/u.test(rootPath) && rootPath.includes("\\")) {
    return `${rootPath.replace(/[\\/]+$/u, "")}\\${normalizedRelativePath.replace(/\//g, "\\")}`;
  }
  return `${rootPath.replace(/\/+$/u, "")}/${normalizedRelativePath.replace(/\\/g, "/")}`;
};
