import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {templatePath, templateFiles} from '../lib/letters.mjs'
import {buildSnapshot} from '../lib/snapshot.mjs'
const script = name => fileURLToPath(new URL(`../${name}.mjs`, import.meta.url))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mailings-process-'))
  t.after(() => rmSync(root, {recursive:true,force:true}))
  const put = (p,s) => {mkdirSync(dirname(join(root,p)),{recursive:true}); writeFileSync(join(root,p),s)}
  const run = (name,args=[]) => spawnSync(process.execPath,[script(name),'demo','--root',root,...args],{encoding:'utf8',timeout:15000})
  const result = run('scaffold'); assert.equal(result.status,0,result.stderr)
  return {root,put,run}
}
test('scaffold creates policy without per-process sending or file-access endpoints and preserves existing helpers', t => {
  const f = fixture(t)
  for (const path of ['demo/actions/send-letter.ts','demo/actions/register.ts','demo/tests/ops.ts','.mailings/storage/read-letter.ts'])
    assert.equal(existsSync(join(f.root,path)),false,path)
  const ws = JSON.parse(readFileSync(join(f.root,'demo/.workspace.json'),'utf8'))
  assert.deepEqual(ws.config.mailings,{testOnly:true,testContacts:[]})
  f.put('.mailings/storage/read-letter.ts','existing reader')
  assert.equal(f.run('scaffold').status,0)
  assert.equal(readFileSync(join(f.root,'.mailings/storage/read-letter.ts'),'utf8'),'existing reader')
})
test('template lookup includes all SDK variants, keeps legacy exact paths and rejects traversal',t=>{
  const f=fixture(t)
  const prefix='.mailings/storage/processes/demo/series/'
  for(const name of ['welcome','welcome.v2','welcomex.v3']) f.put(prefix+name+'.message.yaml','title: Hello')
  const step={params:{messageKey:'processes/demo/series/welcome.v8.message.yaml'}}
  assert.deepEqual(templateFiles(f.root,step),[prefix+'welcome.message.yaml',prefix+'welcome.v2.message.yaml'])
  assert.deepEqual(templateFiles(f.root,{params:{letterPath:prefix+'welcome.v2.message.yaml'}}),[prefix+'welcome.v2.message.yaml'])
  for(const key of ['../private','/private','a//b','a\\b',{ $ref:'event.key' }]) assert.throws(()=>templatePath({params:{messageKey:key}}))
})
test('checker validates plugin route against registry, variables in every variant, and no longer requires reader',t=>{
  const f=fixture(t)
  f.put('demo/process.yaml','title: Demo\naccountId: 10\nstages: []\nnodes: []\nlinks: []\n')
  const action={type:'action',id:'send',actionName:'Send',actionRoute:{routeType:'function',routeJson:[20,'plugin/automations/send-template','/send']},params:{messageKey:'processes/demo/series/welcome',var_name:'Anna'}}
  f.put('demo/automations/send.automationConfig.json',JSON.stringify({title:'Send',eventUrls:['external:event'],settings:{continueOnError:true},steps:[action]}))
  const letter='title: Hello\ndescription: Welcome\nsubject: "{{name}}"\nplain: "{{name}}"\nhtml: "{{name}}"\nshort: "{{name}}"\nvariables:\n - name: name\n   description: Name\n   required: true\n'
  f.put('.mailings/storage/processes/demo/series/welcome.message.yaml',letter)
  f.put('.mailings/storage/processes/demo/series/welcome.v2.message.yaml',letter.replaceAll('{{name}}','{{extra}}').replace('name: name','name: extra'))
  const check=(args=[])=>JSON.parse(f.run('check',['--no-snapshot','--json',...args]).stdout).checks
  let checks=check()
  assert.equal(checks.find(c=>c.id==='automations').ok,false)
  assert.ok(checks.find(c=>c.id==='letters').errors.some(e=>e.includes('var_extra')))
  assert.equal(checks.some(c=>c.id==='letters.reader'),false)
  const registry=join(f.root,'registry.json')
  f.put('registry.json',JSON.stringify({accountId:10,actions:[{routeJson:action.actionRoute.routeJson,inputSchema:[{name:'messageKey',required:true}]}]}))
  action.params.var_extra='Provided'
  f.put('demo/automations/send.automationConfig.json',JSON.stringify({title:'Send',eventUrls:['external:event'],steps:[action]}))
  checks=check(['--registry',registry])
  assert.equal(checks.find(c=>c.id==='automations').ok,true)
  assert.equal(checks.find(c=>c.id==='letters').ok,true)
  assert.equal(checks.find(c=>c.id==='letters.transport').ok,true)
  f.put('registry.json',JSON.stringify({events:[],actions:[{routeJson:action.actionRoute.routeJson,inputSchema:[{name:'messageKey',required:true}]}],conditions:[]}))
  assert.equal(check(['--registry',registry]).find(c=>c.id==='automations').ok,true)
  f.put('.mailings/storage/processes/demo/series/welcome.message.yaml', letter.replace('short: "{{name}}"\n', ''))
  checks=check(['--registry',registry])
  assert.ok(!checks.find(c=>c.id==='letters').errors.some(e=>e.includes('поле short')))
  f.put('.mailings/storage/processes/demo/series/welcome.message.yaml', letter.replace('short: "{{name}}"', 'short: "Откройте материал..."'))
  checks=check(['--registry',registry])
  assert.ok(checks.find(c=>c.id==='letters').warnings.some(w=>w.includes('выглядит обрезанной')))
  f.put('.mailings/storage/processes/demo/series/welcome.message.yaml', letter)
  f.put('registry.json',JSON.stringify({accountId:999,actions:[{routeJson:action.actionRoute.routeJson}]}))
  assert.equal(check(['--registry',registry]).find(c=>c.id==='automations').ok,false)
})
test('snapshot attributes messageKey sends to their series without losing automationFiles',t=>{
  const f=fixture(t)
  const series='.mailings/storage/processes/demo/series/'
  f.put(series+'welcome.message.yaml','title: Hello\nsubject: Hello\n')
  f.put('demo/page/index.ts','export {}')
  f.put('demo/automations/a.automationConfig.json',JSON.stringify({steps:[{type:'delay',delay:{type:'delay',amount:1,units:'days'}},{type:'action',actionName:'Welcome',params:{messageKey:'processes/demo/series/welcome'}},{type:'action',actionName:'Other',params:{messageKey:'processes/demo/other/letter'}}]}))
  const s=buildSnapshot({root:f.root,slug:'demo',branch:'main',commit:'a'.repeat(40),checks:[],map:{title:'Demo',stages:['Start'],nodes:[{id:'page',kind:'page',title:'Page',stage:'Start',source:'demo/page/'},{id:'series',kind:'series',title:'Series',stage:'Start',source:series}],links:[{from:'page',to:'series',when:'Next',via:'demo/automations/'}]}})
  assert.deepEqual(s.links[0].steps.map(s=>s.kind),['delay','action'])
  assert.deepEqual(s.links[0].automationFiles,['demo/automations/a.automationConfig.json'])
})

