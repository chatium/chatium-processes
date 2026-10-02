import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { creativePacket, creativeStatus, writeCreativeBuild } from '../lib/creative.mjs'
import { creativeReviewPacket, creativeReviewStatus, recordCreativeReview } from '../lib/creative-review.mjs'
import { expandedTaskInputs, taskInputDigest, taskReadiness } from '../lib/tasks.mjs'
import { SKILL_DIR } from '../lib/project.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-creative-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  cpSync(join(SKILL_DIR, 'creative/catalog'), join(root, '.agents/skills/processes/creative/catalog'), { recursive: true })
  const put = (path, content) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof content === 'string' || Buffer.isBuffer(content) ? content : JSON.stringify(content, null, 2) + '\n')
  }
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Демо\norder: [offer.md]\n')
  put('.knowledge-base/processes/demo/offer.md', '---\ntitle: Предложение\n---\nМатериал помогает сделать первый шаг. Контакт нужен для выдачи.\n')
  put('demo/PLAN.md', '# Демо\n\n## Задачи\n- [ ] T1 Собрать страницу\n')
  put('demo/process.yaml', { title: 'Проба', nodes: [{ id: 'lead-page', kind: 'page', title: 'Получить материал',
    creativeRef: 'demo/creative/lead-page/spec.yaml' }] })
  const spec = {
    version: 1, kind: 'landing', targetNode: 'lead-page', landingType: 'lead_magnet',
    objective: 'Выдать материал после заявки', audience: 'Новые посетители',
    sources: [{ id: 'offer', path: '.knowledge-base/processes/demo/offer.md' }], references: [],
    sections: ['hero', 'benefits', 'form_section'].map(type => ({ id: type, type, covers: [type],
      purpose: `Объяснить ${type}`, points: [{ text: 'Материал помогает сделать первый шаг', sourceRef: 'offer' }],
      presentation: { desktop: 'Крупный текст и видимая форма', mobile: 'Одна колонка' },
      mechanicRefs: type === 'form_section' ? ['signup'] : [], acceptance: ['Содержание видно и понятно'] })),
    mechanics: [{ id: 'signup', type: 'form', purpose: 'Получить контакт', placement: 'form_section',
      fields: ['email'], target: 'demo/form-submit', success: 'Показать подтверждение',
      error: 'Показать ошибку', mobile: 'Поля в одну колонку' }],
    design: { styleId: 'clean_service', adaptation: 'Использовать контрастную кнопку для выдачи материала' },
    images: [], abTesting: { mode: 'none' }, openQuestions: [], acceptance: ['Материал выдаётся после корректной заявки'],
  }
  put('demo/creative/lead-page/spec.yaml', spec)
  return { root, put, spec, args: { root, slug: 'demo', nodeId: 'lead-page' } }
}

