import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { compileCreative, creativePacket, creativeStatus, writeCreativeBuild } from '../lib/creative.mjs'
import { creativeReviewPacket, creativeReviewStatus, recordCreativeReview } from '../lib/creative-review.mjs'
import { expandedTaskInputs, parseTaskPlan, taskDefinitionDigest, taskInputDigest, taskReadiness } from '../lib/tasks.mjs'
import { SKILL_DIR } from '../lib/project.mjs'
import { prepareOwnerDecision, recordOwnerDecision } from '../lib/owner-decisions.mjs'

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
    mechanics: [{ id: 'signup', type: 'form', purpose: 'Получить контакт', expectedOutcome: 'Клиент получает материал после заявки', placement: 'form_section',
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

test('source must contain the named nonempty section', t => {
  const f = fixture(t)
  f.spec.sources[0].section = 'Условия'
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /раздел «Условия» не найден/)
  f.put('.knowledge-base/processes/demo/offer.md', '# Условия\n\n## Пустой подраздел\n')
  assert.match(creativePacket(f.args).errors.join('\n'), /раздел «Условия» пуст/)
  f.put('.knowledge-base/processes/demo/offer.md', '# Условия\n\nМожно получить материал после заявки.\n')
  assert.deepEqual(creativePacket(f.args).errors, [])
})

test('creative sources and copied sections reject placeholders or missing text', t => {
  const f = fixture(t)
  f.put('.knowledge-base/processes/demo/offer.md', '---\ntitle: Предложение\n---\n# Условия\n<!-- нужен текст -->\nTODO: уточнить цену\n')
  assert.match(creativePacket(f.args).errors.join('\n'), /Источник offer:.*заглушк/)
  f.put('.knowledge-base/processes/demo/offer.md', '# Условия\nЦена известна владельцу.\n')
  f.spec.sections[0].copyRef = 'demo/copy.md#Смысл'
  f.put('demo/copy.md', '# Другое\nТекст другой секции.\n')
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /Текст секции hero:.*Смысл.*не найден/)
  f.put('demo/copy.md', '# Смысл\n<!-- пока пусто -->\n')
  assert.match(creativePacket(f.args).errors.join('\n'), /Текст секции hero:.*пуст/)
  f.put('demo/copy.md', '# Смысл\nЗаявку передадут менеджеру.\n')
  assert.deepEqual(creativePacket(f.args).errors, [])
})

test('page catalog keeps the V4 scenario coverage with review guidance', () => {
  const catalog = JSON.parse(readFileSync(join(SKILL_DIR, 'creative/catalog/landing-types.json'), 'utf8'))
  const v4 = ['sales', 'lead_magnet', 'course', 'service', 'quiz', 'content', 'event', 'webinar',
    'promo', 'ecommerce', 'thankyou', 'business_card', 'portfolio', 'link_in_bio', 'coming_soon',
    'waitlist', 'comparison', 'case_study', 'vacancy', 'vsl', 'product_launch', 'challenge',
    'application', 'oto', 'pricing_page', 'redesign', 'longread_sales']
  for (const key of v4) {
    const item = catalog.types[key]
    assert.ok(item, `missing ${key}`)
    assert.ok(item.purpose && item.guidance && item.reviewQuestions?.length, `incomplete ${key}`)
  }
})

