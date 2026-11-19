#!/usr/bin/env node
// Где мы сейчас: этап процесса по артефактам, задачи PLAN.md и карточки
// компонентов, которые есть в карте.
//
//   node .agents/skills/chatium-processes/scripts/context.mjs <process> [--no-cards] [--offline] [--knowledge-stage design|build|launch] [--root DIR]
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRoot, isDir, parseArgs, rel, SKILL_DIR, walk } from './lib/project.mjs'
import { parseYaml, requireYaml } from './lib/yaml.mjs'
import { codeReviewStatus } from './lib/code-review.mjs'
import { collectKnowledge } from './lib/knowledge.mjs'
import { reviewStatus, REVIEW_STAGES } from './lib/knowledge-review.mjs'
import { loadTasks, parseTaskPlan, taskReadiness, TASK_STAGES } from './lib/tasks.mjs'
import { creativeStatus } from './lib/creative.mjs'
import { needsCreativeReview } from './lib/page-mode.mjs'
import { creativeReviewStatus } from './lib/creative-review.mjs'
import { spawnSync } from 'node:child_process'
import { readProcessBoard } from './lib/board.mjs'
import { inspectProcessFormat } from './lib/process-format.mjs'
import { boardDecisionDigest, ownerDecisionStatus } from './lib/owner-decisions.mjs'
import { commissionStatus } from './lib/commission.mjs'
import { git } from './lib/git-state.mjs'
import { hasOpenBuildWork, implementationStep, messageFooter, stepGuidance } from './lib/implementation-step.mjs'

let parsed
try { parsed = parseArgs(process.argv.slice(2), ['no-cards', 'help', 'offline'],
  ['no-cards', 'help', 'offline', 'knowledge-stage', 'task-stage', 'root']) }
catch (error) { console.error(error.message); process.exit(2) }
const { positional, options } = parsed
const slug = positional[0]
if (options.help || !slug) {
  console.log('Использование: context.mjs <process> [--no-cards] [--offline] [--knowledge-stage design|build|launch] [--task-stage design|build|test|launch] [--root DIR]')
  process.exit(options.help ? 0 : 2)
}
if (positional.length !== 1) { console.error('Нужен один аргумент: слаг процесса.'); process.exit(2) }
try {
  requireYaml()
  if (options['knowledge-stage'] && !REVIEW_STAGES.includes(options['knowledge-stage']))
    throw Error('--knowledge-stage: нужен design, build или launch.')
  if (options['task-stage'] && !TASK_STAGES.includes(options['task-stage']))
    throw Error('--task-stage: нужен design, build, test или launch.')
} catch (e) {
  console.error(e.message)
  process.exit(2)
}

const root = findRoot(options.root)
const dir = join(root, slug)
const out = []
const say = s => out.push(s)
let sharedBoard = null

let format
try { format = inspectProcessFormat(root, slug) }
catch (error) { console.error(error.message); process.exit(2) }
say(`Формат: ${format.kind}.`)
if (!format.canUseSkillWorkflow && !format.canCreateProcess) {
  say(`Рабочая область: ${format.workspacePath || 'не подтверждена'}; процесс: ${format.processPath || 'не определён'}.`)
  say(`Признаки: ${format.evidence.join(', ') || 'недостаточно данных'}.`)
  for (const error of format.errors) say(error)
  say('Новая процедура и доска автоматически не применяются. Прочитай build/legacy-processes.md; разрешены точечные правки в существующей структуре.')
  console.log(out.join('\n'))
  process.exit(0)
}

