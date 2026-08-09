import type { Project } from "./types";
import { stripResumeCliArgs } from "./resumeCliArgs";

const CODEX_LIGHT_TUI_THEME_ARG = "-c theme=catppuccin-latte";
const DIRECT_CODEX_COMMAND_PATTERN = /^(\s*codex(?:\.(?:cmd|exe|ps1))?)(?=\s|$)/i;

export function isDirectCodexStartupCommand(command?: string | null): boolean {
  const trimmed = command?.trim();
  return Boolean(trimmed && DIRECT_CODEX_COMMAND_PATTERN.test(trimmed));
}

function hasCodexThemeConfigArg(command: string): boolean {
  return /(^|\s)(?:-c|--config)(?:\s+|=)["']?(?:tui\.)?theme\s*=/i.test(command);
}

export function isCodexStartupCommand(command?: string | null): boolean {
  return isDirectCodexStartupCommand(command);
}

export function normalizeDirectCodexStartupCommand(command?: string): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

export function withCodexLightTuiTheme(command?: string): string | undefined {
  const normalized = normalizeDirectCodexStartupCommand(command);
  if (!normalized || hasCodexThemeConfigArg(normalized)) return normalized;

  const match = DIRECT_CODEX_COMMAND_PATTERN.exec(normalized);
  if (!match) return normalized;

  return `${match[1]} ${CODEX_LIGHT_TUI_THEME_ARG}${normalized.slice(match[1].length)}`;
}

export function resolveProjectStartupCommand(
  project: Pick<Project, "cli_tool" | "cli_args" | "startup_cmd">,
): string | undefined {
  const startupCmd = project.startup_cmd.trim();
  if (startupCmd) return normalizeDirectCodexStartupCommand(startupCmd);

  const cliTool = project.cli_tool.trim();
  if (!cliTool) return undefined;

  const cliArgs = project.cli_args.trim();
  return cliArgs ? `${cliTool} ${cliArgs}` : cliTool;
}

// 历史会话 resume 命令继承项目启动参数：仅当项目走 cli_tool 分支且工具类型与会话来源一致时追加；
// startup_cmd 是自由文本（可能含一次性 prompt），无法安全拆参，保持不继承。
export function appendResumeCliArgs(
  baseCommand: string,
  source: "claude" | "codex" | "grok",
  project: Pick<Project, "cli_tool" | "cli_args" | "startup_cmd" | "provider_overrides" | "shell"> | null | undefined
): string {
  if (!project || project.startup_cmd.trim()) return baseCommand;
  const matchesSource =
    source === "codex"
      ? project.cli_tool.trim().toLowerCase() === "codex"
      : source === "claude"
        ? project.cli_tool.trim().toLowerCase().includes("claude")
        : project.cli_tool.trim().toLowerCase().includes("grok");
  if (!matchesSource) return baseCommand;

  const cliArgs = stripResumeCliArgs(project.cli_args);
  return cliArgs ? `${baseCommand} ${cliArgs}` : baseCommand;
}
