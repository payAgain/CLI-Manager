import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// 执行真实 Hook/组件回调，模拟 React 的持久槽位、依赖比较及 effect 清理；不启动桌面服务。
function harness(file, name, dependencies = {}) {
  const slots = [], effects = [];
  let cursor = 0, dirty = false, props, output;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const memo = (factory, deps) => {
    const index = cursor++;
    if (!slots[index] || !same(slots[index].deps, deps)) slots[index] = { value: factory(), deps };
    return slots[index].value;
  };
  const effect = (callback, deps) => {
    const index = cursor++;
    const previous = slots[index];
    if (previous && same(previous.deps, deps)) return;
    slots[index] = { deps, cleanup: previous?.cleanup };
    effects.push(() => {
      slots[index].cleanup?.();
      slots[index].cleanup = callback();
    });
  };
  const sourceText = readFileSync(new URL(file, import.meta.url), "utf8");
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText()).join("\n");
  const compiled = ts.transpileModule(`${body}\nexports.testTarget = ${name};`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: "createElement" },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, {
    exports,
    createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
    useState: initial => {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: typeof initial === "function" ? initial() : initial };
      const slot = slots[index];
      slot.set ??= next => {
        const value = typeof next === "function" ? next(slot.value) : next;
        if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; }
      };
      return [slot.value, slot.set];
    },
    useRef: initial => {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect: effect,
    useLayoutEffect: effect,
    ...dependencies,
  });
  return {
    get output() { return output; },
    get retainedAnswerChars() {
      return slots.reduce((total, slot) => total + (Array.isArray(slot.value)
        ? slot.value.reduce((sum, item) => sum + (typeof item?.content === "string" ? item.content.length : 0), 0)
        : 0), 0);
    },
    render(nextProps = props) {
      props = nextProps;
      for (let pass = 0; pass < 30; pass += 1) {
        cursor = 0;
        dirty = false;
        output = exports.testTarget(props);
        while (effects.length) effects.shift()();
        if (!dirty) return output;
      }
      throw new Error("unbounded render loop");
    },
    unmount() { for (const slot of slots) slot.cleanup?.(); },
  };
}

function find(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type || node.type?.name === type) return node;
  for (const child of node.props?.children ?? []) {
    const result = find(child, type);
    if (result) return result;
  }
  return null;
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const answer = content => ({ messages: [{ role: 'assistant', content }] });

