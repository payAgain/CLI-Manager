export type AgentPermissionMode = "manual" | "yolo";

// Orca uses a separate bypass recipe for each CLI; there is no universal --yolo flag.
// Reference: stablyai/orca, src/shared/tui-agent-permissions.ts.
export const AGENT_YOLO_ARGS: Readonly<Record<string, string>> = {
  claude: "--dangerously-skip-permissions",
  codex: "--dangerously-bypass-approvals-and-sandbox",
  kimi: "--yolo",
  grok: "--permission-mode bypassPermissions",
  qwen: "--approval-mode yolo",
  gemini: "--yolo",
  copilot: "--yolo",
  cline: "--auto-approve true",
  amp: "--dangerously-allow-all",
  aider: "--yes-always",
  crush: "--yolo",
};

const PERMISSION_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  claude: ["--dangerously-skip-permissions", "--permission-mode"],
  codex: ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto", "--auto-review", "--ask-for-approval", "-a", "--sandbox", "-s", "--profile", "-p"],
  kimi: ["--yolo", "-y", "--afk"],
  grok: ["--permission-mode", "--yolo"],
  qwen: ["--approval-mode", "--yolo", "-y"],
  gemini: ["--approval-mode", "--yolo", "-y"],
  copilot: ["--yolo", "--allow-all", "--allow-all-tools", "--allow-tool", "--deny-tool", "--allow-all-paths", "--allow-all-urls"],
  cline: ["--auto-approve", "--yolo", "-y"],
  amp: ["--dangerously-allow-all"],
  aider: ["--yes-always", "--no-yes-always"],
  crush: ["--yolo", "-y"],
};

interface CommandToken { value: string; end: number }

/** Only tokenize literal, single invocations. Shell scripts and substitutions stay user-owned. */
function tokenizeCommand(command: string): CommandToken[] | null {
  const tokens: CommandToken[] = [];
  let index = /^\s*&\s+/.exec(command)?.[0].length ?? 0; // PowerShell quoted executable.
  while (index < command.length) {
    while (/[ \t]/.test(command[index] ?? "")) index += 1;
    if (index >= command.length) break;
    let quote = "", value = "";
    while (index < command.length) {
      const char = command[index];
      if (char === "$" || char === "`" || /[\r\n\0]/.test(char)) return null;
      if (!quote && /[|;&<>()#]/.test(char)) return null;
      if (!quote && /[ \t]/.test(char)) break;
      if (char === "\\" && index + 1 < command.length
        && (command[index + 1] === quote || (!quote && /[ \t"']/.test(command[index + 1])))) {
        value += command[++index];
      } else if (char === quote) {
        quote = "";
      } else if (!quote && (char === "'" || char === '"')) {
        quote = char;
      } else {
        value += char;
      }
      index += 1;
    }
    if (quote) return null;
    tokens.push({ value, end: index });
  }
  return tokens;
}

function executableName(value: string): string {
  return value.split(/[\\/]/).pop()!.replace(/\.(?:exe|cmd|ps1)$/i, "").toLowerCase();
}

function skipEnvironment(tokens: CommandToken[], start: number): number {
  let index = start;
  if (tokens[index]?.value === "env") index += 1;
  while (/^[A-Za-z_][A-Za-z_0-9]*=/.test(tokens[index]?.value ?? "")) index += 1;
  return index;
}

export function normalizeAgentPermissionMode(value: unknown): AgentPermissionMode {
  if (value == null) return "yolo";
  return value === "yolo" ? "yolo" : "manual";
}

/** Apply defaults at launch time, before local/WSL/SSH transport wraps the command. */
export function applyAgentLaunchPermissions(command: string | undefined, mode: AgentPermissionMode): string | undefined {
  if (!command || mode !== "yolo") return command;
  const tokens = tokenizeCommand(command);
  if (!tokens?.length) return command;
  let index = skipEnvironment(tokens, 0);
  if (executableName(tokens[index]?.value ?? "") === "wsl") {
    index += 1;
    while (tokens[index]?.value.startsWith("-")) {
      const option = tokens[index++].value;
      if (option === "--" || option === "--exec" || option === "-e") break;
      if (["--distribution", "-d", "--user", "-u", "--cd"].includes(option)) index += 1;
      else return command;
    }
    index = skipEnvironment(tokens, index);
  }
  const executable = tokens[index];
  if (!executable) return command;
  const tool = executableName(executable.value);
  if (!Object.prototype.hasOwnProperty.call(AGENT_YOLO_ARGS, tool)) return command;
  const bypass = AGENT_YOLO_ARGS[tool];
  if (!bypass) return command;

  const args = tokens.slice(index + 1);
  const endOfOptions = args.findIndex(token => token.value === "--");
  const options = endOfOptions < 0 ? args : args.slice(0, endOfOptions);
  // Utility commands do not start an interactive Agent.
  if (["auth", "login", "logout", "mcp", "update", "upgrade", "install", "uninstall", "config", "completion", "completions", "app-server", "exec", "serve"].includes(args[0]?.value)) return command;
  for (let n = 0; n < options.length; n += 1) {
    const value = options[n].value;
    const option = value.split("=", 1)[0];
    if (["--help", "-h", "--version", "-V", ...PERMISSION_OPTIONS[tool]].includes(option)) return command;
    if (tool === "codex" && (option === "-c" || option === "--config")) {
      const config = value.includes("=") ? value.slice(value.indexOf("=") + 1) : options[++n]?.value ?? "";
      if (/^(?:approval_policy|sandbox_mode|permissions\.|profile\s*=)/.test(config)) return command;
    }
  }
  return `${command.slice(0, executable.end)} ${bypass}${command.slice(executable.end)}`;
}