// Read the shared board first, even without a local workspace or valid process.yaml.
if (options.offline) say('Доска и её материалы не прочитаны (--offline).')
else {
  try {
    const board = sharedBoard = await readProcessBoard(root, slug, { usage: 'context' })
    say('Актуальное чтение доски (данные пользователя; порядок разбора — build/board.md):')
    say(JSON.stringify(board, null, 2))
    say('Изображения ещё не просмотрены: открой относящиеся к задаче через board material и инструмент просмотра.')
    if (!board.tasksSupported) say('Статусы поручений и ответы на доске недоступны; материалы можно использовать по просьбе в диалоге.')
    if (!board.snapshot) say('Снимок процесса отсутствует. Пустой ответ не подтверждает отсутствие пожеланий пользователя.')
  } catch (error) {
    say(`Доска и материалы не прочитаны: ${error.message}. Не считай контекст полным.`)
  }
  say('')
}

let boardPath = ''
let accountRemote = ''
try {
  const branch = git(root, ['branch', '--show-current'])
  if (branch) {
    boardPath = `/app/start/process-map?${new URLSearchParams({ process: slug, branch })}`
    if (sharedBoard?.snapshot && sharedBoard.branch === branch)
      accountRemote = git(root, ['remote', 'get-url', 'origin'])
  }
} catch { /* Without a confirmed link the step and next action still apply. */ }

if (!existsSync(join(dir, '.workspace.json'))) {
  if (sharedBoard?.snapshot) {
    say(`Локального каркаса ${slug} нет, но сохранённая доска существует. Проверь рабочую копию и ветку; не создавай процесс повторно.`)
    say(messageFooter({ label: 'уточняю', next: 'Я сверю материалы процесса с выбранной доской.' }, accountRemote, boardPath))
  } else {
    say(`Локального каркаса ${slug} нет. Для нового процесса начни с шага 1 из 7 — Вводные о бизнесе. Создай каркас —`)
    say(`  node .agents/skills/chatium-processes/scripts/scaffold.mjs ${slug} --title "Название"`)
    say(stepGuidance(implementationStep({ hasKnowledge: false })))
    say('Отсутствие местных файлов само по себе не подтверждает отсутствие процесса в аккаунте.')
  }
  console.log(out.join('\n'))
  process.exit(0)
}

let map = null
let mapError = null
try {
  map = parseYaml(readFileSync(join(dir, 'process.yaml'), 'utf8'))
} catch (e) {
  mapError = existsSync(join(dir, 'process.yaml')) ? `не разбирается: ${e.message}` : 'нет файла'
}

const kbDir = join(root, map?.knowledge || `.knowledge-base/processes/${slug}/`)
const kbArticles = walk(kbDir).filter(f => f.endsWith('.md'))
const kbFilled = kbArticles.filter(f => {
  const body = readFileSync(f, 'utf8').replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').trim()
  return body && !/(?:^|\n)\s*(?:[-*]\s*)?(?:TODO|TBD|FIXME)\s*:/im.test(body) &&
    !/^\s*[-*]?\s*…\s*$/m.test(body)
})

const planFile = join(dir, 'PLAN.md')
const plan = existsSync(planFile) ? readFileSync(planFile, 'utf8') : null
const tasks = plan
  ? [...plan.matchAll(/^- \[( |x|X)\] (T\d+)\s+(.*)$/gm)].map(m => ({
      done: m[1] !== ' ',
      id: m[2],
      title: m[3].trim(),
    }))
  : []
const realTasks = tasks.filter(t => t.title !== '…')
const decision = kind => {
  try { return ownerDecisionStatus({ root, slug, kind,
    ...(sharedBoard?.boardRevision === undefined ? {} : { currentBoardRevision: sharedBoard.boardRevision,
      currentBoardDigest: boardDecisionDigest(sharedBoard) }) }) }
  catch (error) { return { status: 'invalid', error: error.message } }
}
const planDecision = decision('plan')
const launchDecision = decision('launch')
const designReview = (() => {
  try { return commissionStatus({ root, slug, stage: 'design' }) }
  catch (error) { return { status: 'needs-work', error: error.message } }
})()
const planApproved = planDecision.status === 'ready'
const launchApproved = launchDecision.status === 'ready' && launchDecision.authority === 'owner'
const buildReview = (() => {
  if (!planApproved || designReview.status !== 'ready') return null
  try { return commissionStatus({ root, slug, stage: 'build' }) }
  catch (error) { return { status: 'needs-work', error: error.message } }
})()
const designing = !planApproved || designReview.status !== 'ready'
let openBuildWork = realTasks.some(task => !task.done)
if (openBuildWork && !designing) try {
  const planned = parseTaskPlan(plan)
  if (planned.length === realTasks.length) openBuildWork = hasOpenBuildWork(planned, loadTasks(root, slug).tasks)
} catch { /* Keep the open work visible. taskReadiness reports malformed cards below. */ }
const taskStage = designing ? 'design' : options['task-stage'] || (
  openBuildWork || buildReview?.status !== 'ready' ? 'build' :
    launchApproved ? 'launch' : 'test')
