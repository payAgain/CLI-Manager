import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const read=path=>readFileSync(new URL(path,import.meta.url),'utf8');
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const deferred=()=>{let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return{promise,resolve,reject};};
const target=(id='external')=>({project:{id:'repo',name:'CLI-Manager',path:'/repo'},worktree:{id,project_id:'repo',name:`codex/${id}`,path:`/trees/${id}`,branch:`codex/${id}`,origin:'discovered'}});
const preflight=(extra={})=>({confirmationToken:'review-one',worktreePath:'/trees/external',branch:'codex/external',detached:false,head:'abc123',locked:false,dirty:false,stagedCount:0,unstagedCount:0,untrackedCount:0,changedPaths:[],runningSessions:[],externalProcesses:[],...extra});
const sameDeps=(a,b)=>Boolean(a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index])));
function harness(options={}){
 const hooks=[],effects=[];let cursor=0,tree,props={open:true,targets:options.targets??[target()],onClose:()=>closed.push(true),onRemoved:ids=>removed.push(ids)};
 const calls=[],checks=[],closed=[],removed=[],notices=[];
 let check=options.preflight??(async()=>preflight()),remove=options.remove??(async()=>{});
 const react={
  useState(initial){const index=cursor++;if(!(index in hooks))hooks[index]=typeof initial==='function'?initial():initial;return[hooks[index],value=>{hooks[index]=typeof value==='function'?value(hooks[index]):value;}];},
  useRef(initial){const index=cursor++;if(!(index in hooks))hooks[index]={current:initial};return hooks[index];},
  useMemo(fn,deps){const index=cursor++;if(!hooks[index]||!sameDeps(hooks[index].deps,deps))hooks[index]={deps,value:fn()};return hooks[index].value;},
  useCallback(fn,deps){return react.useMemo(()=>fn,deps);},
  useEffect(fn,deps){const index=cursor++;if(!hooks[index]||!sameDeps(hooks[index].deps,deps)){const previous=hooks[index];hooks[index]={deps};effects.push(()=>{previous?.cleanup?.();hooks[index].cleanup=fn();});}},
 };
 const store={preflightRemoval:async record=>{checks.push(record.id);return check(record);},removeWorktree:async(...args)=>{calls.push(args);return remove(...args);}};
 const mocks={react,'react/jsx-runtime':require('react/jsx-runtime'),'lucide-react':{RefreshCw:'svg'},sonner:{toast:Object.fromEntries(['success','info'].map(name=>[name,(...args)=>notices.push([name,...args])]))},
  '../../lib/i18n':{useI18n:()=>({t:(key,params)=>params?`${key} ${JSON.stringify(params)}`:key})},'../../stores/worktreeStore':{useWorktreeStore:selector=>selector(store)},
  '../ui/dialog':Object.fromEntries(['Dialog','DialogContent','DialogDescription','DialogFooter','DialogTitle'].map(name=>[name,name])), '../ui/button':{Button:'button'},
 };
 const exports={};new Function('exports','require',compile(read('../src/components/worktree/WorktreeRemoveDialog.tsx')))(exports,name=>{assert.ok(mocks[name],`unexpected dependency ${name}`);return mocks[name];});
 const render=()=>{cursor=0;tree=exports.WorktreeRemoveDialog(props);for(const effect of effects.splice(0))effect();return tree;};
 const settle=async()=>{for(let i=0;i<18;i++)await Promise.resolve();render();};
 render();
 return{calls,checks,closed,removed,notices,render,settle,get tree(){return tree;},setCheck(fn){check=fn;},setRemove(fn){remove=fn;},setProps(next){props={...props,...next};render();}};
}
function all(node,predicate,out=[]){if(Array.isArray(node)){for(const child of node)all(child,predicate,out);return out;}if(!node||typeof node!=='object')return out;if(predicate(node))out.push(node);all(node.props?.children,predicate,out);return out;}
const text=node=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(' '):node?.props?text(node.props.children):'';
const button=h=>all(h.tree,node=>node.type==='button'&&node.props.variant==='destructive')[0];
const checkbox=(h,key)=>all(h.tree,node=>node.type==='label'&&text(node).includes(key))[0]?.props.children[0];
const refresh=h=>all(h.tree,node=>node.type==='button'&&node.props['aria-label']==='worktree.remove.recheck')[0];

