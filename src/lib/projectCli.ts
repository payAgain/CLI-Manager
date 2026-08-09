import type { Project } from "./types";

const UNCONFIGURED_CLI_TOOL_VALUES = new Set(["none", "未选择", "未選擇"]);

export function hasConfiguredCliTool(project: Pick<Project, "cli_tool">): boolean {
  const cliTool = project.cli_tool.trim().toLowerCase();
  return cliTool.length > 0 && !UNCONFIGURED_CLI_TOOL_VALUES.has(cliTool);
}