function fixture({ props = {}, setup, dependencies = {} } = {}) {
  const requests = [], closes = [], listeners = new Map();
  const state = { sessions: [{ id: 'view', cliSessionId: 'a', cliTool: 'codex', cwd: '/project' }], tabStatuses: {} };
  const projects = { projects: [] }, worktrees = { worktrees: [] };
  const base = { sessionId: 'view', open: true, isVisible: true, terminalTheme: {}, onClose() {}, ...props };
  state.sessions[0].id = base.sessionId;
  setup?.({ state, projects, worktrees });
  const events = {
    addEventListener(name, callback) { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
  };
  const document = { ...events, visibilityState: 'visible', focused: true, hasFocus() { return this.focused; } };
  const window = { ...events, setTimeout };
  const h = harness('../src/components/terminal/TerminalMarkdownPreview.tsx', 'TerminalMarkdownPreview', {
    document, window, crypto: { randomUUID },
    useI18n: () => ({ language: 'en-US', t: key => key }),
    isLightTerminalTheme: () => false,
    runtimeAgentTool: () => undefined,
    useTerminalStore: selector => selector(state),
    useProjectStore: selector => selector(projects),
    useWorktreeStore: selector => selector(worktrees),
    resolveCliToolHistorySourceId: value => value || null,
    resolveTerminalProjectPath: (cwd, path) => cwd || path,
    fetchLatestProjectSessionDetail: (...args) => new Promise(resolve => requests.push({ args, resolve })),
    invoke: (command, args) => { closes.push({ command, args }); return Promise.resolve(); },
    FileText: 'Icon', RefreshCw: 'Icon', X: 'Icon', SessionTranscriptContent: 'Transcript',
    ...dependencies,
  });
  h.render(base);
  return { h, base, state, projects, worktrees, requests, closes, document,
    emit(name) { for (const callback of listeners.get(name) ?? []) callback(); h.render(); } };
}

const remoteSetup = ({ state, projects }) => {
  state.sessions[0].projectId = 'remote';
  projects.projects = [{ id: 'remote', environment_type: 'ssh', remote_path: '/remote', ssh_host_id: 'host', cli_tool: 'codex' }];
};
const context = (consumerId = 'shared') => ({ consumerId, hostId: 'host', launch: { projectId: 'remote' } });

test('closed previews never read full transcripts when hooks complete', () => {
  const f = fixture({ props: { open: false } });
  for (const hook of ['running', 'done', 'failed']) {
    f.state.tabStatuses.view = { hook, hookUpdatedAt: Date.now() };
    f.h.render();
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.h.retainedAnswerChars, 0);
  assert.equal(f.h.output, null);
  f.h.unmount();
});

test('closing releases large answers; reopening reloads while preserving the answer selection', async () => {
  const f = fixture();
  const detail = { messages: [{ role: 'assistant', content: 'a'.repeat(1_000_000) }, { role: 'assistant', content: 'last' }] };
  f.requests[0].resolve(detail); await settle(); f.h.render();
  find(f.h.output, 'MarkdownPreviewAnswerSelect').props.onSelect(0); f.h.render();
  assert.ok(f.h.retainedAnswerChars >= 1_000_000);
  f.h.render({ ...f.base, open: false });
  assert.equal(f.h.retainedAnswerChars, 0);
  f.h.render(f.base);
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(detail); await settle(); f.h.render();
  assert.equal(find(f.h.output, 'Transcript').props.content.length, 1_000_000);
  f.h.unmount();
});

test('opening in an already hidden window never starts a transcript request', () => {
  const f = fixture({ props: { open: false } });
  f.document.focused = false;
  f.h.render({ ...f.base, open: true });
  assert.equal(f.requests.length, 0);
  f.h.unmount();
});

test('closing during a load discards the late answer', async () => {
  const f = fixture();
  f.h.render({ ...f.base, open: false });
  f.requests[0].resolve(answer('late'.repeat(100_000))); await settle(); f.h.render();
  assert.equal(f.h.retainedAnswerChars, 0);
  f.h.unmount();
});

test('hidden split/Workspan panes stop loading and refresh the same hook trigger when visible again', async () => {
  const f = fixture({ props: { isVisible: false } });
  assert.equal(f.requests.length, 0);
  f.h.render({ ...f.base, isVisible: true });
  f.requests[0].resolve(answer('before')); await settle(); f.h.render();
  f.h.render(f.base);
  f.state.tabStatuses.view = { hook: 'done', hookUpdatedAt: 1 };
  f.h.render();
  assert.equal(f.requests.length, 1);
  f.h.render({ ...f.base, isVisible: true });
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve(answer('after')); await settle(); f.h.render();
  assert.equal(find(f.h.output, 'Transcript').props.content, 'after');
  f.h.unmount();
});

test('window blur/tray and document hiding invalidate requests and refresh on foreground return', async () => {
  for (const event of ['blur', 'visibilitychange']) {
    const f = fixture();
    if (event === 'blur') f.document.focused = false;
    else f.document.visibilityState = 'hidden';
    f.emit(event);
    f.requests[0].resolve(answer('stale')); await settle(); f.h.render();
    assert.equal(f.h.retainedAnswerChars, 0);
    f.state.tabStatuses.view = { hook: 'done', hookUpdatedAt: 2 }; f.h.render();
    assert.equal(f.requests.length, 1);
    f.document.focused = true; f.document.visibilityState = 'visible'; f.emit('focus');
    assert.equal(f.requests.length, 2);
    f.requests[1].resolve(answer('foreground')); await settle(); f.h.render();
    assert.equal(find(f.h.output, 'Transcript').props.content, 'foreground');
    f.h.unmount();
  }
});

test('a newly bound CLI session cannot inherit answers or late results', async () => {
  const f = fixture();
  f.state.sessions[0] = { ...f.state.sessions[0], cliSessionId: 'b' }; f.h.render();
  f.requests[1].resolve(answer('session b')); await settle(); f.h.render();
  f.requests[0].resolve(answer('session a')); await settle(); f.h.render();
  assert.equal(find(f.h.output, 'Transcript').props.content, 'session b');
  f.h.unmount();
});

test('Agent exit/unbinding releases its answers without falling back to another project session', async () => {
  const f = fixture();
  f.requests[0].resolve(answer('old agent')); await settle(); f.h.render();
  f.state.sessions[0] = { ...f.state.sessions[0], cliSessionId: null }; f.h.render();
  assert.equal(f.requests.length, 1);
  assert.equal(f.h.retainedAnswerChars, 0);
  assert.equal(find(f.h.output, 'Transcript'), null);
  f.h.unmount();
});

test('Worktree and WSL paths keep their exact history scope across a switch', async () => {
  const f = fixture({ setup({ state, worktrees }) {
    state.sessions[0].environmentType = 'wsl';
    state.sessions[0].worktreeId = 'one';
    worktrees.worktrees = [{ id: 'one', path: '/worktrees/one' }, { id: 'two', path: '/worktrees/two' }];
  } });
  assert.equal(f.requests[0].args[0], '/worktrees/one');
  f.state.sessions[0] = { ...f.state.sessions[0], worktreeId: 'two' }; f.h.render();
  assert.equal(f.requests[1].args[0], '/worktrees/two');
  f.requests[1].resolve(answer('two')); await settle(); f.h.render();
  f.requests[0].resolve(answer('one')); await settle(); f.h.render();
  assert.equal(find(f.h.output, 'Transcript').props.content, 'two');
  f.h.unmount();
});

test('closing during SSH context creation closes the late consumer without reading history', async () => {
  const builds = [], reads = [];
  const f = fixture({ setup: remoteSetup, dependencies: {
    buildSshAgentHistoryContext: () => new Promise(resolve => builds.push(resolve)),
    fetchRemoteLatestProjectSessionDetail: async ctx => { reads.push(ctx); return { context: ctx, result: answer('remote') }; },
  } });
  f.h.render({ ...f.base, open: false });
  builds[0](context()); await settle(); f.h.render();
  assert.equal(reads.length, 0);
  assert.match(f.closes.at(-1).args.consumerId, /^shared:preview:view:/);
  assert.equal(f.h.retainedAnswerChars, 0);
  f.h.unmount();
});

test('a stale SSH context cannot replace the newly bound consumer', async () => {
  const builds = [], reads = [];
  const f = fixture({ setup: remoteSetup, dependencies: {
    buildSshAgentHistoryContext: () => new Promise(resolve => builds.push(resolve)),
    fetchRemoteLatestProjectSessionDetail: async ctx => { reads.push(ctx.consumerId); return { context: ctx, result: answer('new') }; },
  } });
  f.state.sessions[0] = { ...f.state.sessions[0], cliSessionId: 'new' }; f.h.render();
  builds[0](context('old')); await settle(); f.h.render();
  assert.equal(reads.length, 0);
  builds[1](context('new')); await settle(); f.h.render();
  assert.equal(reads.length, 1);
  assert.match(reads[0], /^new:preview:view:/);
  assert.equal(find(f.h.output, 'Transcript').props.content, 'new');
  f.h.unmount();
  assert.equal(f.closes.at(-1).args.consumerId, reads[0]);
});

test('same-project SSH split panes own separate consumers and do not close each other', async () => {
  const reads = [];
  const options = { setup: remoteSetup, dependencies: {
    buildSshAgentHistoryContext: async () => context(),
    fetchRemoteLatestProjectSessionDetail: async ctx => { reads.push(ctx.consumerId); return { context: ctx, result: answer('content') }; },
  } };
  const a = fixture({ ...options, props: { sessionId: 'pane-a' } });
  const b = fixture({ ...options, props: { sessionId: 'pane-b' } });
  await settle(); a.h.render(); b.h.render();
  assert.equal(reads.length, 2);
  assert.notEqual(reads[0], reads[1]);
  a.h.unmount();
  assert.equal(a.closes.at(-1).args.consumerId, reads[0]);
  assert.equal(b.closes.length, 0);
  b.h.unmount();
});

test('late SSH reads are released without closing the replacement consumer', async () => {
  const reads = [];
  const f = fixture({ setup: remoteSetup, dependencies: {
    buildSshAgentHistoryContext: async () => context(),
    fetchRemoteLatestProjectSessionDetail: ctx => new Promise(resolve => reads.push({ ctx, resolve })),
  } });
  await settle();
  f.state.sessions[0] = { ...f.state.sessions[0], cliSessionId: 'new' }; f.h.render(); await settle();
  reads[0].resolve({ context: reads[0].ctx, result: answer('stale') }); await settle(); f.h.render();
  assert.equal(f.h.retainedAnswerChars, 0);
  assert.ok(f.closes.every(item => item.args.consumerId !== reads[1].ctx.consumerId));
  reads[1].resolve({ context: reads[1].ctx, result: answer('new') }); await settle(); f.h.render();
  assert.equal(find(f.h.output, 'Transcript').props.content, 'new');
  f.h.unmount();
});
