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
