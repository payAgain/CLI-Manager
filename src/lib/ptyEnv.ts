export const SHELL_RUNTIME_MONITORING_ENV = "CLI_MANAGER_SHELL_RUNTIME_MONITORING";

const DEFAULT_ZSH_TERM = "xterm-256color";
const DEFAULT_ZSH_COLORTERM = "truecolor";

type ShellKey =
  | "powershell"
  | "cmd"
  | "pwsh"
  | "wsl"
  | "gitbash"
  | "bash"
  | "zsh"
  | "fish"
  | "sh";

type OsPlatform = "windows" | "macos" | "linux" | "unknown";

interface BuildPtyEnvVarsOptions {
  os: OsPlatform;
  shellRuntimeMonitoringEnabled: boolean;
}

function endsWithExe(raw: string, exeName: string): boolean {
  return raw.endsWith(`\\${exeName}`) || raw.endsWith(`/${exeName}`);
}

function isGitBashPath(raw: string): boolean {
  return (
    endsWithExe(raw, "git-bash.exe") ||
    raw.endsWith("/git/bin/bash.exe") ||
    raw.endsWith("\\git\\bin\\bash.exe") ||
    raw.endsWith("/git/usr/bin/bash.exe") ||
    raw.endsWith("\\git\\usr\\bin\\bash.exe")
  );
}

function normalizeShellKey(value?: string | null): ShellKey | undefined {
  if (!value) return undefined;
  const raw = value.trim().toLowerCase();
  if (!raw) return undefined;

  if (
    raw === "powershell" ||
    raw === "powershell.exe" ||
    raw === "windows powershell" ||
    endsWithExe(raw, "powershell.exe")
  ) {
    return "powershell";
  }
  if (raw === "cmd" || raw === "cmd.exe" || raw === "command prompt" || endsWithExe(raw, "cmd.exe")) {
    return "cmd";
  }
  if (raw === "pwsh" || raw === "pwsh.exe" || raw === "powershell core" || endsWithExe(raw, "pwsh.exe")) {
    return "pwsh";
  }
  if (raw === "wsl" || raw === "wsl.exe" || endsWithExe(raw, "wsl.exe")) {
    return "wsl";
  }
  if (raw === "gitbash" || raw === "git bash" || raw === "git-bash" || isGitBashPath(raw)) {
    return "gitbash";
  }
  if (raw === "bash" || raw === "bash.exe" || endsWithExe(raw, "bash.exe") || raw === "/bin/bash") {
    return "bash";
  }
  if (raw === "zsh" || raw === "/bin/zsh" || endsWithExe(raw, "zsh")) {
    return "zsh";
  }
  if (raw === "fish" || raw === "/bin/fish" || endsWithExe(raw, "fish")) {
    return "fish";
  }
  if (raw === "sh" || raw === "/bin/sh" || endsWithExe(raw, "sh")) {
    return "sh";
  }
  return undefined;
}

export function supportsShellRuntimeInjection(shell?: string | null): boolean {
  const normalized = normalizeShellKey(shell);
  return (
    normalized === "powershell" ||
    normalized === "pwsh" ||
    normalized === "cmd" ||
    normalized === "gitbash"
  );
}

export function buildPtyEnvVars(
  envVars: Record<string, string> | null | undefined,
  shell: string | null | undefined,
  options: BuildPtyEnvVarsOptions
): Record<string, string> | null {
  const next = { ...(envVars ?? {}) };
  const normalizedShell = normalizeShellKey(shell);

  if (options.os === "macos" && normalizedShell === "zsh") {
    if (!next.TERM?.trim()) {
      next.TERM = DEFAULT_ZSH_TERM;
    }
    if (!next.COLORTERM?.trim()) {
      next.COLORTERM = DEFAULT_ZSH_COLORTERM;
    }
  }

  if (options.shellRuntimeMonitoringEnabled && supportsShellRuntimeInjection(shell)) {
    next[SHELL_RUNTIME_MONITORING_ENV] = "1";
  } else {
    delete next[SHELL_RUNTIME_MONITORING_ENV];
  }
  return Object.keys(next).length > 0 ? next : null;
}

function isEmptyEnvVarsText(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 0);
  } catch {
    return false;
  }
}

function parseEnvVarsObjectText(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value.trim() || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringifyEnvVarsObject(value: Record<string, unknown>): string {
  return Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : "{}";
}

export function withPtyEnvVarsTextDefaults(
  envVarsText: string,
  shell: string | null | undefined,
  os: OsPlatform
): string {
  if (!isEmptyEnvVarsText(envVarsText)) return envVarsText;
  const defaults = buildPtyEnvVars(null, shell, {
    os,
    shellRuntimeMonitoringEnabled: false,
  });
  return defaults ? JSON.stringify(defaults, null, 2) : envVarsText;
}

export function syncPtyEnvVarsTextForShell(
  envVarsText: string,
  shell: string | null | undefined,
  os: OsPlatform
): string {
  const normalizedShell = normalizeShellKey(shell);
  if (os !== "macos" || normalizedShell === "zsh") {
    return withPtyEnvVarsTextDefaults(envVarsText, shell, os);
  }

  const parsed = parseEnvVarsObjectText(envVarsText);
  if (!parsed) return envVarsText;

  const next = { ...parsed };
  let changed = false;
  if (next.TERM === DEFAULT_ZSH_TERM) {
    delete next.TERM;
    changed = true;
  }
  if (next.COLORTERM === DEFAULT_ZSH_COLORTERM) {
    delete next.COLORTERM;
    changed = true;
  }

  return changed ? stringifyEnvVarsObject(next) : envVarsText;
}
