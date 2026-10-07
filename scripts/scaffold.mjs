#!/usr/bin/env node
// Каркас нового процесса из шаблонов скилла. Существующие файлы не трогает.
//
//   node .agents/skills/processes/scripts/scaffold.mjs <process> --title "Название" [--topics audience,journey] [--account-id 123] [--root DIR] [--dry-run]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { findRoot, isProcessSlug, parseArgs, SKILL_DIR } from './lib/project.mjs'
import { parseYaml, requireYaml, stringifyYaml } from './lib/yaml.mjs'
import { assertSkillProcess } from './lib/process-format.mjs'

let parsed
try { parsed = parseArgs(process.argv.slice(2), ['dry-run', 'help', 'allow-main'], ['dry-run', 'help', 'allow-main', 'root', 'title', 'topics', 'account-id']) }
catch (error) { console.error(error.message); process.exit(2) }
const { positional, options } = parsed
const slug = positional[0]

if (options.help || !slug) {
  console.log(
    'Использование: scaffold.mjs <process> --title "Название" [--topics audience,offer,journey,pages,series,operations] [--account-id 123] [--root DIR] [--dry-run] [--allow-main]',
  )
  process.exit(options.help ? 0 : 2)
}
if (positional.length !== 1) {
  console.error('Нужен один аргумент: слаг процесса.')
  process.exit(2)
}
if (!isProcessSlug(slug)) {
  console.error(`Слаг процесса «${slug}» должен быть латиницей в kebab-case, например trial-class`)
  process.exit(2)
}
const accountId = options['account-id'] ? Number(options['account-id']) : null
if (options['account-id'] && !(Number.isInteger(accountId) && accountId > 0)) {
  console.error('--account-id должен быть положительным целым числом')
  process.exit(2)
}
const allowedTopics = new Set(['audience', 'offer', 'journey', 'pages', 'series', 'operations'])
let topics = []
if (Object.hasOwn(options, 'topics')) {
  const requested = typeof options.topics === 'string' ? options.topics.split(',').map(topic => topic.trim()) : []
  if (requested.length === 0 || requested.some(topic => !allowedTopics.has(topic))) {
    console.error(`--topics: укажите непустой список через запятую из ${[...allowedTopics].join(', ')}`)
    process.exit(2)
  }
  topics = [...new Set(requested)]
}

try {
  requireYaml()
} catch (e) {
  console.error(e.message)
  process.exit(2)
}

const root = findRoot(options.root)
const dryRun = !!options['dry-run']
const wsFile = join(root, slug, '.workspace.json')
if (!dryRun && !existsSync(wsFile) && existsSync(join(root, '.git'))) {
  let branch
  try { branch = execFileSync('git', ['-C', root, 'branch', '--show-current'],
    { encoding: 'utf8', timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim() }
  catch (error) { console.error(`Нельзя определить ветку аккаунта: ${error.message}`); process.exit(2) }
  if (!branch) { console.error('Нельзя создавать процесс при отсоединённом HEAD: сначала выбери рабочую ветку.'); process.exit(2) }
  if (['main', 'master'].includes(branch) && !options['allow-main']) {
    console.error('Новый процесс нельзя создавать прямо в main/master. Сначала создай ветку process/<process>. --allow-main допустим только при явном разрешении владельца для тестового аккаунта.')
    process.exit(2)
  }
  if (!(['main', 'master'].includes(branch) && options['allow-main'])) {
    const runGit = args => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } })
    const remote = runGit(['ls-remote', '--heads', 'origin', 'refs/heads/main'])
    const currentMain = /^([0-9a-f]{40})\s+refs\/heads\/main$/m.exec(remote.stdout || '')?.[1]
    if (remote.status !== 0 || !currentMain) {
      console.error('Нельзя подтвердить текущий origin/main. Проверь доступ к Git и повтори создание процесса; файлы не записаны.')
      process.exit(2)
    }
    const ancestor = runGit(['merge-base', '--is-ancestor', currentMain, 'HEAD'])
    if (ancestor.status !== 0) {
      console.error(`Ветка ${branch} не содержит опубликованный origin/main ${currentMain.slice(0, 7)}. Сначала git fetch origin main и создай ветку от origin/main либо влей его обычным merge; файлы не записаны.`)
      process.exit(2)
    }
    const skillDiff = runGit(['diff', '--quiet', currentMain, 'HEAD', '--', '.agents/skills/processes'])
    const skillDirty = runGit(['status', '--porcelain', '--', '.agents/skills/processes'])
    if (skillDiff.status !== 0 || skillDirty.status !== 0 || skillDirty.stdout.trim()) {
      console.error('Скилл processes в рабочей ветке отличается от опубликованного origin/main. Обнови ветку и верни актуальную отслеживаемую копию скилла до создания процесса; файлы не записаны.')
      process.exit(2)
    }
  }
}
try {
  assertSkillProcess(root, slug, { creating: true })
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
const title = options.title || slug
const created = []
const skipped = []
const updated = []

// Интервью могло уже создать статьи с собственными именами и композицией.
// Используем одну из них, не добавляя рядом пустой обязательный «обзор».
const knowledgeDir = `.knowledge-base/processes/${slug}`
function firstArticle(dir, prefix = '') {
  if (!existsSync(dir)) return null
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
  const direct = entries.find(entry => entry.isFile() && entry.name === 'overview.md') ||
    entries.find(entry => entry.isFile() && entry.name.endsWith('.md'))
  if (direct) return prefix + direct.name
  for (const entry of entries.filter(entry => entry.isDirectory())) {
    const found = firstArticle(join(dir, entry.name), `${prefix}${entry.name}/`)
    if (found) return found
  }
  return null
}
const knowledgeEntry = firstArticle(join(root, knowledgeDir)) || 'overview.md'

const vars = {
  __PROCESS__: slug,
  __TITLE__: title,
  __TITLE_YAML__: JSON.stringify(title),
  __ACCOUNT_ID__: accountId === null ? 'null' : String(accountId),
  __KNOWLEDGE_ENTRY__: knowledgeEntry.split('/').map(part => encodeURIComponent(part)
    .replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/'),
  __DATE__: new Date().toISOString().slice(0, 10),
}

function render(tplRel) {
  let text = readFileSync(join(SKILL_DIR, 'templates', tplRel), 'utf8')
  for (const [k, v] of Object.entries(vars)) text = text.split(k).join(v)
  return text
}

function put(targetRel, tplRel) {
  const target = join(root, targetRel)
  if (existsSync(target)) {
    skipped.push(targetRel)
    return
  }
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, render(tplRel))
  }
  created.push(targetRel)
}