test('copywriting direction rejects an unknown style and reaches the page brief', t => {
  const f = fixture(t)
  const styles = JSON.parse(readFileSync(join(SKILL_DIR, 'creative/catalog/copywriting.json'), 'utf8')).styles
  const v4Styles = ['corporate', 'expert', 'educational', 'dan_kennedy', 'frank_kern',
    'russell_brunson', 'gary_halbert', 'info_style', 'carnegie', 'zverev',
    'minimalist', 'startup', 'storytelling', 'conversational', 'inspirational',
    'provocative', 'humorous', 'luxury', 'aida', 'science_pop', 'pas', 'faq_style', 'community']
  for (const id of v4Styles) assert.ok(styles[id]?.when && styles[id]?.guidance && styles[id]?.avoid, id)
  f.spec.copywriting = { styleId: 'unknown', adaptation: 'Коротко объяснить пользу начинающим' }
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /Неизвестная подача текста/)
  f.spec.copywriting.styleId = 'educational'
  delete f.spec.copywriting.adaptation
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /адаптацию под аудиторию и бренд/)
  f.spec.copywriting.adaptation = 'Коротко объяснить пользу начинающим'
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.deepEqual(creativePacket(f.args).errors, [])
  const brief = compileCreative(creativePacket(f.args))
  assert.match(brief, /Подача текста/)
  assert.match(brief, /Коротко объяснить пользу начинающим/)
  assert.match(brief, /неподтверждён/)
})

test('mechanic needs an expected outcome and a real section reference', t => {
  const f = fixture(t)
  delete f.spec.mechanics[0].expectedOutcome
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /ожидаемый результат/)
  f.spec.mechanics[0].expectedOutcome = 'Клиент получает материал после заявки'
  f.spec.mechanics[0].placement = 'missing-section'
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /нет секции missing-section/)
  f.spec.mechanics[0].placement = 'form_section'
  f.spec.sections[2].mechanicRefs = []
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /не привязана к секции form_section/)
  f.spec.sections[2].mechanicRefs = ['signup']
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.deepEqual(creativePacket(f.args).errors, [])
})

test('oversized first-screen image is rejected before a page brief is accepted', t => {
  const f = fixture(t)
  const asset = 'demo/assets/hero.webp'
  f.put(asset, Buffer.alloc(1_200_000, 1))
  f.spec.images = [{ id: 'hero-photo', sectionId: 'hero', purpose: 'Показать материал',
    alt: 'Материал на столе', asset, aspect: '16:9', mobileCrop: 'Предмет в центре' }]
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /первого экрана.*слишком велик/)
  f.put(asset, Buffer.alloc(300_000, 1))
  assert.deepEqual(creativePacket(f.args).errors, [])
})

test('creative CLI distinguishes invalid work from an unusable command', t => {
  const f = fixture(t)
  const cli = fileURLToPath(new URL('../creative.mjs', import.meta.url))
  const run = command => spawnSync(process.execPath,
    [cli, command, 'demo', 'lead-page', '--root', f.root], { encoding: 'utf8' })
  f.spec.mechanics[0].expectedOutcome = ''
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  const invalid = run('validate')
  assert.equal(invalid.status, 1)
  assert.match(invalid.stdout, /ожидаемый результат/)
  const invalidCompile = run('compile')
  assert.equal(invalidCompile.status, 1)
  assert.match(invalidCompile.stdout, /ожидаемый результат/)
  assert.equal(invalidCompile.stderr, '')
  const unknown = run('bad-command')
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Неизвестная команда/)
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

test('webinar and quiz use their own page brief and a working registration path', t => {
  const f = fixture(t)
  f.spec.landingType = 'webinar'
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /webinar: нужны дата\/часовой пояс, формат, программа/)
  f.spec.event = { date: '2026-11-04 18:00', timezone: 'Asia/Almaty', format: 'онлайн',
    program: 'Разбор задач и ответы', presenter: 'Эксперт студии', registrationOutcome: 'Ссылка после заявки' }
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.deepEqual(creativePacket(f.args).errors, [])
  assert.match(compileCreative(creativePacket(f.args)), /Сценарий мероприятия/)
  f.spec.landingType = 'quiz'
  delete f.spec.event
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /quiz: нужна настроенная механика quiz/)
  f.spec.mechanics.push({ id: 'profile', type: 'quiz', purpose: 'Подобрать первый шаг', expectedOutcome: 'Человек видит рекомендацию', placement: 'form_section',
    fields: ['experience'], target: 'demo/quiz-result', success: 'Показать рекомендацию',
    error: 'Попросить ответить на вопрос', mobile: 'Вопросы по одному' })
  f.spec.quiz = { resultRule: 'По ответу experience', outcomes: 'Новичку или опытному — разные советы',
    nextStep: 'Показать материал для выбранной группы' }
  f.spec.sections[2].mechanicRefs.push('profile')
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.deepEqual(creativePacket(f.args).errors, [])
})

