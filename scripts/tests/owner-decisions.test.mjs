import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ownerDecisionForCurrentBoard, ownerDecisionStatus, prepareOwnerDecision, recordOwnerDecision } from '../lib/owner-decisions.mjs'
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
    response: answer({ messageReference: '' }) }), /реального ответа/)
  assert.throws(() => recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet,
    response: answer({ answeredAt: '2020-01-01T00:00:00Z' }) }), /раньше показа/)
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
