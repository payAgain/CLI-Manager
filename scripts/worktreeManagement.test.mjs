import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const source = path => readFileSync(new URL(path, import.meta.url), "utf8");
const compile = code => ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
function load(path, dependencies = {}, globals = {}) {
  const exports = {};
  new Function("exports", "require", ...Object.keys(globals), compile(source(path)))(exports, name => {
    if (name in dependencies) return dependencies[name];
    assert.equal(name, "react/jsx-runtime", `unexpected dependency ${name}`);
    return require(name);
  }, ...Object.values(globals));
  return exports;
}
const management = load("../src/lib/worktreeManagement.ts");
const { resolveWorktreeManagementTarget } = management;
const managed = () => ({ id: "wt", project_id: "repo", name: "task", branch: "wt/task", path: "/tree", status: "active" });
const project = { id: "repo", path: "/repo" };
const ast = ts.createSourceFile("TerminalTabs.tsx", source("../src/components/TerminalTabs.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function nodes(root, predicate) {
  const result = [];
  function visit(node) { if (predicate(node)) result.push(node); ts.forEachChild(node, visit); }
  visit(root);
  return result;
}
function evaluate(expression, dependencies) {
  const exports = {};
  new Function("exports", "require", ...Object.keys(dependencies), compile(`exports.value = ${expression};`))(
    exports, require, ...Object.values(dependencies),
  );
  return exports.value;
}
function variable(name) {
  const declaration = nodes(ast, node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name)[0];
  assert.ok(declaration, `production handler ${name} exists`);
  return declaration.initializer.getText(ast);
}
const tick = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

test("management requires the current managed identity and location", () => {
  const record = managed();
  assert.equal(resolveWorktreeManagementTarget(record, [record]).worktree, record);
  for (const current of [[], [{ ...record, path: "/other" }], [{ ...record, branch: "wt/other" }], [{ ...record, project_id: "other" }]]) {
    assert.equal(resolveWorktreeManagementTarget(record, current).error, "worktree_target_changed");
  }
  assert.equal(resolveWorktreeManagementTarget(record, [{ ...record, origin: "discovered" }]).error, "external_worktree_read_only");
  assert.equal(resolveWorktreeManagementTarget({ ...record, origin: "discovered" }, [record]).error, "external_worktree_read_only");
});

test("both terminal menu surfaces protect external merge while allowing reviewed removal", () => {
  const menus = nodes(ast, node => ts.isJsxElement(node)
    && ["button", "ContextMenuItem"].includes(node.openingElement.tagName.getText(ast))
    && node.children.some(child => ts.isJsxExpression(child) && /^t\("worktree\.menu\.(finish|discard)"\)$/.test(child.expression?.getText(ast) ?? "")));
  assert.equal(menus.length, 4);
  for (const external of [true, false]) {
    const record = { ...managed(), ...(external ? { origin: "discovered" } : {}) };
    for (const menu of menus) {
      const element = evaluate(menu.getText(ast), {
        activeWorktree: record, worktreeById: new Map([[record.id, record]]),
        session: { projectId: "repo", worktreeId: record.id }, projectById: new Map([["repo", project]]),
        t: key => key, ContextMenuItem: "ContextMenuItem",
      });
      const finishing = menu.getText(ast).includes('worktree.menu.finish');
      assert.equal(Boolean(element.props.disabled), external && finishing);
      if (finishing) assert.equal(element.props.title, external ? "worktree.externalManagedElsewhere" : undefined);
    }
  }
});

function terminalHandlers(current) {
  const calls = [], notices = [];
  const state = { worktrees: current };
  const dependencies = {
    useCallback: fn => fn, resolveWorktreeManagementTarget,
    useWorktreeStore: { getState: () => state }, toast: { error: message => notices.push(message) }, t: key => key,
  };
  const getManagedWorktree = evaluate(variable("getManagedWorktree"), dependencies);
  const callbacks = { ...dependencies, getManagedWorktree,
    rejectMissingWorktree: () => false,
    setFinishTarget: target => calls.push(["finish", target]),
    setDiscardTarget: target => calls.push(["discard", target]),
  };
  return { state, calls, notices, getManagedWorktree,
    finish: evaluate(variable("handlePaneFinishWorktree"), callbacks),
    discard: evaluate(variable("handlePaneDiscardWorktree"), callbacks),
  };
}

test("finish callbacks keep ownership protection while removal opens the shared review", () => {
  const record = managed();
  const h = terminalHandlers([{ ...record, origin: "discovered" }]);
  h.finish(project, record); h.discard(project, record);
  assert.deepEqual(h.calls.map(([name]) => name), ["discard"]);
  assert.deepEqual(h.notices, ["worktree.externalManagedElsewhere"]);
  h.calls.length = 0; h.state.worktrees = [record]; h.finish(project, record); h.discard(project, record);
  assert.deepEqual(h.calls.map(([name]) => name), ["finish", "discard"]);
});

test("terminal removal is routed to shared preflight rather than a direct destructive confirmation", () => {
  const dialogs = nodes(ast, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "WorktreeRemoveDialog");
  assert.equal(dialogs.length, 1);
  const oldDirectConfirm = nodes(ast, node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === "ConfirmDialog"
    && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.text === "title" && prop.initializer.getText(ast).includes("worktree.discard.title")));
  assert.equal(oldDirectConfirm.length, 0);
});

