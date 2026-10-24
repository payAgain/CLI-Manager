import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
function load(path,dependencies={}){
 const exports={};
 const output=ts.transpileModule(read(path),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},fileName:path}).outputText;
 new Function('exports','require',output)(exports,name=>{
  if(name==='react/jsx-runtime')return require(name);
  assert.ok(name in dependencies,`unexpected production dependency ${name}`);return dependencies[name];
 });return exports;
}
const statuses=load('../src/lib/workspaceStatus.ts');
const shell=extra=>({id:'shell',title:'Review terminal rendering',environmentType:'local',runtimeAgent:null,...extra});

test('a live plain PTY or idle Agent is ready; actual task evidence is needed for working',()=>{
 for(const runtimeAgent of [null,undefined,{tool:'codex'}]){
  assert.equal(statuses.workspaceTerminalStatus(shell({runtimeAgent}),'running'),'ready');
  assert.equal(statuses.workspaceTerminalStatus(shell({runtimeAgent}),'running','none'),'ready');
 }
 assert.equal(statuses.workspaceTerminalStatus(shell(),'running','running'),'working','shell command evidence is a task, not an Agent guess');
 assert.equal(statuses.workspaceTerminalStatus(shell(),'running','done'),'done');
 assert.equal(statuses.workspaceTerminalStatus(shell(),'running','attention'),'attention');
 assert.equal(statuses.workspaceTerminalStatus(shell(),'running','failed'),'failed');
});

test('SSH connection states and PTY exit take precedence over old task notifications',()=>{
 for(const connectionState of ['connecting','authenticating'])assert.equal(statuses.workspaceTerminalStatus(shell({environmentType:'ssh',connectionState}),'running','running'),'connecting');
 assert.equal(statuses.workspaceTerminalStatus(shell({environmentType:'ssh',connectionState:'failed'}),'running','done'),'failed');
 assert.equal(statuses.workspaceTerminalStatus(shell({environmentType:'ssh',connectionState:'disconnected'}),'running','running'),'stopped');
 for(const status of ['exited',undefined])assert.equal(statuses.workspaceTerminalStatus(shell(),status,'running'),'stopped');
 assert.equal(statuses.workspaceTerminalStatus(shell(),'error','done'),'failed');
});

test('workspace aggregation uses the most actionable PTY state and ignores read-only/editor panes',()=>{
 const sessions=[shell({id:'ready'}),shell({id:'working'}),shell({id:'failed'}),shell({id:'attention'}),shell({id:'preview',kind:'subagent-transcript'})];
 const alive=Object.fromEntries(sessions.map(session=>[session.id,'running']));
 const notes={working:'running',failed:'failed',attention:'attention',preview:'attention'};
 assert.equal(statuses.workspaceDisplayStatus(sessions,alive,notes),'attention');
 assert.equal(statuses.workspaceDisplayStatus(sessions.slice(0,3),alive,notes),'failed');
 assert.equal(statuses.workspaceDisplayStatus(sessions.slice(0,2),alive,notes),'working');
 assert.equal(statuses.workspaceDisplayStatus([sessions[0],sessions[4]],alive,notes),'ready');
 assert.equal(statuses.workspaceDisplayStatus([],{},{}),'stopped');
 assert.equal(statuses.workspaceDisplayStatus(sessions,alive,notes,true),'unavailable');
 assert.equal(statuses.workspaceDisplayStatus([shell({kind:'file-editor'})],{shell:'error'},{}),'stopped');
});

function nodes(element,predicate){
 const found=[];function visit(item){if(!item||typeof item!=='object')return;if(predicate(item))found.push(item);for(const child of [item.props?.children].flat(Infinity))visit(child);}visit(element);return found;
}
function fixture(props={}){
 const calls=[];const terminalState={sessionStatuses:{shell:'running'},tabNotifications:{},activeSessionId:'shell',setActive:id=>calls.push(['active',id])};
 const terminalStore=selector=>selector(terminalState);terminalStore.getState=()=>terminalState;
 const icon=()=>null;
 const {WorkspaceCard}=load('../src/components/sidebar/WorkspaceCard.tsx',{
  '../CliToolIcon':{CliToolIcon:icon},'../../lib/cliTools':{CLI_TOOL_DESCRIPTORS:[],resolveCliToolIconKey:()=>null},
  '../icons':{AlertTriangle:icon,GitBranch:icon,MoreHorizontal:icon,Play:icon,Terminal:icon},
  '../../stores/terminalStore':{useTerminalStore:terminalStore},'../../lib/i18n':{useI18n:()=>({t:(key,args)=>key+(args?.count!==undefined?`:${args.count}`:'')})},
  '../../lib/projectStartupCommand':{projectTerminalLaunchLabel:()=> 'sidebar.menu.newBlankTerminal'},'../../lib/workspaceStatus':statuses,
 });
 const tree=WorkspaceCard({project:{id:'repo',path:'/repo',environment_type:'local'},terminals:[shell()],name:'master',branch:'master',selected:false,compact:false,invalid:false,
  onSelect:event=>calls.push(['select',event]),onOpen:()=>calls.push(['open']),onContextMenu:()=>calls.push(['menu']),...props});
 return{tree,calls};
}

test('terminal rows stay clickable in every checkout card and have no terminal drag behavior',()=>{
 const h=fixture();const row=nodes(h.tree,item=>item.type==='button'&&item.props.className?.includes('ui-workspace-session '))[0];
 assert.ok(row,'unselected card still shows its terminal');
 let stopped=0;const event={stopPropagation(){stopped++;}};row.props.onClick(event);
 assert.equal(stopped,1);assert.deepEqual(h.calls,[['select',event],['active','shell']]);
 row.props.onDoubleClick(event);assert.equal(stopped,2);assert.equal(h.calls.length,2);
 for(const node of nodes(h.tree,()=>true)){
  assert.equal(node.props?.draggable,undefined);assert.equal(node.props?.onDragStart,undefined);assert.equal(node.props?.onPointerDown,undefined);
  if(node.type==='button')assert.equal(nodes(node.props.children,item=>item.type==='button').length,0,'no nested buttons');
 }
 assert.equal(row.props['data-status'],'ready');assert.equal(row.props['aria-current'],'true');
});

test('launch/menu controls remain separate from row activation and repeated branch names are not duplicated',()=>{
 const h=fixture();const actions=nodes(h.tree,item=>item.type==='button'&&item.props.className?.includes('ui-sidebar-tool'));
 let stopped=0;for(const action of actions)action.props.onClick({stopPropagation(){stopped++;}});
 assert.equal(stopped,2);assert.deepEqual(h.calls,[['open'],['menu']]);
 const meta=nodes(h.tree,item=>item.props?.className==='ui-workspace-card-branch')[0];
 assert.equal(nodes(meta,item=>item.type==='span')[1].props.children,'workspace.terminalCount:1');
 const distinct=fixture({name:'Feature work',branch:'codex/task'});
 const branch=nodes(distinct.tree,item=>item.props?.className==='ui-workspace-card-branch')[0];
 assert.ok(nodes(branch,item=>item.type==='span').some(item=>item.props.children==='codex/task'));
});
