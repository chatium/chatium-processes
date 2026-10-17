import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { stringifyYaml } from '../lib/yaml.mjs'
import { createRun, saveRun, testInputs, readTestRun, testStatus, testPath, validatePlan, validateRun, coverageForTargets, testCachePath, assertTestSourcesCommitted, hash, canonicalTestJson, readTestPlan } from '../lib/process-testing.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-testing-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), typeof source === 'string' ? source : JSON.stringify(source)) }
  const scenario = { id: 'welcome', title: 'Заявка получает письмо', kind: 'runtime', required: true,
    conditions: ['Новый тестовый клиент'], expected: ['Одна отправка'], targets: [{ kind: 'node', id: 'form' }, { kind: 'link', id: 'welcome-link' }],
    sources: ['demo/handler.ts'], script: 'demo/tests/scenarios/welcome.mjs', capabilities: ['mailings.send'] }
  const map = { nodes: [{ id: 'form' }], links: [{ id: 'welcome-link' }] }
  put('demo/.workspace.json', { config: {} }); put('demo/handler.ts', 'export const handler = 1\n')
  put(scenario.script, 'export default async t => {}\n')
  put('demo/tests/plan.yaml', stringifyYaml({ version: 1, cases: [scenario] }))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid')
  git('add', '.'); git('commit', '-m', 'initial')
  const begin = (previousRunId) => {
    const run = createRun({ root, slug: 'demo', scenario, previousRunId }); saveRun(root, run, { create: true }); return run
  }
  const pass = run => {
    run.status = 'passed'; run.finishedAt = new Date().toISOString()
    run.assertions = [{ criterion: 'Одна отправка', ok: true, actual: 1 }]
    run.observations = [{ title: 'Sender', summary: 'Канал принял сообщение' }]
    run.runtime = [{ module: 'sender', kind: 'message', id: 'message-1' }]
    run.limitations = ['Получение адресатом не проверено']; saveRun(root, run); return run
  }
  return { root, put, git, scenario, map, begin, pass, status: () => testStatus({ root, slug: 'demo', map }) }
}

test('successful attempt keeps evidence limits, targets and immutable history', t => {
  const f = fixture(t), first = f.begin()
  first.status = 'failed'; first.finishedAt = new Date().toISOString(); saveRun(f.root, first)
  assert.throws(() => f.pass(first), /перезаписать/)
  const second = f.begin(first.runId); second.startedAt = new Date(Date.now() + 1000).toISOString(); f.pass(second)
  const result = f.status()
  assert.equal(result.cases[0].status, 'passed'); assert.equal(result.runs.length, 2)
  assert.equal(readTestRun(f.root, 'demo', second.runId).previousRunId, first.runId)
  assert.equal(result.cases[0].limitations[0], 'Получение адресатом не проверено')
  assert.equal(coverageForTargets(result.cases, [{ kind: 'link', id: 'welcome-link' }]), 'passed')
  assert.equal(coverageForTargets(result.cases, [{ kind: 'node', id: 'untested' }]), 'not-tested')
})

test('report commits and notes do not stale evidence; source, script and settings edits do', t => {
  const f = fixture(t); f.pass(f.begin())
  assert.equal(f.git('status', '--porcelain').toString(), '')
  f.put('notes.md', 'Независимая заметка')
  f.git('add', '.'); f.git('commit', '-m', 'note')
  assert.equal(f.status().cases[0].status, 'passed')
  for (const path of ['demo/handler.ts', 'demo/.workspace.json', f.scenario.script]) {
    const before = readFileSync(join(f.root, path), 'utf8'); f.put(path, before + '\n')
    assert.equal(f.status().cases[0].status, 'stale', path); f.put(path, before)
  }
})

test('a result from another branch is history, not coverage for this branch', t => {
  const f = fixture(t); f.pass(f.begin()); f.git('switch', '-c', 'process/change')
  assert.equal(f.status().cases[0].status, 'not-tested'); assert.equal(f.status().runs.length, 1)
})

test('all required criteria, runtime references and observations are needed', t => {
  const f = fixture(t), run = f.begin(); f.pass(run)
  assert.throws(() => validateRun({ ...run, runtime: [] }), /ID реального/)
  assert.throws(() => validateRun({ ...run, observations: [] }), /наблюдений/)
  assert.throws(() => validateRun({ ...run, assertions: [{ criterion: 'Одна отправка', ok: false }] }), /Успех/)
  const plan = { version: 1, cases: [{ ...f.scenario, expected: [...f.scenario.expected, 'Правильный адресат'] }] }
  f.put('demo/tests/plan.yaml', stringifyYaml(plan)); assert.equal(f.status().cases[0].status, 'stale')
})

test('artifact integrity is checked and executable/path artifacts are rejected', t => {
  const f = fixture(t), run = f.begin()
  run.artifacts.push({ title: 'Ответ Sender', name: 'sender.json', content: '{}', sha256: hash('{}') }); f.pass(run)
  assert.equal(f.status().cases[0].status, 'passed')
  assert.throws(() => validateRun({ ...run, artifacts: [{ ...run.artifacts[0], content: 'changed' }] }), /изменилось/)
  assert.throws(() => validateRun({ ...run, artifacts: [{ ...run.artifacts[0], name: '../private.json' }] }), /формат/)
})

