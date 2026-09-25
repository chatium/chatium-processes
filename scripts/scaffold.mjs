#!/usr/bin/env node
// Каркас нового процесса из шаблонов скилла. Существующие файлы не трогает.
//
//   node .agents/skills/processes/scripts/scaffold.mjs <process> --title "Название" [--account-id 123] [--root DIR] [--dry-run]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findRoot, isProcessSlug, parseArgs, SKILL_DIR } from './lib/project.mjs'
import { parseYaml, requireYaml, stringifyYaml } from './lib/yaml.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['dry-run', 'help'])
const slug = positional[0]

if (options.help || !slug) {
  console.log(
    'Использование: scaffold.mjs <process> --title "Название" [--account-id 123] [--root DIR] [--dry-run]',
  )
  process.exit(options.help ? 0 : 2)
}
if (!isProcessSlug(slug)) {
  console.error(`Слаг процесса «${slug}» должен быть латиницей в kebab-case, например webinar-demo`)
  process.exit(2)
}
const accountId = options['account-id'] ? Number(options['account-id']) : null
if (options['account-id'] && !(Number.isInteger(accountId) && accountId > 0)) {
  console.error('--account-id должен быть положительным целым числом')
  process.exit(2)
}

try {
  requireYaml()
} catch (e) {
  console.error(e.message)
  process.exit(2)
}

const root = findRoot(options.root)
const title = options.title || slug
const dryRun = !!options['dry-run']
const created = []
const skipped = []
const updated = []

const vars = {
  __PROCESS__: slug,
  __TITLE__: title,
  __ACCOUNT_ID__: accountId === null ? 'null' : String(accountId),
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
  if (!existsSync(target)) {
    put(targetRel, tplRel)
    if (dryRun) return
  }
  const doc = parseYaml(readFileSync(target, 'utf8')) || {}
  const order = Array.isArray(doc.order) ? doc.order : []
  const missing = entries.filter(e => !order.includes(e))
  if (missing.length === 0) return
  doc.order = [...order, ...missing]
  if (!dryRun) writeFileSync(target, stringifyYaml(doc))
  if (!created.includes(targetRel)) updated.push(`${targetRel} (+ ${missing.join(', ')})`)
}

// Воркспейс процесса
const wsFile = join(root, slug, '.workspace.json')
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
put(`${slug}/process.yaml`, 'process/process.yaml.tpl')
put(`${slug}/specs/events.yaml`, 'process/events.yaml.tpl')
put(`${slug}/tests/records.ts`, 'process/records.ts.tpl')
put(`${slug}/actions/send-letter.ts`, 'process/actions/send-letter.ts.tpl')
put(`${slug}/actions/register.ts`, 'process/actions/register.ts.tpl')

// База знаний
ensureOrder('.knowledge-base/.knowledge.yml', 'knowledge/root.knowledge.yml.tpl', [
  'business',
  'processes',
])
put('.knowledge-base/business/.knowledge.yml', 'knowledge/business.knowledge.yml.tpl')
ensureOrder('.knowledge-base/processes/.knowledge.yml', 'knowledge/processes.knowledge.yml.tpl', [
  slug,
])
put(`.knowledge-base/processes/${slug}/.knowledge.yml`, 'knowledge/process.knowledge.yml.tpl')
put(`.knowledge-base/processes/${slug}/overview.md`, 'knowledge/overview.md.tpl')

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
