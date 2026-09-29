import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSnapshot } from '../lib/snapshot.mjs'
const root=mkdtempSync(join(tmpdir(),'process-snapshot-'))
const map={title:'Demo',stages:['Start','Follow up'],nodes:[{id:'page',stage:'Start',kind:'page',title:'Page',purpose:'Start',source:'demo/page/'},{id:'series',stage:'Follow up',kind:'series',title:'Series',purpose:'Follow up',source:'.mailings/storage/processes/demo/series/'}],links:[{from:'page',to:'series',when:'After one day',via:'demo/automations/'}],needsInput:[{title:'Approve texts',nodeId:'series'}]}
mkdirSync(join(root,'demo/page'),{recursive:true});mkdirSync(join(root,'demo/automations'),{recursive:true});mkdirSync(join(root,'.mailings/storage/processes/demo/series'),{recursive:true})
writeFileSync(join(root,'.mailings/storage/processes/demo/series/01.message.yaml'),'title: Hello\nsubject: Your booking\n')
writeFileSync(join(root,'demo/automations/test.automationConfig.json'),JSON.stringify({steps:[{type:'delay',delay:{type:'delay',amount:1,units:'days'}},{type:'condition',conditionName:'Paid?',thenBranch:{steps:[{type:'action',actionName:'Thank you',params:{letterPath:'.mailings/storage/processes/demo/series/01.message.yaml'}}]},elseBranch:{steps:[{type:'action',actionName:'Reminder',params:{letterPath:'.mailings/storage/processes/demo/series/01.message.yaml'}}]}}]}))
const build=(extra={})=>buildSnapshot({root,slug:'demo',map,checks:[],branch:'process/demo',commit:'a'.repeat(40),...extra})
test('letters, action branches and needs-input survive in snapshot',()=>{const s=build();assert.equal(s.nodes[1].status,'needs-input');assert.equal(s.nodes[1].letters[0].subject,'Your booking');assert.equal(s.links[0].steps.length,4);assert.match(s.links[0].steps[2].title,/Thank you/);assert.match(s.links[0].steps[3].title,/Reminder/);assert.doesNotMatch(s.links[0].steps[0].detail,/[{}]/)})
test('absent source is missing even when it needs approval',()=>{const s=build({map:{...map,nodes:map.nodes.map(n=>({...n,source:'absent/'}))}});assert.equal(s.nodes[1].status,'missing')})
test('invalid maps are not published as empty or healthy',()=>assert.throws(()=>build({checks:[{id:'map',ok:false,errors:['invalid'],warnings:[]}]})))
test('traversal is rejected before reading files',()=>assert.throws(()=>build({map:{...map,nodes:[{...map.nodes[0],source:'../outside'}]}})))
test('path-specific errors override existence',()=>{const s=build({checks:[{id:'code',ok:false,errors:['demo/page/index.ts is broken'],warnings:[]}]});assert.equal(s.nodes[0].status,'error')})
test('shared automation omits another series and its trailing waits',()=>{const other={...map,nodes:[...map.nodes,{id:'other',stage:'Follow up',kind:'series',title:'Other',purpose:'',source:'.mailings/storage/processes/demo/other/'}],links:[{from:'page',to:'other',via:'demo/automations/',when:'Now'}]};assert.equal(build({map:other}).links[0].steps.length,0)})
process.on('exit',()=>rmSync(root,{recursive:true,force:true}))
