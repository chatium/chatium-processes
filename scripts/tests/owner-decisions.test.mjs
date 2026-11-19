import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { approvalScope, boardDecisionDigest, ownerDecisionForCurrentBoard, ownerDecisionStatus, prepareOwnerDecision, recordOwnerDecision } from '../lib/owner-decisions.mjs'
import { fileURLToPath } from 'node:url'

const contextCli = fileURLToPath(new URL('../context.mjs', import.meta.url))
const decisionCli = fileURLToPath(new URL('../owner-decisions.mjs', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-owner-decision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  const git = args => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr) }
  git(['init', '-q']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test'])
  put('demo/PLAN.md', '# План\n\n- [ ] T1 Форма записи\n- Строим: ожидает\n')
  put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\n')
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Demo\norder: [overview.md]\n')
  put('.knowledge-base/processes/demo/overview.md', '---\ntitle: Demo\n---\nКлиент оставляет заявку.\n')
  git(['add', '.']); git(['commit', '-qm', 'Initial'])
  return { root, put, git }
}

const response = { decision: 'approve', message: 'Да, строим по показанному плану.',
  messageReference: 'conversation/message-123', owner: 'business-owner' }
const answer = (overrides = {}) => ({ ...response, answeredAt: new Date().toISOString(), ...overrides })

test('owner answer is required and binds business scope, not a bookkeeping commit', t => {
  const f = fixture(t)
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' }).status, 'missing')
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: 3 })
  assert.throws(() => recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet,
    response: answer({ messageReference: '' }) }), /текст ответа, ссылка/)
  assert.throws(() => recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet,
    response: answer({ answeredAt: '2020-01-01T00:00:00Z' }) }), /раньше подготовки/)
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet, response: answer() })
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' }).status, 'ready')
  f.put('demo/PLAN.md', '# План\n\n- [x] T1 Форма записи\n- Строим: согласовано\n')
  f.git(['add', '.']); f.git(['commit', '-qm', 'Bookkeeping'])
  const ready = ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' })
  assert.equal(ready.status, 'ready')
  assert.notEqual(ready.currentCommit, ready.shownCommit)
  f.put('demo/PLAN.md', '# План\n\n- [x] T1 Другая цена и форма записи\n- Строим: согласовано\n')
  const stale = ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' })
  assert.equal(stale.status, 'stale')
  assert.ok(stale.changedFiles.includes('demo/PLAN.md'))
})

test('recording plan approval does not invalidate it when only the approval status changes', t => {
  const f = fixture(t)
  f.put('demo/PLAN.md', '# План\n\n- [ ] T1 Форма записи\n## Согласования\n- План: не согласован\n- Запуск: не согласован\n')
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: null })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet, response: answer() })
  f.put('demo/PLAN.md', '# План\n\n- [ ] T1 Форма записи\n## Согласования\n- План: согласован 2026-10-08\n- Запуск: не согласован\n')
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' }).status, 'ready')
  f.put('demo/PLAN.md', '# План\n\n- [ ] T1 Форма записи\n- План: цена 9000 рублей\n## Согласования\n- План: согласован 2026-10-08\n- Запуск: не согласован\n')
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' }).status, 'stale')
})

test('an existing approved decision remains readable after status normalization changes', t => {
  const f = fixture(t)
  f.put('demo/PLAN.md', '# План\n\n- [ ] T1 Форма записи\n## Согласования\n- План: согласован 2026-10-08\n')
  const legacy = approvalScope({ root: f.root, slug: 'demo', kind: 'plan', historical: true })
  assert.notEqual(legacy.digest, approvalScope({ root: f.root, slug: 'demo', kind: 'plan' }).digest)
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: null })
  const old = { version: 1, kind: 'plan', process: 'demo', decision: 'approve',
    ...answer(), shownCommit: packet.shownCommit, boardRevision: null,
    scopeDigest: legacy.digest, scopeManifest: legacy.manifest }
  f.put('demo/decisions/plan.json', JSON.stringify(old))
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' }).status, 'ready')
  f.put('demo/PLAN.md', '# План\n\n- [ ] T1 Другая цена и форма записи\n## Согласования\n- План: согласован 2026-10-08\n')
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' }).status, 'stale')
})

