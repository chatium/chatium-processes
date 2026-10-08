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

test('a series cannot enter test stage without channels and a real test-only recipient policy', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'title: Demo\nstages: [Lead]\nnodes:\n  - id: followup\n    kind: series\n    stage: Lead\n    title: Follow-up\n    source: .mailings/storage/processes/demo/followup/\nlinks: []\n')
  const workspace = stage => JSON.parse(f.run('--task-stage', stage).stdout).checks.find(check => check.id === 'workspace')
  const missing = workspace('test')
  assert.match(missing.errors.join('\n'), /senderChannels/)
  assert.match(missing.errors.join('\n'), /mailings\.testOnly/)
  assert.match(missing.errors.join('\n'), /mailings\.testContacts/)

  f.put('demo/.workspace.json', JSON.stringify({ type: 'process', processEngine: 'processes-v2', config: {
    senderChannels: ['email-1'], mailings: { testOnly: false, testContacts: [{ type: 'email', value: 'owner@example.com' }] },
  } }))
  assert.match(workspace('test').errors.join('\n'), /testOnly: true/)
  assert.equal(workspace('launch').errors.length, 0)

  f.put('demo/.workspace.json', JSON.stringify({ type: 'process', processEngine: 'processes-v2', config: {
    senderChannels: ['email-1'], mailings: { testOnly: true, testContacts: [{ type: 'email', value: 'owner@example.com' }] },
  } }))
  assert.equal(workspace('test').errors.length, 0)
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

test('planned automation edge stays on the map during design and requires code during build', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'title: Demo\naccountId: 123\nstages: [Lead, Followup]\nknowledge: .knowledge-base/processes/demo\nnodes:\n  - id: form\n    kind: page\n    stage: Lead\n    title: Form\n    purpose: Capture\n    source: demo/form/\n  - id: message\n    kind: series\n    stage: Followup\n    title: Message\n    purpose: Reply\n    source: .mailings/storage/processes/demo/message/\nlinks:\n  - from: form\n    to: message\n    when: after form\n    via: demo/automations/reply/\n')
  const map = (...flags) => JSON.parse(f.run(...flags).stdout).checks.find(check => check.id === 'map')
  const design = map('--task-stage', 'design')
  assert.equal(design.ok, true)
  assert.match(design.warnings.join('\n'), /demo\/automations\/reply.*этапе сборки/)
  const build = map('--task-stage', 'build')
  assert.equal(build.ok, false)
  assert.match(build.errors.join('\n'), /demo\/automations\/reply.*automationConfig/)
  f.put('demo/automations/reply/reply.automationConfig.json', '{"title":"Reply","steps":[]}')
  const implemented = map('--task-stage', 'build')
  assert.equal(implemented.ok, true, implemented.errors.join('\n'))
})

test('map accepts a matching event in any automation within the linked folder', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'title: Demo\naccountId: 123\nknowledge: .knowledge-base/processes/demo\nstages: [Flow]\nnodes:\n  - {id: a, kind: page, stage: Flow, title: A, purpose: Start, source: demo/a}\n  - {id: b, kind: page, stage: Flow, title: B, purpose: Finish, source: demo/b}\nlinks:\n  - {from: a, to: b, when: after event, signal: "event:finished", via: demo/automations/flow/}\n')
  f.put('demo/specs/events.yaml', 'events:\n  - {key: finished, type: workspaceEvent, name: Finished}\n  - {key: started, type: workspaceEvent, name: Started}\n')
  const file = path => `demo/automations/flow/${path}.automationConfig.json`
  f.put(file('a'), JSON.stringify({ title: 'Other', eventUrls: ['event://account/demo/started'], steps: [] }))
  f.put(file('b'), JSON.stringify({ title: 'Finish', eventUrls: ['event://account/demo/finished'], steps: [] }))
  const map = () => JSON.parse(f.run().stdout).checks.find(check => check.id === 'map')
  assert.equal(map().ok, true, map().errors.join('\n'))
  f.put(file('b'), JSON.stringify({ title: 'Wrong', eventUrls: ['event://account/demo/started'], steps: [] }))
  assert.match(map().errors.join('\n'), /не слушает event:\/\/account\/demo\/finished/)
})

