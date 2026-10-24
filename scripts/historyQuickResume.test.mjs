import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/components/HistoryWorkspace.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('HistoryWorkspace.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function declaration(name) {
  let result;
  function visit(node) {
    if(ts.isFunctionDeclaration(node)&&node.name?.text===name) result=node.getText(ast);
    if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name) result=`const ${node.getText(ast)};`;
    ts.forEachChild(node,visit);
  }
  visit(ast); assert.ok(result,`production ${name} missing`); return result;
}
function evaluate(text, context={}) {
  const exports={};
  const compiled=ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('exports',...Object.keys(context),compiled)(exports,...Object.values(context)); return exports;
}
function load(relative,dependencies={}) {
  return evaluate(readFileSync(new URL(relative,import.meta.url),'utf8'),{require:name=>{
    assert.ok(dependencies[name],`unexpected dependency ${name}`);return dependencies[name];
  }});
}
const runtime=load('../src/lib/terminalRuntimeEnvironment.ts');
const gates=load('../src/lib/historyResumeRuntime.ts',{'./terminalRuntimeEnvironment':runtime});
const commands=load('../src/lib/historyResumeCommand.ts',{
  './cliTools':{resolveCliToolHistorySourceId:value=>value},
  './projectStartupCommand':{appendResumeCliArgs:base=>base},
});
const identities=load('../src/lib/historySessionIdentity.ts');
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const fixture=extra=>({source:'codex',session_id:'chat-1',file_path:'/history/chat-1.jsonl',cwd:'/repo',title:'Saved conversation',sessionKey:'row-1',...extra});
function harness(options={}) {
  const session=fixture(options.session);
  const project={id:'repo',name:'Repo',path:'/repo',environment_type:'local',shell:'zsh',env_vars:'{}',...options.project};
  const context=options.remoteContext??null;
  let terminalState={sessions:options.terminals??[],sessionStatuses:options.statuses??{},terminalScope:{kind:'project',projectId:'other'},activeSessionId:'other'};
  const historyState={sessions:[session],remoteContext:context};
  const calls=[],closed=[],notices=[],busy=[],intents=[];
  const create=options.create??deferred();
  const preflight=options.preflight??deferred();
  terminalState.setActive=id=>{terminalState.activeSessionId=id;calls.push(['active',id]);};
  terminalState.setTerminalScope=scope=>{terminalState.terminalScope=scope;};
  const env={...commands,...identities,...runtime,...gates,
    useCallback:fn=>fn,useTerminalStore:{getState:()=>terminalState},useHistoryStore:{getState:()=>historyState},
    resolveHistoryResumeEnvironment:load('../src/lib/historyResumeEnvironment.ts').resolveHistoryResumeEnvironment,
    resumeInFlightRef:{current:null},setResumingSessionKey:value=>busy.push(value),
    setResumeIntent:value=>intents.push(value),remoteContext:context,
    closeHistory:value=>closed.push(value),t:key=>key,
    toast:Object.fromEntries(['error','info'].map(key=>[key,(...args)=>notices.push([key,...args])])),
    HISTORY_SOURCE_DESCRIPTOR_BY_ID:new Map(['codex','claude','grok','pi'].map(source=>[source,{capabilities:{resume:'supported'}}])),
    projectWithWorktreeProviderOverrides:item=>item,resolveHistoryResumeCwd:(_session,parent,tree)=>tree?.path??_session.cwd??parent?.path,
    parseProjectEnvVars:item=>item?JSON.parse(item.env_vars??'{}'):undefined,
    invoke:async(name,args)=>{calls.push([name,args]);if(name==='history_remote_resume_preflight')return preflight.promise;},
    createSession:async(...args)=>{
      calls.push(['create',args]);
      const id=await create.promise;
      terminalState.sessions=[...terminalState.sessions,{id,projectId:args[0],worktreeId:args[7],cwd:args[1],environmentType:args[8]?'ssh':project.environment_type}];
      terminalState.sessionStatuses[id]='running';return id;
    },
  };
  const api=evaluate(`${declaration('revealHistoryResumeTerminal')}\n${declaration('resumeSession')}\nexports.resume=resumeSession;`,env);
  return{...api,session,project,calls,closed,notices,busy,intents,create,preflight,historyState,state:()=>terminalState};
}
const flush=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const live=(extra={})=>({id:'existing',projectId:'repo',cwd:'/repo',environmentType:'local',cliSessionId:'chat-1',runtimeAgent:{tool:'codex',cliSessionId:'chat-1'},...extra});

