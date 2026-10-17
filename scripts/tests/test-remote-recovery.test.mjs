import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const harness=`
import vm from 'node:vm';import fs from 'node:fs';
const pending={process:'demo',branch:'main',runId:'run-one',status:'incomplete',limitations:[]};
let session={context:{runId:'run-one',token:'private'},contacts:[],sequence:1,pendingReport:pending},temp,failed=false;
let server={report:{...pending,status:process.env.MODE==='sealed'?'failed':'running'},sequence:2};const calls=[];
const sdk=(_root,_commit,method,input)=>{
 calls.push(method);
 if(method==='readProcessTestRun')return structuredClone(server);
 if(method==='writeProcessTestRun'){
  if(process.env.MODE==='retry'&&!failed){failed=true;throw Error('metadata unavailable')}
  if(server.report.status!=='running')throw Error('sealed report must not be overwritten');
  if(input.sequence!==server.sequence+1)throw Error('wrong recovered sequence');
  server={report:structuredClone(input.report),sequence:input.sequence};return {sequence:input.sequence};
 }
 if(method==='closeProcessTestContext')return {resources:[],requiredProviders:[],pendingOperations:[]};
 if(method==='getProcessTestCapabilities')return {operations:[]};
 throw Error('Unexpected effect: '+method);
};
const modules={
 'node:fs':{writeFileSync(_path,body){temp=JSON.parse(body)},renameSync(){session=temp},mkdirSync(){}},
 './git-state.mjs':{gitState:()=>({commit:'a'.repeat(40)})},
 './test-exec.mjs':{readSession:()=>structuredClone(session),sessionPath:()=>'/session',testSdk:sdk,redact: v=>v,redactData:v=>v},
 './process-testing.mjs':{hash:()=>'',saveRun(){},testCachePath(){},validateRun(){}}
};
const context=vm.createContext({Date,Error,Set});const source=fs.readFileSync(process.env.SOURCE_SCRIPT,'utf8');
const main=new vm.SourceTextModule(source,{context});
await main.link(name=>{const values=modules[name];if(!values)throw Error('unmocked '+name);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value)},{context})});
await main.evaluate();const first=main.namespace.closeRun('/account','run-one');
const firstPending=Boolean(session.pendingReport);const second=main.namespace.closeRun('/account','run-one');
process.stdout.write(JSON.stringify({first,second,firstPending,session,server,calls}));
`
for(const mode of ['recover','retry','sealed'])test(`cleanup recovers report metadata without replaying business effects: ${mode}`,()=>{
 const result=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module'],{input:harness,encoding:'utf8',env:{...process.env,MODE:mode,SOURCE_SCRIPT:fileURLToPath(new URL('../lib/test-remote.mjs',import.meta.url))}})
 assert.equal(result.status,0,result.stderr)
 const value=JSON.parse(result.stdout)
 assert.equal(value.session.pendingReport,undefined)
 assert.equal(value.server.report.status,mode==='sealed'?'failed':'incomplete')
 assert.ok(!value.calls.includes('executeProcessTestOperation'),'report recovery cannot repeat a business operation')
 if(mode==='retry'){assert.equal(value.first[0].operation,'run.finalize');assert.equal(value.firstPending,true)}
 if(mode==='sealed')assert.equal(value.calls.filter(m=>m==='writeProcessTestRun').length,0)
})
