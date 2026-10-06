import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkScript = fileURLToPath(new URL('../check.mjs', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-check-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', 'title: Demo\nnodes: []\nlinks: []\n')
  const run = (...flags) => spawnSync(process.execPath,
    [checkScript, 'demo', '--root', root, '--no-snapshot', '--json', ...flags],
    { encoding: 'utf8', timeout: 15_000 })
  return { root, put, run }
}

test('unknown option exits before any snapshot or output-file write', t => {
  const f = fixture(t)
  const target = join(f.root, 'should-not-exist.json')
  const result = f.run('--no-snapshto', '--snapshot-file', target)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--no-snapshto/)
  assert.throws(() => readFileSync(target))
})

test('large JSON result is complete when check exits with failed checks', t => {
  const f = fixture(t)
  f.put('demo/automations/large.automationConfig.json', JSON.stringify({
    title: 'Large validation', eventUrls: ['event://external/test'],
    steps: Array.from({ length: 12_000 }, (_, index) => ({ id: `step-${index}`, type: 'unsupported' })),
  }))
  const result = spawnSync(process.execPath,
    [checkScript, 'demo', '--root', f.root, '--no-snapshot', '--json'],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(result.status, 1, result.stderr)
  assert.ok(Buffer.byteLength(result.stdout) > 1024 * 1024, 'output must exercise a result over 1 MiB')
  const report = JSON.parse(result.stdout)
  assert.equal(report.checks.find(check => check.id === 'automations').errors.length, 12_000)
  assert.ok(report.snapshot)
})

test('boolean snapshot option with an equals value is rejected before writing', t => {
  const f = fixture(t)
  const target = join(f.root, 'should-not-exist.json')
  const result = spawnSync(process.execPath,
    [checkScript, 'demo', '--root', f.root, '--publish-snapshot=false', '--snapshot-file', target],
    { encoding: 'utf8', timeout: 15_000 })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--publish-snapshot/)
  assert.throws(() => readFileSync(target))
})

test('design gate asks for design review without requiring implementation sources', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'title: Demo\nstages: [Lead]\nknowledge: .knowledge-base/processes/demo\nnodes:\n  - id: home\n    kind: page\n    stage: Lead\n    title: Home\n    purpose: Capture\n    source: demo/home/\nlinks: []\n')
  const checks = JSON.parse(f.run('--task-stage', 'design').stdout).checks
  assert.equal(checks.find(check => check.id === 'implementation.review'), undefined)
  assert.match(checks.find(check => check.id === 'knowledge.review').title, /design/)
  const commission = checks.find(check => check.id === 'reviews')
  assert.equal(commission.ok, false)
  assert.match(commission.errors.join('\n'), /knowledge-design/)
  assert.match(commission.errors.join('\n'), /architecture/)
  assert.equal(checks.find(check => check.id === 'map.sources').ok, true)
  assert.match(checks.find(check => check.id === 'map.sources').warnings.join('\n'), /этапе сборки/)
})

test('unsupported branches and templated dateExpression fail automations check', t => {
  const f = fixture(t)
  f.put('demo/automations/a.automationConfig.json', JSON.stringify({
    title: 'Test', eventUrls: ['event://external/test'],
    steps: [
      { id: 'branch', type: 'condition', thenBranch: { steps: [] } },
      { id: 'wait', type: 'delay', delay: { type: 'dateExpression', dateExpression: '{{ steps.prepare.date }}' } },
    ],
  }))
  const result = f.run()
  assert.ok(result.stdout, result.stderr)
  const automations = JSON.parse(result.stdout).checks.find(check => check.id === 'automations')
  assert.equal(automations.ok, false)
  assert.match(automations.errors.join('\n'), /condition/)
  assert.match(automations.errors.join('\n'), /thenBranch/)
  assert.match(automations.errors.join('\n'), /JS-выражением/)
})