test('design accepts a planned letter before its automation, but build requires a sender', t => {
  const f = fixture(t)
  const path = '.mailings/storage/processes/demo/welcome/01.message.yaml'
  f.put('demo/process.yaml', 'title: Demo\nstages: [Lead]\nnodes:\n  - id: welcome\n    kind: series\n    stage: Lead\n    title: Welcome\n    source: .mailings/storage/processes/demo/welcome/\n    creativeRef: demo/creative/welcome/spec.yaml\nlinks: []\n')
  f.put('demo/creative/welcome/spec.yaml', JSON.stringify({ deliveryMode: 'automation', messages: [{ path }] }))
  f.put(path, 'title: Первый шаг\ndescription: Выдача материала\nsubject: Материал\nplain: Текст\nhtml: <p>Текст</p>\n')
  const letters = (...flags) => JSON.parse(f.run(...flags).stdout).checks.find(check => check.id === 'letters')
  const design = letters('--task-stage', 'design')
  assert.doesNotMatch(design.errors.join('\n'), /не отправляет ни один шаг автоматизации/)
  assert.match(design.warnings.join('\n'), /подключение проверяется на этапе сборки/)
  assert.match(letters('--task-stage', 'build').errors.join('\n'), /не отправляет ни один шаг автоматизации/)
  f.put('.mailings/storage/processes/demo/welcome/unplanned.message.yaml', 'title: Лишнее\ndescription: Без задания\nsubject: Лишнее\nplain: Текст\nhtml: <p>Текст</p>\n')
  assert.match(letters('--task-stage', 'design').errors.join('\n'), /unplanned.*не отправляет ни один шаг автоматизации/)
})

