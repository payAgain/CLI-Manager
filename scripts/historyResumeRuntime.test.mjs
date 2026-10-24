import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function load(relative, dependencies = {}) {
  const exports = {};
  const compiled = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function('exports', 'require', compiled)(exports, name => {
    assert.ok(dependencies[name], `unexpected production import ${name}`); return dependencies[name];
  });
  return exports;
}
const { acquireHistoryResume, findRunningHistoryResumeTerminal: find } = load('../src/lib/historyResumeRuntime.ts', {
  './terminalRuntimeEnvironment': load('../src/lib/terminalRuntimeEnvironment.ts'),
});
const target = extra => ({ source: 'codex', sessionId: 'chat-1', cwd: '/repo', environmentType: 'local', ...extra });
const terminal = extra => ({ id: 'pane', title: 'Agent', cwd: '/repo', environmentType: 'local',
  cliTool: 'codex', cliSessionId: 'chat-1', runtimeAgent: { tool: 'codex', cliSessionId: 'chat-1' }, ...extra });
const running = { pane: 'running' };

test('a synchronous shared gate prevents double starts across callers and releases independently by identity', () => {
  const release = acquireHistoryResume('codex:chat-1:local:/repo');
  assert.equal(typeof release, 'function');
  assert.equal(acquireHistoryResume('codex:chat-1:local:/repo'), null);
  const other = acquireHistoryResume('codex:chat-2:local:/repo');
  assert.equal(typeof other, 'function');
  release();
  const next = acquireHistoryResume('codex:chat-1:local:/repo');
  assert.equal(typeof next, 'function');
  release();
  assert.equal(acquireHistoryResume('codex:chat-1:local:/repo'), null, 'an old release is idempotent and cannot release a newer operation');
  next(); other();
  assert.equal(acquireHistoryResume('  '), null);
});

test('all four supported Agents focus only an exactly matching live process and conversation', () => {
  for (const source of ['claude', 'codex', 'grok', 'pi']) {
    const pane = terminal({ cliTool: source, runtimeAgent: { tool: source, cliSessionId: 'chat-1' } });
    assert.equal(find([pane], running, target({ source })), pane);
    assert.equal(find([pane], running, target({ source, sessionId: 'other' })), undefined);
    assert.equal(find([pane], running, target({ source: source === 'claude' ? 'codex' : 'claude' })), undefined);
  }
  assert.equal(find([terminal()], running, target({ source: 'gemini' })), undefined);
  assert.equal(find([terminal()], running, target({ sessionId: '--last' })), undefined);
});

test('exited, unknown-status, transcript and file tabs never substitute for a live conversation PTY', () => {
  for (const status of ['exited', 'error', undefined]) assert.equal(find([terminal()], { pane: status }, target()), undefined);
  for (const kind of ['subagent-transcript', 'file-editor', 'synced-history']) {
    assert.equal(find([terminal({ kind })], running, target()), undefined);
  }
  for (const runtimeAgent of [null, undefined]) {
    assert.equal(find([terminal({ runtimeAgent, isAgentSession: true, startupCmd: 'codex resume chat-1' })], running, target()), undefined, 'saved launch fields alone cannot prove a live Agent');
  }
});

test('an unexpired exact pending resume protects the interval before Agent process detection', () => {
  const pending = { tool: 'codex', sessionId: 'chat-1', expiresAtMs: Date.now() + 60_000 };
  for (const runtimeAgent of [null, undefined]) {
    const pane = terminal({ runtimeAgent, pendingConversationResume: pending });
    assert.equal(find([pane], running, target()), pane);
  }
  for (const pendingConversationResume of [
    { ...pending, expiresAtMs: Date.now() - 1 }, { ...pending, tool: 'claude' }, { ...pending, sessionId: 'other' },
  ]) assert.equal(find([terminal({ runtimeAgent: null, pendingConversationResume })], running, target()), undefined);
});

test('current runtime identity overrides stale Hook, launch and pending identities', () => {
  const pending = { tool: 'codex', sessionId: 'chat-1', expiresAtMs: Date.now() + 60_000 };
  const switched = terminal({ runtimeAgent: { tool: 'claude', cliSessionId: 'chat-1' }, pendingConversationResume: pending });
  assert.equal(find([switched], running, target()), undefined);
  const newer = terminal({ runtimeAgent: { tool: 'codex', cliSessionId: 'new-chat' }, pendingConversationResume: pending });
  assert.equal(find([newer], running, target()), undefined);
  assert.equal(find([newer], running, target({ sessionId: 'new-chat' })), newer);
  const manuallyStarted = terminal({ isAgentSession: false, cliTool: 'claude' });
  assert.equal(find([manuallyStarted], running, target()), manuallyStarted, 'live process evidence includes manually started Agents');
});