test('compiler expands selected landing settings and detects changed inputs or generated text', t => {
  const f = fixture(t)
  const result = writeCreativeBuild(f.args)
  assert.equal(creativeStatus(f.args).status, 'ready')
  const content = readFileSync(join(f.root, result.path), 'utf8')
  assert.match(content, /## Дизайн-система/)
  assert.match(content, /Контрастная заливка primary/)
  assert.match(content, /### form_section/)
  assert.match(content, /creative-build-v1/)
  f.put('.knowledge-base/processes/demo/offer.md', 'Материал обновлён.\n')
  assert.equal(creativeStatus(f.args).status, 'stale')
  writeCreativeBuild(f.args)
  f.put(result.path, content + '\nРучная правка\n')
  assert.equal(creativeStatus(f.args).status, 'stale')
})

test('sales permits author-selected sections, keeps a real conversion path and distinct A/B variants', t => {
  const f = fixture(t)
  f.spec.landingType = 'sales'
  f.spec.sections = [{ ...f.spec.sections[0], id: 'workshop-invitation', type: 'invitation',
    covers: ['приглашение на занятие'], purpose: 'Пригласить на занятие с понятными условиями', mechanicRefs: ['signup'] }]
  f.spec.mechanics[0].placement = 'workshop-invitation'
  f.spec.abTesting = { mode: 'text', hypothesis: 'Другой заголовок помогает понять ценность',
    experimentKey: 'heading-test', assignment: 'Закрепить вариант за контактом',
    metric: 'Заявки', tracking: 'Событие с variantKey', variants: [{ key: 'A', changes: 'Заголовок A' }, { key: 'A', changes: 'Заголовок B' }] }
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  const packet = creativePacket(f.args)
  assert.ok(packet.errors.some(e => e.includes('уникальными ключами')))
  f.spec.abTesting.variants[1].key = 'B'
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.deepEqual(creativePacket(f.args).errors, [])
  const built = writeCreativeBuild(f.args)
  const body = readFileSync(join(f.root, built.path), 'utf8')
  assert.match(body, /workshop-invitation/)
  assert.doesNotMatch(body, /### hero|### problem|### pricing/)
  f.spec.mechanics = []
  f.spec.sections[0].mechanicRefs = []
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.ok(creativePacket(f.args).errors.some(e => e.includes('путь покупки или заявки')))
})

test('series keeps each email distinct and checks its automation dependency', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { title: 'Проба', nodes: [{ id: 'followup', kind: 'series', title: 'Серия после заявки',
    creativeRef: 'demo/creative/followup/spec.yaml' }] })
  f.put('demo/automation/flow.automationConfig.json', { version: 1 })
  const spec = { version: 1, kind: 'series', targetNode: 'followup', seriesType: 'sales',
    objective: 'Помочь выбрать предложение', audience: 'Оставившие заявку',
    sources: [{ id: 'offer', path: '.knowledge-base/processes/demo/offer.md' }],
    voice: { addressing: 'вы', character: 'спокойный эксперт', emotionality: 'сдержанно', example: 'Покажем следующий шаг.' },
    emailDesign: { layout: 'Одна колонка', components: 'Текст и кнопка', colors: 'Контрастный текст', mobile: 'Ширина по экрану' },
    messages: [{ id: 'm1', path: '.mailings/storage/processes/demo/followup/1.message.yaml',
      goal: 'Объяснить ценность', mainIdea: 'Материал помогает начать', hook: 'С чего начать?',
      subject: 'Первый шаг', preheader: 'Короткая инструкция',
      blocks: [{ type: 'value', text: 'Первый шаг проще с материалом', sourceRef: 'offer' }],
      cta: { label: 'Открыть материал', target: '/material' } }],
    automationRef: 'demo/automation/flow.automationConfig.json', openQuestions: [],
    acceptance: ['Письмо ведёт к следующему шагу'],
  }
  f.put('demo/creative/followup/spec.yaml', spec)
  const args = { root: f.root, slug: 'demo', nodeId: 'followup' }
  assert.deepEqual(creativePacket(args).errors, [])
  writeCreativeBuild(args)
  assert.equal(creativeStatus(args).status, 'ready')
  spec.messages.push({ id: 'm2', path: '.mailings/storage/processes/demo/followup/2.message.yaml',
    goal: 'Ответить на вопрос читателя', mainIdea: 'Как пользоваться материалом', subject: 'Ответ на ваш вопрос',
    blocks: [{ type: 'answer-in-one-paragraph', text: 'Материал помогает сделать первый шаг', sourceRef: 'offer' }] })
  f.put('demo/creative/followup/spec.yaml', spec)
  assert.deepEqual(creativePacket(args).errors, [])
  const built = writeCreativeBuild(args)
  const body = readFileSync(join(f.root, built.path), 'utf8')
  assert.match(body, /answer-in-one-paragraph/)
  assert.doesNotMatch(body, /undefined/)
  spec.messages[1].blocks[0].sourceRef = 'missing-source'
  f.put('demo/creative/followup/spec.yaml', spec)
  assert.ok(creativePacket(args).errors.some(e => e.includes('источника')))
  spec.messages[1].blocks[0].sourceRef = 'offer'
  spec.messages[0].cta = null
  f.put('demo/creative/followup/spec.yaml', spec)
  assert.ok(creativePacket(args).errors.some(e => e.includes('следующий шаг')))
})

test('work task automatically includes selected references from its generated brief', t => {
  const f = fixture(t)
  f.put('demo/extra-reference.md', 'Проверяй форму на мобильном экране.\n')
  f.spec.references = ['demo/extra-reference.md']
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  writeCreativeBuild(f.args)
  const task = { inputs: [{ kind: 'build', path: 'demo/creative/lead-page/build.md', purpose: 'Задание' }], expectedOutputs: [] }
  assert.ok(expandedTaskInputs(f.root, task).some(input => input.path === 'demo/extra-reference.md'))
  const before = taskInputDigest(f.root, task)
  f.put('demo/extra-reference.md', 'Проверяй форму и CTA на мобильном экране.\n')
  assert.notEqual(taskInputDigest(f.root, task), before)
  const afterReference = taskInputDigest(f.root, task)
  f.put('.knowledge-base/processes/demo/offer.md', 'Предложение больше не включает материал.\n')
  assert.notEqual(taskInputDigest(f.root, task), afterReference)
})

test('independent review is tied to the current brief and sources', t => {
  const f = fixture(t)
  writeCreativeBuild(f.args)
  const args = { ...f.args, stage: 'spec' }
  const packet = creativeReviewPacket(args)
  const quote = 'Материал помогает сделать первый шаг'
  const report = { version: 1, process: 'demo', nodeId: 'lead-page', stage: 'spec',
    inputDigest: packet.inputDigest, inspectedFiles: packet.files.map(file => file.path), inspectedVisuals: [],
    answers: packet.questions.map(q => ({ id: q.id, status: 'pass', reason: 'Unit-only structural report.',
      evidence: [{ path: '.knowledge-base/processes/demo/offer.md', quote }] })),
  }
  assert.equal(recordCreativeReview({ ...args, packet, report, agentReference: 'unit-test-only' }).status, 'ready')
  assert.equal(JSON.parse(readFileSync(join(f.root, 'demo/reviews/creative/lead-page-spec.json'), 'utf8')).status, 'ready')
  assert.equal(creativeReviewStatus(args).status, 'ready')
  f.put('.knowledge-base/processes/demo/offer.md', 'Новое описание материала.\n')
  writeCreativeBuild(f.args)
  assert.equal(creativeReviewStatus(args).status, 'stale')
})

test('result screenshots are tied to a committed, unchanged implementation', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { title: 'Проба', nodes: [{ id: 'lead-page', kind: 'page', title: 'Получить материал',
    source: 'demo/page.ts', creativeRef: 'demo/creative/lead-page/spec.yaml' }] })
  f.put('demo/page.ts', 'import { title } from "./shared"\nexport { title }\n')
  f.put('demo/shared.ts', 'export const title = "Получить материал"\n')
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')
  f.put('demo/reviews/creative/desktop.png', png)
  f.put('demo/reviews/creative/mobile.png', png)
  writeCreativeBuild(f.args)
  const git = (...args) => spawnSync('git', args, { cwd: f.root, encoding: 'utf8' })
  assert.equal(git('init', '-q').status, 0)
  assert.equal(git('add', '.').status, 0)
  assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'implementation').status, 0)
  const version = git('rev-parse', 'HEAD').stdout.trim()
  const visual = { captures: ['desktop', 'mobile'].map(viewport => ({
    path: `demo/reviews/creative/${viewport}.png`, viewport, codeVersion: version,
  })) }
  f.put('demo/reviews/creative/lead-page-visual.json', visual)
  const args = { ...f.args, stage: 'result' }
  assert.equal(creativeReviewPacket(args).visuals.length, 2)
  f.put('demo/reviews/creative/desktop.png', 'not-an-image')
  assert.throws(() => creativeReviewPacket(args), /PNG-изображением/)
  f.put('demo/reviews/creative/desktop.png', png)
  assert.equal(git('add', '.').status, 0)
  assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'visual evidence').status, 0)
  assert.equal(creativeReviewPacket(args).visuals.length, 2)
  f.put('demo/shared.ts', 'export const title = "Другая версия"\n')
  assert.throws(() => creativeReviewPacket(args), /Результат изменился/)
  f.put('demo/shared.ts', 'export const title = "Получить материал"\n')
  f.put('demo/page.ts', 'export const title = "Обновлённый материал"\n')
  assert.throws(() => creativeReviewPacket(args), /Результат изменился/)
})