test('list summary resumes its exact ID without loading detail and waits for successful startup delivery',async()=>{
 const h=harness();const run=h.resume(h.session,h.session.title,h.project,null);await flush();
 const args=h.calls.find(([kind])=>kind==='create')[1];
 assert.equal(args[3],'codex resume chat-1');assert.equal(args[9],'chat-1');assert.deepEqual(args[13],{waitForStartup:true});
 assert.deepEqual(h.busy,['row-1']);assert.deepEqual(h.closed,[]);
 await h.resume(h.session,'Repeated click',h.project,null);
 assert.equal(h.calls.filter(([kind])=>kind==='create').length,1);
 h.create.resolve('new-terminal');await run;
 assert.deepEqual(h.busy,['row-1',null]);assert.equal(h.closed.length,1);
 assert.equal(h.state().activeSessionId,'new-terminal');assert.deepEqual(h.state().terminalScope,{kind:'project',projectId:'repo'});
});

test('an already running exact conversation is focused and revealed without creating a second PTY',async()=>{
 const h=harness({terminals:[live({worktreeId:'feature'})],statuses:{existing:'running'}});
 await h.resume(h.session,'Saved',h.project,null);
 assert.equal(h.calls.filter(([kind])=>kind==='create').length,0);assert.equal(h.state().activeSessionId,'existing');
 assert.deepEqual(h.state().terminalScope,{kind:'worktree',projectId:'repo',worktreeId:'feature'});
});

test('failed startup keeps history open, clears loading and allows a deliberate retry',async()=>{
 const h=harness();const run=h.resume(h.session,'Saved',h.project,null);await flush();h.create.reject(Error('write failed'));await run;
 assert.deepEqual(h.closed,[]);assert.equal(h.busy.at(-1),null);assert.ok(h.notices.some(([kind])=>kind==='error'));
 const retry=h.resume(h.session,'Retry',h.project,null);await flush();await retry;
 assert.equal(h.calls.filter(([kind])=>kind==='create').length,2);
});

test('malformed IDs and unsupported sources cannot reach the PTY or SSH preflight',async()=>{
 for(const session of [{session_id:'chat-1;echoBAD'},{session_id:'--latest'},{source:'gemini'}]){
  const h=harness({session});await h.resume(h.session,'Saved',h.project,null);assert.deepEqual(h.calls,[]);assert.equal(h.busy.length,0);
 }
});

const sshContext={hostId:'host',source:'codex',sourceInstanceId:'instance',consumerId:'consumer',launch:{},projectPaths:['/remote'],configuredConfigRoot:'/home/.codex'};
const sshSession={cwd:'/remote',session_ref:{transportKind:'ssh',sourceId:'codex',sourceInstanceId:'instance',sourceSessionId:'chat-1'}};
const sshProject={environment_type:'ssh',ssh_host_id:'host',remote_path:'/remote'};
test('SSH exact reuse retains its current consumer and excludes an exited matching tab',async()=>{
 const existing=live({environmentType:'ssh',sshHostId:'host',remoteHistorySourceInstanceId:'instance',remoteHistoryConsumerId:'consumer'});
 const h=harness({session:sshSession,project:sshProject,remoteContext:sshContext,terminals:[existing],statuses:{existing:'running'}});
 await h.resume(h.session,'Remote',h.project,null);
 assert.deepEqual(h.closed,[{preserveRemoteConsumer:true}]);assert.equal(h.calls.filter(([kind])=>kind==='history_remote_resume_preflight').length,0);
});

test('SSH preflight completion rechecks live terminals and never duplicates a newly started session',async()=>{
 const h=harness({session:sshSession,project:sshProject,remoteContext:sshContext});
 const run=h.resume(h.session,'Remote',h.project,null);await flush();
 h.state().sessions.push(live({environmentType:'ssh',sshHostId:'host',remoteHistorySourceInstanceId:'instance',remoteHistoryConsumerId:'consumer'}));h.state().sessionStatuses.existing='running';
 h.preflight.resolve({remoteCwd:'/remote',resumeCommand:'codex resume chat-1',sourceSessionId:'chat-1',environmentOverrides:{}});await run;
 assert.equal(h.calls.filter(([kind])=>kind==='create').length,0);assert.equal(h.state().activeSessionId,'existing');
});

