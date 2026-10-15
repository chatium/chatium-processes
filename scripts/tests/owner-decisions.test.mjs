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

test('delegated tester may decide only for an allowlisted test process, never for live delivery', t => {
  const f = fixture(t)
  const workspace = (testOnly, contacts) => JSON.stringify({ type: 'process', config: {
    mailings: { testOnly, testContacts: contacts },
  } })
  const contact = [{ type: 'email', value: 'test@example.invalid' }]
  f.put('demo/.workspace.json', workspace(true, contact))
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', boardRevision: null })
  const delegated = answer({ authority: 'delegated-test', owner: undefined,
    actor: 'test-executor', delegationReference: 'conversation/owner-delegation',
    message: 'Для проверки выбираю учебные письма и безопасный запуск.',
    messageReference: 'tests/delegated-decision.md' })
  const fresh = () => ({ ...delegated, answeredAt: new Date().toISOString() })
  assert.throws(() => recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet,
    response: { ...delegated, delegationReference: '' } }), /основанием тестового делегирования/)
  f.put('demo/.workspace.json', workspace(false, contact))
  const livePacket = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', boardRevision: null })
  assert.throws(() => recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet: livePacket,
    response: fresh() }), /testOnly=true/)
  f.put('demo/.workspace.json', workspace(true, []))
  const noContactsPacket = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', boardRevision: null })
  assert.throws(() => recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet: noContactsPacket,
    response: fresh() }), /тестовый контакт/)
  f.put('demo/.workspace.json', workspace(true, contact))
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet, response: fresh() })
  const planPacket = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: null })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet: planPacket, response: fresh() })
  const ready = ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.authority, 'delegated-test')
  assert.equal(ready.delegationReference, delegated.delegationReference)
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' }).authority, 'delegated-test')
  f.put('demo/.workspace.json', workspace(false, contact))
  const stale = ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' })
  assert.equal(stale.status, 'stale')
  assert.match(stale.error, /для обычного запуска нужен ответ владельца/)
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' }).status, 'stale')
})

test('context does not present stale owner approval from an old PLAN.md line', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}\n')
  f.put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes:\n  - id: page\n    kind: page\n')
  f.put('demo/PLAN.md', '# План\n## Задачи\n- [ ] T1 Форма записи\n- План: согласован\n- Запуск: согласован\n')
  const context = () => {
    const result = spawnSync(process.execPath,
      [contextCli, 'demo', '--root', f.root, '--offline', '--no-cards'], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  assert.match(context(), /решение «строим так\?» missing/)
  assert.match(context(), /check\.mjs demo --task-stage design --knowledge-stage design/)
  assert.match(context(), /Этап: 2\. План — ждёт независимых заключений/)
  assert.match(context(), /Следующий шаг: Получи недостающие заключения design: knowledge-design.*architecture/)
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: null })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet, response: answer() })
  assert.match(context(), /решение «строим так\?» ready/)
  assert.match(context(), /check\.mjs demo --task-stage build --knowledge-stage build/)
  assert.match(context(), /Этап: 2\. План — ждёт независимых заключений/)
  assert.match(context(), /Следующий шаг: Получи недостающие заключения design:/)
  f.put('.knowledge-base/processes/demo/overview.md', '---\ntitle: Demo\n---\nДругое обещание клиенту.\n')
  const stale = context()
  assert.match(stale, /решение «строим так\?» stale/)
  assert.match(stale, /Этап: 2\. План — ждёт независимых заключений/)
  assert.match(stale, /Следующий шаг: Получи недостающие заключения design:/)
})
