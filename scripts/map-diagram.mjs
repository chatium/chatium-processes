#!/usr/bin/env node
// Каркас процесса в формате доски Start (*.diagram.yaml, version 1): этапы —
// колонки-рамки, узлы — карточки с цветом статуса, стрелки — с подписями.
// Раскладку считает скрипт, а не агент. Проба варианта B экрана процесса.
//
//   node .agents/skills/processes/scripts/map-diagram.mjs <process> [--out FILE] [--example-note] [--root DIR]
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRoot, isDir, parseArgs, walk } from './lib/project.mjs'
import { parseYaml, requireYaml, stringifyYaml } from './lib/yaml.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['example-note', 'help'])
const slug = positional[0]
if (options.help || !slug) {
  console.log('Использование: map-diagram.mjs <process> [--out FILE] [--example-note] [--root DIR]')
  process.exit(options.help ? 0 : 2)
}
try {
  requireYaml()
} catch (e) {
  console.error(e.message)
  process.exit(2)
}

const root = findRoot(options.root)
const mapFile = join(root, slug, 'process.yaml')
if (!existsSync(mapFile)) {
  console.error(`Нет ${slug}/process.yaml`)
  process.exit(2)
}
const map = parseYaml(readFileSync(mapFile, 'utf8')) || {}
const stages = Array.isArray(map.stages) ? map.stages : []
const nodes = Array.isArray(map.nodes) ? map.nodes : []
const links = Array.isArray(map.links) ? map.links : []

// ---------- статусы узлов ----------

