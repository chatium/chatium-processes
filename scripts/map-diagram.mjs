#!/usr/bin/env node
// Каркас процесса в формате доски Start (*.diagram.yaml, version 1): этапы —
// колонки-рамки, узлы — карточки с цветом статуса, стрелки — с подписями.
// Раскладку считает скрипт, а не агент. Проба варианта B экрана процесса.
//
//   node .agents/skills/processes/scripts/map-diagram.mjs <process> [--out FILE] [--example-note] [--root DIR]
import { spawnSync } from 'node:child_process'
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

// ---------- данные узлов ----------

const KIND_ICON = { page: '📄', table: '🗂️', series: '✉️', payment: '💳', crm: '👤', external: '🔗' }
const norm = p => String(p || '').replace(/^\.\//, '').replace(/\/+$/, '')

function isBuilt(n) {
  const abs = join(root, norm(n.source))
  if (!n.source || !existsSync(abs)) return false
  if (n.kind === 'series') return walk(abs).some(f => f.endsWith('.message.yaml'))
  return true
}

function seriesLetters(n) {
  const abs = join(root, norm(n.source))
  if (!isDir(abs)) return []
  return walk(abs)
    .filter(f => f.endsWith('.message.yaml'))
    .sort()
    .map(f => {
      try {
        return parseYaml(readFileSync(f, 'utf8'))?.title
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** Домен аккаунта из origin Source Git — для ссылок карточек страниц. */
function accountOrigin() {
  const r = spawnSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
  const m = /^(https:\/\/[^/]+)\/s\/source-git\//.exec((r.stdout || '').trim())
  return m ? m[1] : null
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

const COL_W = 360
const COL_GAP = 150 // место под подпись стрелки
const LEFT = 40
const TOP = 170
const PAD = 24
const CARD_W = COL_W - PAD * 2
const CARD_GAP = 24
const CHARS_PER_LINE = 34

/** Высота карточки по тексту: заголовок + строки с переносом. */
function cardHeight(text) {
  const lines = text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0)
  return 64 + lines * 22
}

const origin = accountOrigin()
const blocks = []
const connections = []

blocks.push({
  id: 'proc-title',
  type: 'text',
  text: `${map.title || slug}`,
  ui: { x: LEFT, y: 40 },
  size: { w: 900, h: 56 },
  style: { fontSize: 28, textAlign: 'left', verticalAlign: 'middle' },
})

const tables = nodes.filter(n => n?.kind === 'table')
const cardNodes = nodes.filter(n => n?.kind !== 'table')
const blockIdOf = new Map()
const columns = stages.map((stage, i) => {
  const x = LEFT + i * (COL_W + COL_GAP)
  const cards = cardNodes.filter(n => n.stage === stage).map(n => {
    const built = isBuilt(n)
    const lines = [n.purpose]
    if (n.kind === 'series') {
      const letters = seriesLetters(n)
      if (letters.length) lines.push(`${letters.length} ${letters.length === 1 ? 'письмо' : 'письма'}: ${letters.map(t => `«${t}»`).join(', ')}`)
    }
    if (!built) lines.push('Ещё не построено')
    const text = lines.filter(Boolean).join('\n')
    return { n, built, text, h: cardHeight(text) }
  })
  const stageTables = tables.filter(t => t.stage === stage)
  return { stage, x, cards, stageTables }
})
const innerH = Math.max(
  160,
  ...columns.map(c => c.cards.reduce((s, k) => s + k.h + CARD_GAP, 0) + (c.stageTables.length ? 40 : 0)),
)
const frameH = innerH + PAD

columns.forEach((col, i) => {
  blocks.push({
    id: `proc-stage-${i + 1}-title`,
    type: 'text',
    text: `${i + 1}. ${col.stage}`,
    ui: { x: col.x, y: TOP - 48 },
    size: { w: COL_W, h: 40 },
    style: { fontSize: 18, textAlign: 'left', verticalAlign: 'middle' },
  })
  blocks.push({
    id: `proc-stage-${i + 1}`,
    type: 'frame',
    ui: { x: col.x, y: TOP },
    size: { w: COL_W, h: frameH },
    style: { fill: 'gray' },
  })
  let y = TOP + PAD
  for (const { n, built, text, h } of col.cards) {
    const id = `proc-node-${n.id}`
    blockIdOf.set(n.id, id)
    const block = {
      id,
      type: 'card',
      title: `${KIND_ICON[n.kind] || '•'} ${n.title}`,
      text,
      ui: { x: col.x + PAD, y },
      size: { w: CARD_W, h },
      style: { fill: built ? 'white' : 'yellow', textAlign: 'left', verticalAlign: 'top' },
    }
    if (n.kind === 'page' && origin && built) block.link = `${origin}/${norm(n.source)}`
    blocks.push(block)
    y += h + CARD_GAP
  }
  if (col.stageTables.length) {
    blocks.push({
      id: `proc-stage-${i + 1}-data`,
      type: 'text',
      text: `🗂️ Данные: ${col.stageTables.map(t => t.title).join(', ')}`,
      ui: { x: col.x + PAD, y: TOP + frameH - 48 },
      size: { w: CARD_W, h: 32 },
      style: { fontSize: 13, textAlign: 'left', verticalAlign: 'middle', textColor: '#6B7280' },
    })
  }
})

links.forEach((l, i) => {
  const from = blockIdOf.get(l.from)
  const to = blockIdOf.get(l.to)
  if (!from || !to) return
  connections.push({
    id: `proc-link-${i + 1}`,
    from: { block: from, anchor: 'right' },
    to: { block: to, anchor: 'left' },
    label: l.via ? `⚙️ ${l.when}` : l.when,
    arrow: 'end',
    route: 'smooth',
    line: 'solid',
    width: 3,
    color: 'blue',
  })
})

const boardRight = LEFT + Math.max(1, stages.length) * (COL_W + COL_GAP) - COL_GAP + 60
const openTodos = ownerTodos().filter(t => !t.done)
blocks.push({
  id: 'proc-owner-todos',
  type: 'sticky',
  title: openTodos.length ? `Нужно от вас · ${openTodos.length}` : 'Нужно от вас',
  text: openTodos.length ? openTodos.map(t => `- ${t.text}`).join('\n') : 'Ничего — всё, что требовалось от владельца, сделано.',
  ui: { x: boardRight, y: TOP },
  size: { w: 300, h: openTodos.length ? 80 + openTodos.length * 44 : 130 },
  style: { fill: openTodos.length ? 'orange' : 'green' },
})

blocks.push({
  id: 'proc-legend',
  type: 'text',
  text: 'Белая карточка — построено · жёлтая — ещё нет · ⚙️ — переход делает автоматизация',
  ui: { x: LEFT, y: TOP + frameH + 24 },
  size: { w: 900, h: 32 },
  style: { fontSize: 13, textAlign: 'left', verticalAlign: 'middle', textColor: '#6B7280' },
})

// Пример заметки человека — второй слой доски (вариант B). Только для пробы.
if (options['example-note']) {
  const series = cardNodes.find(n => n.kind === 'series')
  const target = series ? blockIdOf.get(series.id) : null
  if (target) {
    const targetBlock = blocks.find(b => b.id === target)
    blocks.push({
      id: 'note-example-1',
      type: 'sticky',
      title: 'Ратмир · заметка',
      text: 'Сделать тему письма теплее, добавить имя спикера.',
      ui: { x: targetBlock.ui.x + 30, y: TOP + frameH + 90 },
      size: { w: 260, h: 130 },
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
      color: 'gray',
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
