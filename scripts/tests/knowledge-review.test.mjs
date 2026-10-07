import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeReviewPacket, recordReview, reviewPath, reviewStatus, validateReview } from '../lib/knowledge-review.mjs'

import { writeReferenceSnapshot } from '../lib/review-library.mjs'

const articlePath = '.knowledge-base/processes/demo/overview.md'
const quote = 'Заявка передаётся менеджеру, который отвечает в течение рабочего дня.'
const article = body => `---\ntitle: Запись на услугу\n---\n\n${body}\n`
const cli = fileURLToPath(new URL('../kb-review.mjs', import.meta.url))

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'knowledge-review-'))
  const root = join(base, 'account')
  mkdirSync(root)
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Запись\norder: [overview.md]\n')
  put(articlePath, article(`${quote}\n\nВ этом процессе нет оплаты и автоматической рассылки.`))
  put('demo/PLAN.md', '# План\n\nФорма заявки и ручной ответ менеджера.\n')
  put('demo/process.yaml', 'title: Запись\nknowledge: .knowledge-base/processes/demo\nnodes: []\n')
  const packet = (stage = 'build') => makeReviewPacket({ root, slug: 'demo', stage })
  const run = (command, flags = []) => spawnSync(process.execPath,
    [cli, command, 'demo', '--root', root, '--json', ...flags],
    { encoding: 'utf8', env: process.env, cwd: root })
  return { base, root, put, packet, run }
}

// These answers exercise structural validation only, not semantic acceptance.
function syntheticReport(packet) {
  return {
    version: 1, process: packet.process, stage: packet.stage, inputDigest: packet.inputDigest,
    inspectedFiles: packet.files.map(file => file.path),
    inspectedReferences: [...packet.referenceLibrary.required],
    answers: packet.questions.map((question, index) => ({ id: question.id, status: 'covered',
      reason: 'Синтетический ответ для проверки формата валидатора.',
      evidence: question.id.startsWith('risk.')
        ? question.requiredEvidenceGroups.map(group => ({ path: group.paths[0], quote: question.id.slice(5) }))
        : [{ path: articlePath, quote: quote.slice(index % 3) }] })),
  }
}

function save(f, packet, report = syntheticReport(packet)) {
  return recordReview({ root: f.root, slug: 'demo', stage: packet.stage, packet, report,
    agentReference: 'unit-test-only:synthetic-review' })
}

test('one mechanically repeated citation cannot make every different answer green', t => {
  const packet = fixture(t).packet()
  const report = syntheticReport(packet)
  for (const answer of report.answers) answer.evidence = [{ path: articlePath, quote }]
  assert.throws(() => validateReview(report, packet), /механически повторена/)
})

test('route protection cannot be marked covered with only a claim in the plan', () => {
  const packet = { process: 'demo', stage: 'implementation', inputDigest: 'current',
    files: [{ path: 'demo/PLAN.md', content: 'Маршрут закрыт для сотрудников.' },
      { path: 'demo/pages/private/index.tsx', content: 'export const route = staffOnly' }],
    questions: [{ id: 'security.routes', requiredEvidencePaths: ['.ts', '.tsx', '.js', '.jsx', '.vue'] }],
    referenceLibrary: { files: [], required: [] }, staticChecks: [] }
  const report = { version: 1, process: 'demo', stage: 'implementation', inputDigest: 'current',
    inspectedFiles: packet.files.map(file => file.path), inspectedReferences: [],
    answers: [{ id: 'security.routes', status: 'covered', reason: 'Защита есть.',
      evidence: [{ path: 'demo/PLAN.md', quote: 'Маршрут закрыт для сотрудников.' }] }] }
  assert.throws(() => validateReview(report, packet), /первичного источника/)
  report.answers[0].evidence.push({ path: 'demo/pages/private/index.tsx', quote: 'export const route = staffOnly' })
  assert.equal(validateReview(report, packet).status, 'ready')
})