test('redesign cannot proceed without the original and a preservation/change contract', t => {
  const f = fixture(t)
  f.spec.landingType = 'redesign'
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /redesign: нужны исходный материал/)
  f.spec.redesign = { sourceRef: 'offer', preserve: ['Условие выдачи материала'],
    changes: ['Упростить форму'], verification: ['Сравнить старую и новую форму'] }
  f.spec.sources[0].role = 'original'
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.deepEqual(creativePacket(f.args).errors, [])
  const body = compileCreative(creativePacket(f.args))
  assert.match(body, /Исходник и границы редизайна/)
  assert.match(body, /Условие выдачи материала/)
  f.spec.redesign.sourceRef = 'missing'
  f.put('demo/creative/lead-page/spec.yaml', f.spec)
  assert.match(creativePacket(f.args).errors.join('\n'), /redesign: нужны исходный материал/)
})

test('series keeps each email distinct and checks its automation dependency', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { title: 'Проба', nodes: [{ id: 'followup', kind: 'series', title: 'Серия после заявки',
    source: '.mailings/storage/processes/demo/followup/', creativeRef: 'demo/creative/followup/spec.yaml' }] })
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
  const linkedMap = { title: 'Проба', nodes: [
    { id: 'followup', kind: 'series', title: 'Серия после заявки',
      source: '.mailings/storage/processes/demo/followup/', creativeRef: 'demo/creative/followup/spec.yaml' },
    { id: 'reminder', kind: 'series', title: 'Напоминание',
      source: '.mailings/storage/processes/demo/reminder/', creativeRef: 'demo/creative/reminder/spec.yaml' },
  ], links: [{ from: 'followup', to: 'reminder', when: 'Через день' }] }
  f.put('demo/process.yaml', linkedMap)
  const beforeNeighbor = creativeReviewPacket({ ...args, stage: 'spec' })
  assert.deepEqual(beforeNeighbor.adjacentMissing, ['reminder'])
  f.put('demo/creative/reminder/spec.yaml', { version: 1, kind: 'series', targetNode: 'reminder',
    objective: 'Напомнить об условиях', audience: 'Те же лиды',
    messages: [{ id: 'm1', subject: 'Другая цена', mainIdea: 'Цена отличается от первой серии' }] })
  const adjacent = creativeReviewPacket({ ...args, stage: 'spec' })
  assert.notEqual(adjacent.inputDigest, beforeNeighbor.inputDigest)
  assert.ok(adjacent.files.some(file => file.path === 'demo/creative/reminder/spec.yaml'))
  assert.ok(adjacent.questions.some(question => question.id === 'series-consistency'))
  linkedMap.nodes.push({ id: 'unrelated', kind: 'page', title: 'Вне маршрута', source: 'demo/unrelated/' })
  f.put('demo/process.yaml', linkedMap)
  assert.equal(creativeReviewPacket({ ...args, stage: 'spec' }).inputDigest, adjacent.inputDigest)
  f.put('demo/creative/reminder/spec.yaml', { version: 1, kind: 'series', targetNode: 'reminder',
    objective: 'Напомнить об условиях', audience: 'Те же лиды',
    messages: [{ id: 'm1', subject: 'Та же цена', mainIdea: 'Цена подтверждена первой серией' }] })
  assert.notEqual(creativeReviewPacket({ ...args, stage: 'spec' }).inputDigest, adjacent.inputDigest)
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