test('missing or invalid sender channels warn without adding failures to the check', t => {
  const f = fixture(t)
  const ws = JSON.parse(readFileSync(join(f.root, 'demo/.workspace.json'), 'utf8'))
  const check = channels => {
    ws.config.senderChannels = channels
    f.put('demo/.workspace.json', JSON.stringify(ws))
    const result = f.run('check', ['--no-snapshot', '--json'])
    assert.ok([0, 1].includes(result.status), result.stderr)
    const report = JSON.parse(result.stdout)
    return {status: result.status, report, workspace: report.checks.find(c => c.id === 'workspace')}
  }
  const configured = check(['email-channel-id', 'telegram-channel-id'])
  assert.equal(configured.workspace.ok, true)
  assert.deepEqual(configured.workspace.warnings, [])
  for (const channels of [undefined, [], null, 'email-channel-id', [''], ['  '], [42]]) {
    const result = check(channels)
    assert.equal(result.workspace.ok, true)
    assert.deepEqual(result.workspace.errors, [])
    assert.ok(result.workspace.warnings.some(w => w.includes('config.senderChannels')))
    assert.equal(result.status, configured.status)
    assert.equal(result.report.passed, configured.report.passed)
    assert.equal(result.report.total, configured.report.total)
  }
  const text = f.run('check', ['--no-snapshot'])
  assert.match(text.stdout, /! config\.senderChannels/)
})

test('local message action may prepare variables while template and variant checks remain active', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'title: Demo\naccountId: 10\nstages: []\nnodes: []\nlinks: []\n')
  f.put('demo/actions/confirm-order.ts', `import { sendMessageFromTemplate } from '@mailings/sdk'
export const confirmOrder = app.function('/send').handle(async (ctx, {params}) => {
  const order = await Orders.findById(ctx, params.orderId)
  return sendMessageFromTemplate(ctx, {
    messageKey: params.messageKey,
    contacts: [{type: 'email', value: order.email}],
    variables: {name: order.name, date: order.date},
  })
})`)
  const action = {type: 'action', id: 'send', actionName: 'Confirm order',
    actionRoute: {routeType: 'function', routeJson: [10, 'demo/actions/confirm-order', '/send']},
    params: {messageKey: 'processes/demo/series/confirmation', orderId: 'order-id'}}
  const saveAction = () => f.put('demo/automations/send.automationConfig.json', JSON.stringify({
    title: 'Confirmation', eventUrls: ['external:event'], steps: [action],
  }))
  saveAction()
  const prefix = '.mailings/storage/processes/demo/series/confirmation'
  const letter = 'title: Confirmation\ndescription: Order\nsubject: "{{name}}"\nplain: "{{name}}"\nhtml: "{{name}}"\nshort: "{{name}}"\nvariables:\n - name: name\n   description: Name\n   required: true\n'
  f.put(prefix + '.message.yaml', letter)
  f.put(prefix + '.v2.message.yaml', letter.replaceAll('{{name}}', '{{date}}').replace('name: name', 'name: date'))
  const check = () => JSON.parse(f.run('check', ['--no-snapshot', '--json']).stdout).checks
  let letters = check().find(c => c.id === 'letters')
  assert.equal(letters.ok, true, JSON.stringify(letters.errors))
  assert.ok(letters.warnings.some(w => w.includes('variables') && w.includes('confirm-order.ts')))
  f.put(prefix + '.v2.message.yaml', letter.replaceAll('{{name}}', '{{undeclared}}'))
  letters = check().find(c => c.id === 'letters')
  assert.equal(letters.ok, false)
  assert.ok(letters.errors.some(e => e.includes('undeclared')))
  f.put(prefix + '.v2.message.yaml', letter)
  action.params.messageKey = 'processes/demo/series/missing'
  saveAction()
  assert.equal(check().find(c => c.id === 'letters').ok, false)
  action.params.messageKey = 'processes/demo/series/confirmation'
  action.actionRoute.routeJson[1] = 'demo/actions/missing'
  saveAction()
  assert.equal(check().find(c => c.id === 'automations').ok, false)
})