const KIND_ICON = { page: '📄', table: '🗂️', series: '✉️', payment: '💳', crm: '👤', external: '🔗' }
const STATUS = {
  built: { fill: 'green', label: 'построено' },
  planned: { fill: 'white', label: 'не построено' },
}
const norm = p => String(p || '').replace(/^\.\//, '').replace(/\/+$/, '')

function nodeStatus(n) {
  const abs = join(root, norm(n.source))
  if (!n.source || !existsSync(abs)) return 'planned'
  if (n.kind === 'series' && walk(abs).filter(f => f.endsWith('.message.yaml')).length === 0) return 'planned'
  return 'built'
}

function nodeDetails(n) {
  if (n.kind === 'series' && isDir(join(root, norm(n.source)))) {
    const letters = walk(join(root, norm(n.source))).filter(f => f.endsWith('.message.yaml')).sort()
    const subjects = letters.map(f => {
      try {
        return parseYaml(readFileSync(f, 'utf8'))?.title
      } catch {
        return null
      }
    }).filter(Boolean)
    if (subjects.length) return `Письма: ${subjects.join('; ')}`
  }
  if (n.kind === 'table') return 'Счётчик записей появится после запуска'
  return ''
}

// ---------- «нужно от вас» из PLAN.md ----------

function ownerTodos() {
  const plan = join(root, slug, 'PLAN.md')
  if (!existsSync(plan)) return []
  const text = readFileSync(plan, 'utf8')
  const section = /## Нужно от вас\n([\s\S]*?)(?:\n## |$)/.exec(text)?.[1] || ''
  return [...section.matchAll(/^- \[( |x|X)\] (.+)$/gm)].map(m => ({ done: m[1] !== ' ', text: m[2].trim() }))
}

// ---------- раскладка ----------

const COL_W = 340
const COL_GAP = 60
const LEFT = 40
const TOP = 150
const CARD_W = COL_W - 60
const CARD_H = 130
const CARD_GAP = 28
const FRAME_HEAD = 70

const blocks = []
const connections = []

blocks.push({
  id: 'proc-title',
  type: 'text',
  text: `${map.title || slug}`,
  ui: { x: LEFT, y: 40 },
  size: { w: 900, h: 60 },
  style: { fontSize: 28, textAlign: 'left', verticalAlign: 'middle' },
})

const nodesByStage = stages.map(stage => nodes.filter(n => n?.stage === stage))
const maxInStage = Math.max(1, ...nodesByStage.map(list => list.length))
const frameH = FRAME_HEAD + maxInStage * (CARD_H + CARD_GAP) + 10
const blockIdOf = new Map()

stages.forEach((stage, i) => {
  const x = LEFT + i * (COL_W + COL_GAP)
  blocks.push({
    id: `proc-stage-${i + 1}`,
    type: 'frame',
    title: stage,
    ui: { x, y: TOP },
    size: { w: COL_W, h: frameH },
    style: { fill: 'gray' },
  })
  nodesByStage[i].forEach((n, j) => {
    const status = nodeStatus(n)
    const id = `proc-node-${n.id}`
    blockIdOf.set(n.id, id)
    const details = nodeDetails(n)
    blocks.push({
      id,
      type: 'card',
      title: `${KIND_ICON[n.kind] || '•'} ${n.title}`,
      text: [n.purpose, details, `Статус: ${STATUS[status].label}`].filter(Boolean).join('\n'),
      ui: { x: x + 30, y: TOP + FRAME_HEAD + j * (CARD_H + CARD_GAP) },
      size: { w: CARD_W, h: CARD_H },
      style: { fill: STATUS[status].fill, textAlign: 'left', verticalAlign: 'top' },
    })
  })
})

links.forEach((l, i) => {
  const from = blockIdOf.get(l.from)
  const to = blockIdOf.get(l.to)
  if (!from || !to) return
  connections.push({
    id: `proc-link-${i + 1}`,
    from: { block: from, anchor: 'auto' },
    to: { block: to, anchor: 'auto' },
    label: l.via ? `${l.when} · автоматизация` : l.when,
    arrow: 'end',
    route: 'smooth',
    line: 'solid',
    width: 3,
  })
})

const boardRight = LEFT + Math.max(1, stages.length) * (COL_W + COL_GAP)
const todos = ownerTodos()
if (todos.length) {
  blocks.push({
    id: 'proc-owner-todos',
    type: 'sticky',
    title: 'Нужно от вас',
    text: todos.map(t => `- [${t.done ? 'x' : ' '}] ${t.text}`).join('\n'),
    ui: { x: boardRight, y: TOP },
    size: { w: 300, h: 60 + todos.length * 34 },
    style: { fill: 'orange' },
  })
}

blocks.push({
  id: 'proc-legend',
  type: 'text',
  text: 'Зелёный — построено · белый — не построено · стрелка — что за чем происходит',
  ui: { x: LEFT, y: TOP + frameH + 30 },
  size: { w: 900, h: 40 },
  style: { fontSize: 14, textAlign: 'left', verticalAlign: 'middle', textColor: '#6B7280' },
})

// Пример заметки человека — второй слой доски (вариант B). Только для пробы.
if (options['example-note']) {
  const series = nodes.find(n => n.kind === 'series')
  const target = series ? blockIdOf.get(series.id) : blocks.find(b => b.type === 'card')?.id
  if (target) {
    const targetBlock = blocks.find(b => b.id === target)
    blocks.push({
      id: 'note-example-1',
      type: 'sticky',
      title: 'Заметка · Ратмир',
      text: 'Пример заметки человека: «Сделать тему письма теплее». Агент увидит её при следующем запуске.',
      ui: { x: targetBlock.ui.x + 40, y: TOP + frameH + 90 },
      size: { w: 260, h: 150 },
      style: { fill: 'yellow' },
    })
    connections.push({
      id: 'note-example-1-link',
      from: { block: 'note-example-1', anchor: 'top' },
      to: { block: target, anchor: 'bottom' },
      arrow: 'end',
      route: 'smooth',
      line: 'dashed',
      width: 2,
    })
  }
}

// ---------- самопроверка по правилам формата ----------

const errors = []
const ids = new Set()
for (const b of blocks) {
  if (ids.has(b.id)) errors.push(`повтор id ${b.id}`)
  ids.add(b.id)
  if (!(b.size.w > 0 && b.size.h > 0)) errors.push(`${b.id}: размер должен быть положительным`)
}
const frames = new Set(blocks.filter(b => b.type === 'frame').map(b => b.id))
for (const c of connections) {
  if (ids.has(c.id)) errors.push(`повтор id ${c.id}`)
  ids.add(c.id)
  for (const end of [c.from.block, c.to.block]) {
    if (!blocks.some(b => b.id === end)) errors.push(`${c.id}: нет блока ${end}`)
    if (frames.has(end)) errors.push(`${c.id}: рамку нельзя соединять`)
  }
}
if (errors.length) {
  for (const e of errors) console.error(`✘ ${e}`)
  process.exit(1)
}

const doc = {
  diagram: {
    version: 1,
    title: `Карта процесса: ${map.title || slug}`,
    description: 'Каркас собран скриптом map-diagram.mjs из process.yaml. Не правь руками.',
    blocks,
    connections,
    drawings: [],
  },
}
const yamlText = stringifyYaml(doc)
if (options.out) {
  writeFileSync(options.out, yamlText)
  console.error(`Каркас записан: ${options.out} — блоков ${blocks.length}, стрелок ${connections.length}`)
} else {
  process.stdout.write(yamlText)
}
