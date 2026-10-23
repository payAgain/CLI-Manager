import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function load(path, dependencies = {}, names) {
  const source = readFileSync(new URL("../" + path, import.meta.url), "utf8");
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const statements = ast.statements.filter(node => !ts.isImportDeclaration(node)
    && (!names || ts.isFunctionDeclaration(node) && names.includes(node.name?.text)));
  const code = statements.map(node => node.getText(ast)).join("\n")
    + (names ? "\nexport { " + names.join(", ") + " };" : "");
  const output = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("exports", ...Object.keys(dependencies), output)(exports, ...Object.values(dependencies));
  return exports;
}

const workspaceBinding = load("src/lib/terminalWorkspaceBinding.ts", {
  ...load("src/lib/workspaceTerminals.ts", load("src/lib/terminalProject.ts")),
});
const { parseProjectEnvVars } = load("src/lib/projectEnv.ts");
const resumeArgs = load("src/lib/resumeCliArgs.ts");
const launchCommand = load("src/lib/projectStartupCommand.ts", resumeArgs);
const historyCommand = load("src/lib/historyResumeCommand.ts", { ...launchCommand, ...load("src/lib/cliTools.ts") });
const workspaceLaunch = load("src/lib/worktreeLaunch.ts", { ...resumeArgs, ...launchCommand, ...historyCommand, ...load("src/lib/cliTools.ts") });
const { resolveNewTerminalContext: context, resolveNewTerminalCommand: command } = load("src/lib/newTerminal.ts", { parseProjectEnvVars, ...workspaceLaunch });
const { resolveDirectCliToolCommand } = load("src/lib/cliTools.ts");
const { createAgentTerminalMetadata } = load("src/lib/agentTerminal.ts");
const project = {
  id: "project-a", name: "Workspace", path: "E:/repo", environment_type: "local",
  shell: "powershell", env_vars: '{"PROJECT_ENV":"base","PATH":"project-path"}',
  cli_tool: "codex", cli_args: "--model project-model", startup_cmd: "", remote_path: "", ssh_host_id: null, cli_config_root: "",
};

test("new blank and Agent terminals inherit the same active Worktree, shell and environment", () => {
  const session = { id: "parent", title: "Codex", cwd: "E:/worktrees/feature", projectId: project.id,
    worktreeId: "feature", shell: "pwsh", envVars: { PATH: "active-path", SESSION_ENV: "yes" }, startupCmd: "codex resume existing-id" };
  const resolved = context(session, project, { id: "feature", path: "E:/worktrees/feature" }, "cmd");
  assert.equal(resolved.projectId, project.id);
  assert.equal(resolved.cwd, session.cwd);
  assert.equal(resolved.worktreeId, "feature");
  assert.equal(resolved.shell, "pwsh");
  assert.deepEqual(resolved.envVars, { PROJECT_ENV: "base", PATH: "active-path", SESSION_ENV: "yes" });
  assert.equal(command(resolved, "codex"), "codex --model project-model");
  assert.equal(command(resolved, "claude"), "claude");
  assert.ok(!command(resolved, "codex").includes("existing-id"));
});

test("an empty scoped workspace discovers and launches Agents in its configured WSL shell", () => {
  const resolved = context(null, { ...project, shell: "wsl:Ubuntu", path: "//wsl.localhost/Ubuntu/home/me/repo" }, null, "pwsh");
  assert.equal(resolved.shell, "wsl:Ubuntu");
  assert.equal(resolved.cwd, "//wsl.localhost/Ubuntu/home/me/repo");
  assert.equal(resolved.projectId, project.id);
  assert.equal(resolved.remote, false);
});

test("SSH sessions retain the host and remote directory, including standalone connections", () => {
  const remoteProject = { ...project, environment_type: "ssh", remote_path: "/srv/project", ssh_host_id: "host-a" };
  const resolved = context({ id: "ssh", title: "Remote", projectId: project.id, environmentType: "ssh",
    sshHostId: "host-a", remotePath: "/srv/project/child", cwd: "ignored-local-cwd" }, remoteProject, null, "pwsh");
  assert.equal(resolved.cwd, "/srv/project/child");
  assert.equal(resolved.sshHostId, "host-a");
  assert.equal(resolved.shell, undefined);
  assert.equal(resolved.remote, true);
  const standalone = context({ id: "ssh", title: "Host", environmentType: "ssh", sshHostId: "host-b", remotePath: "/home/user" }, null, null, "pwsh");
  assert.equal(standalone.projectId, undefined);
  assert.equal(standalone.sshHostId, "host-b");
  assert.equal(standalone.cwd, "/home/user");
});