test('stage question sets grow from design to build to launch, with unique IDs', t => {
  const f = fixture(t)
  const design = f.packet('design'), build = f.packet('build'), launch = f.packet('launch')
  const ids = p => p.questions.map(q => q.id)
  assert.ok(design.questions.length > 0)
  assert.ok(build.questions.length > design.questions.length)
  assert.ok(launch.questions.length > build.questions.length)
  assert.ok(ids(design).every(id => ids(build).includes(id)))
  assert.ok(ids(build).every(id => ids(launch).includes(id)))
  assert.ok(design.questions.every(q => q.fromStage === 'design'))
  assert.ok(build.questions.every(q => ['design', 'build'].includes(q.fromStage)))
  assert.ok(!ids(design).includes('artifacts.alignment'))
  assert.ok(ids(design).includes('evidence.materials'))
  assert.ok(ids(design).includes('business.specific'))
  assert.ok(ids(build).includes('artifacts.alignment'))
  assert.ok(!ids(build).includes('launch.permission'))
  assert.ok(ids(launch).includes('launch.permission'))
  for (const packet of [design, build, launch]) {
    assert.equal(new Set(ids(packet)).size, packet.questions.length)
    assert.equal(packet.staticChecks.flatMap(c => c.errors).length, 0)
    assert.ok(packet.reviewerInstructions.length > 0)
    assert.ok(packet.referenceLibrary.required.includes('skills/processes/method/readiness.md'))
    assert.equal(packet.methodology, undefined)
  }
  assert.throws(() => f.packet('unknown'), /этап/)
})

test('a business-specific gap blocks design despite covered generic topics', t => {
  const packet = fixture(t).packet('design')
  const report = syntheticReport(packet)
  const answer = report.answers.find(item => item.id === 'business.specific')
  answer.status = 'gap'
  answer.reason = 'Не определено, как сезонность меняет сроки записи.'
  answer.evidence = []
  answer.priority = 'blocking'
  answer.nextAction = 'Уточнить у владельца сроки записи в высокий сезон.'
  const result = validateReview(report, packet)
  assert.equal(result.status, 'needs-work')
  assert.deepEqual(result.blocking.map(item => item.id), ['business.specific'])
})

test('an undocumented owner choice against a material recommendation blocks design', t => {
  const packet = fixture(t).packet('design')
  const question = packet.questions.find(item => item.id === 'evidence.decisions')
  assert.match(question.lookFor, /вопреки рекомендации/)
  const report = syntheticReport(packet)
  const answer = report.answers.find(item => item.id === 'evidence.decisions')
  Object.assign(answer, { status: 'gap', priority: 'blocking', evidence: [],
    reason: 'Владелец отказался от подтверждения адреса, но последствия и граница отказа не записаны.',
    nextAction: 'Сохранить точный ответ, объяснённый риск и способ контроля до проектирования.' })
  const result = validateReview(report, packet)
  assert.equal(result.status, 'needs-work')
  assert.deepEqual(result.blocking.map(item => item.id), ['evidence.decisions'])
})

