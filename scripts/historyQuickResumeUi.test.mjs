import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
const require=createRequire(import.meta.url);
function load(file,dependencies={},globals={}) {
  const exports={};
  runInNewContext(ts.transpileModule(readFileSync(new URL(`../${file}`,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,{exports,require:id=>dependencies[id]??require(id),...globals});
  return exports;
}
const sources=load('src/lib/historySources.ts');
const hierarchy=load('src/lib/historySubagents.ts');
const projects=load('src/lib/terminalProject.ts');
const time=load('src/components/history/historyViewUtils.tsx');
const command=load('src/lib/historyResumeCommand.ts',{'./cliTools':{},'./projectStartupCommand':{}});
const {translate}=load('src/lib/i18n.ts',{'../stores/settingsStore':{useSettingsStore:{getState:()=>({language:'zh-CN'})}}});
const session=(source,id,extra={})=>({source,session_id:id,sessionKey:`${source}:${id}`,title:id,displayTitle:id,file_path:`/history/${source}/${id}.jsonl`,cwd:'/repo',message_count:4,updated_at:1720000000000,created_at:1720000000000,starred:false,tags:[],alias:'',project_key:'repo',...extra});
const parent=session('claude','parent');
const child=session('claude','agent-child',{displayTitle:'Child task',file_path:'/history/claude/parent/subagents/agent-child.jsonl',subagent:{parent_session_id:'parent',nickname:'Reviewer'}});
const ssh=session('codex','display id',{displayTitle:'SSH history',session_ref:{transportKind:'ssh',sourceSessionId:'remote:source-id',sourceInstanceId:'machine:root'}});
const wsl=session('codex','wsl-id',{displayTitle:'WSL history',file_path:'\\\\wsl.localhost\\Ubuntu\\home\\dev\\.codex\\sessions\\wsl-id.jsonl',cwd:'/home/dev/repo'});
const samples=[parent,child,ssh,wsl,session('pi','pi-id',{read_only:true}),session('grok','grok-id',{read_only:true}),session('gemini','gemini-id',{read_only:true}),session('future-agent','future-id'),session('codex','bad id',{displayTitle:'Invalid identity'}),session('pi','remote-pi',{displayTitle:'SSH Pi',session_ref:{transportKind:'ssh',sourceSessionId:'pi-remote'}}),session('grok','remote-grok',{displayTitle:'SSH Grok',session_ref:{transportKind:'ssh',sourceSessionId:'grok-remote'}})];
function fixture(overrides={},language='en-US') {
  const states=[];states[2]=new Set([parent.sessionKey]);let cursor=0;
  const calls={open:[],resume:[],select:[],deleted:[]};
  const noop=()=>{};
  const props={historySidebarWidth:300,sidebarRef:{current:null},sessionListRef:{current:null},globalSearchRef:{current:null},sourceFilter:'all',projectPathFilter:null,projectIdFilter:null,scopedProjectPathFilter:null,projects:[],groups:[],globalQuery:'',favoriteOnly:false,activeSessionKey:parent.sessionKey,loadingSessions:false,loadingMoreSessions:false,searching:false,normalizedGlobal:'',groupedSessions:Array.from(new Set(samples.map(item=>item.source)),source=>({source,items:samples.filter(item=>item.source===source)})),filteredSessionCount:samples.length,hasMoreSessions:false,loadMoreSessionMode:'local',visibleSessionCount:samples.length,searchHits:[],indexStatus:{phase:'ready',indexedFiles:10,totalFiles:10},selectionMode:false,selectedCount:0,allVisibleSelected:false,selectedSessionKeys:new Set(),onRefresh:noop,onClose:noop,onProjectPathFilterChange:noop,onGlobalQueryChange:noop,onFavoriteOnlyChange:noop,onEnterSelectionMode:noop,onCancelSelectionMode:noop,onToggleSelectAllVisible:noop,onToggleSessionSelection:key=>calls.select.push(key),onOpenSession:key=>calls.open.push(key),onResumeSession:item=>calls.resume.push(item),canConvertSession:()=>false,onConvertSession:noop,onDeleteSession:item=>calls.deleted.push(item),onDeleteSelected:noop,onOpenHit:noop,onLoadMoreSessions:noop,onSessionListScroll:noop,onStartResize:noop,...overrides};
  const module=load('src/components/history/HistoryListPane.tsx',{
    react:{...React,useCallback:callback=>callback,useMemo:factory=>factory(),useEffect(){},useRef:value=>({current:value}),useState:initial=>{const index=cursor++;if(!(index in states))states[index]=initial;return[states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value;}];}},
    '@tanstack/react-virtual':{useVirtualizer:options=>{let start=0;const rows=Array.from({length:options.count},(_,index)=>{const row={index,key:options.getItemKey(index),start};start+=options.estimateSize(index);return row;});return{getVirtualItems:()=>rows,getTotalSize:()=>start,measureElement(){}};}},
    '../../lib/i18n':{useI18n:()=>({language,t:(key,params)=>translate(language,key,params)})},
    '../../lib/historySources':sources,'../../lib/historyResumeCommand':command,'../../lib/historySubagents':hierarchy,'../../lib/terminalProject':projects,'./historyViewUtils':time,
    '../../lib/cliTools':{resolveCliToolIconKey:()=>null,resolveHistorySourceIconKey:()=>null},'../../stores/worktreeStore':{useWorktreeStore:selector=>selector({worktrees:[]})},'../CliToolIcon':{CliToolIcon:()=>null},'../ui/Portal':{Portal:({children})=>children},
  },{window:{innerWidth:1280,innerHeight:900}});
  return{props,calls,render:()=>{cursor=0;return module.HistoryListPane(props);}};
}
function all(tree,predicate) {
  const results=[];
  function walk(node){if(Array.isArray(node)){node.forEach(walk);return;}if(!node||typeof node!=='object')return;if(predicate(node))results.push(node);walk(node.props?.children);}
  walk(tree);return results;
}
const hasClass=(node,name)=>node.props?.className?.split(' ').includes(name);
const row=(tree,title)=>all(tree,node=>hasClass(node,'history-session-row')&&all(node,child=>hasClass(child,'history-session-title')&&child.props.children===title).length)[0];
const button=(tree,name)=>all(tree,node=>node.type==='button'&&hasClass(node,name))[0];

test('quick resume passes exact local, SSH, WSL and supported read-only session without selecting its row',()=>{
  const {render,calls}=fixture();const tree=render();
  for(const item of[parent,child,ssh,wsl,...samples.filter(item=>['pi','grok'].includes(item.source)&&!item.session_ref)]){
    const quick=button(row(tree,item.displayTitle),'history-session-resume');assert.equal(quick.props.type,'button');assert.equal(quick.props.disabled,false);
    let stopped=0;quick.props.onClick({stopPropagation(){stopped++;}});assert.equal(stopped,1);assert.equal(calls.resume.at(-1),item);assert.equal(calls.open.length,0);assert.equal(calls.select.length,0);
  }
  button(row(tree,parent.displayTitle),'history-session-open').props.onClick();assert.deepEqual(calls.open,[parent.sessionKey]);
});

test('unsupported sources, malformed IDs, unsupported SSH tools and pending resume disable all resume entry points',()=>{
  for(const title of['gemini-id','future-id','Invalid identity','SSH Pi','SSH Grok']){
    const current=fixture();let tree=current.render();const target=row(tree,title);const quick=button(target,'history-session-resume');assert.equal(quick.props.disabled,true);assert.ok(quick.props.title);
    quick.props.onClick({stopPropagation(){}});assert.equal(current.calls.resume.length,0);
    target.props.onContextMenu({preventDefault(){},clientX:10,clientY:10});tree=current.render();
    const menu=all(tree,node=>node.props?.role==='menu')[0];const resume=all(menu,node=>node.props?.role==='menuitem')[0];assert.equal(resume.props.disabled,true);resume.props.onClick();assert.equal(current.calls.resume.length,0);
  }
  const {render,calls}=fixture({resumingSessionKey:parent.sessionKey});const tree=render();const quick=all(tree,node=>hasClass(node,'history-session-resume'));
  assert.ok(quick.every(node=>node.props.disabled));assert.equal(quick.filter(node=>node.props['aria-busy']).length,1);
  quick.forEach(node=>node.props.onClick({stopPropagation(){}}));assert.equal(calls.resume.length,0);
  button(row(tree,wsl.displayTitle),'history-session-open').props.onClick();assert.deepEqual(calls.open,[wsl.sessionKey],'loading does not disable ordinary list selection');
});

test('bulk selection and subagent expansion keep their own click paths and action buttons never nest',()=>{
  const selected=fixture({selectionMode:true});const tree=selected.render();assert.equal(all(tree,node=>hasClass(node,'history-session-resume')).length,0);
  const target=row(tree,parent.displayTitle);target.props.onClick();all(target,node=>node.props?.onToggle)[0].props.onToggle();assert.deepEqual(selected.calls.select,[parent.sessionKey,parent.sessionKey]);assert.equal(button(target,'history-session-open').props.tabIndex,-1);
  const expanded=fixture();let normal=expanded.render();let stopped=false;button(row(normal,parent.displayTitle),'history-session-toggle').props.onClick({stopPropagation(){stopped=true;}});normal=expanded.render();assert.equal(stopped,true);assert.equal(row(normal,child.displayTitle),undefined);assert.equal(expanded.calls.resume.length,0);
  function inspect(node,inButton=false){if(Array.isArray(node)){node.forEach(childNode=>inspect(childNode,inButton));return;}if(!node||typeof node!=='object')return;assert.ok(!(inButton&&node.type==='button'),'row actions must not nest buttons');inspect(node.props?.children,inButton||node.type==='button');}
  inspect(normal);
});

test('named actions and unsupported, invalid and loading explanations render in all three languages',()=>{
  for(const language of['zh-CN','en-US','zh-TW']){
    const {render}=fixture({},language);const html=renderToStaticMarkup(render());assert.ok(html.includes(translate(language,'history.quickResume.action',{title:parent.displayTitle}).replaceAll('"','&quot;')));assert.ok(html.includes(translate(language,'history.quickResume.unsupported')));assert.ok(html.includes(translate(language,'history.resumeProject.invalidSession')));assert.ok(!html.includes('history.quickResume.'));
    const pending=renderToStaticMarkup(fixture({resumingSessionKey:parent.sessionKey},language).render());assert.ok(pending.includes(translate(language,'history.quickResume.pending')));
  }
});