test('a changed remote source cannot launch a stale row or close the new remote history context',async()=>{
 const h=harness({session:sshSession,project:sshProject,remoteContext:sshContext});
 const run=h.resume(h.session,'Remote',h.project,null);await flush();h.historyState.remoteContext={...sshContext,consumerId:'new-consumer',hostId:'other'};
 h.preflight.resolve({remoteCwd:'/remote',resumeCommand:'codex resume chat-1',sourceSessionId:'chat-1',environmentOverrides:{}});await run;
 assert.equal(h.calls.filter(([kind])=>kind==='create').length,0);assert.deepEqual(h.closed,[]);
 assert.ok(h.calls.some(([kind,args])=>kind==='history_remote_close'&&args.consumerId==='consumer'));
});

test('SSH unsupported tool and host/source-instance mismatches reject before any claim or startup',async()=>{
 for(const session of [{source:'pi',session_ref:{...sshSession.session_ref,sourceId:'pi'}},{session_ref:{...sshSession.session_ref,sourceInstanceId:'old'}},{remote_identity:{hostId:'other'}}]){
  const h=harness({session:{...sshSession,...session},project:sshProject,remoteContext:sshContext});
  await h.resume(h.session,'Remote',h.project,null);assert.deepEqual(h.calls,[]);assert.deepEqual(h.closed,[]);
 }
});

test('quick resume locates the exact local history root and preserves unrelated project environment',async()=>{
 const h=harness({session:{file_path:'/profiles/codex-user/sessions/2026/10/chat-1.jsonl'},project:{env_vars:JSON.stringify({CODEX_HOME:'/wrong',KEEP:'yes'})}});
 const run=h.resume(h.session,'Saved',h.project,null);await flush();
 const args=h.calls.find(([kind])=>kind==='create')[1];
 assert.equal(args[4].CODEX_HOME,'/profiles/codex-user');assert.equal(args[4].KEEP,'yes');assert.equal(args[3],'codex resume chat-1');
 h.create.resolve('new-terminal');await run;
});

test('an identical conversation ID in another source root cannot substitute for the selected history',async()=>{
 const h=harness({session:{file_path:'/profiles/selected/sessions/chat-1.jsonl'},terminals:[live({envVars:{CODEX_HOME:'/profiles/other'}})],statuses:{existing:'running'}});
 const run=h.resume(h.session,'Saved',h.project,null);await flush();
 assert.equal(h.calls.filter(([kind])=>kind==='create').length,1);assert.equal(h.state().activeSessionId,'other');
 h.create.resolve('selected-root');await run;assert.equal(h.state().activeSessionId,'selected-root');
});

test('WSL resume passes the Linux source root with matching distro and preserves project forwarding',async()=>{
 const h=harness({session:{file_path:'\\\\wsl.localhost\\Ubuntu\\home\\me\\.codex\\sessions\\chat-1.jsonl'},project:{environment_type:'wsl',shell:'wsl',env_vars:JSON.stringify({WSL_DISTRO_NAME:'Ubuntu',WSLENV:'KEEP/u',KEEP:'yes'})}});
 const run=h.resume(h.session,'Saved',h.project,null);await flush();
 const args=h.calls.find(([kind])=>kind==='create')[1];
 assert.equal(args[4].CODEX_HOME,'/home/me/.codex');assert.equal(args[4].WSLENV,'KEEP/u:CODEX_HOME');assert.equal(args[5],'wsl');
 h.create.resolve('wsl-terminal');await run;
});

test('WSL source from another distro rejects before creating any terminal',async()=>{
 const h=harness({session:{file_path:'\\\\wsl.localhost\\Debian\\home\\me\\.codex\\sessions\\chat-1.jsonl'},project:{environment_type:'wsl',shell:'wsl',env_vars:JSON.stringify({WSL_DISTRO_NAME:'Ubuntu'})}});
 await h.resume(h.session,'Saved',h.project,null);
 assert.equal(h.calls.filter(([kind])=>kind==='create').length,0);assert.equal(h.closed.length,0);assert.equal(h.busy.at(-1),null);
 assert.ok(h.notices.some(([, ,args])=>args?.description==='history.quickResume.wslDistroMismatch'));
});