test('each material risk decision has its own non-skippable question and source', t => {
  const f = fixture(t)
  for (const id of ['RD1', 'RD2']) f.put(`demo/decisions/risk/${id}.json`, JSON.stringify({
    version: 1, id, recommendation: `Безопасный путь ${id}`,
    choice: `Владелец выбрал рискованный путь ${id}`,
    consequence: `Последствие ${id}`, scope: `Граница ${id}`, control: `Контроль ${id}`,
    owner: { message: `Выбираю ${id}`, messageReference: `message:${id}`,
      answeredAt: '2026-10-07T10:00:00.000Z' },
  }, null, 2))
  const withoutLinks = f.packet('design')
  const incomplete = syntheticReport(withoutLinks)
  incomplete.answers.find(a => a.id === 'risk.RD1').evidence =
    [{ path: 'demo/decisions/risk/RD1.json', quote: 'RD1' }]
  assert.throws(() => validateReview(incomplete, withoutLinks), /связанных материалов/)
  f.put(articlePath, article(`${quote}\n\nRD1: выбор и последствия первого риска.\nRD2: выбор и последствия второго риска.`))
  f.put('demo/PLAN.md', '# План\n\nRD1: контроль первого риска.\nRD2: контроль второго риска.\n')
  const packet = f.packet('design')
  assert.deepEqual(packet.questions.filter(q => q.id.startsWith('risk.')).map(q => q.id),
    ['risk.RD1', 'risk.RD2'])
  assert.equal(validateReview(syntheticReport(packet), packet).status, 'ready')
  const firstRecord = JSON.parse(readFileSync(join(f.root, 'demo/decisions/risk/RD1.json'), 'utf8'))
  delete firstRecord.owner.messageReference
  f.put('demo/decisions/risk/RD1.json', JSON.stringify(firstRecord, null, 2))
  assert.equal(f.packet('design').questions.filter(q => q.id.startsWith('risk.')).length, 2)
  const missing = syntheticReport(packet)
  missing.answers = missing.answers.filter(a => a.id !== 'risk.RD2')
  assert.throws(() => validateReview(missing, packet), /каждый вопрос/)
  const wrong = syntheticReport(packet)
  wrong.answers.find(a => a.id === 'risk.RD2').evidence =
    [{ path: 'demo/decisions/risk/RD1.json', quote: '"id": "RD1"' }]
  assert.throws(() => validateReview(wrong, packet), /допустимой области/)
  const dismissed = syntheticReport(packet)
  dismissed.answers.find(a => a.id === 'risk.RD2').status = 'not-applicable'
  assert.throws(() => validateReview(dismissed, packet), /нельзя объявить неприменимым/)
  const unresolved = syntheticReport(packet)
  Object.assign(unresolved.answers.find(a => a.id === 'risk.RD2'), {
    status: 'gap', priority: 'blocking', evidence: [],
    reason: 'Не определён контроль риска.', nextAction: 'Уточнить контроль с владельцем.',
  })
  assert.equal(validateReview(unresolved, packet).status, 'needs-work')
  unresolved.answers.find(a => a.id === 'risk.RD2').priority = 'advisory'
  assert.throws(() => validateReview(unresolved, packet), /блокирует этап/)
  const before = packet.inputDigest
  f.put('demo/decisions/risk/RD2.json', readFileSync(join(f.root, 'demo/decisions/risk/RD2.json'), 'utf8')
    .replace('Контроль RD2', 'Новый контроль RD2'))
  assert.notEqual(f.packet('design').inputDigest, before)
  assert.throws(() => save(f, packet), /изменились после подготовки/)
})

test('invalid or escaped risk records cannot disappear into a green review', t => {
  const f = fixture(t)
  f.put('demo/decisions/risk/RD1.json', '{"version":1,"id":"RD1"}')
  assert.throws(() => f.packet('design'), /нужен точный ответ владельца/)
  rmSync(join(f.root, 'demo/decisions/risk/RD1.json'))
  const outside = join(f.base, 'outside.json')
  writeFileSync(outside, '{}')
  symlinkSync(outside, join(f.root, 'demo/decisions/risk/RD1.json'))
  assert.throws(() => f.packet('design'), /недоступно или слишком велико/)
})

test('every rubric question needs one answer and every packet file must be listed once', t => {
  const packet = fixture(t).packet()
  const missing = syntheticReport(packet); missing.answers.pop()
  assert.throws(() => validateReview(missing, packet), /каждый вопрос/)
  const duplicate = syntheticReport(packet); duplicate.answers[1] = duplicate.answers[0]
  assert.throws(() => validateReview(duplicate, packet), /повторный ID/)
  const unknown = syntheticReport(packet); unknown.answers[0].id = 'invented.question'
  assert.throws(() => validateReview(unknown, packet), /Неизвестный/)
  for (const change of [r => r.inspectedFiles.pop(), r => { r.inspectedFiles[1] = r.inspectedFiles[0] },
    r => { r.inspectedFiles[0] = 'outside.md' }]) {
    const report = syntheticReport(packet); change(report)
    assert.throws(() => validateReview(report, packet), /inspectedFiles/)
  }
})

