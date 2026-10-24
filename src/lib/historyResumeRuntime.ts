import { resolveTerminalRuntimeEnvironment, terminalRuntimeWslDistro } from "./terminalRuntimeEnvironment";
import type { ProjectEnvironmentType, TerminalSession } from "./types";

const inFlightHistoryResumes = new Set<string>();
const supportedSources = new Set(["claude", "codex", "grok", "pi"]);

/** Shared by list, detail and project-selection actions, including separate mounted history views. */
export function acquireHistoryResume(key: string): (() => void) | null {
  if (!key.trim() || inFlightHistoryResumes.has(key)) return null;
  inFlightHistoryResumes.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightHistoryResumes.delete(key);
  };
}

export interface HistoryResumeTarget {
  source: string;
  sessionId: string;
  cwd?: string;
  environmentType?: string;
  sshHostId?: string;
  sourceInstanceId?: string;
  wslDistro?: string;
  configRoot?: string;
}

function cwdIdentity(cwd?: string): { path: string; distro?: string } | undefined {
  if (!cwd?.trim()) return undefined;
  const path = cwd.trim().replace(/\\/g, "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
  const wsl = path.match(/^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(\/.*)?$/i);
  if (wsl) return { path: wsl[2]?.replace(/\/+$/, "") || "/", distro: wsl[1].toLowerCase() };
  const normalized = path.replace(/\/+$/, "") || "/";
  return { path: /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized };
}

function matchesLiveIdentity(session: TerminalSession, source: string, sessionId: string, now: number): boolean {
  const agent = session.runtimeAgent;
  if (agent) {
    if (agent.tool.trim().toLowerCase() !== source) return false;
    // Current process identity wins over stale launch/Hook fields or an older pending resume.
    const currentId = agent.cliSessionId?.trim() || session.cliSessionId?.trim();
    if (currentId) return currentId === sessionId;
  }
  const pending = session.pendingConversationResume;
  return Boolean(pending && pending.expiresAtMs >= now
    && pending.tool.trim().toLowerCase() === source && pending.sessionId.trim() === sessionId);
}

/** Reuse only a running PTY with exact live/pending identity in the same execution environment. */
export function findRunningHistoryResumeTerminal(
  sessions: readonly TerminalSession[],
  statuses: Readonly<Record<string, string | undefined>>,
  target: HistoryResumeTarget,
): TerminalSession | undefined {
  const source = target.source.trim().toLowerCase();
  const sessionId = target.sessionId.trim();
  if (!supportedSources.has(source) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(sessionId)) return undefined;
  if (target.environmentType && !["local", "wsl", "ssh"].includes(target.environmentType)) return undefined;
  const targetCwd = cwdIdentity(target.cwd);
  const targetDistro = (target.wslDistro?.trim() || targetCwd?.distro)?.toLowerCase();
  const environment = resolveTerminalRuntimeEnvironment({
    environmentType: target.environmentType as ProjectEnvironmentType | undefined,
    sshHostId: target.sshHostId, cwd: target.cwd,
    envVars: targetDistro ? { WSL_DISTRO_NAME: targetDistro } : undefined,
  });
  if (environment === "ssh" && (!target.sshHostId?.trim() || !target.sourceInstanceId?.trim())) return undefined;
  if (environment !== "ssh" && !targetCwd) return undefined;
  const now = Date.now();
  return sessions.find(session => {
    if ((session.kind ?? "pty") !== "pty" || statuses[session.id] !== "running"
      || !matchesLiveIdentity(session, source, sessionId, now)) return false;
    if (target.configRoot !== undefined) {
      const key = source === "codex" ? "CODEX_HOME" : source === "claude" ? "CLAUDE_CONFIG_DIR" : undefined;
      const actual = key ? cwdIdentity(session.envVars?.[key]) : undefined;
      const expected = cwdIdentity(target.configRoot);
      if (!actual || !expected || actual.path !== expected.path || (actual.distro ?? null) !== (expected.distro ?? null)) return false;
    }
    const sessionEnvironment = resolveTerminalRuntimeEnvironment(session);
    if (sessionEnvironment !== environment) return false;
    if (environment === "ssh") {
      return session.connectionState !== "disconnected" && session.connectionState !== "failed"
        && session.sshHostId?.trim() === target.sshHostId!.trim()
        && session.remoteHistorySourceInstanceId?.trim() === target.sourceInstanceId!.trim();
    }
    const sessionCwd = cwdIdentity(session.cwd);
    if (!sessionCwd || sessionCwd.path !== targetCwd!.path) return false;
    if (environment === "wsl") {
      const sessionDistro = (terminalRuntimeWslDistro(session) || sessionCwd.distro)?.toLowerCase();
      if ((sessionDistro ?? null) !== (targetDistro ?? null)) return false;
    }
    return true;
  });
}