test('decision CLI will not solicit plan approval before independent design conclusions', t => {
  const f = fixture(t)
  const result = spawnSync(process.execPath,
    [decisionCli, 'prepare', 'demo', '--kind', 'plan', '--board-revision', 'none', '--root', f.root],
    { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Сначала нужны принятые заключения методологии и архитектуры/)
  assert.match(result.stderr, /knowledge-design/)
  assert.match(result.stderr, /architecture/)
})

test('decision CLI reports missing command inputs before inspecting a process', t => {
  const f = fixture(t)
  for (const [command, expected] of [
    ['prepare', /--board-revision/],
    ['record', /--packet и --response/],
  ]) {
    const result = spawnSync(process.execPath,
      [decisionCli, command, 'demo', '--kind', 'plan', '--root', f.root], { encoding: 'utf8' })
    assert.equal(result.status, 2)
    assert.match(result.stderr, expected)
    assert.doesNotMatch(result.stderr, /заключения методологии/)
  }
})

test('decision CLI reports an unknown command before requiring a decision kind', () => {
  const result = spawnSync(process.execPath,
    [decisionCli, 'not-a-command', 'demo'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Команда: prepare, record или status/)
  assert.doesNotMatch(result.stderr, /--kind/)
})

test('launch decision detects changed delivery and board revision', t => {
  const f = fixture(t)
  f.put('.mailings/storage/processes/demo/welcome/01.message.yaml', 'subject: Подтверждение\n')
  f.put('demo/pages/checkout.ts', 'export const price = 3900\n')
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', boardRevision: 5 })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet,
    response: answer({ message: 'Да, запускаем.', messageReference: 'conversation/message-456' }) })
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch', currentBoardRevision: 5 }).status, 'ready')
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch', currentBoardRevision: 6 }).status, 'stale')
  f.put('demo/pages/checkout.ts', 'export const price = 4900\n')
  const changedPrice = ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch', currentBoardRevision: 5 })
  assert.equal(changedPrice.status, 'stale')
  assert.ok(changedPrice.changedFiles.includes('demo/pages/checkout.ts'))
  f.put('.mailings/storage/processes/demo/welcome/01.message.yaml', 'subject: Другое обещание\n')
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' }).status, 'stale')
})

test('launch decision includes code in nested folders named like service records', async t => {
  for (const folder of ['tasks', 'reviews', 'decisions']) await t.test(folder, t => {
    const f = fixture(t)
    const path = `demo/admin/${folder}/action.ts`
    f.put(path, 'export const price = 3900\n')
    const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', boardRevision: null })
    recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet,
      response: answer({ message: 'Да, запускаем.', messageReference: 'conversation/message-456' }) })
    f.put(path, 'export const price = 4900\n')
    const result = ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' })
    assert.equal(result.status, 'stale')
    assert.ok(result.changedFiles.includes(path))
  })
})

test('launch decision includes letter series named like service records', async t => {
  for (const folder of ['tasks', 'reviews', 'decisions']) await t.test(folder, t => {
    const f = fixture(t)
    const path = `.mailings/storage/processes/demo/${folder}/01.message.yaml`
    f.put(path, 'subject: Подтверждение\n')
    const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', boardRevision: null })
    recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet,
      response: answer({ message: 'Да, запускаем.', messageReference: 'conversation/message-456' }) })
    f.put(path, 'subject: Другое обещание\n')
    const result = ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' })
    assert.equal(result.status, 'stale')
    assert.ok(result.changedFiles.includes(path))
  })
})

test('build transition reads the current board revision before trusting plan approval', async t => {
  const f = fixture(t)
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: 4 })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet, response: answer() })
  assert.equal((await ownerDecisionForCurrentBoard({ root: f.root, slug: 'demo', kind: 'plan',
    readBoard: async () => ({ boardRevision: 4 }) })).status, 'ready')
  const stale = await ownerDecisionForCurrentBoard({ root: f.root, slug: 'demo', kind: 'plan',
    readBoard: async () => ({ boardRevision: 5 }) })
  assert.equal(stale.status, 'stale')
  assert.match(stale.error, /ревизия 4.*5/)
  assert.equal((await ownerDecisionForCurrentBoard({ root: f.root, slug: 'demo', kind: 'plan',
    readBoard: async () => { throw Error('SDK unavailable') } })).status, 'unavailable')
})