const knowledgeStage = designing ? 'design' : options['knowledge-stage'] ||
  (taskStage === 'design' ? 'design' : taskStage === 'launch' ? 'launch' : 'build')

const lettersDir = join(root, map?.letters || `.mailings/storage/processes/${slug}/`)
const letters = walk(lettersDir).filter(f => f.endsWith('.message.yaml'))
const automations = walk(dir).filter(f => f.endsWith('.automationConfig.json'))

say('Артефакты:')
say(`  база знаний  ${rel(root, kbDir)} — статей ${kbArticles.length}, заполнено ${kbFilled.length}`)
say(`  PLAN.md      ${plan ? 'есть' : 'нет'}`)
say(`  решение «строим так?» ${planDecision.status}${planDecision.authority === 'delegated-test' ? ' (исполнитель теста)' : ''}${planDecision.error ? ` — ${planDecision.error}` : ''}`)
say(`  проверка архитектуры ${designReview.status}${designReview.error ? ` — ${designReview.error}` : ''}`)
const missingDesign = designReview.requirements?.filter(item => item.status !== 'ready')
if (missingDesign?.length) say(`  нужны заключения: ${missingDesign.map(item => `${item.id} (${item.status})`).join(', ')}`)
say(`  решение «запускаем?» ${launchDecision.status}${launchDecision.authority === 'delegated-test' ? ' (исполнитель теста)' : ''}${launchDecision.error ? ` — ${launchDecision.error}` : ''}`)
say(`  карта        ${map ? `узлов ${(map.nodes || []).length}, стрелок ${(map.links || []).length}` : mapError}`)
say(`  письма       ${rel(root, lettersDir)} — ${letters.length}`)
say(`  автоматизации ${automations.length}`)
if (realTasks.length > 0) {
  say('')
  say(`Задачи: закрыто ${realTasks.filter(t => t.done).length} из ${realTasks.length}`)
  for (const t of realTasks) say(`  [${t.done ? 'x' : ' '}] ${t.id} ${t.title}`)
}
try {
  const work = taskReadiness({ root, slug, stage: taskStage })
  if (work.enabled) {
    say(`Рабочие карточки: завершено ${work.tasks.filter(t => t.status === 'done').length} из ${work.tasks.length}.`)
    for (const task of work.tasks) say(`  ${task.id} [${task.status}] ${task.title}`)
    for (const issue of work.errors) say(`  ✘ ${issue}`)
    for (const issue of work.warnings) say(`  ! ${issue}`)
    say(`Детали: node .agents/skills/chatium-processes/scripts/tasks.mjs context ${slug} W001`)
    if (!designing) for (const node of (map?.nodes || []).filter(needsCreativeReview)) {
      const creative = creativeStatus({ root, slug, nodeId: node.id })
      say(`Задание ${node.id}: ${creative.status}${creative.errors.length ? ` — ${creative.errors.join('; ')}` : ''}`)
      const review = creativeReviewStatus({ root, slug, nodeId: node.id, stage: 'spec' })
      say(`Ревью задания ${node.id}: ${review.status}${review.error ? ` — ${review.error}` : ''}`)
    }
  }
} catch (error) { say(`Рабочие карточки не прочитаны: ${error.message}`) }
say('')
say(`Проверка: node .agents/skills/chatium-processes/scripts/check.mjs ${slug} --task-stage ${taskStage} --knowledge-stage ${knowledgeStage}`)
say('')
try {
  const knowledge = collectKnowledge({ root, slug })
  say(`Структура знаний: ${knowledge.passed}/${knowledge.total}.`)
  for (const c of knowledge.checks) {
    for (const error of c.errors) say(`  ✘ ${error}`)
    for (const warning of c.warnings) say(`  ! ${warning}`)
  }
  const review = reviewStatus({ root, slug, stage: knowledgeStage })
  say(`Независимое ревью (${knowledgeStage}): ${review.status}.`)
  if (review.error) say(`  ${review.error}`)
  for (const gap of review.blocking || []) say(`  ✘ ${gap.id}: ${gap.reason} → ${gap.nextAction}`)
  for (const gap of review.advisory || []) say(`  ! ${gap.id}: ${gap.reason}`)
  if (review.status !== 'ready') say('Готовность не подтверждена: следуй method/review.md; закрытые задачи не заменяют ревью.')
} catch (e) { say(`Знания: проверка недоступна (${e.message}). Готовность не подтверждена.`) }