test('fabricated quotes and evidence outside the packet cannot substantiate an answer', t => {
  const packet = fixture(t).packet()
  const report = syntheticReport(packet)
  report.answers[0].evidence[0].quote = 'Несуществующая подтверждённая конверсия 93 процента.'
  assert.throws(() => validateReview(report, packet), /Цитата.*не найдена/)
  report.answers[0].evidence[0] = { path: 'private-business.md', quote }
  assert.throws(() => validateReview(report, packet), /Источник.*отсутствует/)
})

test('reference coverage requires mandatory sections but allows selective reading', t => {
  const packet = fixture(t).packet(), report = syntheticReport(packet)
  assert.equal(validateReview(report, packet).status, 'ready')
  assert.ok(report.inspectedReferences.length < packet.referenceLibrary.files.length)
  for (const change of [r => { delete r.inspectedReferences }, r => r.inspectedReferences.pop(),
    r => r.inspectedReferences.push(r.inspectedReferences[0]), r => r.inspectedReferences.push('outside.md')]) {
    const altered = structuredClone(report); change(altered)
    assert.throws(() => validateReview(altered, packet), /inspectedReferences/)
  }
})

test('not-applicable requires a reason and a real source, not an unsupported dismissal', t => {
  const packet = fixture(t).packet(), report = syntheticReport(packet)
  const answer = report.answers.find(a => a.id === 'payment.contract')
  answer.status = 'not-applicable'; answer.evidence = []
  assert.throws(() => validateReview(report, packet), /Нужна цитата/)
  answer.evidence = [{ path: articlePath, quote: 'В этом процессе нет оплаты и автоматической рассылки.' }]
  answer.reason = ' '
  assert.throws(() => validateReview(report, packet), /reason/)
  answer.reason = 'В источнике явно указан бесплатный процесс.'
  assert.equal(validateReview(report, packet).status, 'ready')
})

test('quote matching normalizes source line wrapping and repeated whitespace', t => {
  const f = fixture(t)
  f.put(articlePath, article(quote.replace('менеджеру, который', 'менеджеру,\n\tкоторый')))
  const packet = f.packet()
  assert.equal(validateReview(syntheticReport(packet), packet).status, 'ready')
})

test('blocking gaps and structural errors block readiness; advisory gaps do not', t => {
  const packet = fixture(t).packet(), report = syntheticReport(packet)
  const gap = report.answers[0]
  Object.assign(gap, { status: 'gap', priority: 'advisory', evidence: [],
    reason: 'Нужно улучшить описание.', nextAction: 'Добавить пример при следующей правке.' })
  let result = validateReview(report, packet)
  assert.equal(result.status, 'ready'); assert.equal(result.advisory.length, 1)
  gap.priority = 'blocking'
  result = validateReview(report, packet)
  assert.equal(result.status, 'needs-work'); assert.equal(result.blocking.length, 1)
  delete gap.nextAction
  assert.throws(() => validateReview(report, packet), /nextAction/)
  const broken = structuredClone(packet)
  broken.staticChecks[0].errors.push('Статья содержит незаполненное поле.')
  assert.equal(validateReview(syntheticReport(packet), broken).status, 'needs-work')
  const covered = syntheticReport(packet); covered.answers[0].priority = 'advisory'
  assert.throws(() => validateReview(covered, packet), /только для gap/)
})

test('record creates parseable provenance and status progresses from missing to ready to stale', t => {
  const f = fixture(t), packet = f.packet()
  assert.equal(reviewStatus({ root: f.root, slug: 'demo' }).status, 'missing')
  const result = save(f, packet)
  const saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(saved.reviewer.kind, 'subagent')
  assert.equal(saved.reviewer.reference, 'unit-test-only:synthetic-review')
  assert.ok(Number.isFinite(Date.parse(saved.reviewedAt)))
  assert.equal(saved.inputDigest, packet.inputDigest)
  assert.equal(reviewStatus({ root: f.root, slug: 'demo' }).status, 'ready')
  f.put('demo/PLAN.md', '# План\n\nДобавлено подтверждение времени записи.\n')
  assert.equal(reviewStatus({ root: f.root, slug: 'demo' }).status, 'stale')
})

