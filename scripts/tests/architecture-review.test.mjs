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
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n## Нужно от вас\n- [ ] Согласовать текст чек-листа.\n')
  const ownerBefore = makeArchitectureReviewPacket({ root, slug: 'demo' }).inputDigest
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n## Нужно от вас\n- [x] Согласовать текст чек-листа.\n')
  assert.equal(makeArchitectureReviewPacket({ root, slug: 'demo' }).inputDigest, ownerBefore)
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n## Нужно от вас\n- [x] Согласовать другую цену.\n')
  assert.notEqual(makeArchitectureReviewPacket({ root, slug: 'demo' }).inputDigest, ownerBefore)
})

test('architecture reviewer checks existing work-card conditions without tracking status bookkeeping', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-architecture-tasks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Demo\norder: [overview.md]\n')
  put('.knowledge-base/processes/demo/overview.md', '---\ntitle: Процесс\n---\nПовторная заявка выдаёт чек-лист снова.\n')
  put('demo/PLAN.md', '# План\n\nПовторная заявка выдаёт чек-лист снова.\n')
  put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\n')
  const task = { id: 'W003', planTask: 'T1', title: 'Выдать чек-лист', status: 'queued',
    revision: 0, objective: 'Обработать повторную заявку', scope: { includes: ['Повтор'] },
    steps: [{ id: 'P1', action: 'Проверить событие', status: 'todo' }],
    acceptanceCriteria: [{ id: 'C1', planCriteria: ['T1.A1'],
      condition: 'Повторная заявка не запускает второе письмо',
      verification: { kind: 'test', instruction: 'Отправить форму дважды' } }] }
  put('demo/tasks/index.json', '{"version":1}\n')
  put('demo/tasks/W003.json', JSON.stringify(task))
  const before = makeArchitectureReviewPacket({ root, slug: 'demo' })
  const taskPath = 'demo/tasks/W003.json'
  assert.ok(before.files.some(file => file.path === taskPath &&
    file.content.includes('Повторная заявка не запускает второе письмо')))
  const report = { version: 1, process: 'demo', stage: 'architecture', inputDigest: before.inputDigest,
    inspectedFiles: before.files.map(file => file.path),
    inspectedReferences: [...before.referenceLibrary.required],
    answers: before.questions.map(question => ({ id: question.id, status: 'gap', priority: 'advisory',
      reason: 'Проверяется отдельно.', evidence: [], nextAction: 'Сверить материалы.' })) }
  const consistency = report.answers.find(answer => answer.id === 'consistency')
  Object.assign(consistency, { status: 'covered', reason: 'Условия якобы совпадают.',
    evidence: [{ path: 'demo/PLAN.md', quote: 'Повторная заявка выдаёт чек-лист снова.' }] })
  delete consistency.priority
  delete consistency.nextAction
  assert.throws(() => validateReview(report, before), /отдельные доказательства/)
  consistency.evidence.push({ path: taskPath, quote: 'Повторная заявка не запускает второе письмо' })
  assert.equal(validateReview(report, before).status, 'ready')

  put('demo/tasks/W003.json', JSON.stringify({ ...task, status: 'done', revision: 3,
    steps: [{ id: 'P1', action: 'Проверить событие', status: 'done' }] }))
  assert.equal(makeArchitectureReviewPacket({ root, slug: 'demo' }).inputDigest, before.inputDigest)
  put('demo/tasks/W003.json', JSON.stringify({ ...task, acceptanceCriteria: [{ ...task.acceptanceCriteria[0],
    condition: 'Повторная заявка выдаёт второе письмо' }] }))
  assert.notEqual(makeArchitectureReviewPacket({ root, slug: 'demo' }).inputDigest, before.inputDigest)
})

test('covered data answer requires citations from plan, table, event and analytics', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-architecture-join-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Demo\norder: [overview.md]\n')
  put('.knowledge-base/processes/demo/overview.md', '---\ntitle: Процесс\n---\nПросмотр связываем с заявкой.\n')
  put('demo/PLAN.md', '# План\n\nСохраняем visitorUid вместе с заявкой и связываем просмотр с заявкой.\n')
  put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\n')
  put('demo/specs/data.yaml', 'tables:\n  - id: requests\n    fields: [name]\n')
  put('demo/specs/events.yaml', 'events:\n  - key: request_created\n    visitorUid: uid\n')
  put('demo/specs/analytics.yaml', 'report: link by visitorUid\n')
  const packet = makeArchitectureReviewPacket({ root, slug: 'demo' })
  const report = { version: 1, process: 'demo', stage: 'architecture', inputDigest: packet.inputDigest,
    inspectedFiles: packet.files.map(file => file.path),
    inspectedReferences: [...packet.referenceLibrary.required],
    answers: packet.questions.map(question => ({ id: question.id, status: 'gap', priority: 'advisory',
      reason: 'Проверяется отдельно.', evidence: [], nextAction: 'Проверить источник.' })) }
  const dataAnswer = report.answers.find(answer => answer.id === 'data')
  Object.assign(dataAnswer, { status: 'covered', reason: 'Ключ якобы связан.',
    evidence: [{ path: 'demo/PLAN.md', quote: 'Сохраняем visitorUid вместе с заявкой' }] })
  delete dataAnswer.priority
  delete dataAnswer.nextAction
  assert.throws(() => validateReview(report, packet), /отдельные доказательства/)
  dataAnswer.evidence.push(
    { path: 'demo/specs/data.yaml', quote: 'fields: [name]' },
    { path: 'demo/specs/events.yaml', quote: 'visitorUid: uid' },
    { path: 'demo/specs/analytics.yaml', quote: 'link by visitorUid' },
  )
  assert.equal(validateReview(report, packet).status, 'ready')
  dataAnswer.status = 'not-applicable'
  assert.throws(() => validateReview(report, packet), /нельзя объявить неприменимым/)
  dataAnswer.status = 'covered'
  const lifecycle = report.answers.find(answer => answer.id === 'event-lifecycle')
  lifecycle.status = 'not-applicable'
  assert.throws(() => validateReview(report, packet), /нельзя объявить неприменимым/)
  Object.assign(lifecycle, { status: 'covered', reason: 'Источник каждого поля якобы существует до события.',
    evidence: [{ path: 'demo/specs/events.yaml', quote: 'visitorUid: uid' }] })
  delete lifecycle.priority
  delete lifecycle.nextAction
  assert.throws(() => validateReview(report, packet), /отдельные доказательства/)
  lifecycle.evidence.push({ path: 'demo/PLAN.md', quote: 'Сохраняем visitorUid вместе с заявкой' })
  assert.equal(validateReview(report, packet).status, 'ready')
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
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n## Экономика\n- План: цена 1000 рублей\nRD1: архитектурный контроль первого решения.\nRD2: архитектурный контроль второго решения.\n- [ ] T1 Собрать страницу\n## Согласования\n- План: согласовано снижение цены до 1000 рублей\n')
  const meaningfulApprovalLine = makeArchitectureReviewPacket({ root, slug: 'demo' }).inputDigest
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n## Экономика\n- План: цена 1000 рублей\nRD1: архитектурный контроль первого решения.\nRD2: архитектурный контроль второго решения.\n- [ ] T1 Собрать страницу\n## Согласования\n- План: согласовано снижение цены до 9000 рублей\n')
  assert.notEqual(makeArchitectureReviewPacket({ root, slug: 'demo' }).inputDigest, meaningfulApprovalLine)
})
