import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
const directory = mkdtempSync(join(tmpdir(), 'cli-command-history-'));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));
for (const name of ['commandHistory', 'terminalCommandHistory']) {
  writeFileSync(join(directory, name + '.mjs'), ts.transpileModule(readFileSync(new URL('../src/lib/' + name + '.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText);
}
const { normalizeHistoryCommand, recentTemplateCommands } = await import(pathToFileURL(join(directory, 'commandHistory.mjs')));
const { parseTerminalCommandHistory } = await import(pathToFileURL(join(directory, 'terminalCommandHistory.mjs')));
for (const command of ['npm run dev', 'git commit -m "修复中文标题"', './custom-build --watch', 'my-tool test', 'echo "a;b"']) {
  test('preserves a confirmed command: ' + command, () => assert.equal(normalizeHistoryCommand(command), command));
}
for (const command of ['', ' npm run dev', 'echo one\necho two', 'hello\x1b[31m', 'curl --api-key example', 'export OPENAI_API_KEY=example', 'curl -H "Authorization: Bearer example"', 'git clone https://user:password@example.com/repo', 'echo ghp_' + 'a'.repeat(30), 'x'.repeat(4097)]) {
  test('omits private, multiline, or unsupported history input: ' + JSON.stringify(command).slice(0, 55), () => assert.equal(normalizeHistoryCommand(command), null));
}
test('deduplicates exact commands by recency while preserving case and filtering search', () => {
  const entries = ['npm run dev', 'git status', 'npm run dev', 'NPM run dev'].map((command, index) => ({ id: String(index), project_id: 'one', command, executed_at: String(index + 1) }));
  assert.deepEqual(recentTemplateCommands(entries).map(x => x.id), ['3', '2', '1']);
  assert.deepEqual(recentTemplateCommands(entries, 'npm', 1).map(x => x.id), ['3']);
});
test('decodes a session-bound UTF-8 command and stable execution identity', () => {
  const command = 'git commit -m "中文; emoji ✅"';
  assert.deepEqual(parseTerminalCommandHistory('session;123-4;' + Buffer.from(command).toString('base64'), 'session'), { command, eventId: 'session:123-4' });
});
test('rejects malformed, oversized, invalid UTF-8, and cross-session markers', () => {
  for (const body of ['other;1-1;ZWNobw==', 'session;1-x;ZWNobw==', 'session;1-1;!!!', 'session;1-1;/w==', 'session;1-1;' + 'a'.repeat(22001), 'session;1-1;ZWNobw==;extra']) assert.equal(parseTerminalCommandHistory(body, 'session'), null);
});

const terminalStoreSource = ts.createSourceFile('terminalStore.ts', readFileSync(new URL('../src/stores/terminalStore.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const recorderNode = terminalStoreSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'recordTerminalCommandHistory');
const recorderCode = ts.transpileModule(recorderNode.getText(terminalStoreSource).replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const resolveNode = terminalStoreSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolvePrimaryTabId');
const resolverCode = ts.transpileModule(resolveNode.getText(terminalStoreSource), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
test('history follows each PTY, including hidden Workspan, split and Worktree terminals; disabled and remote sessions are skipped', async () => {
  let enabled = true;
  const saved = [];
  const state = { activeSessionId: 'a', sessions: [{ id: 'a', projectId: 'A' }, { id: 'b', projectId: 'B', worktreeId: 'tree-B' }, { id: 'ssh', projectId: 'SSH', environmentType: 'ssh' }, { id: 'wsl', projectId: 'WSL', shell: 'wsl' }], splits: { a: { secondSessionId: 'a-right' } } };
  const recorder = new Function('useSettingsStore', 'useTerminalStore', 'useCommandHistoryStore', 'normalizeShellKey', 'logError', resolverCode + recorderCode + '; return recordTerminalCommandHistory;')(
    { getState: () => ({ commandHistoryEnabled: enabled }) },
    { getState: () => state },
    { getState: () => ({ addCommand: async (...args) => saved.push(args) }) },
    shell => shell,
    () => { throw new Error('unexpected storage failure'); },
  );
  recorder('a-right', 'git status', 'split-event');
  recorder('b', 'npm run dev', 'hidden-worktree-event');
  recorder('ssh', 'pwd', 'remote-event');
  recorder('wsl', 'pwd', 'wsl-event');
  recorder('unknown', 'pwd', 'stale-event');
  enabled = false;
  recorder('a', 'pwd', 'disabled-event');
  assert.deepEqual(saved, [['A', 'git status', 'split-event'], ['B', 'npm run dev', 'hidden-worktree-event']]);
});