function finishHarness(changes = [{ path: "file", status: "M" }]) {
  const record = managed(), state = { worktrees: [record] };
  const calls = [], effects = [], values = [], previousDeps = [];
  let cursor = 0, stage;
  const ui = Object.fromEntries(["Dialog", "DialogContent", "DialogDescription", "DialogFooter", "DialogTitle", "Button", "Textarea"].map(name => [name, name]));
  const store = selector => selector({ ...state,
    mergeWorktree: async target => { calls.push(["merge", target]); return { merged: true, output: "merged" }; },
    removeWorktree: async target => { calls.push(["closeSession", target], ["remove", target]); },
  });
  store.getState = () => state;
  const { WorktreeFinishDialog } = load("../src/components/worktree/WorktreeFinishDialog.tsx", {
    react: {
      useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = typeof value === "function" ? value(values[index]) : value; }]; },
      useMemo: fn => fn(),
      useEffect(fn, deps) { const index = cursor++; if (!previousDeps[index] || deps.some((value, i) => value !== previousDeps[index][i])) { previousDeps[index] = deps; effects.push(fn); } },
    },
    "@tauri-apps/api/core": { invoke: async (name, payload) => { calls.push([name, payload]); if (name === "git_get_changes") return changes; if (name === "git_stage_all" && stage) await stage; return "commit-id"; } },
    sonner: { toast: { success: () => {} } },
    "../../lib/i18n": { useI18n: () => ({ t }) },
    "../../stores/worktreeStore": { useWorktreeStore: store }, "../../lib/worktreeManagement": management,
    "../ui/dialog": ui, "../ui/button": ui, "../ui/textarea": ui,
    "./WorktreeRemoveDialog": { WorktreeRemoveDialog: "WorktreeRemoveDialog" },
  });
  function t(key) { return key; }
  const walk = (element, predicate) => {
    if (!element || typeof element !== "object") return [];
    const own = predicate(element) ? [element] : [];
    return own.concat([element.props?.children].flat(Infinity).flatMap(child => walk(child, predicate)));
  };
  return { state, record, calls,
    render() { cursor = 0; return WorktreeFinishDialog({ project, worktree: record, open: true, onClose: () => {} }); },
    async ready() { this.render(); while (effects.length) effects.shift()(); await tick(); return this.render(); },
    button(name) { const button = walk(this.render(), node => node.type === "Button" && node.props.children === `worktree.finish.${name}`)[0]; assert.ok(button, name); return button.props; },
    block() { state.worktrees = [{ ...record, origin: "discovered" }]; },
    deferStage() { let resolve; stage = new Promise(done => { resolve = done; }); return resolve; },
    review() { return walk(this.render(), node => node.type === "WorktreeRemoveDialog")[0]; },
    mutations() { return calls.filter(([name]) => name !== "git_get_changes"); },
  };
}

test("an open finish dialog rejects a newly external target before staging, merging or cleanup", async () => {
  for (const action of ["commitAll", "merge", "cleanup"]) {
    const h = finishHarness(action === "commitAll" ? undefined : []);
    await h.ready();
    if (action === "cleanup") await h.button("merge").onClick();
    const onClick = h.button(action).onClick;
    h.calls.length = 0; h.block();
    await onClick();
    assert.deepEqual(h.mutations(), [], action);
    assert.equal(h.button(action).disabled, true, action);
  }
});

test("a dialog opened with an external or removed target exposes no enabled Git mutation", async () => {
  for (const unavailable of ["external", "removed"]) {
    const h = finishHarness();
    if (unavailable === "external") h.block();
    else h.state.worktrees = [];
    await h.ready();
    const button = h.button("commitAll");
    assert.equal(button.disabled, true, unavailable);
    await button.onClick();
    assert.deepEqual(h.mutations(), [], unavailable);
  }
});

test("a target becoming external while staging never reaches commit", async () => {
  const h = finishHarness(); await h.ready();
  const release = h.deferStage(), run = h.button("commitAll").onClick();
  await tick(); h.block(); release(); await run;
  assert.deepEqual(h.mutations().map(([name]) => name), ["git_stage_all"]);
});

test("managed completion stages and merges, then requires the same reviewed removal flow", async () => {
  const h = finishHarness(); await h.ready();
  await h.button("commitAll").onClick();
  assert.deepEqual(h.mutations().map(([name]) => name), ["git_stage_all", "git_commit"]);
  await h.button("merge").onClick();
  await h.button("cleanup").onClick();
  assert.deepEqual(h.mutations().map(([name]) => name), ["git_stage_all", "git_commit", "merge"]);
  assert.ok(h.review(), "cleanup must open preflight review before any session is closed");
});
