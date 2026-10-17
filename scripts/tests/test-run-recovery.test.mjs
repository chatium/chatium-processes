import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

// Execute the real CLI with a simulated SDK boundary; no accounts, messages or Git remotes are touched.
const harness = `
import vm from 'node:vm';import fs from 'node:fs';import * as path from 'node:path';import * as url from 'node:url';
const mode=process.env.MODE,commit='a'.repeat(40),calls=[],copies=x=>JSON.parse(JSON.stringify(x));
let local,remote,caps=0,publishes=0;
const run={runId:'run',caseId:'case',testedCommit:commit,branch:'main',status:'running',inputs:{files:[]},limitations:[]};
const scenario={id:'case',kind:'runtime',capabilities:['sender.send']};
const sdk=(_root,_commit,method)=>{
 calls.push(method);
 if(method==='getProcessTestCapabilities'){if(++caps===2&&mode==='capabilities')throw Error('capabilities unavailable');return {version:2,operations:[{id:'sender.send',available:true}]}}
 if(method==='createProcessTestContext')return {context:{runId:'run',token:'private'},scope:{codeFingerprints:{}}};
 throw Error(method);
};
const modules={
 'node:child_process':{spawnSync(){calls.push('worker');if(mode==='sealed'){local={...run,status:'passed'};remote=copies(local)}return {status:0}}},
 'node:fs':{readFileSync:file=>file==='/outside/scope.json'?'{}':'{}',realpathSync:p=>p},'node:path':path,'node:url':url,
 './lib/project.mjs':{parseArgs:()=>({positional:['demo','run'],options:{case:'case',scope:'/outside/scope.json'}}),findRoot:()=>'/account'},
 './lib/git-state.mjs':{git:()=>commit,gitState:()=>({branch:'main',commit})},'./lib/yaml.mjs':{parseYaml:()=>({})},
 './lib/process-testing.mjs':{assertTestSourcesCommitted(){},hash:()=>'',createRun:()=>copies(run),readTestPlan:()=>({cases:[scenario]}),readTestRun:()=>copies(local),saveRun:(_root,value)=>{local=copies(value)},testPath:(_root,p)=>'/account/'+p,testStatus:()=>({})},
 './lib/test-exec.mjs':{readSession:()=>({context:{token:'private'},contacts:[]}),saveSession(){},saveTestPluginBranches(){},testSdk:sdk,redact:x=>x,redactData:x=>x,platformTestLogs:()=>[]},
 './lib/test-remote.mjs':{
  publishRun(_root,value){calls.push('publish:'+value.status);publishes++;remote=copies(value);if(mode==='publish'&&publishes===1)throw Error('lost initial publish response')},
  recoverSequence(){calls.push('recover');if(mode==='recovery'||mode==='sealed')throw Error('recovery unavailable');return copies(remote)},
  fetchRun:()=>({report:copies(remote),effectiveStatus:remote?.status}),closeRun(){calls.push('close');return []}
 }
};
// Scope validation still occurs in the CLI before any SDK execution.
modules['node:fs'].readFileSync=file=>file==='/outside/scope.json'?JSON.stringify({contacts:[],channels:[]}):'{}';
const errors=[],fakeProcess={argv:[],exitCode:0,execPath:process.execPath};
const context=vm.createContext({process:fakeProcess,console:{log(){},error:v=>errors.push(v)},Buffer});
const source=fs.readFileSync(process.env.SOURCE_SCRIPT,'utf8');
const main=new vm.SourceTextModule(source,{context,identifier:url.pathToFileURL(process.env.SOURCE_SCRIPT).href,initializeImportMeta:meta=>{meta.url=url.pathToFileURL(process.env.SOURCE_SCRIPT).href}});
await main.link(name=>{const values=modules[name];if(!values)throw Error('Unmocked import '+name);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value)},{context})});
await main.evaluate();process.stdout.write(JSON.stringify({calls,local,remote,errors,code:fakeProcess.exitCode}));
`
for (const mode of ['capabilities','recovery','publish','sealed']) test(`CLI finalizes interrupted work and closes its context: ${mode}`,()=>{
 const result=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module'],{input:harness,encoding:'utf8',
  env:{...process.env,MODE:mode,SOURCE_SCRIPT:fileURLToPath(new URL('../test.mjs',import.meta.url))}})
 assert.equal(result.status,0,result.stderr)
 const value=JSON.parse(result.stdout)
 assert.ok(value.calls.includes('close'));assert.equal(value.code,2)
 assert.equal(value.remote.status,mode==='sealed'?'passed':'incomplete')
 assert.equal(value.local.status,mode==='sealed'?'passed':'incomplete')
 if(mode==='sealed')assert.equal(value.calls.filter(c=>c.startsWith('publish:')).length,1,'do not rewrite a sealed report')
 if(mode==='capabilities')assert.ok(!value.calls.includes('worker'),'capability failure must precede scenario execution')
})