/** Дописывает entry в order у .knowledge.yml (или создаёт файл из шаблона). */
function ensureOrder(targetRel, tplRel, entries) {
  const target = join(root, targetRel)
  const existed = existsSync(target)
  const doc = parseYaml(existed ? readFileSync(target, 'utf8') : render(tplRel)) || {}
  if (typeof doc !== 'object' || Array.isArray(doc) ||
      (doc.order !== undefined && (!Array.isArray(doc.order) || doc.order.some(entry => typeof entry !== 'string')))) {
    throw new Error(`${targetRel}: ожидается YAML-объект с order — массивом строк; существующие данные не изменены`)
  }
  const order = Array.isArray(doc.order) ? doc.order : []
  const missing = entries.filter(e => !order.includes(e))
  if (existed && missing.length === 0) return
  doc.order = [...order, ...missing]
  if (!dryRun) {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, stringifyYaml(doc))
  }
  if (existed) updated.push(`${targetRel} (+ ${missing.join(', ')})`)
  else created.push(targetRel)
}

// Воркспейс процесса
if (existsSync(wsFile)) {
  try {
    const ws = JSON.parse(readFileSync(wsFile, 'utf8'))
    if (ws.type !== 'process') {
      console.error(`${slug}/.workspace.json уже есть, но type = ${ws.type}, а не process`)
      process.exit(2)
    }
  } catch {
    console.error(`${slug}/.workspace.json не разбирается как JSON`)
    process.exit(2)
  }
}
put(`${slug}/.workspace.json`, 'process/workspace.json.tpl')
put(`${slug}/.dir.json`, 'process/dir.json.tpl')
put(`${slug}/PLAN.md`, 'process/PLAN.md.tpl')
put(`${slug}/tasks/index.json`, 'process/tasks-index.json.tpl')
put(`${slug}/process.yaml`, 'process/process.yaml.tpl')
put(`${slug}/specs/events.yaml`, 'process/events.yaml.tpl')
put(`${slug}/tests/records.ts`, 'process/records.ts.tpl')

// База знаний
ensureOrder('.knowledge-base/.knowledge.yml', 'knowledge/root.knowledge.yml.tpl', [
  'business',
  'processes',
])
put('.knowledge-base/business/.knowledge.yml', 'knowledge/business.knowledge.yml.tpl')
ensureOrder('.knowledge-base/processes/.knowledge.yml', 'knowledge/processes.knowledge.yml.tpl', [
  slug,
])
put(`${knowledgeDir}/${knowledgeEntry}`, 'knowledge/overview.md.tpl')
for (const topic of topics) {
  put(`.knowledge-base/processes/${slug}/${topic}.md`, `knowledge/${topic}.md.tpl`)
}
ensureOrder(`.knowledge-base/processes/${slug}/.knowledge.yml`, 'knowledge/process.knowledge.yml.tpl', [
  knowledgeEntry.split('/')[0],
  ...topics.map(topic => `${topic}.md`),
])

// Хранилище писем (если его ещё нет в аккаунте)
if (!existsSync(join(root, '.mailings/storage/.workspace.json'))) {
  put('.mailings/storage/.workspace.json', 'mailings/workspace.json.tpl')
  put('.mailings/storage/.dir.json', 'mailings/dir.json.tpl')
}

console.log(`${dryRun ? '[dry-run] ' : ''}Каркас процесса ${slug} в ${root}`)
for (const f of created) console.log(`  + ${f}`)
for (const f of updated) console.log(`  ~ ${f}`)
for (const f of skipped) console.log(`  = ${f} (уже есть)`)
console.log(`Письма серий кладите в .mailings/storage/processes/${slug}/<series>/`)
if (accountId === null) {
  console.log('accountId в process.yaml пуст: узнайте его через chatium exec (return ctx.account.id)')
}
