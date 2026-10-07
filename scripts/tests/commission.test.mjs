import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commissionStatus, reviewRequirements } from '../lib/commission.mjs'
import { makeArchitectureReviewPacket, recordArchitectureReview } from '../lib/architecture-review.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-commission-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'demo/agents'), { recursive: true })
  writeFileSync(join(root, 'demo/process.yaml'), `title: Demo
nodes:
  - { id: home, kind: page, source: demo/pages/home/ }
  - { id: welcome, kind: series, source: .mailings/storage/processes/demo/welcome/ }
links: []
`)
  return root
}

test('commission roster follows stage and process contents', t => {
  const root = fixture(t)
  const requirements = stage => reviewRequirements({ root, slug: 'demo', stage }).map(item => item.id)
  assert.deepEqual(requirements('design'), ['knowledge-design', 'architecture'])
  assert.deepEqual(requirements('build'), ['knowledge-build', 'architecture', 'implementation',
    'creative-home-spec', 'creative-welcome-spec'])
  assert.deepEqual(requirements('test'), ['knowledge-build', 'architecture', 'implementation',
    'creative-home-spec', 'creative-home-result', 'creative-welcome-spec', 'creative-welcome-result'])
  writeFileSync(join(root, 'demo/agents/helper.agent.json'), '{}')
  assert.ok(requirements('test').includes('agents'))
  assert.ok(!requirements('design').includes('agents'))
})

test('missing and invalid independent conclusions block the central status', t => {
  const root = fixture(t)
  const result = commissionStatus({ root, slug: 'demo', stage: 'design' })
  assert.equal(result.status, 'needs-work')
  assert.equal(result.requirements.length, 2)
  assert.ok(result.requirements.every(item => item.status !== 'ready'))
})

test('a process without customer pages or message series needs no creative commission', t => {
  const root = fixture(t)
  writeFileSync(join(root, 'demo/process.yaml'), `title: Manager notice
nodes:
  - { id: notice, kind: external, source: demo/api/notify.ts }
links: []
`)
  assert.deepEqual(reviewRequirements({ root, slug: 'demo', stage: 'test' }).map(item => item.role),
    ['methodology', 'architecture', 'implementation'])
})

test('a blocking architecture conclusion keeps the design commission red', t => {
  const root = fixture(t)
  mkdirSync(join(root, '.knowledge-base/processes/demo'), { recursive: true })
  writeFileSync(join(root, '.knowledge-base/.knowledge.yml'), 'order: [processes]\n')
  writeFileSync(join(root, '.knowledge-base/processes/.knowledge.yml'), 'order: [demo]\n')
  writeFileSync(join(root, '.knowledge-base/processes/demo/.knowledge.yml'), 'title: Demo\norder: [overview.md]\n')
  const article = '.knowledge-base/processes/demo/overview.md'
  const quote = 'Менеджер принимает заявку и отвечает клиенту в рабочий день.'
  writeFileSync(join(root, article), `---\ntitle: Процесс\n---\n${quote}\n`)
  writeFileSync(join(root, 'demo/PLAN.md'), '# План\n\nМенеджер отвечает на заявку.\n')
  writeFileSync(join(root, 'demo/process.yaml'), 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\nlinks: []\n')
  const packet = makeArchitectureReviewPacket({ root, slug: 'demo' })
  const report = { version: 1, process: 'demo', stage: 'architecture', inputDigest: packet.inputDigest,
    inspectedFiles: packet.files.map(file => file.path), inspectedReferences: [...packet.referenceLibrary.required],
    answers: packet.questions.map((question, index) => ({ id: question.id, status: 'covered',
      reason: 'Синтетический ответ для проверки комиссии.',
      evidence: [{ path: article, quote: quote.slice(index % 3) }] })) }
  Object.assign(report.answers.find(answer => answer.id === 'journey'), {
    status: 'gap', priority: 'blocking', reason: 'Путь отказа клиента пропущен.',
    nextAction: 'Добавить путь отказа в план и карту.', evidence: [],
  })
  assert.equal(recordArchitectureReview({ root, slug: 'demo', packet, report,
    agentReference: 'unit-test-only:architecture-gap' }).status, 'needs-work')
  const status = commissionStatus({ root, slug: 'demo', stage: 'design' })
  assert.equal(status.status, 'needs-work')
  const architecture = status.requirements.find(item => item.id === 'architecture')
  assert.equal(architecture.status, 'needs-work')
  assert.deepEqual(architecture.blocking.map(item => item.id), ['journey'])
})