test('manual series has a real invocation contract without a fake automation', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { title: 'Проба', nodes: [{ id: 'followup', kind: 'series', title: 'Сообщение после разговора',
    source: '.mailings/storage/processes/demo/followup/', creativeRef: 'demo/creative/followup/spec.yaml' }] })
  const spec = { version: 1, kind: 'series', targetNode: 'followup', seriesType: 'welcome',
    objective: 'Помочь начать', audience: 'Клиенты после разговора',
    sources: [{ id: 'offer', path: '.knowledge-base/processes/demo/offer.md' }],
    voice: { addressing: 'вы', character: 'спокойный', emotionality: 'сдержанно', example: 'Ваш следующий шаг.' },
    emailDesign: { layout: 'Одна колонка', components: 'Текст', colors: 'Контраст', mobile: 'По ширине экрана' },
    messages: [{ id: 'm1', path: '.mailings/storage/processes/demo/followup/01.message.yaml',
      goal: 'Подтвердить разговор', mainIdea: 'Материал помогает начать', subject: 'Первый шаг',
      blocks: [{ type: 'value', text: 'Материал помогает начать', sourceRef: 'offer' }] }],
    deliveryMode: 'manual', openQuestions: [], acceptance: ['Менеджер отправляет по запросу'],
  }
  const args = { root: f.root, slug: 'demo', nodeId: 'followup' }
  f.put('demo/creative/followup/spec.yaml', spec)
  assert.match(creativePacket(args).errors.join('\n'), /manualInvocation.caller/)
  spec.manualInvocation = { caller: 'Менеджер', trigger: 'После разговора', recipient: 'Контакт текущего клиента', stop: 'Если клиент отказался' }
  f.put('demo/creative/followup/spec.yaml', spec)
  assert.deepEqual(creativePacket(args).errors, [])
  const build = writeCreativeBuild(args)
  assert.match(readFileSync(join(f.root, build.path), 'utf8'), /Ручной запуск/)
})