test('launch requires published action registry even when the local hook imports it', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'title: Demo\naccountId: 10\nnodes: []\nlinks: []\n')
  f.put('demo/actions/send.ts', "export const send = app.function('/send', async () => ({success: true}))\n")
  f.put('demo/automations/send.automationConfig.json', JSON.stringify({ title: 'Send',
    eventUrls: ['event://external/test'], settings: { continueOnError: true },
    steps: [{ id: 'send', type: 'action', actionName: 'Send',
      actionRoute: { routeType: 'function', routeJson: [10, 'demo/actions/send', '/send'] }, params: {} }] }))
  const automations = (...flags) => JSON.parse(f.run(...flags).stdout).checks.find(check => check.id === 'automations')
  assert.match(automations().warnings.join('\n'), /не зарегистрировано/)
  assert.match(automations('--task-stage', 'launch').errors.join('\n'), /не зарегистрировано/)
  f.put('demo/actions/register.ts', "import { send } from './send'\napp.accountHook('@automations/actions', () => [send])\n")
  assert.match(automations('--task-stage', 'launch').errors.join('\n'), /реестр/)
  f.put('registry.json', JSON.stringify({ events: [], actions: [{
    routeJson: [10, 'demo/actions/send', '/send'], inputSchema: [],
  }], conditions: [] }))
  const registered = automations('--task-stage', 'launch', '--registry', join(f.root, 'registry.json'))
  assert.doesNotMatch(registered.errors.join('\n'), /не зарегистрировано|реестр/)
  f.put('demo/actions/register.ts', 'export {}\n')
  assert.doesNotMatch(automations('--task-stage', 'launch', '--registry', join(f.root, 'registry.json')).errors.join('\n'), /не зарегистрировано|реестр/)
  f.put('registry.json', JSON.stringify({ events: [], actions: [], conditions: [] }))
  assert.match(automations('--task-stage', 'launch', '--registry', join(f.root, 'registry.json')).errors.join('\n'), /реестр/)
})

test('letter variables are not mistaken for workspace variables', t => {
  const f = fixture(t)
  f.put('demo/message.ts', 'letter.variables.map(item => item.name); config.variables?.price?.value;\n')
  const result = f.run()
  const workspace = JSON.parse(result.stdout).checks.find(check => check.id === 'workspace')
  assert.match(workspace.errors.join('\n'), /переменная процесса price/)
  assert.doesNotMatch(workspace.errors.join('\n'), /переменная процесса map/)
})

test('launch refuses an empty business variable while build can continue', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', JSON.stringify({ type: 'process', processEngine: 'processes-v2',
    config: { variables: { price: { value: '  ', description: 'Цена предложения' } } } }))
  const checks = (...flags) => JSON.parse(f.run(...flags).stdout).checks
  assert.equal(checks().some(check => check.id === 'launch.variables'), false)
  assert.match(checks('--task-stage', 'launch').find(check => check.id === 'launch.variables').errors.join('\n'), /переменная price: перед запуском/)
})

test('launch check lists missing full automation run as a separate gate', t => {
  const f = fixture(t)
  f.put('demo/automations/welcome.automationConfig.json', '{"title":"Welcome","eventUrls":[],"steps":[]}')
  const result = f.run('--task-stage', 'launch')
  const smoke = JSON.parse(result.stdout).checks.find(check => check.id === 'automation.smoke')
  assert.equal(smoke.ok, false)
  assert.match(smoke.errors.join('\n'), /полного тестового прогона/)
})

test('local-time delay requires a real timezone instead of an example placeholder', t => {
  const f = fixture(t)
  const config = { title: 'Reminder', eventUrls: ['event://external/test'],
    steps: [{ id: 'wait', type: 'delay', delay: { type: 'waitForTime', weekdays: ['monday'], weekdayTime: '10:00' } }] }
  f.put('demo/automations/reminder.automationConfig.json', JSON.stringify(config))
  const errors = () => JSON.parse(f.run().stdout).checks.find(check => check.id === 'automations').errors.join('\n')
  assert.match(errors(), /defaultTimezone/)
  config.defaultTimezone = '<часовой пояс бизнеса>'
  f.put('demo/automations/reminder.automationConfig.json', JSON.stringify(config))
  assert.match(errors(), /IANA/)
  config.defaultTimezone = 'Asia/Almaty'
  f.put('demo/automations/reminder.automationConfig.json', JSON.stringify(config))
  assert.doesNotMatch(errors(), /defaultTimezone/)
})

test('manual series letters do not require a fictional automation', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'title: Demo\nstages: [Lead]\nknowledge: .knowledge-base/processes/demo/\nnodes:\n  - id: followup\n    kind: series\n    stage: Lead\n    title: Followup\n    purpose: Reply\n    source: .mailings/storage/processes/demo/followup/\n    creativeRef: demo/creative/followup/spec.yaml\nlinks: []\n')
  const path = '.mailings/storage/processes/demo/followup/01.message.yaml'
  f.put(path, 'title: Первый шаг\ndescription: Подтверждение\nsubject: Здравствуйте\nplain: Текст\nhtml: <p>Текст</p>\nshort: Текст\n')
  f.put('demo/creative/followup/spec.yaml', JSON.stringify({ deliveryMode: 'manual',
    manualInvocation: { caller: 'Менеджер', trigger: 'После звонка', recipient: 'Контакт клиента', stop: 'Отказ' },
    messages: [{ path }] }))
  const letters = JSON.parse(f.run().stdout).checks.find(check => check.id === 'letters')
  assert.doesNotMatch(letters.errors.join('\n'), /не отправляет ни один шаг автоматизации/)
})