test('external clean removal requires completed checks and defaults to keeping its branch',async()=>{
 const pending=deferred(),h=harness({preflight:()=>pending.promise});assert.equal(button(h).props.disabled,true);assert.equal(h.calls.length,0);
 pending.resolve(preflight());await h.settle();assert.equal(button(h).props.disabled,false);assert.equal(checkbox(h,'deleteBranch').props.checked,false);
 button(h).props.onClick();await h.settle();assert.equal(h.calls.length,1);assert.equal(h.calls[0][1],false);assert.deepEqual(h.calls[0][2],{preflight:preflight(),discardChanges:false,closeSessions:false});
 assert.deepEqual(h.removed,[['external']]);assert.equal(h.closed.length,1);
});

test('dirty files and running sessions need separate explicit acknowledgements',async()=>{
 const review=preflight({dirty:true,untrackedCount:1,changedPaths:['notes.txt'],runningSessions:[{sessionId:'shell',title:'Active build'}]});
 const h=harness({preflight:async()=>review});await h.settle();assert.equal(button(h).props.disabled,true);
 checkbox(h,'discardChanges').props.onChange({target:{checked:true}});h.render();assert.equal(button(h).props.disabled,true);
 checkbox(h,'closeSessions').props.onChange({target:{checked:true}});h.render();assert.equal(button(h).props.disabled,false);
 button(h).props.onClick();await h.settle();assert.equal(h.calls[0][2].discardChanges,true);assert.equal(h.calls[0][2].closeSessions,true);assert.equal(h.calls[0][1],false);
});

test('locked worktrees, external processes and failed checks block deletion without side effects',async()=>{
 for(const review of [preflight({locked:true}),preflight({externalProcesses:[{pid:100,name:'codex'}]})]){
  const h=harness({preflight:async()=>review});await h.settle();assert.equal(button(h).props.disabled,true);assert.equal(h.calls.length,0);
 }
 const h=harness({preflight:async()=>{throw Error('worktree_remove_primary');}});await h.settle();assert.equal(button(h).props.disabled,true);assert.ok(text(h.tree).includes('worktree.remove.primary'));assert.equal(h.calls.length,0);
});

test('detached HEAD has no branch deletion choice and cannot send deleteBranch true',async()=>{
 const h=harness({preflight:async()=>preflight({detached:true,branch:null})});await h.settle();assert.equal(checkbox(h,'deleteBranch'),undefined);
 button(h).props.onClick();await h.settle();assert.equal(h.calls[0][1],false);
});

test('refresh resets destructive choices and a changed review never reuses the old confirmation',async()=>{
 let generation=1;const h=harness({preflight:async()=>preflight({confirmationToken:`review-${generation}`,dirty:true,changedPaths:[`file-${generation}`]})});await h.settle();
 checkbox(h,'discardChanges').props.onChange({target:{checked:true}});h.render();assert.equal(button(h).props.disabled,false);
 generation=2;refresh(h).props.onClick();await h.settle();assert.equal(checkbox(h,'discardChanges').props.checked,false);assert.equal(button(h).props.disabled,true);assert.equal(h.calls.length,0);
 checkbox(h,'discardChanges').props.onChange({target:{checked:true}});h.render();button(h).props.onClick();await h.settle();assert.equal(h.calls[0][2].preflight.confirmationToken,'review-2');
});