test('built-in reference cannot escape its catalog', t => {
  const f = fixture(t)
  f.spec.references = ['creative/catalog/../../../SKILL.md']
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.ok(creativePacket(f.args).errors.some(error => error.includes('Некорректный путь встроенного референса')))
})

test('result review refuses a screenshot version when Git is unavailable', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { title: 'Проба', nodes: [{ id: 'lead-page', kind: 'page', title: 'Получить материал',
    source: 'demo/page.ts', creativeRef: 'demo/creative/lead-page/spec.yaml' }] })
  f.put('demo/page.ts', 'export const title = "Материал"\n')
  writeCreativeBuild(f.args)
  f.put('demo/reviews/creative/lead-page-visual.json', { captures: ['desktop', 'mobile'].map(viewport => ({
    path: `demo/reviews/creative/${viewport}.png`, viewport, codeVersion: 'a'.repeat(40),
  })) })
  assert.throws(() => creativeReviewPacket({ ...f.args, stage: 'result' }), /Git недоступен/)
})

test('a current creative review can substantiate a work-task criterion', t => {
  const f = fixture(t)
  writeCreativeBuild(f.args)
  const reviewArgs = { ...f.args, stage: 'spec' }
  const packet = creativeReviewPacket(reviewArgs)
  const report = { version: 1, process: 'demo', nodeId: 'lead-page', stage: 'spec',
    inputDigest: packet.inputDigest, inspectedFiles: packet.files.map(file => file.path), inspectedVisuals: [],
    answers: packet.questions.map(q => ({ id: q.id, status: 'pass', reason: 'Unit-only structural report.',
      evidence: [{ path: '.knowledge-base/processes/demo/offer.md', quote: 'Материал помогает сделать первый шаг' }] })),
  }
  recordCreativeReview({ ...reviewArgs, packet, report, agentReference: 'unit-test-only' })
  f.put('demo/PLAN.md', '# Demo\n\n## Задачи\n- [ ] T1 Проверить страницу\n  - T1.A1 [build] Спецификация проверена.\n')
  f.put('demo/tasks/index.json', { version: 1 })
  f.put('demo/page.ts', 'export const title = "Материал"\n')
  const task = { version: 1, id: 'W001', planTask: 'T1', title: 'Проверить страницу', targetNode: 'lead-page',
    executor: { kind: 'main', role: 'developer' }, mode: 'verify', stage: 'build', objective: 'Подтвердить спецификацию',
    scope: { includes: ['Страница'], excludes: [] }, status: 'queued', revision: 0, dependsOn: [], session: null,
    inputs: [{ kind: 'build', path: 'demo/creative/lead-page/build.md', purpose: 'Точное задание' }],
    expectedOutputs: [{ path: 'demo/page.ts', purpose: 'Страница' }],
    steps: [{ id: 'P1', action: 'Проверить', status: 'todo' }],
    acceptanceCriteria: [{ id: 'C1', planCriteria: ['T1.A1'], condition: 'Ревью готово',
      verification: { kind: 'review', instruction: 'Проверить профильным агентом' } }],
    questions: [], drafts: [], attempts: [], result: null, acceptance: null, cancellation: null,
  }
  f.put('task.json', task)
  const cli = fileURLToPath(new URL('../tasks.mjs', import.meta.url))
  const run = (command, ...args) => spawnSync(process.execPath,
    [cli, command, 'demo', 'W001', ...args, '--root', f.root], { encoding: 'utf8' })
  assert.equal(run('create', '--file', join(f.root, 'task.json')).status, 0)
  assert.equal(run('start').status, 0)
  assert.equal(run('step', '--step', 'P1', '--status', 'done').status, 0)
  f.put('result.json', { attemptId: 'R001', summary: 'Проверено', outputs: [{ path: 'demo/page.ts' }],
    criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{
      path: 'demo/reviews/creative/lead-page-spec.json', locator: 'task', observation: 'Спецификация пригодна',
    }] }],
  })
  assert.equal(run('record', '--file', join(f.root, 'result.json')).status, 0)
  assert.equal(run('accept').status, 0)
  f.put('.knowledge-base/processes/demo/offer.md', 'Изменённое предложение.\n')
  assert.equal(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(error => error.includes('изменились входные материалы')), true)
})