test('unsupported branches and templated dateExpression fail automations check', t => {
  const f = fixture(t)
  f.put('demo/automations/a.automationConfig.json', JSON.stringify({
    title: 'Test', eventUrls: ['event://external/test'],
    steps: [
      { id: 'branch', type: 'condition', thenBranch: { steps: [] }, thenSteps: [] },
      { id: 'wait', type: 'delay', delay: { type: 'dateExpression', dateExpression: '{{ steps.prepare.date }}' } },
      { id: 'broken-js', type: 'delay', delay: { type: 'dateExpression', dateExpression: 'new Date(' } },
      { id: 'valid-js', type: 'delay', delay: { type: 'dateExpression', dateExpression: 'new Date(event.dueDate)' } },
    ],
  }))
  const result = f.run()
  assert.ok(result.stdout, result.stderr)
  const automations = JSON.parse(result.stdout).checks.find(check => check.id === 'automations')
  assert.equal(automations.ok, false)
  assert.match(automations.errors.join('\n'), /condition/)
  assert.match(automations.errors.join('\n'), /thenBranch/)
  assert.match(automations.errors.join('\n'), /thenSteps/)
  assert.match(automations.errors.join('\n'), /JS-выражением/)
  assert.match(automations.errors.join('\n'), /broken-js.*синтаксис/)
  assert.doesNotMatch(automations.errors.join('\n'), /valid-js/)
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

test('automation step cannot hide a failure behind success false', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'title: Demo\naccountId: 10\nnodes: []\nlinks: []\n')
  const config = { title: 'Fail closed', eventUrls: [], settings: { continueOnError: false }, steps: [
    { id: 'send', type: 'action', actionName: 'Send',
      actionRoute: { routeType: 'function', routeJson: [10, 'demo/actions/send', '/send'] }, params: {} },
    { id: 'can_continue', type: 'continueCondition', conditionName: 'Can continue',
      conditionRoute: { routeType: 'function', routeJson: [10, 'demo/actions/condition', '/check'] }, params: {} },
  ] }
  f.put('demo/automations/send.automationConfig.json', JSON.stringify(config))
  f.put('demo/actions/send.ts', "// return { success: false }\nexport const send = app.function('/send', async () => { return { success: false } })\n")
  f.put('demo/actions/condition.ts', "export const check = app.function('/check', async () => ({ success: false }))\n")
  const report = (...flags) => JSON.parse(f.run(...flags).stdout).checks.find(item => item.id === 'automations')
  assert.equal((report().warnings.join('\n').match(/возвращает \{ success: false \}/g) || []).length, 2)
  assert.equal((report('--task-stage', 'test').errors.join('\n').match(/возвращает \{ success: false \}/g) || []).length, 2)
  f.put('demo/actions/send.ts', "// return { success: false }\nexport const send = app.function('/send', async () => { throw new Error('send failed') })\n")
  f.put('demo/actions/condition.ts', "export const check = app.function('/check', async () => ({ success: true, satisfied: false }))\n")
  assert.doesNotMatch(report('--task-stage', 'test').errors.join('\n'), /возвращает \{ success: false \}/)
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

test('letter check requires content for selected transports only', t => {
  const f = fixture(t)
  const path = '.mailings/storage/processes/demo/followup/01.message.yaml'
  f.put('demo/process.yaml', 'title: Demo\nstages: [Lead]\nnodes:\n  - id: followup\n    kind: series\n    stage: Lead\n    title: Followup\n    source: .mailings/storage/processes/demo/followup/\n    creativeRef: demo/creative/followup/spec.yaml\nlinks: []\n')
  const spec = (formats, requiredMedia) => f.put('demo/creative/followup/spec.yaml', JSON.stringify({ formats, deliveryMode: 'manual',
    manualInvocation: { caller: 'Менеджер', trigger: 'После звонка', recipient: 'Контакт клиента', stop: 'Отказ' },
    messages: [{ path, ...(requiredMedia ? { requiredMedia } : {}) }] }))
  const errors = () => JSON.parse(f.run().stdout).checks.find(check => check.id === 'letters').errors.join('\n')
  spec(['email'])
  f.put(path, 'title: Первый шаг\ndescription: Подтверждение\nsubject: Здравствуйте\nplain: Текст\nhtml: <p>Текст</p>\n')
  assert.doesNotMatch(errors(), /пустое или нет поле/)
  spec(['email', 'sms'])
  assert.match(errors(), /пустое или нет поле short/)
  spec(['messenger'])
  f.put(path, 'title: Первый шаг\ndescription: Подтверждение\nplain: Текст\n')
  assert.doesNotMatch(errors(), /пустое или нет поле/)
  f.put('demo/.workspace.json', JSON.stringify({ type: 'process', processEngine: 'processes-v2',
    config: { senderChannels: ['telegram-1'] } }))
  spec(['messenger'], [{ kind: 'media', key: 'guide-photo', channelIds: ['telegram-1'] }])
  assert.match(errors(), /нет обещанного медиа guide-photo/)
  f.put(path, 'title: Первый шаг\ndescription: Подтверждение\nplain: Текст\nmedia:\n  - key: guide-photo\n    type: image\n    url: https://example.com/photo.png\n    mime_type: image/png\n    only_channel_ids: [telegram-2]\n')
  assert.match(errors(), /медиа не попадёт в канал telegram-1/)
  f.put(path, 'title: Первый шаг\ndescription: Подтверждение\nplain: Текст\nmedia:\n  - key: guide-photo\n    type: image\n    url: https://example.com/photo.png\n    mime_type: image/png\n    only_channel_ids: [telegram-1]\n')
  assert.doesNotMatch(errors(), /медиа|media/)
  spec(['messenger'], [null])
  assert.match(errors(), /requiredMedia: неверное требование/)
})

test('channel plan constrains every message variant to its selected Sender IDs', t => {
  const f = fixture(t)
  const path = '.mailings/storage/processes/demo/followup/01.message.yaml'
  const variant = '.mailings/storage/processes/demo/followup/01.v2.message.yaml'
  f.put('demo/process.yaml', 'title: Demo\nstages: [Lead]\nnodes:\n  - id: followup\n    kind: series\n    stage: Lead\n    title: Followup\n    source: .mailings/storage/processes/demo/followup/\n    creativeRef: demo/creative/followup/spec.yaml\nlinks: []\n')
  f.put('demo/.workspace.json', JSON.stringify({ type: 'process', processEngine: 'processes-v2',
    config: { senderChannels: ['email-1', 'telegram-1'] } }))
  const spec = { formats: ['messenger'], channelIdsByFormat: { messenger: ['telegram-1'] }, deliveryMode: 'manual',
    manualInvocation: { caller: 'Менеджер', trigger: 'Заявка', recipient: 'Контакт', stop: 'Отказ' },
    messages: [{ path }] }
  f.put('demo/creative/followup/spec.yaml', JSON.stringify(spec))
  const message = { title: 'Первый шаг', description: 'Материал', plain: 'Откройте материал.' }
  const errors = () => JSON.parse(f.run('--task-stage', 'launch').stdout).checks.find(check => check.id === 'letters').errors.join('\n')
  f.put(path, JSON.stringify(message))
  f.put(variant, JSON.stringify(message))
  assert.match(errors(), /processDeliveryChannelIds/)
  message.processDeliveryChannelIds = ['email-1']
  f.put(path, JSON.stringify(message))
  f.put(variant, JSON.stringify(message))
  assert.match(errors(), /не совпадает с channelIdsByFormat/)
  message.processDeliveryChannelIds = ['telegram-1']
  f.put(path, JSON.stringify(message))
  assert.match(errors(), /01\.v2\.message\.yaml: processDeliveryChannelIds/)
  f.put(variant, JSON.stringify(message))
  assert.doesNotMatch(errors(), /processDeliveryChannelIds|channelIdsByFormat/)
  const delivery = JSON.parse(f.run('--task-stage', 'launch').stdout).checks.find(check => check.id === 'letters.delivery')
  assert.equal(delivery.ok, false)
  assert.match(delivery.errors.join('\n'), /Нет результатов тестовой доставки/)
  spec.channelIdsByFormat.messenger = ['unknown-channel']
  f.put('demo/creative/followup/spec.yaml', JSON.stringify(spec))
  assert.match(errors(), /unknown-channel отсутствует в config.senderChannels/)
})

test('launch blocks a message series without configured Sender channels', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'title: Demo\nstages: [Lead]\nnodes:\n  - id: followup\n    kind: series\n    stage: Lead\n    title: Followup\n    source: .mailings/storage/processes/demo/followup/\nlinks: []\n')
  const build = JSON.parse(f.run('--task-stage', 'build').stdout).checks.find(check => check.id === 'workspace')
  assert.equal(build.ok, true)
  assert.match(build.warnings.join('\n'), /senderChannels/)
  const launch = JSON.parse(f.run('--task-stage', 'launch').stdout).checks.find(check => check.id === 'workspace')
  assert.equal(launch.ok, false)
  assert.match(launch.errors.join('\n'), /senderChannels/)
})
