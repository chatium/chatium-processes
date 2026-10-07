import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeReviewPacket, recordReview } from '../lib/knowledge-review.mjs'
import { makeArchitectureReviewPacket, recordArchitectureReview } from '../lib/architecture-review.mjs'
import { prepareOwnerDecision, recordOwnerDecision } from '../lib/owner-decisions.mjs'

const cli = fileURLToPath(new URL('../tasks.mjs', import.meta.url))

test('implementation starts only after approved plan and accepted design conclusions', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-design-transition-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  }
  const run = (command, ...args) => spawnSync(process.execPath,
    [cli, command, 'demo', ...args, '--root', root], { cwd: root, encoding: 'utf8', timeout: 15_000 })
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr)
  }
  const article = '.knowledge-base/processes/demo/overview.md'
  const quote = 'Клиент оставляет заявку на консультацию; менеджер отвечает в рабочий день.'
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Запись\norder: [overview.md]\n')
  put(article, `---\ntitle: Запись\n---\n${quote}\n`)
  put('demo/.workspace.json', { type: 'process', processEngine: 'processes-v2' })
  put('demo/PLAN.md', '# Demo\n\n## Задачи\n- [ ] T1 Форма\n  - T1.A1 [build] Корректная заявка записана.\n')
  put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\nlinks: []\n')
  put('demo/tasks/index.json', { version: 1 })
  put('task.json', {
    version: 1, id: 'W001', planTask: 'T1', title: 'Собрать форму', targetNode: 'form',
    executor: { kind: 'main', role: 'developer' }, mode: 'implement', stage: 'build',
    objective: 'Сохранить заявку', scope: { includes: ['Форма'], excludes: [] },
    status: 'queued', revision: 0, createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z',
    dependsOn: [], session: null, inputs: [{ kind: 'knowledge', path: article, purpose: 'Поля' }],
    expectedOutputs: [{ path: 'demo/form.vue', purpose: 'Форма' }],
    steps: [{ id: 'P1', action: 'Собрать форму', status: 'todo', reason: null }],
    acceptanceCriteria: [{ id: 'C1', planCriteria: ['T1.A1'], condition: 'Заявка записана',
      verification: { kind: 'test', instruction: 'Проверить сохранение заявки' } }],
    questions: [], drafts: [], latestAttempt: null, attempts: [], result: null, acceptance: null, cancellation: null,
  })
  git('init', '-q')
  git('config', 'user.email', 'test@example.invalid')
  git('config', 'user.name', 'Test')
  git('add', '.')
  git('commit', '-qm', 'Initial')
  assert.equal(run('create', 'W001', '--file', join(root, 'task.json')).status, 0)
  const ownerPacket = prepareOwnerDecision({ root, slug: 'demo', kind: 'plan', boardRevision: null })
  recordOwnerDecision({ root, slug: 'demo', kind: 'plan', packet: ownerPacket,
    response: { decision: 'approve', message: 'Согласен строить описанную форму.',
      messageReference: 'unit-test/plan-approval', owner: 'fixture-owner', answeredAt: '2026-10-07T10:00:00Z' } })
  const reportFor = packet => ({ version: 1, process: packet.process, stage: packet.stage,
    inputDigest: packet.inputDigest, inspectedFiles: packet.files.map(file => file.path),
    inspectedReferences: [...packet.referenceLibrary.required],
    answers: packet.questions.map((question, index) => ({ id: question.id, status: 'covered',
      reason: 'Синтетический ответ для проверки перехода этапа.',
      evidence: [{ path: article, quote: quote.slice(index % 3) }] })) })
  const knowledge = makeReviewPacket({ root, slug: 'demo', stage: 'design' })
  assert.equal(recordReview({ root, slug: 'demo', stage: 'design', packet: knowledge,
    report: reportFor(knowledge), agentReference: 'unit-test-only:methodology' }).status, 'ready')
  const architecture = makeArchitectureReviewPacket({ root, slug: 'demo' })
  const red = reportFor(architecture)
  Object.assign(red.answers.find(answer => answer.id === 'journey'), {
    status: 'gap', priority: 'blocking', reason: 'Не описан путь отказа.',
    nextAction: 'Добавить путь отказа в план.', evidence: [],
  })
  assert.equal(recordArchitectureReview({ root, slug: 'demo', packet: architecture,
    report: red, agentReference: 'unit-test-only:architecture-red' }).status, 'needs-work')
  const blocked = run('start', 'W001')
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /architecture: needs-work/)
  assert.equal(recordArchitectureReview({ root, slug: 'demo', packet: architecture,
    report: reportFor(architecture), agentReference: 'unit-test-only:architecture-green' }).status, 'ready')
  const started = run('start', 'W001')
  assert.equal(started.status, 0, started.stderr)
  assert.match(started.stdout, /"attemptId": "R001"/)
})
