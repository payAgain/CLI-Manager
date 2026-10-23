import type { ProjectEnvironmentType, TerminalSession } from "./types";

type RuntimeContext = Pick<TerminalSession, "environmentType" | "sshHostId" | "shell" | "cwd" | "startupCmd" | "envVars">;

function isWslCommand(command?: string | null): boolean {
  return /^(?:"(?:[^"]*[\\/])?wsl(?:\.exe)?"|'(?:[^']*[\\/])?wsl(?:\.exe)?'|(?:[^\s"']*[\\/])?wsl(?:\.exe)?)(?:\s|$)/i.test(command?.trim() ?? "");
}

export function terminalRuntimeWslDistro(context: RuntimeContext): string | null {
  const cwd = context.cwd?.replace(/\\/g, "/");
  const unc = cwd?.match(/^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)/i)?.[1];
  const command = [context.shell, context.startupCmd].find(isWslCommand);
  const distro = command?.match(/(?:^|\s)(?:-d|--distribution)(?:\s+|=)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  return unc ?? context.envVars?.WSL_DISTRO_NAME ?? distro?.[1] ?? distro?.[2] ?? distro?.[3] ?? null;
}

/** A local checkout may run WSL. Runtime evidence must not rewrite its workspace owner. */
export function resolveTerminalRuntimeEnvironment(
  context: RuntimeContext, fallback: ProjectEnvironmentType = "local",
): ProjectEnvironmentType {
  if (context.environmentType === "ssh" || context.sshHostId) return "ssh";
  if (context.environmentType === "wsl" || terminalRuntimeWslDistro(context)
    || isWslCommand(context.shell) || isWslCommand(context.startupCmd)) return "wsl";
  return context.environmentType ?? fallback;
}