test('snapshot-only board revision does not invalidate a content-bound decision', async t => {
  const f = fixture(t)
  const board = { boardRevision: 4, elements: { blocks: [{ id: 'note-1', text: 'Проверить форму' }], connections: [] }, notes: [] }
  const boardContentDigest = boardDecisionDigest(board)
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: 4, boardContentDigest })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet, response: answer() })
  const snapshotOnly = await ownerDecisionForCurrentBoard({ root: f.root, slug: 'demo', kind: 'plan',
    readBoard: async () => ({ ...board, boardRevision: 5 }) })
  assert.equal(snapshotOnly.status, 'ready')
  const changedNote = await ownerDecisionForCurrentBoard({ root: f.root, slug: 'demo', kind: 'plan',
    readBoard: async () => ({ ...board, boardRevision: 6,
      elements: { ...board.elements, blocks: [{ id: 'note-1', text: 'Отправлять всем клиентам' }] } }) })
  assert.equal(changedNote.status, 'stale')
  assert.match(changedNote.error, /заметки или материалы/)
})

test('the approved launch survives only the testOnly deployment switch', t => {
  const f = fixture(t)
  const workspace = testOnly => JSON.stringify({ type: 'process', config: {
    senderChannels: ['mail'], mailings: { testOnly, testContacts: [{ type: 'email', value: 'test@example.com' }] },
  } })
  f.put('demo/.workspace.json', workspace(true))
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', boardRevision: 1 })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet,
    response: answer({ message: 'Да, запускаем после безопасного прогона.' }) })
  f.put('demo/.workspace.json', workspace(false))
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' }).status, 'ready')
  f.put('demo/.workspace.json', workspace(false).replace('mail', 'sms'))
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' }).status, 'stale')
})

test('a delegated rehearsal requires an explicit delegation and keeps its authority with normal delivery enabled', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', JSON.stringify({type:'process',config:{mailings:{testOnly:false,testContacts:[]}}}))
  for (const kind of ['plan', 'launch']) {
    const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind, boardRevision: null })
    const response = answer({ authority: 'delegated-test', owner: undefined, actor: 'tester',
      delegationReference: 'owner-message', message: 'Проверить учебный сценарий.' })
    assert.throws(() => recordOwnerDecision({ root: f.root, slug: 'demo', kind, packet,
      response: {...response,delegationReference:''} }), /основанием тестового делегирования/)
    recordOwnerDecision({ root: f.root, slug: 'demo', kind, packet, response })
    const saved = ownerDecisionStatus({ root: f.root, slug: 'demo', kind })
    assert.equal(saved.status, kind === 'launch' ? 'rehearsal' : 'ready')
    assert.equal(saved.authority, 'delegated-test')
  }
})

test('delegated plan approval works without a transport or real contact, but does not authorize launch', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', JSON.stringify({type:'process',processEngine:"processes-v2",config:{senderChannels:[],mailings:{testOnly:false,testContacts:[]}}}))
  const response = answer({authority:'delegated-test',owner:undefined,actor:'test-executor',
    delegationReference:'conversation/owner-delegation',message:'Собрать и проверить внутренним транспортом; внешний канал подключить перед запуском.'})
  const packet = prepareOwnerDecision({root:f.root,slug:'demo',kind:'plan',boardRevision:null})
  recordOwnerDecision({root:f.root,slug:'demo',kind:'plan',packet,response:{...response,answeredAt:new Date().toISOString()}})
  assert.equal(ownerDecisionStatus({root:f.root,slug:'demo',kind:'plan'}).status,'ready')
  const launch = prepareOwnerDecision({root:f.root,slug:'demo',kind:'launch',boardRevision:null})
  const saved = recordOwnerDecision({root:f.root,slug:'demo',kind:'launch',packet:launch,response:{...response,answeredAt:new Date().toISOString()}})
  assert.equal(saved.status, 'rehearsal')
  const check = spawnSync(process.execPath, [fileURLToPath(new URL('../check.mjs', import.meta.url)),
    'demo','--root',f.root,'--task-stage','launch','--no-snapshot','--json'], {encoding:'utf8'})
  const gate = JSON.parse(check.stdout).checks.find(item => item.id === 'owner.launch')
  assert.equal(gate.ok, false)
  assert.match(gate.errors.join(' '), /решение владельца/)
})

