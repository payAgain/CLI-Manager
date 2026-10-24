import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const modules = new Map();
function load(path) {
  const url = new URL(path, import.meta.url);
  if (modules.has(url.href)) return modules.get(url.href);
  const exports = {}; modules.set(url.href, exports);
  const code = ts.transpileModule(readFileSync(url, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'exports', code)(name => {
    if (name === '@tauri-apps/api/core') return { invoke: () => { throw Error('Unexpected IPC'); } };
    assert.ok(name.startsWith('.'));
    return load(new URL(name + '.ts', url));
  }, exports);
  return exports;
}
const { createWorktreeDiscovery, mergeDiscoveredWorktrees, canDiscoverWorktrees, worktreePathKey } = load('../src/lib/worktreeDiscovery.ts');
const { buildQuickJumpTargets } = load('../src/lib/quickJumpTargets.ts');
const { indexWorkspaceTerminals } = load('../src/lib/workspaceTerminals.ts');
const project = (id='repo', path='/repo', extras={}) => ({ id, name:id, path, environment_type:'local', cli_tool:'codex', group_name:'', remote_path:'', ...extras });
const entry = (path, branch='codex/feature', missing=false) => ({ path, branch, head:'1234567890abcdef', missing });
const managed = (path='/trees/managed') => ({ id:'saved-id', project_id:'repo', path, name:'saved name', branch:'wt/managed', base_branch:'main', status:'active', deps_prompt_dismissed:1, provider_overrides:'{}', created_at:'123', updated_at:'123' });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Git-discovered siblings are visible without database records, with stable identities and no primary duplicate', () => {
  const entries = [entry('/repo','main'), entry('/trees/a'), entry('/trees/b','codex/other'), entry('/trees/c','')];
  const records = mergeDiscoveredWorktrees(project(), [], entries);
  assert.equal(records.length,3);
  assert.deepEqual(records.map(r=>r.name), ['codex/feature','codex/other','12345678']);
  assert.ok(records.every(r=>r.origin==='discovered' && r.deps_prompt_dismissed===1 && r.base_branch===''));
  assert.deepEqual(records, mergeDiscoveredWorktrees(project(), [], entries));
  assert.notEqual(records[0].id, mergeDiscoveredWorktrees(project('other'), [], entries)[0].id);
});

test('managed records keep their identity, permissions and settings while branch/missing status follows Git', () => {
  const record=managed('C:\\trees\\managed');
  const entries=[entry('c:/trees/managed','wt/renamed'),entry('/trees/missing','codex/stale',true)];
  const merged=mergeDiscoveredWorktrees(project(),[record],entries);
  assert.equal(merged.length,1); assert.equal(merged[0].id,record.id);
  assert.equal(merged[0].branch,'wt/renamed'); assert.equal(merged[0].base_branch,'main'); assert.equal(merged[0].origin,undefined);
  assert.equal(mergeDiscoveredWorktrees(project(),[record],[entry(record.path,'',true)])[0].status,'missing');
  assert.equal(mergeDiscoveredWorktrees(project(),[{...record,status:'missing'}],[entry(record.path)])[0].status,'active');
  assert.notEqual(worktreePathKey('/repo/Feature'),worktreePathKey('/repo/feature'));
});

test('host Git never probes SSH, WSL or UNC paths', async () => {
  const projects=[project(),project('ssh','/repo',{environment_type:'ssh'}),project('wsl','/repo',{environment_type:'wsl'}),project('unc','\\\\wsl.localhost\\Ubuntu\\repo'),project('extended','\\\\?\\UNC\\wsl$\\Ubuntu\\repo'),project('empty','')];
  assert.deepEqual(projects.filter(canDiscoverWorktrees).map(p=>p.id),['repo']);
  assert.equal(canDiscoverWorktrees(project('win','\\\\?\\C:\\repo')),true);
  const calls=[]; const discover=createWorktreeDiscovery(async path=>{calls.push(path);return[];});
  await discover(projects,[]); assert.deepEqual(calls,['/repo']);
});

test('focus and palette refreshes share reads, cache five seconds and bound concurrency', async () => {
  let now=0, active=0, peak=0, calls=0;
  const discover=createWorktreeDiscovery(async path=>{calls++;active++;peak=Math.max(peak,active);await tick();active--;return[entry(path+'/tree')];},()=>now);
  const projects=[project('a','/a'),project('b','/b'),project('c','/c'),project('alias','/a')];
  const [first,second]=await Promise.all([discover(projects,[]),discover(projects,[])]);
  assert.equal(calls,3); assert.ok(peak<=2); assert.deepEqual(first,second); assert.equal(first.length,4);
  now=4999;await discover(projects,[]);assert.equal(calls,3);
  now=5000;await discover(projects,[]);assert.equal(calls,6);
});