test('local sessions require the same cwd, preserve POSIX case and normalize Windows paths', () => {
  const pane = terminal();
  assert.equal(find([pane], running, target({ cwd: '/other' })), undefined);
  assert.equal(find([pane], running, target({ cwd: undefined })), undefined);
  assert.equal(find([terminal({ cwd: '/Repo' })], running, target()), undefined);
  assert.equal(find([pane], running, target({ cwd: '/repo/' })), pane);
  const windows = terminal({ cwd: 'C:\\Work\\Repo\\' });
  assert.equal(find([windows], running, target({ cwd: 'c:/work/repo' })), windows);
  assert.equal(find([terminal({ environmentType: 'ssh', sshHostId: 'host' })], running, target()), undefined);
});

test('WSL is separate from local cwd and each known distribution, including local workspace ownership', () => {
  const pane = terminal({ environmentType: 'local', shell: 'wsl -d Ubuntu', envVars: { WSL_DISTRO_NAME: 'Ubuntu' } });
  assert.equal(find([pane], running, target()), undefined);
  const wsl = target({ environmentType: 'wsl', wslDistro: 'Ubuntu' });
  assert.equal(find([pane], running, wsl), pane);
  assert.equal(find([pane], running, { ...wsl, wslDistro: 'Debian' }), undefined);
  assert.equal(find([pane], running, { ...wsl, wslDistro: undefined }), undefined, 'unknown distribution cannot prove it is the requested one');
  const unc = terminal({ environmentType: 'wsl', cwd: '\\\\wsl$\\Ubuntu\\repo' });
  assert.equal(find([unc], running, wsl), unc);
  assert.equal(find([unc], running, target({ cwd: '//wsl.localhost/ubuntu/repo' })), unc);
  assert.equal(find([unc], running, target({ cwd: '//wsl.localhost/Debian/repo' })), undefined);
});

test('SSH requires matching host, source instance, Agent and exact ID and tolerates later manual cwd', () => {
  const remoteTarget = target({ environmentType: 'ssh', sshHostId: 'host-a', sourceInstanceId: 'root-a' });
  const pane = terminal({ environmentType: 'ssh', sshHostId: 'host-a', remoteHistorySourceInstanceId: 'root-a',
    cwd: '/other/manual', connectionState: 'connected' });
  assert.equal(find([pane], running, remoteTarget), pane);
  for (const extra of [{ sshHostId: 'host-b' }, { sourceInstanceId: 'root-b' }, { sourceInstanceId: undefined }, { sshHostId: undefined }, { source: 'claude' }]) {
    assert.equal(find([pane], running, { ...remoteTarget, ...extra }), undefined);
  }
  for (const connectionState of ['disconnected', 'failed']) {
    assert.equal(find([{ ...pane, connectionState }], running, remoteTarget), undefined);
  }
  assert.equal(find([terminal()], running, remoteTarget), undefined);
});

test('known source roots cannot reuse another config tree or an unknown inherited root', () => {
  const known = terminal({ envVars: { CODEX_HOME: '/profiles/codex-a' } });
  assert.equal(find([known], running, target({ configRoot: '/profiles/codex-a/' })), known);
  assert.equal(find([known], running, target({ configRoot: '/profiles/codex-b' })), undefined);
  assert.equal(find([terminal()], running, target({ configRoot: '/profiles/codex-a' })), undefined);
  const claude = terminal({ envVars: { CLAUDE_CONFIG_DIR: '/profiles/claude' },
    runtimeAgent: { tool: 'claude', cliSessionId: 'chat-1' } });
  assert.equal(find([claude], running, target({ source: 'claude', configRoot: '/profiles/claude' })), claude);
  assert.equal(find([claude], running, target({ source: 'claude', configRoot: '/profiles/Claude' })), undefined);
});

test('source root matching follows native Windows and WSL path identity without crossing distributions', () => {
  const windows = terminal({ cwd: 'C:\\repo', envVars: { CODEX_HOME: 'C:\\Agent Data\\Codex' } });
  assert.equal(find([windows], running, target({ cwd: 'c:/repo', configRoot: 'c:/agent data/codex/' })), windows);
  const wsl = terminal({ environmentType: 'wsl', shell: 'wsl -d Ubuntu',
    envVars: { WSL_DISTRO_NAME: 'Ubuntu', CODEX_HOME: '/home/me/.codex' } });
  assert.equal(find([wsl], running, target({ environmentType: 'wsl', wslDistro: 'Ubuntu', configRoot: '/home/me/.codex' })), wsl);
  assert.equal(find([wsl], running, target({ environmentType: 'wsl', wslDistro: 'Debian', configRoot: '/home/me/.codex' })), undefined);
});
