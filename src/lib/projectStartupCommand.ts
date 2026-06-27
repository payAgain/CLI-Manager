import type { Project } from "./types";
import { getCodexProviderOverride, isExactCodexProject } from "./providerSwitching";

const CODEX_NO_ALT_SCREEN_ARG = "--no-alt-screen";
const CODEX_PROFILE_ARG = "--profile";
const CODEX_LIGHT_TUI_THEME_ARG = "-c theme=catppuccin-latte";
const DIRECT_CODEX_COMMAND_PATTERN = /^(\s*codex(?:\.(?:cmd|exe|ps1))?)(?=\s|$)/i;

function isCodexStartupCommand(command: string): boolean {
  return /\bcodex(?:\.(?:cmd|exe|ps1))?\b/i.test(command);
}

function hasNoAltScreenArg(command: string): boolean {
  return new RegExp(`(^|\\s)${CODEX_NO_ALT_SCREEN_ARG}(\\s|$)`).test(command);
}

function hasProfileArg(command: string): boolean {
  return new RegExp(`(^|\\s)${CODEX_PROFILE_ARG}(\\s|$)`).test(command);
}

function hasCodexThemeConfigArg(command: string): boolean {
  return /(^|\s)(?:-c|--config)(?:\s+|=)["']?(?:tui\.)?theme\s*=/i.test(command);
}

export function normalizeDirectCodexStartupCommand(command?: string): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  if (hasNoAltScreenArg(trimmed)) return trimmed;

  const match = DIRECT_CODEX_COMMAND_PATTERN.exec(trimmed);
  if (!match) return trimmed;

  return `${match[1]} ${CODEX_NO_ALT_SCREEN_ARG}${trimmed.slice(match[1].length)}`;
}

export function withCodexLightTuiTheme(command?: string): string | undefined {
  const normalized = normalizeDirectCodexStartupCommand(command);
  if (!normalized || hasCodexThemeConfigArg(normalized)) return normalized;

  const match = DIRECT_CODEX_COMMAND_PATTERN.exec(normalized);
  if (!match) return normalized;

  return `${match[1]} ${CODEX_LIGHT_TUI_THEME_ARG}${normalized.slice(match[1].length)}`;
}

export function resolveProjectStartupCommand(
  project: Pick<Project, "cli_tool" | "startup_cmd" | "provider_overrides">,
  options: { includeCodexProviderProfile?: boolean } = {}
): string | undefined {
  const startupCmd = project.startup_cmd.trim();
  if (startupCmd) return normalizeDirectCodexStartupCommand(startupCmd);

  const cliTool = project.cli_tool.trim();
  if (!cliTool) return undefined;

  let command = cliTool;
  if (options.includeCodexProviderProfile !== false && isExactCodexProject(project)) {
    const override = getCodexProviderOverride(project);
    if (override && !hasProfileArg(command)) {
      command = `${command} ${CODEX_PROFILE_ARG} ${override.profileName}`;
    }
  }
  if (isCodexStartupCommand(command) && !hasNoAltScreenArg(command)) {
    return `${command} ${CODEX_NO_ALT_SCREEN_ARG}`;
  }

  return command;
}
