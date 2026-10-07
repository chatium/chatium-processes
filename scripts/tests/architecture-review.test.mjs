import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { makeArchitectureReviewPacket } from '../lib/architecture-review.mjs'
import { validateReview } from '../lib/knowledge-review.mjs'

test('architecture reviewer receives actual component specifications and notices their change', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-architecture-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Demo\norder: [overview.md]\n')
  put('.knowledge-base/processes/demo/overview.md', '---\ntitle: Процесс\n---\nКлиент выбирает услугу.\n')
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n')
  put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\n')
  put('demo/specs/site.yaml', 'version: 1\ntitle: Сайт\n')
  const before = makeArchitectureReviewPacket({ root, slug: 'demo' })
  assert.ok(before.files.some(file => file.path === 'demo/specs/site.yaml'))
  assert.ok(before.questions.some(question => question.id === 'site-and-services'))
  assert.ok(before.questions.some(question => question.id === 'staff-notifications' &&
    question.question.includes('сотрудник') && question.question.includes('заявк')))
  put('demo/specs/site.yaml', 'version: 1\ntitle: Другой сайт\n')
  const after = makeArchitectureReviewPacket({ root, slug: 'demo' })
  assert.notEqual(after.inputDigest, before.inputDigest)
})

test('architecture review tracks each owner risk decision but ignores plan bookkeeping', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-architecture-risk-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Demo\norder: [overview.md]\n')
  put('.knowledge-base/processes/demo/overview.md', '---\ntitle: Процесс\n---\nКлиент выбирает услугу.\n')
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n## Экономика\n- План: цена 1000 рублей\n- [ ] T1 Собрать страницу\n## Согласования\n- План: не согласован\n')
  put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\n')
  for (const id of ['RD1', 'RD2']) put(`demo/decisions/risk/${id}.json`, JSON.stringify({
    version: 1, id, recommendation: 'Проверять адрес до отправки',
    choice: 'Не проверять адрес', consequence: 'Ошибочный получатель',
    scope: 'Только тест', control: 'Остановить отправку при сбое',
    owner: { message: `Выбираю ${id}`, answeredAt: '2026-10-07T10:00:00.000Z' },
  }, null, 2))
  const before = makeArchitectureReviewPacket({ root, slug: 'demo' })
  assert.deepEqual(before.questions.filter(q => q.id.startsWith('risk.')).map(q => q.id),
    ['risk.RD1', 'risk.RD2'])
  const report = { version: 1, process: 'demo', stage: 'architecture', inputDigest: before.inputDigest,
    inspectedFiles: before.files.map(file => file.path),
    inspectedReferences: [...before.referenceLibrary.required],
    answers: before.questions.map(question => ({ id: question.id, status: 'gap',
      priority: question.id.startsWith('risk.') ? 'blocking' : 'advisory',
      reason: 'Синтетический незакрытый вопрос.', evidence: [],
      nextAction: 'Проверить вручную.' })) }
  report.answers.pop()
  assert.throws(() => validateReview(report, before), /каждый вопрос/)
  report.answers.push({ id: 'risk.RD2', status: 'covered', reason: 'Синтетическая проверка ссылки.',
    evidence: [{ path: 'demo/decisions/risk/RD2.json', quote: 'RD2' }] })
  assert.throws(() => validateReview(report, before), /связанных материалов/)
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n## Экономика\n- План: цена 1000 рублей\nRD1: архитектурный контроль первого решения.\nRD2: архитектурный контроль второго решения.\n- [x] T1 Собрать страницу\n## Согласования\n- План: согласован\n')
  const linked = makeArchitectureReviewPacket({ root, slug: 'demo' })
  const completed = { ...report, inputDigest: linked.inputDigest, inspectedFiles: linked.files.map(file => file.path),
    answers: report.answers.map(answer => answer.id.startsWith('risk.')
      ? { id: answer.id, status: 'covered', reason: 'Синтетическая проверка ссылок.',
        evidence: [{ path: `demo/decisions/risk/${answer.id.slice(5)}.json`, quote: answer.id.slice(5) },
          { path: 'demo/PLAN.md', quote: answer.id.slice(5) }] }
      : answer) }
  assert.equal(validateReview(completed, linked).status, 'ready')
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n## Экономика\n- План: цена 1000 рублей\nRD1: архитектурный контроль первого решения.\nRD2: архитектурный контроль второго решения.\n- [ ] T1 Собрать страницу\n## Согласования\n- План: не согласован\n')
  assert.equal(makeArchitectureReviewPacket({ root, slug: 'demo' }).inputDigest, linked.inputDigest)
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n## Экономика\n- План: цена 9000 рублей\nRD1: архитектурный контроль первого решения.\nRD2: архитектурный контроль второго решения.\n- [ ] T1 Собрать страницу\n## Согласования\n- План: не согласован\n')
  assert.notEqual(makeArchitectureReviewPacket({ root, slug: 'demo' }).inputDigest, linked.inputDigest)
})
