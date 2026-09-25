#!/usr/bin/env node
// Где мы сейчас: этап процесса по артефактам, задачи PLAN.md и карточки
// кубиков, которые есть в карте.
//
//   node .agents/skills/processes/scripts/context.mjs <process> [--no-cards] [--root DIR]
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRoot, isDir, parseArgs, rel, SKILL_DIR, walk } from './lib/project.mjs'
import { parseYaml, requireYaml } from './lib/yaml.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['no-cards', 'help'])
const slug = positional[0]
if (options.help || !slug) {
  console.log('Использование: context.mjs <process> [--no-cards] [--root DIR]')
  process.exit(options.help ? 0 : 2)
}
try {
  requireYaml()
} catch (e) {
  console.error(e.message)
  process.exit(2)
}

const root = findRoot(options.root)
const dir = join(root, slug)
const out = []
const say = s => out.push(s)

if (!existsSync(join(dir, '.workspace.json'))) {
  say(`Процесса ${slug} нет. Этап 0: создай каркас —`)
  say(`  node .agents/skills/processes/scripts/scaffold.mjs ${slug} --title "Название"`)
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
else stage = '7–8. Запущен — изменения ведутся в новой ветке'

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

// Карточки кубиков по видам узлов карты
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