try {
  const review = codeReviewStatus({ root, slug })
  say(`Независимое ревью реализации: ${review.status}.`)
  if (!designing) {
    if (review.error) say(`  ${review.error}`)
    for (const gap of review.blocking || []) say(`  ✘ ${gap.id}: ${gap.reason} → ${gap.nextAction}`)
    for (const gap of review.advisory || []) say(`  ! ${gap.id}: ${gap.reason}`)
    for (const issue of review.structuralErrors || []) say(`  ✘ ${issue}`)
    if (review.status !== 'ready') say('До полного тестового прогона и сдачи нужно ревью по build/review.md.')
  }
} catch (e) { say(`Ревью реализации недоступно: ${e.message}. Готовность к прогону не подтверждена.`) }

// Read-only by construction. Reuse check's verdict, never a second validation policy.
say('')
let report = null
let checkError = null
let boardChanged = false
const result = spawnSync(process.execPath, [join(SKILL_DIR, 'scripts/check.mjs'), slug,
  options.offline ? '--no-snapshot' : '--verify-snapshot', '--json', '--task-stage', taskStage,
  '--knowledge-stage', knowledgeStage, '--root', root],
{ cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
try {
  if (result.error) throw result.error
  if (result.signal) throw Error(`check прерван (${result.signal})`)
  report = JSON.parse(result.stdout)
  if (!Array.isArray(report.checks) || typeof report.passed !== 'number' || typeof report.total !== 'number')
    throw Error('check вернул неполный результат')
  if (![0, 1].includes(result.status)) checkError = `check завершился с кодом ${result.status}; полная проверка не завершена`
  if (!options.offline) {
    const snapshot = report.snapshot || {}
    if (sharedBoard && snapshot.verified && (snapshot.boardRevision !== sharedBoard.boardRevision || snapshot.revision !== sharedBoard.snapshotRevision)) {
      boardChanged = true
      say('Доска изменилась во время чтения контекста. Перечитай board read перед использованием материалов.')
    }
    say(`Проверки: ${report.passed}/${report.total}. Доска: ${snapshot.verified ? `актуальна (${snapshot.branch} @ ${snapshot.commit}, снимок ${snapshot.revision}, доска ${snapshot.boardRevision})` : snapshot.error || 'актуальность не подтверждена'}`)
  }
} catch (error) {
  report = null
  checkError = error.message
}
if (options.offline) say('Доска: актуальность и материалы не проверены (--offline). Перед завершением нужен обычный check.')

// Keep the actionable summary ahead of potentially large board materials.
const allowedWork = taskStage === 'design'
  ? 'Знания, план, карта и проверка проекта. Реализацию до принятого проекта и согласования не начинать.'
  : taskStage === 'build'
    ? 'Сборка и исправления по согласованному плану, независимые проверки. Боевой запуск не разрешён.'
    : taskStage === 'test'
      ? 'Подготовка теста; полный прогон только после ревью реализации и при выполненных условиях теста. Боевой запуск не разрешён.'
      : 'Запуск только в согласованном объёме после полной проверки; затем наблюдение.'
const currentNodes = report?.snapshot?.verified && !boardChanged ? sharedBoard?.snapshot?.nodes : null
const progress = implementationStep({
  prematureContent: report?.checks.some(check => check.id === 'design.content' && !check.ok),
  hasKnowledge: kbFilled.length > 0, hasPlan: Boolean(plan && realTasks.length && map?.nodes?.length),
  designReady: designReview.status === 'ready', planDecision, openTasks: openBuildWork,
  buildReady: buildReview?.status === 'ready', processAcceptance: report?.snapshot?.construction?.processAcceptance,
  currentNodes, constructionStatus: report?.snapshot?.construction?.status,
  testingStatus: report?.testing?.status, checkPassed: result.status === 0 && !checkError, taskStage, launchDecision,
})
const summary = [`Процесс: ${map?.title || slug} (${slug}/)`, '', messageFooter(progress, accountRemote, boardPath), '', stepGuidance(progress), '',
  `Работа на этапе ${taskStage}: ${allowedWork}`]
if (currentNodes?.length) {
  const acceptedCount = currentNodes.filter(node => node.status === 'built').length
  const drafts = currentNodes.every(node => ['present', 'missing'].includes(node.build?.source))
    ? `${currentNodes.filter(node => node.build.source === 'present').length} из ${currentNodes.length}` : 'неизвестно'
  summary.push(`По актуальной доске: собрано в черновике — ${drafts}; прошли приёмку — ${acceptedCount} из ${currentNodes.length}.`)
  const state = report.snapshot.construction?.status === 'current' ? report.snapshot.construction.processReview : undefined
  const reviewLabels = { passed: 'пройдено', failed: 'есть замечания', pending: 'ожидается', stale: 'требует повторной проверки', unavailable: 'результат недоступен' }
  summary.push(`Общее ревью процесса: ${reviewLabels[state] || 'пока не подтверждено'}.`)
  if ((acceptedCount < currentNodes.length || report.snapshot.construction?.processAcceptance !== 'passed') && progress.number >= 4)
    summary.push('Для сдачи нужны приёмка всех блоков и общая проверка процесса. Продолжай доступную работу сейчас: исправь замечание, возобнови прерванное ревью и сверь результат с доской.')
  if (report.snapshot.construction?.status !== 'current')
    summary.push('Приёмка на доске требует сверки. Эти цифры показывают состояние доски; готовность к запуску не подтверждена.')
} else summary.push('Сборка и приёмка блоков по актуальной доске не подтверждены.')

if (options['task-stage']) summary.push('Этап проверки задан вручную; это не разрешает пропускать предыдущие этапы.')
if (report) {
  const failures = report.checks.filter(check => !check.ok)
  summary.push(`Проверка этапа ${taskStage}: ${report.passed}/${report.total}.`)
  if (failures.length) {
    summary.push('Переход дальше заблокирован. Непройденные пункты:')
    for (const check of failures) summary.push(`  ✘ ${check.id}: ${check.title}${check.errors?.length ? ` — ${check.errors.join('; ')}` : ''}`)
  } else summary.push('Локальные проверки пройдены; проверь также согласования, материалы доски и опубликованную версию.')
  const construction = report.snapshot?.construction
  summary.push(`Сверка статусов сборки с доской: ${construction?.status || 'не подтверждена'}.`)
  for (const node of construction?.nodes || [])
    summary.push(`  ${node.id}: доска ${node.actual}; текущая приёмка ${node.expected}. ${node.reason}`)
  if (construction?.errors.length) summary.push('Исправление рассинхрона обязательно до сдачи: проверь задачи и их приёмку, синхронизируй прогресс и опубликуй актуальный check. Не устанавливай «собрано» вручную.',
    ...construction.next.map(command => `  ${command}`))
  const testing = report.testing
  summary.push(`Тестирование на доске: ${testing?.status || 'не подтверждено'}${Number.isInteger(testing?.totalRuns) ? `; попыток ${testing.totalRuns}` : ''}.`)
  for (const scenario of testing?.cases || []) summary.push(`  ${scenario.id}: ${scenario.status}${scenario.required ? ' (обязательный)' : ''}${scenario.reason ? ` — ${scenario.reason}` : ''}`)
  for (const issue of testing?.errors || []) summary.push(`  ✘ ${issue}`)
  if (progress.number >= 6 && testing?.cases?.some(scenario => scenario.required && scenario.status !== 'passed'))
    summary.push('Тестирование не завершено: сохраняй попытки через test.mjs run/record и сверяй status/show на этой ветке; локальный прогон историю доски не заменяет.')
}
if (checkError) summary.push(`Готовность не подтверждена: ${checkError}. Повтори проверку после устранения причины.`)
if (options.offline || !report?.snapshot?.verified || !sharedBoard || boardChanged)
  summary.push('Доска или её актуальность не подтверждена. Это не полный результат для сдачи этапа.')
const pendingBuildReview = buildReview?.status === 'needs-work' || (progress.number === 5 && buildReview?.status !== 'ready')
const pendingReviewStage = progress.number === 3 && designReview.status !== 'ready' ? 'design' : pendingBuildReview ? 'build' : null
const nextCommand = pendingReviewStage
  ? `node .agents/skills/chatium-processes/scripts/reviews.mjs status ${slug} --stage ${pendingReviewStage}`
  : `node .agents/skills/chatium-processes/scripts/check.mjs ${slug} --task-stage ${taskStage} --knowledge-stage ${knowledgeStage}${options.offline ? ' --no-snapshot' : ''}`
summary.push(`Следующая команда: ${nextCommand}`,
  'Повторять check без изменения причины незачем: сначала выполни следующий шаг, затем проверяй пакет изменений.',
  `Результат этапа для владельца: ${progress.deliverable}`)
summary.push(boardPath ? `Карта (путь в аккаунте, доступность проверяется отдельно): ${boardPath}` :
  'Ссылка на карту не определена: уточни рабочую ветку; маршрут — build/preview.md.')
summary.push('В подписи после ссылки на доску укажи текущий шаг и ближайшее действие с исполнителем. Уточни действие по реальным задачам и вопросам владельцу.', '')
out.splice(1, 0, ...summary)

// Карточки компонентов по видам узлов карты
const kinds = new Set((map?.nodes || []).map(n => n.kind))
const cards = ['channels.md']
if (kinds.has('page')) cards.push('page.md')
if (kinds.has('table')) cards.push('form-table-event.md')
if (kinds.has('series')) cards.push('message-series.md')
if ((map?.links || []).some(l => l.via) || automations.length > 0) cards.push('automation.md')
if (kinds.has('payment')) cards.push('payment.md')
if (kinds.has('crm')) cards.push('crm.md')
if (kinds.has('agent')) cards.push('ai-agent.md')

if (!options['no-cards'] && progress.number >= 4) {
  for (const card of cards) {
    const p = join(SKILL_DIR, 'blocks', card)
    if (!existsSync(p)) continue
    say('')
    say(`===== blocks/${card} =====`)
    say(readFileSync(p, 'utf8').trimEnd())
  }
} else if (progress.number >= 4) {
  say(`Карточки: ${cards.map(c => `blocks/${c}`).join(', ')}`)
}

if (progress.number >= 4 && !isDir(lettersDir) && kinds.has('series')) {
  say('')
  say(`Папки писем ещё нет: ${rel(root, lettersDir)}`)
}

console.log(out.join('\n'))
