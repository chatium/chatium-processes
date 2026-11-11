import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

test('the actual worker publishes a blocked attempt without calling an SDK effect or changing the plan', () => {
  const harness = `
import vm from 'node:vm'; import fs from 'node:fs'; import * as path from 'node:path'; import * as url from 'node:url';
const run={runId:'run',caseId:'booking',testedCommit:'a'.repeat(40),status:'running',limitations:[],assertions:[]}, saved=[], published=[];
const scenario={id:'booking',script:'demo/tests/scenarios/booking.mjs',expected:['A booking exists']};
const copies=x=>JSON.parse(JSON.stringify(x));
const values={
 'node:fs':{readFileSync:()=>JSON.stringify({root:'/account',slug:'demo',runId:'run',scenario})},'node:path':path,'node:url':url,'node:timers/promises':{setTimeout:async()=>{}},
 './process-testing.mjs':{readTestRun:()=>run,saveRun:(_root,value)=>saved.push(copies(value)),testInputs:()=>{},testPath:(_root,p)=>'/account/'+p,hash:()=>''},
 './test-remote.mjs':{publishRun:(_root,value)=>published.push(copies(value))},
 './test-exec.mjs':{readSession:()=>({context:{token:'private-token'}}),redact:text=>text.replaceAll('private-token','[redacted]'),redactData:value=>value,testSdk:()=>{throw Error('A blocked scenario must not call effects')}}
};
const context=vm.createContext({JSON,Error,Date,Buffer});
const main=new vm.SourceTextModule(fs.readFileSync(process.env.SOURCE_SCRIPT,'utf8'),{context,importModuleDynamically:async()=>{
 const scenarioModule=new vm.SyntheticModule(['default'],function(){this.setExport('default',async t=>t.blocked('Adapter unavailable; private-token'))},{context});
 await scenarioModule.link(()=>{});await scenarioModule.evaluate();return scenarioModule;
}});
await main.link(name=>{const exports=values[name];if(!exports)throw Error(name);return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v]of Object.entries(exports))this.setExport(k,v)},{context})});
await main.evaluate();process.stdout.write(JSON.stringify({saved,published,scenario}));
`
  const result=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module'],{input:harness,encoding:'utf8',env:{...process.env,SOURCE_SCRIPT:fileURLToPath(new URL('../lib/test-worker.mjs',import.meta.url))}})
  assert.equal(result.status,0,result.stderr)
  const value=JSON.parse(result.stdout)
  assert.equal(value.saved.at(-1).status,'blocked')
  assert.equal(value.published.at(-1).status,'blocked')
  assert.deepEqual(value.published.at(-1).limitations,['Adapter unavailable; [redacted]'])
  assert.equal(value.scenario.id,'booking');assert.equal(value.scenario.expected[0],'A booking exists')
})