test("file-editor contexts and an empty global workspace have usable launch directories", () => {
  assert.equal(context({ id: "editor", title: "File", kind: "file-editor", fileEditor: { projectPath: "E:/other" } }, project, null, "pwsh").cwd, "E:/other");
  const empty = context(null, null, null, "gitbash");
  assert.equal(empty.shell, "gitbash");
  assert.equal(empty.cwd, undefined);
  assert.equal(command({ ...empty, project: { ...project, startup_cmd: "custom-init && codex" } }, "codex"), "codex");
});

test("launch classification uses the selected Agent instead of the project's different default", () => {
  const { getProjectAgentTerminalMetadata } = load("src/stores/terminalStore.ts", {
    useProjectStore: { getState: () => ({ projects: [project] }) },
    resolveDirectCliToolCommand, createAgentTerminalMetadata,
  }, ["getProjectAgentTerminalMetadata"]);
  assert.deepEqual(getProjectAgentTerminalMetadata(project.id, "claude --model sonnet"), { isAgentSession: true, cliTool: "claude" });
  assert.deepEqual(getProjectAgentTerminalMetadata(undefined, "pi"), { isAgentSession: true, cliTool: "pi" });
  assert.deepEqual(getProjectAgentTerminalMetadata(project.id, ""), { isAgentSession: false, cliTool: undefined });
  assert.equal(resolveDirectCliToolCommand("echo codex"), undefined);
  assert.equal(resolveDirectCliToolCommand("codex.cmd --model x"), "codex");
});

test("SSH launch uses the selected Agent's existing Hook installation and config root", async () => {
  const remoteProject = { ...project, environment_type: "ssh", ssh_host_id: "host-a", remote_path: "/srv/project", cli_config_root: "/codex-project" };
  const host = { id: "host-a", startup_script: "" };
  const { resolveSshToolSource } = load("src/lib/sshToolIntegration.ts");
  const { applyAgentLaunchPermissions } = load("src/lib/agentLaunchPermissions.ts");
  const { resolveProjectStartupCommand } = load("src/lib/projectStartupCommand.ts");
  const integration = {
    loaded: true,
    installations: [{ host_id: host.id, status: "installed", installation_id: "install-a", remote_machine_id: "machine-a", install_path: "/agent" }],
    preferences: [{ host_id: host.id, source: "claude", configured_root: "/claude-host" }],
    integrations: [{ host_id: host.id, source: "claude", configured_root: "/claude-host", cleanup_state: "active", hook_record_json: "{}" }],
  };
  const { resolvePtyLaunch } = load("src/stores/terminalStore.ts", {
    useProjectStore: { getState: () => ({ projects: [remoteProject], worktrees: [] }) },
    useSettingsStore: { getState: () => ({ agentPermissionMode: "manual" }) },
    useSshHostStore: { getState: () => ({ loaded: true, hosts: [host] }) },
    useSshAgentIntegrationStore: { getState: () => integration },
    ...workspaceBinding,
    resolveSshToolSource, resolveDirectCliToolCommand, applyAgentLaunchPermissions, resolveProjectStartupCommand,
    parseProjectEnvVars, getCurrentTerminalColors: () => ({}),
    parseStoredSshHookReport: () => ({ status: "installed", installationId: "install-a", remoteMachineId: "machine-a" }),
    buildSshConnectionSpec: () => ({}), getSshClientInstanceId: () => "client-a", crypto: globalThis.crypto,
  }, ["resolvePtyLaunch"]);
  const result = await resolvePtyLaunch({ projectId: project.id, startupCmd: "claude", remotePath: "/srv/project/child" }, "windows");
  assert.equal(result.invokeArgs.sshLaunch.remotePath, "/srv/project/child");
  assert.equal(result.invokeArgs.sshLaunch.toolSource, "claude");
  assert.equal(result.invokeArgs.sshLaunch.agentPath, "/agent");
  assert.equal(result.invokeArgs.sshLaunch.environmentOverrides.CLAUDE_CONFIG_DIR, "/claude-host");
  assert.equal(result.invokeArgs.sshLaunch.environmentOverrides.CODEX_HOME, undefined);
  const blank = await resolvePtyLaunch({ projectId: project.id, startupCmd: "" }, "windows");
  assert.equal(blank.invokeArgs.sshLaunch.toolSource, "");
  assert.equal(blank.invokeArgs.sshLaunch.agentPath, "");
});