test('digest tracks article, PLAN and map changes but ignores code, reports and unrelated knowledge', t => {
  const f = fixture(t), before = f.packet().inputDigest
  f.put('demo/actions/register.ts', 'export const register = () => true\n')
  f.put('demo/reviews/knowledge-build.json', '{"ignored":"report contents"}\n')
  f.put('.knowledge-base/processes/other/overview.md', article('Другой процесс.'))
  f.put('.knowledge-base/business/unlinked.md', article('Несвязанный бизнес.'))
  assert.equal(f.packet().inputDigest, before)
  for (const path of [articlePath, 'demo/PLAN.md', 'demo/process.yaml']) {
    const original = readFileSync(join(f.root, path), 'utf8')
    f.put(path, original + (path.endsWith('.yaml') ? '\n# Новое условие\n' : '\nНовое условие.\n'))
    assert.notEqual(f.packet().inputDigest, before, path)
    f.put(path, original)
    assert.equal(f.packet().inputDigest, before, path)
  }
})

test('knowledge conclusion survives task bookkeeping and consent record updates', t => {
  const f = fixture(t)
  f.put('demo/PLAN.md', '# План\n\nФорма заявки.\n## Задачи\n- [ ] T1 Собрать форму\n  - Рабочие задачи: [W1](tasks/W1.json)\n## Согласования\n- План: не согласован\n- Запуск: не согласован\n')
  const before = f.packet().inputDigest
  f.put('demo/PLAN.md', '# План\n\nФорма заявки.\n## Задачи\n- [x] T1 Собрать форму\n  - Рабочие задачи: [W2](tasks/W2.json)\n## Согласования\n- План: согласован 07.10\n- Запуск: согласован 07.10\n')
  assert.equal(f.packet().inputDigest, before)
  f.put('demo/PLAN.md', '# План\n\nФорма оплаты.\n## Задачи\n- [x] T1 Собрать форму\n  - Рабочие задачи: [W2](tasks/W2.json)\n## Согласования\n- План: согласован 07.10\n- Запуск: согласован 07.10\n')
  assert.notEqual(f.packet().inputDigest, before)
})

test('stale input packets cannot record a previously passing review', t => {
  const f = fixture(t), packet = f.packet()
  f.put(articlePath, article(`${quote}\nУслуга временно недоступна.`))
  assert.throws(() => save(f, packet), /изменились после подготовки/)
  assert.equal(existsSync(reviewPath(f.root, 'demo', 'build')), false)
})

test('record validates current sources and rubric despite supplied packet tampering', t => {
  const f = fixture(t), packet = f.packet(), altered = structuredClone(packet)
  altered.files.find(file => file.path === articlePath).content += '\nВыдуманное одобрение владельца.'
  const report = syntheticReport(altered)
  report.answers[0].evidence[0].quote = 'Выдуманное одобрение владельца.'
  assert.throws(() => save(f, altered, report), /Цитата.*не найдена/)
  const fewer = structuredClone(packet); fewer.questions = []
  assert.throws(() => save(f, fewer, syntheticReport(fewer)), /каждый вопрос/)
  assert.equal(existsSync(reviewPath(f.root, 'demo', 'build')), false)
})

test('status rejects malformed report identity or missing reviewer provenance', t => {
  const f = fixture(t), packet = f.packet()
  const report = { ...syntheticReport(packet), reviewedAt: new Date().toISOString() }
  f.put('demo/reviews/knowledge-build.json', JSON.stringify(report))
  assert.throws(() => reviewStatus({ root: f.root, slug: 'demo' }), /ревьюере/)
  report.reviewer = { kind: 'subagent', reference: 'unit-test-only' }
  report.process = 'other'
  f.put('demo/reviews/knowledge-build.json', JSON.stringify(report))
  assert.throws(() => reviewStatus({ root: f.root, slug: 'demo' }), /не соответствует/)
})

