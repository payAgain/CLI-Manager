import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function load(relative,dependencies={},timer=setTimeout){
 const exports={};const output=ts.transpileModule(readFileSync(new URL(relative,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 new Function('exports','require','setTimeout',output)(exports,name=>{assert.ok(dependencies[name],`unexpected dependency ${name}`);return dependencies[name];},timer);return exports;
}
const management=load('../src/lib/worktreeManagement.ts');
const runtime=load('../src/lib/terminalRuntimeEnvironment.ts');
const related=load('../src/lib/worktreeRemoval.ts',{'./terminalRuntimeEnvironment':runtime});
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const record=extra=>({id:'wt',project_id:'repo',name:'Feature',path:'/tree',branch:'codex/feature',base_branch:'main',status:'active',...extra});
const session=(id='one',extra={})=>({id,title:`Session ${id}`,cwd:'/tree',worktreeId:'wt',environmentType:'local',...extra});
function harness(options={}){
 const target=record(options.record),calls=[],notices=[];
 const projectState={projects:[{id:'repo',path:'/repo',environment_type:'local',...options.project}],fetchAll:async()=>calls.push(['refresh'])};
 const terminalState={sessions:options.sessions??[],sessionStatuses:options.statuses??{}};
 let closeHook=()=>{},releaseHook=()=>{},removeHook=()=>{},dbError=false;
 terminalState.discardDaemonSession=async id=>{calls.push(['close',id]);await closeHook(id);terminalState.sessions=terminalState.sessions.filter(item=>item.id!==id);delete terminalState.sessionStatuses[id];};
 const sample={confirmationToken:'private-token',worktreePath:'/tree',branch:'codex/feature',detached:false,head:'abc',locked:false,dirty:false,stagedCount:0,unstagedCount:0,untrackedCount:0,changedCount:0,changedPaths:[],runningSessions:[],externalProcesses:[],...options.preflight};
 const {useWorktreeStore:store}=load('../src/stores/worktreeStore.ts',{
  zustand:require('zustand'),'@tauri-apps/api/core':{invoke:async(name,args)=>{calls.push([name,args]);if(name==='git_worktree_remove_preflight')return {...sample,runningSessions:[...sample.runningSessions]};if(name==='git_worktree_remove'){await removeHook(args);return options.output??'';}return{merged:true};}},
  '../lib/db':{getDb:async()=>({execute:async(...args)=>{calls.push(['db',...args]);if(dbError)throw Error('disk full');}})},
  '../lib/projectCli':{},'../lib/projectCapabilities':{},'../lib/worktreeManagement':management,'../lib/worktreeRemoval':related,
  '../lib/terminalRuntimeEnvironment':runtime,
  '../lib/i18n':{translateCurrent:key=>key},sonner:{toast:{warning:key=>notices.push(key)}},
  './projectStore':{useProjectStore:{getState:()=>projectState}},'./terminalStore':{useTerminalStore:{getState:()=>terminalState}},'./settingsStore':{},
 },callback=>queueMicrotask(()=>{releaseHook();callback();}));
 store.setState({worktrees:[target]});
 return{store,target,calls,notices,projectState,terminalState,sample,
  afterClose:fn=>{closeHook=fn;},afterRelease:fn=>{releaseHook=fn;},onRemove:fn=>{removeHook=fn;},failDb:()=>{dbError=true;},
  check:()=>store.getState().preflightRemoval(target),
  remove:(preflight,choices={},deleteBranch=false)=>store.getState().removeWorktree(target,deleteBranch,{preflight,discardChanges:false,closeSessions:false,...choices}),
 };
}
const mutations=h=>h.calls.filter(([name])=>['close','git_worktree_remove','db'].includes(name));

test('external preflight supplements daemon inventory with hidden/starting UI sessions and titles',async()=>{
 const h=harness({record:{origin:'discovered'},sessions:[session(),session('starting'),session('foreign',{cwd:'/elsewhere',worktreeId:'other'})],statuses:{one:'running',starting:'running',foreign:'running'},preflight:{runningSessions:[{sessionId:'one'},{sessionId:'unattached',title:'Background Agent'}]}});
 const check=await h.check();assert.equal(check.projectPath,'/repo');assert.equal(check.worktreeId,'wt');
 assert.deepEqual(check.runningSessions.map(item=>item.sessionId),['one','unattached','starting']);assert.equal(check.runningSessions[0].title,'Session one');
 assert.deepEqual(mutations(h),[]);
});

test('removal cannot close sessions or invoke Git without explicit preflight confirmation',async()=>{
 const h=harness({sessions:[session()],statuses:{one:'running'}});
 await assert.rejects(h.store.getState().removeWorktree(h.target,true),/confirmation_required/);assert.deepEqual(mutations(h),[]);
});

test('dirty changes, running sessions and external processes require their own explicit safe state',async()=>{
 for(const [preflight,choices,error]of[
  [{dirty:true,changedPaths:['file']},{},/changes_confirmation_required/],
  [{runningSessions:[{sessionId:'one'}]},{},/sessions_running/],
  [{externalProcesses:[{pid:42,name:'External Agent'}]},{closeSessions:true,discardChanges:true},/processes_running/],
 ]){const h=harness({preflight});const check=await h.check();await assert.rejects(h.remove(check,choices),error);assert.deepEqual(mutations(h),[]);}
 const h=harness({preflight:{detached:true,branch:null}});const check=await h.check();await assert.rejects(h.remove(check,{},true),/detached_branch/);assert.deepEqual(mutations(h),[]);
});

test('clean external removal keeps its branch by default and never deletes an unowned DB record',async()=>{
 const h=harness({record:{origin:'discovered'}});const check=await h.check();await h.remove(check);
 const call=h.calls.find(([name])=>name==='git_worktree_remove')[1];assert.equal(call.deleteBranch,false);assert.equal(call.confirmationToken,'private-token');assert.equal(call.discardChanges,false);
 assert.deepEqual(h.calls.map(([name])=>name),['git_worktree_remove_preflight','git_worktree_remove','refresh']);assert.deepEqual(h.store.getState().worktrees,[]);
});

test('only confirmed related sessions are closed, including unattached daemon sessions',async()=>{
 const h=harness({sessions:[session(),session('unrelated',{worktreeId:'other',cwd:'/other'})],statuses:{one:'running',unrelated:'running'},preflight:{runningSessions:[{sessionId:'one'},{sessionId:'unattached'}]}});
 const check=await h.check();await h.remove(check,{closeSessions:true});
 assert.deepEqual(h.calls.filter(([name])=>name==='close').map(([,id])=>id),['one','unattached']);assert.equal(h.terminalState.sessions[0].id,'unrelated');
 assert.deepEqual(h.calls.map(([name])=>name),['git_worktree_remove_preflight','git_worktree_remove_preflight','close','close','git_worktree_remove','db','refresh']);
});

test('fresh native association closes a confirmed hidden PTY despite stale UI cwd, status or kind',async()=>{
 for(const kind of ['pty','synced-history']){
  const h=harness({sessions:[session('hidden',{kind,worktreeId:undefined,cwd:'/stale'})],statuses:{hidden:'exited'},preflight:{runningSessions:[{sessionId:'hidden'}]}});
  await h.remove(await h.check(),{closeSessions:true});
  assert.deepEqual(h.calls.filter(([name])=>name==='close'),[['close','hidden']]);
 }
});

test('a confirmed session that is no longer related in native or UI state is not closed',async()=>{
 const h=harness({sessions:[session('one',{worktreeId:'other',cwd:'/other'})],statuses:{one:'running'},preflight:{runningSessions:[{sessionId:'one'}]}});
 const check=await h.check();h.sample.runningSessions=[];await h.remove(check,{closeSessions:true});
 assert.deepEqual(h.calls.filter(([name])=>name==='close'),[]);
});

test('new native sessions and external processes stop the operation before any confirmed session closes',async()=>{
 for(const change of [h=>h.sample.runningSessions.push({sessionId:'new-background'}),h=>h.sample.externalProcesses=[{pid:88,name:'External Agent'}]]){
  const h=harness({preflight:{runningSessions:[{sessionId:'one'}]}});const check=await h.check();change(h);
  await assert.rejects(h.remove(check,{closeSessions:true}),/worktree_remove_(changed|processes_running)/);
  assert.deepEqual(mutations(h),[]);
 }
});

test('a UI-only WSL PTY must exit manually, including inferred WSL launchers and synced history',async()=>{
 for(const extra of [{environmentType:'wsl'},{shell:'wsl.exe -d Ubuntu'},{startupCmd:'wsl -d Ubuntu -- codex'},{kind:'synced-history',environmentType:'wsl'}]){
  const h=harness({sessions:[session('starting',extra)],statuses:{starting:'running'}});
  await assert.rejects(h.check(),/worktree_remove_wsl_sessions/);assert.deepEqual(mutations(h),[]);
 }
 const h=harness({sessions:[session()],statuses:{one:'running'}});const check=await h.check();
 h.terminalState.sessions[0].shell='wsl.exe';
 await assert.rejects(h.remove(check,{closeSessions:true}),/worktree_remove_wsl_sessions/);assert.deepEqual(mutations(h),[]);
});

test('a new related terminal after review is never silently added to the closure authorization',async()=>{
 const h=harness();const check=await h.check();h.terminalState.sessions.push(session('new'));h.terminalState.sessionStatuses.new='running';
 await assert.rejects(h.remove(check,{closeSessions:true}),/worktree_remove_changed/);assert.deepEqual(mutations(h),[]);
});

test('stale worktree and project identities stop before closing or removing any directory',async()=>{
 for(const change of[h=>h.store.setState({worktrees:[]}),h=>h.store.setState({worktrees:[{...h.target,path:'/other'}]}),h=>{h.projectState.projects[0].path='/different-repo';},h=>{h.projectState.projects[0].environment_type='ssh';}]){
  const h=harness({sessions:[session()],statuses:{one:'running'}});const check=await h.check();change(h);await assert.rejects(h.remove(check,{closeSessions:true}),/worktree_(target_changed|remove_unsupported_environment)/);assert.deepEqual(mutations(h),[]);
 }
});

test('ownership/path changes while waiting for session release cannot reach the Git mutation',async()=>{
 const h=harness({sessions:[session()],statuses:{one:'running'}});const check=await h.check();h.afterRelease(()=>h.store.setState({worktrees:[{...h.target,path:'/relocated'}]}));
 await assert.rejects(h.remove(check,{closeSessions:true}),/worktree_target_changed/);assert.deepEqual(mutations(h),[['close','one']]);
});

test('backend state changes leave the worktree record intact and permit fresh review',async()=>{
 const h=harness();const check=await h.check();h.onRemove(()=>{throw Error('worktree_remove_changed');});await assert.rejects(h.remove(check),/changed/);
 assert.equal(h.store.getState().worktrees[0],h.target);assert.equal(h.calls.some(([name])=>name==='db'),false);
 h.onRemove(()=>{});await h.remove(await h.check());assert.deepEqual(h.store.getState().worktrees,[]);
});

test('concurrent removal of the same reviewed target is gated before another destructive request',async()=>{
 const barrier=deferred(),h=harness();const check=await h.check();h.onRemove(()=>barrier.promise);
 const first=h.remove(check);await Promise.resolve();await assert.rejects(h.remove(check),/worktree_remove_busy/);barrier.resolve();await first;
 assert.equal(h.calls.filter(([name])=>name==='git_worktree_remove').length,1);
});

test('post-removal database and branch cleanup failures preserve the true removed state',async()=>{
 const h=harness({output:'branch_delete_failed: still in use'});h.failDb();await h.remove(await h.check(),{},true);
 assert.deepEqual(h.store.getState().worktrees,[]);assert.deepEqual(h.notices,['worktree.remove.metadataFailed','worktree.remove.branchKept']);
});

test('session association checks exact path boundaries, ownership and local/WSL environments',()=>{
 const wt=record();const entries=[session(),session('cwd',{worktreeId:undefined,cwd:'/tree/sub'}),session('wsl',{environmentType:'wsl'}),session('ssh',{environmentType:'ssh',sshHostId:'remote'}),session('history',{kind:'synced-history'}),session('prefix',{worktreeId:undefined,cwd:'/treehouse'}),session('stopped'),session('editor',{kind:'file-editor'})];
 const statuses=Object.fromEntries(entries.map(item=>[item.id,item.id==='stopped'?'exited':'running']));
 assert.deepEqual(related.worktreeRelatedSessions(wt,'/tree',entries,statuses).map(item=>item.id),['one','cwd','wsl','history']);
});
