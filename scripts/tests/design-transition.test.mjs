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
import { commissionStatus } from '../lib/commission.mjs'

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
  put('demo/process.yaml', [
    'title: Demo', 'knowledge: .knowledge-base/processes/demo', 'nodes:',
    '  - {id: form, kind: page, source: demo/form.tsx}',
    '  - {id: intake, kind: external, serviceRef: intake, source: demo/api/intake.ts}',
    'links:', '  - {from: form, to: intake}', '',
  ].join('\n'))
  put('demo/specs/services.yaml', [
    'version: 1', 'services:', '  - id: intake', '    nodeId: intake', '    input: email',
    '    output: requestId', '    access: public', '    repeat: reuse requestId', '    errors: [invalid email]', '',
  ].join('\n'))
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
      messageReference: 'unit-test/plan-approval', owner: 'fixture-owner', answeredAt: new Date().toISOString() } })
  const reportFor = packet => ({ version: 1, process: packet.process, stage: packet.stage,
    inputDigest: packet.inputDigest, inspectedFiles: packet.files.map(file => file.path),
    inspectedReferences: [...packet.referenceLibrary.required],
    answers: packet.questions.map((question, index) => ({ id: question.id, status: 'covered',
      reason: 'Синтетический ответ для проверки перехода этапа.',
      evidence: question.id === 'data' && packet.files.some(file => file.path === 'demo/.workspace.json')
        ? [{ path: 'demo/PLAN.md', quote: 'Корректная заявка записана.' },
          { path: 'demo/.workspace.json', quote: '"processEngine": "processes-v2"' }]
        : question.id === 'site-and-services'
        ? [{ path: 'demo/process.yaml', quote: 'serviceRef: intake' },
          { path: 'demo/specs/services.yaml', quote: 'output: requestId' }]
        : question.id === 'consistency' && packet.files.some(file => file.path === 'demo/tasks/W001.json')
        ? [{ path: 'demo/PLAN.md', quote: 'Корректная заявка записана.' },
          { path: 'demo/tasks/W001.json', quote: 'Заявка записана' }]
        : [{ path: article, quote: quote.slice(index % 3) }] })) })
  const knowledge = makeReviewPacket({ root, slug: 'demo', stage: 'design' })
  assert.equal(recordReview({ root, slug: 'demo', stage: 'design', packet: knowledge,
    report: reportFor(knowledge), agentReference: 'unit-test-only:methodology' }).status, 'ready')
  const architecture = makeArchitectureReviewPacket({ root, slug: 'demo' })
  assert.ok(!architecture.files.some(file => file.path.endsWith('/architecture-source-inventory.txt')))
  assert.deepEqual(architecture.questions.find(q => q.id === 'site-and-services').requiredEvidenceGroups,
    [{ paths: ['demo/process.yaml'] }, { paths: ['demo/specs/services.yaml'] }])
  const red = reportFor(architecture)
  Object.assign(red.answers.find(answer => answer.id === 'journey'), {
    status: 'gap', priority: 'blocking', reason: 'Не описан путь отказа.',
    nextAction: 'Добавить путь отказа в план.', evidence: [],
  })
  assert.equal(recordArchitectureReview({ root, slug: 'demo', packet: architecture,
    report: red, agentReference: 'unit-test-only:architecture-red' }).status, 'needs-work')
  const mixed = commissionStatus({ root, slug: 'demo', stage: 'design' })
  assert.equal(mixed.status, 'needs-work')
  assert.equal(mixed.requirements.find(item => item.id === 'knowledge-design').status, 'ready')
  assert.equal(mixed.requirements.find(item => item.id === 'architecture').status, 'needs-work')
  const blocked = run('start', 'W001')
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /architecture: needs-work/)
  assert.equal(recordArchitectureReview({ root, slug: 'demo', packet: architecture,
    report: reportFor(architecture), agentReference: 'unit-test-only:architecture-green' }).status, 'ready')
  assert.equal(commissionStatus({ root, slug: 'demo', stage: 'design' }).status, 'ready')
  // Exercise the public approval commands with an independently reviewed, empty structure.
  rmSync(join(root, 'demo/decisions/plan.json'))
  const ownerCli = fileURLToPath(new URL('../owner-decisions.mjs', import.meta.url))
  const owner = (command, ...args) => spawnSync(process.execPath,
    [ownerCli, command, 'demo', '--root', root, '--kind', 'plan', ...args], { cwd: root, encoding: 'utf8' })
  const prepared = owner('prepare', '--board-revision', 'none', '--out', 'packet.json')
  assert.equal(prepared.status, 0, prepared.stderr)
  put('answer.json', { decision: 'approve', message: 'Строим по этой схеме.', owner: 'fixture-owner',
    messageReference: 'unit-test/structure', answeredAt: new Date().toISOString() })
  const record = () => owner('record', '--packet', 'packet.json', '--response', 'answer.json')
  put('demo/form.vue', '<h1>Заказать курс</h1>')
  assert.match(record().stderr, /demo\/form\.vue/)
  rmSync(join(root, 'demo/form.vue'))
  const approved = record()
  assert.equal(approved.status, 0, approved.stderr)
  const started = run('start', 'W001')
  assert.equal(started.status, 0, started.stderr)
  assert.match(started.stdout, /"attemptId": "R001"/)
})

test('first publication is not approval; an unchanged existing block survives planning a change', async t => {
  const { prematureContent } = await import('../lib/design-content.mjs')
  const root = mkdtempSync(join(tmpdir(), 'structure-only-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const page = 'demo/home/index.tsx', letter = '.mailings/storage/processes/demo/welcome/1.message.yaml'
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', 'nodes: []\nlinks: []\n')
  put(page, 'export const landing = "Купить"')
  git('init', '-q', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  git('add', '.')
  git('commit', '-qm', 'Publish')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  assert.deepEqual(prematureContent(root, 'demo'), [page])
  git('switch', '-qc', 'change')
  assert.deepEqual(prematureContent(root, 'demo'), [page])
  git('switch', '-q', 'main')
  put('demo/PLAN.md', '# Предложенная структура')
  const packet = prepareOwnerDecision({ root, slug: 'demo', kind: 'plan', boardRevision: null })
  recordOwnerDecision({ root, slug: 'demo', kind: 'plan', packet, response: { decision: 'approve',
    message: 'Согласен', messageReference: 'test/plan', owner: 'fixture', answeredAt: new Date().toISOString() } })
  git('add', '.')
  git('commit', '-qm', 'Approved version')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  git('switch', '-qc', 'next-structure')
  put('demo/PLAN.md', '# Изменённая структура')
  assert.deepEqual(prematureContent(root, 'demo'), [])
  put(letter, 'subject: Новое предложение')
  git('add', '.')
  git('commit', '-qm', 'Letter')
  put(page, 'export const landing = "Изменено"')
  assert.deepEqual(prematureContent(root, 'demo').sort(), [page, letter].sort())
  const tool = fileURLToPath(new URL('../owner-decisions.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [tool, 'prepare', 'demo', '--root', root, '--kind', 'plan',
    '--board-revision', 'none'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.ok(result.stderr.includes(letter))
})