test('report path rejects existing outside symlinks without overwriting their targets', t => {
  const f = fixture(t), packet = f.packet()
  const outside = join(f.base, 'outside.json')
  writeFileSync(outside, 'UNTOUCHED')
  mkdirSync(join(f.root, 'demo/reviews'))
  symlinkSync(outside, join(f.root, 'demo/reviews/knowledge-build.json'))
  assert.throws(() => save(f, packet), /за пределы/)
  assert.equal(readFileSync(outside, 'utf8'), 'UNTOUCHED')
})

test('report path rejects a dangling outside symlink before creating the external target', t => {
  const f = fixture(t), packet = f.packet()
  const outside = join(f.base, 'not-created.json')
  mkdirSync(join(f.root, 'demo/reviews'))
  symlinkSync(outside, join(f.root, 'demo/reviews/knowledge-build.json'))
  assert.throws(() => save(f, packet), /за пределы|символическ|ссылк|ENOENT/)
  assert.equal(existsSync(outside), false)
})

test('CLI prepare emits readable immutable packet and prompt and refuses output overwrite', t => {
  const f = fixture(t), output = join(f.base, 'prepared')
  const prepared = f.run('prepare', ['--out', output])
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout)
  const result = JSON.parse(prepared.stdout)
  const packetText = readFileSync(result.packet, 'utf8')
  const packet = JSON.parse(packetText)
  assert.equal(packet.inputDigest, f.packet().inputDigest)
  const prompt = readFileSync(result.prompt, 'utf8')
  assert.ok(prompt.includes(result.packet))
  assert.ok(prompt.includes('\n'), 'prompt must contain real line breaks')
  assert.equal(f.run('prepare', ['--out', output]).status, 2)
  assert.equal(readFileSync(result.packet, 'utf8'), packetText)
  assert.equal(readFileSync(result.prompt, 'utf8'), prompt)
  assert.equal(f.run('prepare', ['--out', join(f.root, 'review-input')]).status, 2)
})

test('CLI prepare rejects an output directory symlink that points back inside the repository', t => {
  const f = fixture(t), linkedOutput = join(f.base, 'outside-name')
  symlinkSync(join(f.root, 'demo'), linkedOutput)
  assert.equal(f.run('prepare', ['--out', linkedOutput]).status, 2)
  assert.equal(existsSync(join(f.root, 'demo/packet.json')), false)
})

test('CLI status, record and bad arguments use 0, 1 and 2 exit codes', t => {
  const f = fixture(t), packet = f.packet()
  assert.equal(f.run('status').status, 1)
  assert.equal(f.run('status', ['--unknown', 'value']).status, 2)
  assert.equal(f.run('prepare', ['--stage', 'unknown']).status, 2)
  assert.equal(f.run('prepare', ['--stage']).status, 2)
  assert.equal(f.run('prepare', ['--out']).status, 2)
  assert.equal(f.run('prepare', ['extra']).status, 2)
  assert.equal(f.run('record').status, 2)
  assert.equal(f.run('other').status, 2)
  const packetFile = join(f.base, 'packet.json'), reportFile = join(f.base, 'answer.json')
  writeReferenceSnapshot(f.base, packet)
  writeFileSync(packetFile, JSON.stringify(packet))
  writeFileSync(reportFile, JSON.stringify(syntheticReport(packet)))
  const flags = ['--packet', packetFile, '--report', reportFile, '--agent', 'unit-test-only:cli']
  const recorded = f.run('record', flags)
  assert.equal(recorded.status, 0, recorded.stderr || recorded.stdout)
  assert.equal(f.run('status').status, 0)
  const report = syntheticReport(packet)
  Object.assign(report.answers[0], { status: 'gap', priority: 'blocking', evidence: [],
    reason: 'Не указан ответственный.', nextAction: 'Выяснить ответственного у владельца.' })
  writeFileSync(reportFile, JSON.stringify(report))
  assert.equal(f.run('record', flags).status, 1)
  assert.equal(f.run('status').status, 1)
  f.put('demo/PLAN.md', '# Изменённый план\n\nДобавлена ручная обработка.\n')
  assert.equal(f.run('status').status, 1)
  assert.equal(f.run('record', flags).status, 2)
})
