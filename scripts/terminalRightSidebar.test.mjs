import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const source=read('../src/components/TerminalTabs.tsx');
const ast=ts.createSourceFile('TerminalTabs.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const compile=code=>ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
function find(root,predicate){const out=[];const visit=node=>{if(predicate(node))out.push(node);ts.forEachChild(node,visit);};visit(root);return out;}
function expression(name){const node=find(ast,node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)[0];assert.ok(node,`production ${name} exists`);return node.initializer.getText(ast);}
function effectContaining(marker){const node=find(ast,node=>ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.arguments[0]?.getText(ast).includes(marker))[0];assert.ok(node,`production effect ${marker} exists`);return node.arguments[0].getText(ast);}
function evaluate(value,dependencies={}){const exports={};new Function('exports',...Object.keys(dependencies),compile(`exports.value=${value};`))(exports,...Object.values(dependencies));return exports.value;}
const callback=(name,dependencies)=>{const node=find(ast,node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)===name)[0];return evaluate(node.initializer.arguments[0].getText(ast),dependencies);};

function panelState(extra={}){
 const state={rightSidebarVisible:false,sidePanelMerged:true,sidePanelOpen:true,sidePanelTab:'git',statsOpen:false,gitOpen:false,filesOpen:false,tasksPanelOpen:false,templatesOpen:false,...extra};
 const calls=[];const setters={};for(const key of Object.keys(state)){setters[`set${key[0].toUpperCase()}${key.slice(1)}`]=value=>{calls.push([key,value]);state[key]=typeof value==='function'?value(state[key]):value;};}
 return{state,calls,setters};
}

test('the global sidebar control only changes visibility and retains panel/history choices',()=>{
 const h=panelState({rightSidebarVisible:true}),toggle=callback('handleToggleRightSidebar',h.setters);
 toggle();assert.equal(h.state.rightSidebarVisible,false);assert.equal(h.state.sidePanelOpen,true);assert.equal(h.state.sidePanelTab,'git');
 toggle();assert.equal(h.state.rightSidebarVisible,true);assert.deepEqual(h.calls.map(([key])=>key),['rightSidebarVisible','rightSidebarVisible']);
});

test('merged-to-independent conversion keeps its selected panel while remaining hidden',()=>{
 const h=panelState({sidePanelMerged:false,sidePanelOpen:true,sidePanelTab:'files'}),previousSidePanelMergedRef={current:true};
 evaluate(effectContaining('previousSidePanelMergedRef'),{...h.state,...h.setters,previousSidePanelMergedRef})();
 assert.equal(h.state.filesOpen,true);for(const key of ['statsOpen','gitOpen','tasksPanelOpen','templatesOpen','sidePanelOpen'])assert.equal(h.state[key],false,key);
 assert.equal(h.state.rightSidebarVisible,false);assert.ok(!h.calls.some(([key])=>key==='rightSidebarVisible'));
});

test('independent-to-merged conversion keeps the last selected open panel and clears inactive mode flags',()=>{
 const h=panelState({sidePanelMerged:true,sidePanelTab:'files',sidePanelOpen:false,statsOpen:true,filesOpen:true}),previousSidePanelMergedRef={current:false};
 evaluate(effectContaining('previousSidePanelMergedRef'),{...h.state,...h.setters,previousSidePanelMergedRef})();
 assert.equal(h.state.sidePanelOpen,true);assert.equal(h.state.sidePanelTab,'files');assert.equal(h.state.rightSidebarVisible,false);
 for(const key of ['statsOpen','gitOpen','filesOpen','tasksPanelOpen','templatesOpen'])assert.equal(h.state[key],false,key);
});

test('hidden active history is revealed without closing its consumer or resetting its scope',()=>{
 const h=panelState(),calls=[];
 const open=callback('handleOpenHistoryTab',{...h.state,...h.setters,historyOpen:true,closeHistory:()=>calls.push('close'),setActiveWorkspaceTab:tab=>calls.push(tab)});
 open();assert.equal(h.state.rightSidebarVisible,true);assert.deepEqual(calls,['history']);
});

test('explicit file navigation and Git actions reveal hidden tools in either panel mode',async()=>{
 for(const sidePanelMerged of [true,false]){
  const h=panelState({sidePanelMerged,sidePanelOpen:false});
  const open=callback('openFilesPanelForProject',{...h.state,...h.setters,syncFilePanelProject:async()=>true,terminalSidePanelSingleOpen:false,window:{innerWidth:1280}});
  assert.equal(await open({id:'repo'}),true);assert.equal(h.state.rightSidebarVisible,true);assert.equal(h.state.sidePanelTab,'files');assert.equal(sidePanelMerged?h.state.sidePanelOpen:h.state.filesOpen,true);
  h.state.rightSidebarVisible=false;const calls=[];
  const git=callback('handleOpenWorktreeChanges',{...h.state,...h.setters,sessions:[{id:'shell'}],rejectMissingSessionWorktree:()=>false,closeHistory:()=>calls.push('close'),setActiveWorkspaceTab:()=>{},setActive:id=>calls.push(id)});
  git('shell');assert.equal(h.state.rightSidebarVisible,true);assert.equal(h.state.sidePanelTab,'git');assert.ok(calls.includes('shell'));
 }
});

test('history opening has a non-persistent intent sequence even when its existing view makes the request a no-op',async()=>{
 const history=read('../src/stores/historyStore.ts');const historyAst=ts.createSourceFile('historyStore.ts',history,ts.ScriptTarget.Latest,true);
 const open=find(historyAst,node=>ts.isPropertyAssignment(node)&&node.name.getText(historyAst)==='openHistory')[0];assert.ok(open);
 const state={openRequestSeq:4,isOpen:true};
 const callback=evaluate(open.initializer.getText(historyAst),{set:update=>Object.assign(state,typeof update==='function'?update(state):update),get:()=>state,hasExplicitHistoryScope:()=>false});
 await callback();assert.equal(state.openRequestSeq,5);assert.equal(state.isOpen,true);
 const h=panelState();evaluate(effectContaining('historyOpenRequestSeq > 0'),{historyOpenRequestSeq:state.openRequestSeq,...h.setters})();assert.equal(h.state.rightSidebarVisible,true);
});

test('toolbar and panel rendering are gated together without disposing an open history workspace',()=>{
 const toolbar=expression('renderToolbarActions');assert.match(toolbar,/rightSidebarVisible && <SortableContext/);assert.match(toolbar,/handleToggleRightSidebar/);assert.match(toolbar,/aria-expanded=\{rightSidebarVisible\}/);
 assert.match(source,/rightSidebarVisible && \(sidePanelMerged \?/);
 assert.match(source,/display: rightSidebarVisible \? undefined : "none"/);
 assert.match(source,/HistoryWorkspace active=\{historyOpen && rightSidebarVisible\}/);
 assert.match(source,/right: rightSidebarVisible && historyOpen && !historyActive/);
});
