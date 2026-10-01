#!/usr/bin/env node
// Где мы сейчас: этап процесса по артефактам, задачи PLAN.md и карточки
// компонентов, которые есть в карте.
//
//   node .agents/skills/processes/scripts/context.mjs <process> [--no-cards] [--offline] [--knowledge-stage design|build|launch] [--root DIR]
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRoot, isDir, parseArgs, rel, SKILL_DIR, walk } from './lib/project.mjs'
import { parseYaml, requireYaml } from './lib/yaml.mjs'
import { codeReviewStatus } from './lib/code-review.mjs'
import { collectKnowledge } from './lib/knowledge.mjs'
import { reviewStatus, REVIEW_STAGES } from './lib/knowledge-review.mjs'
import { spawnSync } from 'node:child_process'
import { readProcessBoard } from './lib/board.mjs'
import { inspectProcessFormat } from './lib/process-format.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['no-cards', 'help', 'offline'])
const slug = positional[0]
if (options.help || !slug) {
  console.log('Использование: context.mjs <process> [--no-cards] [--offline] [--knowledge-stage design|build|launch] [--root DIR]')
  process.exit(options.help ? 0 : 2)
}
try {
  requireYaml()
  if (options['knowledge-stage'] && !REVIEW_STAGES.includes(options['knowledge-stage']))
    throw Error('--knowledge-stage: нужен design, build или launch.')
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
    const board = sharedBoard = await readProcessBoard(root, slug)
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

if (!existsSync(join(dir, '.workspace.json'))) {
  if (sharedBoard?.snapshot) {
    say(`Локального каркаса ${slug} нет, но сохранённая доска существует. Проверь рабочую копию и ветку; не создавай процесс повторно.`)
  } else {
    say(`Локального каркаса ${slug} нет. Этап 0: для нового процесса создай каркас —`)
    say(`  node .agents/skills/processes/scripts/scaffold.mjs ${slug} --title "Название"`)
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
const kbFilled = kbArticles.filter(f => !/^\s*[-*]?\s*…\s*$/m.test(readFileSync(f, 'utf8')))

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
const planApproved = !!plan && /^- План: согласован/m.test(plan)
const launchApproved = !!plan && /^- Запуск: согласован/m.test(plan)

const lettersDir = join(root, map?.letters || `.mailings/storage/processes/${slug}/`)
const letters = walk(lettersDir).filter(f => f.endsWith('.message.yaml'))
const automations = walk(dir).filter(f => f.endsWith('.automationConfig.json'))

let stage
if (kbFilled.length === 0) stage = '1. Знания — раздел процесса в базе знаний пуст'
else if (!plan || realTasks.length === 0 || !map || (map.nodes || []).length === 0)
  stage = '2. План — нет задач в PLAN.md или узлов в process.yaml'
else if (!planApproved) stage = '2. План — ждёт согласования 1 «строим так?»'
else if (realTasks.some(t => !t.done)) stage = '3. Сборка — есть открытые задачи'
else if (!launchApproved)
  stage = '5–6. Тестовый прогон и согласование 2 «запускаем?» — все задачи закрыты'
else stage = '7–8. Запуск согласован — фактическое выполнение проверь по приёмке и состоянию системы'

say(`Процесс: ${map?.title || slug} (${slug}/)`)
say(`Этап: ${stage}`)
say('')
say('Артефакты:')
say(`  база знаний  ${rel(root, kbDir)} — статей ${kbArticles.length}, заполнено ${kbFilled.length}`)
say(`  PLAN.md      ${plan ? `есть; план ${planApproved ? 'согласован' : 'не согласован'}, запуск ${launchApproved ? 'согласован' : 'не согласован'}` : 'нет'}`)
say(`  карта        ${map ? `узлов ${(map.nodes || []).length}, стрелок ${(map.links || []).length}` : mapError}`)
say(`  письма       ${rel(root, lettersDir)} — ${letters.length}`)
say(`  автоматизации ${automations.length}`)
if (realTasks.length > 0) {
  say('')
  say(`Задачи: закрыто ${realTasks.filter(t => t.done).length} из ${realTasks.length}`)
  for (const t of realTasks) say(`  [${t.done ? 'x' : ' '}] ${t.id} ${t.title}`)
}
say('')
say(`Проверка: node .agents/skills/processes/scripts/check.mjs ${slug}`)
const knowledgeStage = options['knowledge-stage'] || (launchApproved ? 'launch' : 'build')
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
  if (review.error) say(`  ${review.error}`)
  for (const gap of review.blocking || []) say(`  ✘ ${gap.id}: ${gap.reason} → ${gap.nextAction}`)
  for (const gap of review.advisory || []) say(`  ! ${gap.id}: ${gap.reason}`)
  for (const issue of review.structuralErrors || []) say(`  ✘ ${issue}`)
  if (review.status !== 'ready') say('До полного тестового прогона и сдачи нужно ревью по build/review.md.')
} catch (e) { say(`Ревью реализации недоступно: ${e.message}. Готовность к прогону не подтверждена.`) }

// Read-only by construction: never refresh a stale board while restoring context.
say('')
if (options.offline) say('Доска: актуальность и материалы не проверены (--offline). Перед завершением нужен обычный check.')
else {
  const result = spawnSync(process.execPath, [join(SKILL_DIR, 'scripts/check.mjs'), slug, '--verify-snapshot', '--json', '--knowledge-stage', knowledgeStage, '--root', root],
    { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
  try {
    if (result.error) throw result.error
    const report = JSON.parse(result.stdout)
    const snapshot = report.snapshot
    if (sharedBoard && snapshot.verified && (snapshot.boardRevision !== sharedBoard.boardRevision || snapshot.revision !== sharedBoard.snapshotRevision))
      say('Доска изменилась во время чтения контекста. Перечитай board read перед использованием материалов.')
    say(`Проверки: ${report.passed}/${report.total}. Доска: ${snapshot.verified ? `актуальна (${snapshot.branch} @ ${snapshot.commit}, снимок ${snapshot.revision}, доска ${snapshot.boardRevision})` : snapshot.error || 'актуальность не подтверждена'}`)
  } catch (e) {
    say(`Доска: чтение не удалось (${e.message}). Актуальность снимка не подтверждена.`)
  }
}

// Карточки компонентов по видам узлов карты
const kinds = new Set((map?.nodes || []).map(n => n.kind))
const cards = ['channels.md']
if (kinds.has('page')) cards.push('page.md')
if (kinds.has('table')) cards.push('form-table-event.md')
if (kinds.has('series')) cards.push('message-series.md')
if ((map?.links || []).some(l => l.via) || automations.length > 0) cards.push('automation.md')
if (kinds.has('payment')) cards.push('payment.md')
if (kinds.has('crm')) cards.push('crm.md')

if (!options['no-cards']) {
  for (const card of cards) {
    const p = join(SKILL_DIR, 'blocks', card)
    if (!existsSync(p)) continue
    say('')
    say(`===== blocks/${card} =====`)
    say(readFileSync(p, 'utf8').trimEnd())
  }
} else {
  say(`Карточки: ${cards.map(c => `blocks/${c}`).join(', ')}`)
}

if (!isDir(lettersDir) && kinds.has('series')) {
  say('')
  say(`Папки писем ещё нет: ${rel(root, lettersDir)}`)
}

console.log(out.join('\n'))
