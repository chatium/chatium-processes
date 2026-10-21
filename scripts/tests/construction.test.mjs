import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {spawnSync} from 'node:child_process'
import {syncBuildProgress} from '../lib/build-progress.mjs'
import {collectBuildEvidence} from '../lib/build-evidence.mjs'
import {resolveBuildState,buildContractFingerprint} from '../lib/build-state.mjs'
const digest=text=>createHash('sha256').update(text).digest('hex')
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'construction-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
  const put=(path,value)=>{mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),typeof value==='string'?value:JSON.stringify(value,null,2)+'\n')}
  const git=(...args)=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
  const map={title:'Demo',stages:['Start'],nodes:[{id:'page',kind:'page',stage:'Start',title:'Page',source:'demo/page.ts'}],links:[],needsInput:[]}
  put('demo/process.yaml',JSON.stringify(map));put('demo/.workspace.json',{});put('demo/page.ts','page');put('demo/tasks/index.json',{version:1})
  put('demo/tasks/W001.json',{id:'W001',title:'Page',targetNode:'page',stage:'build',status:'running',revision:1,expectedOutputs:[{path:'demo/page.ts'}]})
  git('init','-q');git('config','user.email','test@example.invalid');git('config','user.name','Test');git('add','.');git('commit','-qm','Initial');git('remote','add','origin','https://example.invalid/s/source-git/repo')
  const state={commit:git('rev-parse','HEAD'),branch:git('branch','--show-current')}
  const board={snapshot:{revision:1,snapshot:{...state,nodes:[{id:'page',progress:[]}]}}}
  const calls=[]
  const execute=async(root,code)=>{calls.push(code);if(code.includes('readProcessBoardForAgent'))return board;return {saved:true}}
  return{root,put,git,map,state,board,calls,execute}
}
test('offline resolver is pinned and requires all acceptance gates',()=>{
  const code=readFileSync(new URL('../lib/build-state.mjs',import.meta.url),'utf8'),body=code.match(/\/\/ BEGIN SHARED BUILD RESOLVER\n([\s\S]+?)\n  \/\/ END SHARED BUILD RESOLVER/)[1]
  assert.equal(digest(body),buildContractFingerprint)
  const gate=id=>({id,title:id,state:'passed',details:[],evidence:[]}),facts={source:'present',tasks:[{id:'W001',status:'done',acceptance:'accepted',title:'Page',details:[]}],gates:['tasks','review'].map(gate),blockers:[]}
  const common=['technical','typecheck','task-structure','knowledge-build','architecture','implementation','owner-plan'].map(gate)
  assert.equal(resolveBuildState(facts,common).status,'built');assert.equal(resolveBuildState(facts,[]).status,'in-progress')
  assert.equal(resolveBuildState({...facts,gates:[...facts.gates,{...gate('unpublished'),state:'pending'}]},common).status,'in-progress')
})
test('checkpoint publishes metadata, stable request ID and no working source; retry does not repeat task mutation',async t=>{
  const f=fixture(t);f.put('demo/tasks/W001.json',{id:'W001',title:'Page',targetNode:'page',stage:'build',status:'running',revision:2,expectedOutputs:[{path:'demo/page.ts'}]})
  const result=await syncBuildProgress(f.root,'demo',{execute:f.execute});assert.equal(result.status,'synced');assert.equal(f.calls.length,2)
  const event=JSON.parse(f.calls[1].match(/ctx, (.+)\)/)[1]);assert.equal(event.action,'checkpoint');assert.equal(event.event.taskRevision,2);assert.equal(event.event.taskSha256,digest(readFileSync(join(f.root,'demo/tasks/W001.json'))));assert.equal(event.baseCommit,f.state.commit)
  const before=readFileSync(join(f.root,'demo/tasks/W001.json'),'utf8')
  f.calls.length=0;f.board.snapshot.snapshot.nodes[0].progress=[event.event]
  assert.equal((await syncBuildProgress(f.root,'demo',{execute:f.execute})).status,'synced');assert.equal(f.calls.length,1)
  assert.equal(readFileSync(join(f.root,'demo/tasks/W001.json'),'utf8'),before)
  const failed=await syncBuildProgress(f.root,'demo',{execute:async()=>{throw Error('network')}});assert.equal(failed.status,'pending');assert.equal(readFileSync(join(f.root,'demo/tasks/W001.json'),'utf8'),before)
})
test('only clean own workspace claims may be discarded after local revert',async t=>{
  const f=fixture(t);f.put('demo/tasks/W001.json',{id:'W001',title:'Page',targetNode:'page',stage:'build',status:'running',revision:2})
  await syncBuildProgress(f.root,'demo',{execute:f.execute});const event=JSON.parse(f.calls[1].match(/ctx, (.+)\)/)[1]).event
  f.board.snapshot.snapshot.nodes[0].progress=[{...event}, {...event,taskId:'W002',workspaceId:'c'.repeat(32)}]
  f.git('restore','demo/tasks/W001.json');f.calls.length=0
  const result=await syncBuildProgress(f.root,'demo',{execute:f.execute});assert.deepEqual(result.discarded,['W001']);assert.equal(f.calls.length,2);assert.match(f.calls[1],/"action":"discard"/)
})
test('evidence includes code checks, excludes launch-only conditions and refuses fake done',t=>{
  const f=fixture(t)
  f.map.needsInput=[{title:'Connect channel',nodeId:'page',blocks:['launch']}]
  const proof=collectBuildEvidence({root:f.root,slug:'demo',map:f.map,checks:[{id:'automations',title:'Automations',ok:false,errors:['Bad code']},{id:'process.testing',ok:false,errors:['No run']}]})
  assert.equal(proof.assessment.gates.find(g=>g.id==='technical').state,'failed');assert.deepEqual(proof.nodes.get('page').blockers,[])
  assert.equal(proof.nodes.get('page').tasks[0].acceptance,'pending')
  f.put('demo/tasks/W001.json',{id:'W001',title:'Page',targetNode:'page',stage:'build',status:'done',revision:2,expectedOutputs:[{path:'demo/page.ts'}]})
  const changed=collectBuildEvidence({root:f.root,slug:'demo',map:f.map,checks:[]});assert.equal(changed.nodes.get('page').tasks[0].acceptance,'stale')
  assert.ok(changed.assessment.inputs.some(input=>input.path==='demo/page.ts'))
  f.put('demo/reviews/unrelated.md','Unrelated note')
  assert.ok(!collectBuildEvidence({root:f.root,slug:'demo',map:f.map,checks:[]}).assessment.inputs.some(input=>input.path==='demo/reviews/unrelated.md'))
})