test('a stale backend confirmation refreshes remaining data and resets acknowledgements',async()=>{
 let generation=1;const h=harness({preflight:async()=>preflight({confirmationToken:`review-${generation}`,dirty:true,changedPaths:[`file-${generation}`]}),remove:async()=>{generation=2;throw Error('worktree_remove_confirmation_changed');}});await h.settle();
 checkbox(h,'discardChanges').props.onChange({target:{checked:true}});h.render();button(h).props.onClick();await h.settle();
 assert.equal(h.calls.length,1);assert.equal(h.closed.length,0);assert.equal(h.removed.length,0);assert.equal(checkbox(h,'discardChanges').props.checked,false);assert.equal(button(h).props.disabled,true);assert.ok(text(h.tree).includes('worktree.remove.checkChanged'));
});

test('batch failure stops and retains only unremoved targets for a new review',async()=>{
 let fail=true;const h=harness({targets:[target('one'),target('two'),target('three')],preflight:async record=>preflight({confirmationToken:record.id,worktreePath:record.path}),remove:async record=>{if(record.id==='two'&&fail)throw Error('changed');}});await h.settle();
 button(h).props.onClick();await h.settle();assert.deepEqual(h.calls.map(args=>args[0].id),['one','two']);assert.deepEqual(h.removed,[['one']]);assert.equal(h.closed.length,0);assert.equal(h.checks.filter(id=>id==='one').length,1);
 fail=false;button(h).props.onClick();await h.settle();assert.deepEqual(h.calls.map(args=>args[0].id),['one','two','two','three']);assert.deepEqual(h.removed,[['one'],['two','three']]);assert.equal(h.closed.length,1);
});

test('rapid repeated clicks cannot start another destructive operation while removal is pending',async()=>{
 const pending=deferred(),h=harness({remove:()=>pending.promise});await h.settle();const confirm=button(h);confirm.props.onClick();confirm.props.onClick();await h.settle();assert.equal(h.calls.length,1);assert.equal(button(h).props.disabled,true);
 pending.resolve();await h.settle();assert.equal(h.closed.length,1);
});

test('a preflight response from a dismissed dialog cannot replace a later target review',async()=>{
 const first=deferred(),h=harness({preflight:()=>first.promise});h.setProps({open:false});
 h.setCheck(async record=>preflight({confirmationToken:'new',worktreePath:record.path}));h.setProps({open:true,targets:[target('new')]});await h.settle();
 first.resolve(preflight());await h.settle();assert.ok(text(h.tree).includes('/trees/new'));assert.ok(!text(h.tree).includes('/trees/external'));assert.equal(h.calls.length,0);
});

test('review keeps exact total when the backend returns a truncated file sample',async()=>{
 const h=harness({preflight:async()=>preflight({dirty:true,changedCount:164,changedPaths:Array.from({length:100},(_,index)=>`file-${index}.txt`)})});await h.settle();
 const content=text(h.tree);assert.ok(content.includes('worktree.remove.changes {"count":164}'));assert.ok(content.includes('worktree.remove.moreFiles {"count":156}'));
 assert.ok(content.includes('file-7.txt'));assert.ok(!content.includes('file-8.txt'));
});

test('known backend blocking reasons remain actionable instead of falling back to a generic error',async()=>{
 const cases={primary:'primary',locked:'locked',nested_worktree:'nestedWorktree',path_missing:'pathMissing',sessions_unavailable:'sessionsUnavailable',sessions_running:'sessionsRunning',processes_running:'externalProcessesAction',wsl_sessions:'wslSessions',unsupported_environment:'unsupportedEnvironment',inspection_failed:'checkFailed',confirmation_required:'confirmationRequired',confirmation_expired:'confirmationExpired',changes_confirmation_required:'changesConfirmationRequired',changed:'checkChanged',branch_in_use:'branchInUse',busy:'busy'};
 for(const[code,key]of Object.entries(cases)){
  const h=harness({preflight:async()=>{throw Error(`worktree_remove_${code}`);}});await h.settle();
  assert.ok(text(h.tree).includes(`worktree.remove.${key}`),code);assert.equal(button(h).props.disabled,true);assert.equal(h.calls.length,0);
 }
});