test('series result checks every channel version and email render per message', t => {
  const f = fixture(t)
  const messagePath = '.mailings/storage/processes/demo/followup/01-value.message.yaml'
  f.put('demo/process.yaml', { title: 'Проба', nodes: [{ id: 'followup', kind: 'series', title: 'После заявки',
    source: '.mailings/storage/processes/demo/followup/', creativeRef: 'demo/creative/followup/spec.yaml' }] })
  f.put('demo/automation/flow.automationConfig.json', { version: 1 })
  f.put('demo/creative/followup/spec.yaml', { version: 1, kind: 'series', targetNode: 'followup',
    seriesType: 'welcome', objective: 'Помочь начать', audience: 'Оставившие заявку',
    sources: [{ id: 'offer', path: '.knowledge-base/processes/demo/offer.md' }],
    voice: { addressing: 'вы', character: 'помогающий', emotionality: 'спокойно', example: 'Покажем первый шаг.' },
    emailDesign: { layout: 'Одна колонка', components: 'Текст', colors: 'Контраст', mobile: 'По ширине экрана' },
    messages: [{ id: 'value', path: messagePath, goal: 'Дать первый шаг', mainIdea: 'Материал помогает начать',
      subject: 'Первый шаг', blocks: [{ type: 'value', text: 'Материал помогает сделать первый шаг', sourceRef: 'offer' }] }],
    automationRef: 'demo/automation/flow.automationConfig.json', openQuestions: [], acceptance: ['Польза в каждом канале'] })
  const args = { root: f.root, slug: 'demo', nodeId: 'followup' }
  writeCreativeBuild(args)
  const letter = { title: 'Первый шаг', description: 'Помочь начать', subject: 'Первый шаг',
    plain: 'Польза: откройте материал и сделайте первый шаг.',
    html: '<p>Польза: откройте материал и сделайте первый шаг.</p>',
    short: 'Польза: первый шаг в материале.' }
  f.put(messagePath, { ...letter, short: '' })
  assert.throws(() => creativeReviewPacket({ ...args, stage: 'result' }), /нет содержательной версии short/)
  f.put(messagePath, letter)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64')
  f.put('demo/reviews/creative/value-desktop.png', png)
  f.put('demo/reviews/creative/value-mobile.png', png)
  const git = (...params) => spawnSync('git', params, { cwd: f.root, encoding: 'utf8' })
  assert.equal(git('init', '-q').status, 0)
  assert.equal(git('add', '.').status, 0)
  assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'message').status, 0)
  const version = git('rev-parse', 'HEAD').stdout.trim()
  const visualPath = 'demo/reviews/creative/followup-visual.json'
  f.put(visualPath, { captures: [{ path: 'demo/reviews/creative/value-mobile.png', viewport: 'email-mobile',
    messageId: 'value', codeVersion: version }] })
  assert.throws(() => creativeReviewPacket({ ...args, stage: 'result' }), /email-desktop/)
  f.put(visualPath, { captures: ['desktop', 'mobile'].map(view => ({
    path: `demo/reviews/creative/value-${view}.png`, viewport: `email-${view}`,
    messageId: 'value', codeVersion: version })) })
  const packet = creativeReviewPacket({ ...args, stage: 'result' })
  assert.equal(packet.messageFiles[0].path, messagePath)
  for (const suffix of ['email', 'messenger', 'short', 'render'])
    assert.ok(packet.questions.some(question => question.id === `message.value.${suffix}`))
  const report = { version: 1, process: 'demo', nodeId: 'followup', stage: 'result',
    inputDigest: packet.inputDigest, inspectedFiles: packet.files.map(file => file.path),
    inspectedVisuals: packet.visuals.map(visual => visual.path),
    answers: packet.questions.map((question, index) => ({ id: question.id, status: 'pass', reason: 'Проверен конкретный файл.',
      evidence: [{ path: messagePath, quote: 'Польза'.slice(0, 4 + index % 3) }] })) }
  const unrelated = { ...report, answers: report.answers.map(answer => answer.id === 'message.value.email' ?
    { ...answer, evidence: [{ path: 'demo/creative/followup/spec.yaml', quote: 'Польза' }] } : answer) }
  assert.throws(() => recordCreativeReview({ ...args, stage: 'result', packet, report: unrelated,
    agentReference: 'unit-test-only' }), /нужен пример именно из проверяемого письма/)
  assert.equal(recordCreativeReview({ ...args, stage: 'result', packet, report, agentReference: 'unit-test-only' }).status, 'ready')
  f.put(messagePath, { ...letter, short: 'Другая версия.' })
  assert.equal(creativeReviewStatus({ ...args, stage: 'result' }).status, 'invalid')
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
    answers: packet.questions.map((q, index) => ({ id: q.id, status: 'pass', reason: 'Unit-only structural report.',
      evidence: [{ path: '.knowledge-base/processes/demo/offer.md', quote: quote.slice(0, 8 + index % 3) }] })),
  }
  const repeated = structuredClone(report)
  for (const answer of repeated.answers) answer.evidence = [{ path: '.knowledge-base/processes/demo/offer.md', quote }]
  assert.throws(() => recordCreativeReview({ ...args, packet, report: repeated, agentReference: 'unit-test-only' }), /Одна и та же цитата/)
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