test('failed refresh keeps the last successful snapshot; successful removal and repository changes do not resurrect entries', async () => {
  let now=0,result=[entry('/trees/a')],fail=false;
  const discover=createWorktreeDiscovery(async()=>{if(fail)throw Error('temporarily unavailable');return result;},()=>now);
  const first=await discover([project()],[]);now+=5000;fail=true;
  assert.deepEqual(await discover([project()],[]),first);
  now+=5000;fail=false;result=[];assert.deepEqual(await discover([project()],[]),[]);
  now+=5000;result=[entry('/trees/a')];await discover([project()],[]);
  now+=5000;fail=true;assert.deepEqual(await discover([project('repo','/different')],[]),[]);
  assert.deepEqual(await discover([],[]),[]);
});

test('an interactive create refresh bypasses cache and waits out an older read', async () => {
  let release,calls=0;
  const discover=createWorktreeDiscovery(async()=>{calls++;if(calls===1)return new Promise(resolve=>{release=resolve;});return[entry('/trees/managed','wt/managed')];});
  const first=discover([project()],[]);await tick();
  const refreshed=discover([project()],[managed()],true);release([]);await first;
  const result=await refreshed;assert.equal(calls,2);assert.equal(result.length,1);assert.equal(result[0].status,'active');assert.equal(result[0].id,'saved-id');
});

test('discovered worktrees feed both quick jump and restored terminal membership without creating sessions', () => {
  const p=project(), records=mergeDiscoveredWorktrees(p,[],[entry('/trees/feature')]);
  const sessions=[{id:'existing',kind:'pty',title:'existing terminal',cwd:'/trees/feature/src',projectId:p.id,environmentType:'local'}];
  const index=indexWorkspaceTerminals(sessions,[p],records);assert.equal(index.byWorktree.get(records[0].id)[0].id,'existing');
  const targets=buildQuickJumpTargets({projects:[p],worktrees:records,sessions,sessionStatuses:{existing:'running'},workspans:[],activeSessionId:null,activeWorkspanId:null,workspanEnabled:true});
  assert.ok(targets.some(t=>t.kind==='worktree' && t.intent==='navigate' && t.worktreeId===records[0].id));
  assert.ok(targets.some(t=>t.kind==='worktree' && t.intent==='create' && t.worktreeId===records[0].id));
});

test('external merging stays protected and removal requires explicit preflight before side effects', async () => {
  const src=readFileSync(new URL('../src/stores/worktreeStore.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('worktreeStore.ts',src,ts.ScriptTarget.Latest,true);
  for(const name of ['mergeWorktree','removeWorktree']) {
    let fn;function visit(node){if(ts.isPropertyAssignment(node)&&node.name.getText(ast)===name)fn=node.initializer;ts.forEachChild(node,visit);}visit(ast);assert.ok(fn);
    const code=ts.transpileModule(`const action=${fn.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
    const action=new Function('resolveWorktreeManagementTarget','get',code+';return action;')(
      load('../src/lib/worktreeManagement.ts').resolveWorktreeManagementTarget,
      ()=>({worktrees:[managed()]}),
    );
    await assert.rejects(()=>action({...managed(),origin:'discovered'},true),name==='mergeWorktree'?/external_worktree_read_only/:/worktree_remove_confirmation_required/);
  }
});

test('late focus discovery cannot restore a removed project or overwrite a newer worktree snapshot', async () => {
  const src=readFileSync(new URL('../src/stores/projectStore.ts',import.meta.url),'utf8');
  const ast=ts.createSourceFile('projectStore.ts',src,ts.ScriptTarget.Latest,true);
  let fn;function visit(node){if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='refreshWorktrees')fn=node.initializer;ts.forEachChild(node,visit);}visit(ast);assert.ok(fn);
  const code=ts.transpileModule(`const action=${fn.getText(ast)};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  for(const mutate of [state=>{state.projects=[];},state=>{state.worktrees=[managed()];}]){
    const state={projects:[project()],worktrees:[],groups:[],searchQuery:''};let release,writes=0;
    const action=new Function('get','set','discoverWorktrees','buildTree',`let inflightFetchAll=null,inflightWorktreeRefresh=null;${code};return action;`)(()=>state,()=>writes++,()=>new Promise(resolve=>{release=resolve;}),()=>[]);
    const pending=action();mutate(state);release([managed()]);await pending;assert.equal(writes,0);
  }
});
