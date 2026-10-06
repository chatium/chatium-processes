import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ownerDecisionStatus, prepareOwnerDecision, recordOwnerDecision } from '../lib/owner-decisions.mjs'

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
  messageReference: 'conversation/message-123', owner: 'business-owner', answeredAt: '2026-10-06T10:00:00.000Z' }

test('owner answer is required and binds business scope, not a bookkeeping commit', t => {
  const f = fixture(t)
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'plan' }).status, 'missing')
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: 3 })
  assert.throws(() => recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet,
    response: { ...response, messageReference: '' } }), /реального ответа/)
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet, response })
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

test('launch decision detects changed delivery and board revision', t => {
  const f = fixture(t)
  f.put('.mailings/storage/processes/demo/welcome/01.message.yaml', 'subject: Подтверждение\n')
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', boardRevision: 5 })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet,
    response: { ...response, message: 'Да, запускаем.', messageReference: 'conversation/message-456' } })
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch', currentBoardRevision: 5 }).status, 'ready')
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch', currentBoardRevision: 6 }).status, 'stale')
  f.put('.mailings/storage/processes/demo/welcome/01.message.yaml', 'subject: Другое обещание\n')
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' }).status, 'stale')
})

test('the approved launch survives only the testOnly deployment switch', t => {
  const f = fixture(t)
  const workspace = testOnly => JSON.stringify({ type: 'process', config: {
    senderChannels: ['mail'], mailings: { testOnly, testContacts: [{ type: 'email', value: 'test@example.com' }] },
  } })
  f.put('demo/.workspace.json', workspace(true))
  const packet = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', boardRevision: 1 })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'launch', packet,
    response: { ...response, message: 'Да, запускаем после безопасного прогона.' } })
  f.put('demo/.workspace.json', workspace(false))
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' }).status, 'ready')
  f.put('demo/.workspace.json', workspace(false).replace('mail', 'sms'))
  assert.equal(ownerDecisionStatus({ root: f.root, slug: 'demo', kind: 'launch' }).status, 'stale')
})