test('blocking findings retain their originating run and require passing resolution', t => {
  const f = fixture(t), run = f.pass(f.begin())
  const finding = { id: 'wrong-recipient', caseId: 'welcome', title: 'Неверный адресат', severity: 'blocking', status: 'open', openedIn: run.runId, history: [{ at: run.startedAt, note: 'Требуется исправление' }] }
  writeFileSync(testCachePath(f.root, 'demo', 'findings.json'), JSON.stringify({ version: 1, findings: [finding] }))
  assert.equal(f.status().cases[0].status, 'failed')
  writeFileSync(testCachePath(f.root, 'demo', 'findings.json'), JSON.stringify({ version: 1, findings: [{ ...finding, status: 'resolved', resolvedIn: 'missing-run' }] }))
  assert.throws(() => f.status(), /не подтверждено/)
})

test('malformed plans and paths stop before filesystem mutation', t => {
  const f = fixture(t)
  for (const path of ['../secret', '/tmp/secret', 'demo/../secret', 'demo\\secret', 'demo//secret']) assert.throws(() => testPath(f.root, path), /путь/i)
  symlinkSync(tmpdir(), join(f.root, 'outside')); assert.throws(() => testPath(f.root, 'outside/result.json'), /ссылки/)
  for (const change of [s => { s.id = '../bad' }, s => { s.targets = [{ kind: 'link', id: 'missing' }] }, s => { s.script = 'another/run.mjs' }, s => { s.sources = ['demo/tests/runs/a.json'] }]) {
    const scenario = structuredClone(f.scenario); change(scenario)
    assert.throws(() => validatePlan({ version: 1, cases: [scenario] }, { slug: 'demo', map: f.map }))
  }
  assert.throws(() => validatePlan({ version: 1, cases: [f.scenario, f.scenario] }), /повторяющиеся/)
})

test('uncommitted runtime input is rejected before execution', t => {
  const f = fixture(t)
  assertTestSourcesCommitted(f.root, testInputs(f.root, 'demo', f.scenario))
  f.put('demo/handler.ts', 'export const handler = 2\n')
  assert.throws(() => assertTestSourcesCommitted(f.root, testInputs(f.root, 'demo', f.scenario)), /изменён/)
})


test('cleanup touches owned and declared providers, including unregistered resources, without unrelated modules', async () => {
  const { cleanupModules } = await import('../lib/test-remote.mjs')
  const capabilities = [
    {id:'crm.cleanup',provider:'crm',effect:'cleanup',available:true},
    {id:'agents.cleanup',provider:'agent-process',effect:'cleanup',available:true},
    {id:'sender.cleanup',provider:'sender',effect:'cleanup',available:true},
    {id:'mailings.cleanup',provider:'mailings',effect:'cleanup',available:false},
  ]
  assert.deepEqual([...cleanupModules({resources:[],requiredProviders:['crm','agent-process']},capabilities)].sort(),['agents','crm'])
  assert.deepEqual([...cleanupModules({resources:[{module:'mailings'}],requiredProviders:[]},capabilities)],['mailings'])
})

test('structured redaction preserves numeric JSON and removes nested credentials before persistence', async () => {
  const {redactData} = await import('../lib/test-exec.mjs')
  const cleaned = redactData({chatId:123456789,items:[{api_key:'private',accessToken:'token',cookie:'session'}],description:'user 123456789',count:2},['123456789'])
  assert.equal(JSON.parse(JSON.stringify(cleaned)).chatId,'[redacted]')
  assert.equal(cleaned.items[0].api_key,'[redacted]');assert.equal(cleaned.items[0].accessToken,'[redacted]');assert.equal(cleaned.items[0].cookie,'[redacted]');assert.equal(cleaned.count,2)
})

test('case hash survives object key reordering and YAML date-like scalars stay strings',t=>{
 const f=fixture(t), reversed=JSON.parse(JSON.stringify(f.scenario,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v))
 assert.equal(hash(canonicalTestJson(f.scenario)),hash(canonicalTestJson(reversed)))
 const source=readFileSync(join(f.root,'demo/tests/plan.yaml'),'utf8').replace('Новый тестовый клиент','2026-10-17')
 f.put('demo/tests/plan.yaml',source)
 assert.equal(readTestPlan(f.root,'demo',f.map).cases[0].conditions[0],'2026-10-17')
})

test('privacy cleaning preserves report references and dates while removing contacts and opaque secrets',async()=>{
 const {redactData}=await import('../lib/test-exec.mjs')
 const value=redactData({version:1,branch:'codex/process-testing',runtime:[{id:'test',kind:'observation'}],artifacts:[{name:'test.json'}],recipient:1,message:'test value',at:new Date('2026-10-17T00:00:00Z'),nested:{id:'opaque-secret'}},['opaque-secret'],['test','1'])
 assert.equal(value.version,1);assert.equal(value.branch,'codex/process-testing');assert.equal(value.runtime[0].id,'test');assert.equal(value.artifacts[0].name,'test.json')
 assert.equal(value.recipient,'[redacted]');assert.equal(value.message,'[redacted] value');assert.equal(value.nested.id,'[redacted]');assert.equal(value.at,'2026-10-17T00:00:00.000Z')
})