test('owner-confirmed live preview is accepted only for the reviewed code and both viewports', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { title: 'Проба', nodes: [{ id: 'lead-page', kind: 'page', title: 'Получить материал',
    source: 'demo/page.ts', creativeRef: 'demo/creative/lead-page/spec.yaml' }] })
  f.put('demo/page.ts', 'export const title = "Материал"\n')
  writeCreativeBuild(f.args)
  const git = (...args) => spawnSync('git', args, { cwd: f.root, encoding: 'utf8' })
  assert.equal(git('init', '-q').status, 0)
  assert.equal(git('add', '.').status, 0)
  assert.equal(git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'implementation').status, 0)
  const codeVersion = git('rev-parse', 'HEAD').stdout.trim()
  const path = 'demo/reviews/creative/lead-page-visual.json'
  const visual = { mode: 'owner-preview', ownerReview: { owner: 'Owner',
    message: 'Посмотрел страницу на телефоне и компьютере, вид подходит.',
    messageReference: 'conversation:test-123', reviewedAt: new Date().toISOString() },
  captures: ['desktop', 'mobile'].map(viewport => ({ url: 'https://demo.example/page', viewport, codeVersion })) }
  f.put(path, visual)
  const packet = creativeReviewPacket({ ...f.args, stage: 'result' })
  assert.equal(packet.visualMode, 'owner-preview')
  assert.equal(packet.visuals.length, 2)
  assert.match(packet.questions.find(q => q.id === 'visual').question, /владелец/)
  visual.ownerReview.messageReference = ''
  f.put(path, visual)
  assert.throws(() => creativeReviewPacket({ ...f.args, stage: 'result' }), /ссылка на него/)
  visual.ownerReview.messageReference = 'conversation:test-123'
  visual.captures.pop()
  f.put(path, visual)
  assert.throws(() => creativeReviewPacket({ ...f.args, stage: 'result' }), /mobile/)
  visual.captures.push({ url: 'https://demo.example/page', viewport: 'mobile', codeVersion })
  f.put(path, visual)
  f.put('demo/page.ts', 'export const title = "Изменено"\n')
  assert.throws(() => creativeReviewPacket({ ...f.args, stage: 'result' }), /Результат изменился/)
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
    answers: packet.questions.map((q, index) => ({ id: q.id, status: 'pass', reason: 'Unit-only structural report.',
      evidence: [{ path: '.knowledge-base/processes/demo/offer.md', quote: 'Материал помогает сделать первый шаг'.slice(0, 8 + index % 3) }] })),
  }
  f.put('demo/PLAN.md', '# Demo\n\n## Задачи\n- [ ] T1 Проверить страницу\n  - T1.A1 [build] Спецификация проверена.\n')
  f.put('demo/tasks/index.json', { version: 1 })
  f.put('demo/page.ts', 'export const title = "Материал"\n')
  const task = { version: 1, id: 'W001', planTask: 'T1', title: 'Проверить страницу', targetNode: 'lead-page',
    executor: { kind: 'main', role: 'reviewer' }, mode: 'review', stage: 'build', objective: 'Проверить страницу по спецификации',
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
  recordCreativeReview({ ...reviewArgs, packet, report, agentReference: 'unit-test-only' })
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

test('creative implementation starts after accepted expert and spec tasks with current review', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { nodes: [{ id: 'lead-page', kind: 'page', title: 'Получить материал',
    source: 'demo/page.ts', creativeRef: 'demo/creative/lead-page/spec.yaml' }] })
  writeCreativeBuild(f.args)
  f.put('demo/creative/lead-page/proposals/landing.md', 'Конкретная структура страницы с источниками.\n')
  f.put('demo/PLAN.md', '# Демо\n\n## Задачи\n- [ ] T1 Собрать страницу\n  - T1.A1 [build] Материал выдаётся после заявки.\n  - Рабочие задачи: [W010](tasks/W010.json), [W011](tasks/W011.json), [W001](tasks/W001.json)\n')
  f.put('demo/tasks/index.json', { version: 1 })
  const criterion = { id: 'C1', planCriteria: ['T1.A1'], condition: 'Результат конкретен',
    verification: { kind: 'artifact', instruction: 'Проверить файл' } }
  const base = (id, executor, mode, inputs, expectedOutputs, dependsOn = []) => ({
    version: 1, id, planTask: 'T1', title: `Работа ${id}`, targetNode: 'lead-page', executor, mode, stage: 'build',
    objective: 'Подготовить страницу', scope: { includes: ['Страница'], excludes: [] }, status: 'queued', revision: 0,
    dependsOn, session: null, inputs, expectedOutputs, steps: [{ id: 'P1', action: 'Выполнить', status: 'done' }],
    acceptanceCriteria: [criterion], questions: [], drafts: [], attempts: [], result: null, acceptance: null, cancellation: null,
  })
  const proposal = 'demo/creative/lead-page/proposals/landing.md'
  const specPath = 'demo/creative/lead-page/spec.yaml'
  const expert = base('W010', { kind: 'specialist', role: 'landing' }, 'produce', [], [{ path: proposal, purpose: 'Предложение' }])
  const spec = base('W011', { kind: 'main', role: 'developer' }, 'produce',
    [{ kind: 'report', path: proposal, purpose: 'Предложение' }], [{ path: specPath, purpose: 'Спецификация' }], ['W010'])
  const planTask = parseTaskPlan(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'))[0]
  const sha = path => createHash('sha256').update(readFileSync(join(f.root, path))).digest('hex')
  const accepted = task => {
    const path = task.expectedOutputs[0].path
    task.status = 'done'
    task.result = { attemptId: 'R001', summary: 'Готово', outputs: [{ path, sha256: sha(path) }],
      criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{ path, sha256: sha(path), locator: 'file', observation: 'Содержание проверено' }] }] }
    task.attempts = [{ id: 'R001', session: task.executor.kind === 'specialist' ? { agentId: 'expert-1' } : null,
      responseRef: task.executor.kind === 'specialist' ? '/external/response.json' : null, baseInputs: [] }]
    task.acceptance = { decision: 'accepted', definitionDigest: taskDefinitionDigest(task, planTask),
      inputDigest: taskInputDigest(f.root, task), resultDigest: createHash('sha256').update(JSON.stringify(task.result)).digest('hex') }
    f.put(`demo/tasks/${task.id}.json`, task)
  }
  accepted(expert)
  accepted(spec)
  const implementation = base('W001', { kind: 'main', role: 'developer' }, 'implement',
    [{ kind: 'build', path: 'demo/creative/lead-page/build.md', purpose: 'Задание' }],
    [{ path: 'demo/page.ts', purpose: 'Страница' }], ['W011'])
  implementation.steps[0].status = 'todo'
  f.put('demo/tasks/W001.json', implementation)
  const packet = creativeReviewPacket({ ...f.args, stage: 'spec' })
  const report = { version: 1, process: 'demo', nodeId: 'lead-page', stage: 'spec', inputDigest: packet.inputDigest,
    inspectedFiles: packet.files.map(file => file.path), inspectedVisuals: [],
    answers: packet.questions.map((question, index) => ({ id: question.id, status: 'pass', reason: 'Подтверждено источником.',
      evidence: [{ path: '.knowledge-base/processes/demo/offer.md', quote: 'Материал помогает сделать первый шаг'.slice(0, 8 + index % 3) }] })) }
  recordCreativeReview({ ...f.args, stage: 'spec', packet, report, agentReference: 'reviewer-1' })
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'],
    ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-qm', 'Initial']]) {
    const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const decisionPacket = prepareOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', boardRevision: null })
  recordOwnerDecision({ root: f.root, slug: 'demo', kind: 'plan', packet: decisionPacket,
    response: { decision: 'approve', message: 'Да, строим.', messageReference: 'unit-test/message-1',
      owner: 'fixture-owner', answeredAt: '2026-10-06T10:00:00Z' } })
  const cli = fileURLToPath(new URL('../tasks.mjs', import.meta.url))
  const started = spawnSync(process.execPath, [cli, 'start', 'demo', 'W001', '--root', f.root], { encoding: 'utf8' })
  assert.equal(started.status, 0, started.stderr)
})