test('context does not present stale owner approval from an old PLAN.md line', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}\n')
  f.put('demo/PLAN.md', '# План\n## Задачи\n- [ ] T1 Форма записи\n- План: согласован\n- Запуск: согласован\n')
  const context = () => {
    const result = spawnSync(process.execPath,
      [contextCli, 'demo', '--root', f.root, '--offline', '--no-cards'], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  const planning = context()
  assert.match(planning, /Текущий шаг: 2 из 7 — План и первая карта/)
  assert.doesNotMatch(planning, /Следующий шаг: От вас|^Карточки: /m)
  f.put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes:\n  - id: page\n    kind: page\n')
  const initial = context()
  assert.match(initial, /Сборка и приёмка блоков по актуальной доске не подтверждены/)
  assert.doesNotMatch(initial, /прошли приёмку — \d/)
  assert.match(initial, /решение «строим так\?» missing/)
  assert.match(initial, /check\.mjs demo --task-stage design --knowledge-stage design/)
  assert.match(initial, /Текущий шаг: 3 из 7 — Ревью плана и «Строим так\?»/)
  assert.match(initial, /нужны заключения: knowledge-design.*architecture/)
  assert.match(initial, /Правило шага 3:.*заключения методолога и архитектора/)
  assert.match(initial, /Читать сейчас:.*build\/commission\.md/)
  assert.doesNotMatch(initial, /Ревью задания |===== blocks\/|^Карточки: /m)
  assert.match(initial, /Следующая команда: node .*reviews\.mjs status demo --stage design/)
  assert.match(initial, /Переход дальше заблокирован/)
  assert.match(initial, /✘ reviews: Обязательные заключения комиссии/)
  assert.match(initial, /Результат этапа для владельца:.*план и карта/)
  assert.match(initial, /Это не полный результат для сдачи этапа/)
  assert.ok(initial.indexOf('Переход дальше заблокирован') < initial.indexOf('Артефакты:'))
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: null })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet, response: answer() })
  const approved = context()
  assert.match(approved, /решение «строим так\?» ready/)
  assert.match(approved, /check\.mjs demo --task-stage design --knowledge-stage design/)
  assert.match(approved, /Текущий шаг: 3 из 7 — Ревью плана и «Строим так\?»/)
  assert.match(approved, /Следующий шаг: Я передам план/)
  f.put('.knowledge-base/processes/demo/overview.md', '---\ntitle: Demo\n---\nДругое обещание клиенту.\n')
  const stale = context()
  assert.match(stale, /решение «строим так\?» stale/)
  assert.match(stale, /Текущий шаг: 3 из 7 — Ревью плана и «Строим так\?»/)
  assert.match(stale, /Следующий шаг: Я передам план/)
  f.git(['checkout', '-qb', 'process/demo'])
  assert.match(context(), /\/app\/start\/process-map\?process=demo&branch=process%2Fdemo/)
  f.git(['checkout', '--detach', '-q'])
  assert.match(context(), /Ссылка на карту не определена/)
})

test('adopts only a published populated plan and keeps later edits subject to agreement', async t => {
  const { adoptBuiltPlan } = await import('../lib/adopt-built-plan.mjs')
  const { gitState } = await import('../lib/git-state.mjs')
  const { root, put, git } = fixture(t)
  const slug = 'demo', source = 'demo/page.tsx'
  put('demo/.workspace.json', JSON.stringify({ type: 'process', processEngine: 'processes-v2' }))
  put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes:\n  - {id: page, source: demo/page.tsx, kind: page}\n')
  put(source, '// TODO')
  git(['add', '.']); git(['commit', '-qm', 'Published structure']); git(['remote', 'add', 'origin', root])
  const board = { boardRevision: 1, elements: { blocks: [], connections: [] }, snapshot: {
    ...gitState(root), processPath: slug, nodes: [{ id: 'page', source, build: { source: 'present' } }],
  } }
  const args = { root, slug, readBoard: async () => board }
  assert.equal((await adoptBuiltPlan(args)).status, 'missing')
  put(source, "export const page = app.get('/', () => 'Hello')")
  git(['add', source]); git(['commit', '-qm', 'Publish page'])
  assert.equal((await adoptBuiltPlan(args)).status, 'missing')
  board.snapshot.commit = gitState(root).commit
  assert.equal((await adoptBuiltPlan(args)).authority, 'published-build')
  assert.equal((await adoptBuiltPlan(args)).status, 'ready')
  assert.equal(ownerDecisionStatus({ root, slug, kind: 'launch' }).status, 'missing')
  put('demo/PLAN.md', '# Изменённый план')
  assert.equal((await adoptBuiltPlan(args)).status, 'stale')
})
