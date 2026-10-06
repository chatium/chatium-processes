#!/usr/bin/env node
// Сверка процесса: карта ↔ код, события, автоматизации, письма, переменные.
// Итог честный — N/M проверок.
//
//   node .agents/skills/processes/scripts/check.mjs <process> [--json] [--typecheck] [--no-snapshot | --verify-snapshot | --publish-snapshot] [--snapshot-file FILE] [--registry FILE] [--knowledge-stage design|build|launch] [--root DIR]
//
// Коды выхода: 0 — всё зелёное, 1 — есть провалы, 2 — не удалось запустить.
import { prepareSnapshot, publishSnapshot } from './lib/snapshot.mjs'
import { verifySnapshot } from './lib/freshness.mjs'
import { codeReviewStatus } from './lib/code-review.mjs'
import { commissionStatus } from './lib/commission.mjs'
import { ownerDecisionStatus } from './lib/owner-decisions.mjs'
import { collectKnowledge } from './lib/knowledge.mjs'
import { reviewStatus, REVIEW_STAGES } from './lib/knowledge-review.mjs'
import { safeTaskPath, taskReadiness, TASK_STAGES } from './lib/tasks.mjs'
import { creativeStatus } from './lib/creative.mjs'
import { creativeReviewStatus } from './lib/creative-review.mjs'
import { gitState, assertLocalState, SnapshotDrift } from './lib/git-state.mjs'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findRoot, isDir, isFile, parseArgs, rel, SKILL_DIR, walk } from './lib/project.mjs'
import { parseYaml, requireYaml } from './lib/yaml.mjs'
import { templatePath, templateFiles } from './lib/letters.mjs'
import { assertSkillProcess } from './lib/process-format.mjs'
import { validateProcessAgents } from './lib/agents.mjs'
import { agentReviewStatus } from './lib/agent-review.mjs'
import { automationSmokeStatus } from './lib/automation-smoke.mjs'
import { retirementStatus } from './lib/component-retirements.mjs'
import { tableChangeStatus } from './lib/table-changes.mjs'
import { validateComponentContracts } from './lib/component-contracts.mjs'

const NODE_KINDS = ['page', 'table', 'series', 'payment', 'crm', 'external', 'agent']
const EVENT_TYPES = ['workspaceEvent', 'customerEvent']
const EVENT_CATEGORIES = ['traffic', 'engagement', 'conversion', 'revenue', 'retention', 'content', 'forms', 'other']
const PAYLOAD_TYPES = ['string', 'number', 'boolean', 'date', 'object', 'array', 'any']
const EVENT_FIELD_NAMES = [
  'action_params', 'uid',
  'action_param1', 'action_param2', 'action_param3',
  'action_param1_int', 'action_param2_int', 'action_param3_int',
  'action_param1_float', 'action_param2_float', 'action_param3_float', 'action_param4_float',
  'action_param5_float', 'action_param6_float', 'action_param7_float', 'action_param8_float',
  'action_param1_arrstr', 'action_param2_arrstr', 'action_param3_arrstr',
  'action_param1_uint32arr', 'action_param1_mapstrstr', 'action_param2_mapstrstr',
  'customer_contacts', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
]
const CONTACT_MAPPING_KEY = /^(?:contacts?|customer_?contacts?|contact_?(?:email|phone)|recipient_?(?:email|phone)|e?mail|phone|mobile|telephone|telegram|whatsapp|vk)$/i
const UTM_MAPPING_KEY = /^(?:utm_?)(source|medium|campaign|content|term)$/i
const STEP_TYPES = ['action', 'delay', 'continueCondition', 'draft']
const DELAY_UNITS = ['seconds', 'minutes', 'hours', 'days']
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const LETTER_REQUIRED = ['title', 'description', 'subject', 'plain', 'html', 'short']
const LETTER_FORBIDDEN = [
  'id', 'key', 'path', 'filename', 'email', 'telegram', 'sms', 'content', 'formats',
  'trigger', 'schedule', 'delay', 'action', 'transport', 'status', 'style', 'metadata',
  'replyTo', 'extra', 'agentEnabled', 'agentPercent', 'agentPrompt', 'images',
]
// Запись файлов через SDK Start и @app/ugc: из кода процесса не работает
const FILE_WRITE_APIS = [
  'updateWorkspaceFile', 'updateWorkspaceFilesMulti', 'ensureWorkspaceDirectory',
  'updateUgcFile', 'updateUgcFilesMulti', 'updateUgcFilesMultiExt', 'updateUgcFileSource',
  'deleteUgcFile', 'deleteUgcDirectoryRecursive', 'deleteUgcDirectoryRecursiveExt', 'updateFilePath',
]
const SKILL_FORBIDDEN = [/\.tsx?$/, /\.vue$/, /\.workspace\.json$/, /\.dir\.json$/, /\.automationConfig\.json$/]

const boolOptions = ['json', 'typecheck', 'help', 'no-snapshot', 'verify-snapshot', 'publish-snapshot']
const knownOptions = new Set([...boolOptions, 'snapshot-file', 'registry', 'knowledge-stage', 'task-stage', 'root'])
let parsed
try { parsed = parseArgs(process.argv.slice(2), boolOptions, [...knownOptions]) }
catch (error) { console.error(error.message); process.exit(2) }
const { positional, options } = parsed
const unknownOptions = Object.keys(options).filter(name => !knownOptions.has(name))
const valuedBooleans = boolOptions.filter(name => options[name] !== undefined && options[name] !== true)
if (unknownOptions.length || positional.length > 1 || Object.entries(options).some(([name, value]) =>
  !boolOptions.includes(name) &&
  (typeof value !== 'string' || value.startsWith('--'))) || valuedBooleans.length) {
  console.error(`Некорректные параметры check: ${[...unknownOptions, ...valuedBooleans].map(name => `--${name}`).join(', ') || 'проверьте значения и позиционные аргументы'}. Запустите --help.`)
  process.exit(2)
}
const slug = positional[0]
if (options.help || !slug) {
  console.log('Использование: check.mjs <process> [--json] [--typecheck] [--no-snapshot | --verify-snapshot | --publish-snapshot] [--snapshot-file FILE] [--registry FILE] [--knowledge-stage design|build|launch] [--task-stage design|build|test|launch] [--root DIR]')
  process.exit(options.help ? 0 : 2)
}
if (['no-snapshot', 'verify-snapshot', 'publish-snapshot'].filter(name => options[name]).length > 1) {
  console.error('--no-snapshot, --verify-snapshot и --publish-snapshot несовместимы.')
  process.exit(2)
}
try {
  requireYaml()
} catch (e) {
  console.error(e.message)
  process.exit(2)
}

if (options['knowledge-stage'] && !REVIEW_STAGES.includes(options['knowledge-stage'])) {
  console.error('--knowledge-stage: нужен design, build или launch.')
  process.exit(2)
}
if (options['task-stage'] && !TASK_STAGES.includes(options['task-stage'])) {
  console.error('--task-stage: нужен design, build, test или launch.')
  process.exit(2)
}
const root = findRoot(options.root)
// Stop before Git/network checks and snapshot writes for an old or ambiguous process.
try { assertSkillProcess(root, slug) }
catch (error) {
  if (options.json) console.log(JSON.stringify({ process: slug, root, passed: 0, total: 1,
    checks: [{ id: 'process.format', title: 'Формат процесса', ok: false, errors: [error.message], warnings: [] }],
    snapshot: { saved: false, verified: false, skipped: true, error: error.message },
  }, null, 2))
  else console.error(error.message)
  process.exit(2)
}
// Anchor the check before reading any source, not after validation/typecheck.
let sourceState, sourceError
if (!options['no-snapshot']) {
  try { sourceState = gitState(root); assertLocalState(root, sourceState) }
  catch (e) { sourceError = e }
}
const dir = join(root, slug)
if (!isDir(dir)) {
  console.error(`Нет папки процесса ${slug}/ в ${root}`)
  process.exit(2)
}
let workReport, workError
function getWorkReport() {
  if (workError) throw workError
  if (!workReport) try { workReport = taskReadiness({ root, slug, stage: options['task-stage'] || 'build' }) }
  catch (error) { workError = error; throw error }
  return workReport
}

// ---------- результаты ----------

const checks = []
function check(id, title, fn) {
  const errors = []
  const warnings = []
  try {
    fn({ error: m => errors.push(m), warn: m => warnings.push(m) })
  } catch (e) {
    errors.push(`проверка упала: ${e.message}`)
  }
  checks.push({ id, title, ok: errors.length === 0, errors, warnings })
}

// ---------- загрузка ----------

const norm = p => String(p || '').replace(/^\.\//, '').replace(/\/+$/, '')

function loadYamlFile(abs) {
  if (!isFile(abs)) return { missing: true }
  try {
    return { data: parseYaml(readFileSync(abs, 'utf8')) }
  } catch (e) {
    return { parseError: e.message }
  }
}

const codeFiles = walk(dir).filter(f => /\.(ts|tsx|vue)$/.test(f) && !f.endsWith('.d.ts'))
const codeSources = new Map(codeFiles.map(f => [f, readFileSync(f, 'utf8')]))

const mapRes = loadYamlFile(join(dir, 'process.yaml'))
const map = mapRes.data && typeof mapRes.data === 'object' ? mapRes.data : null
const nodes = Array.isArray(map?.nodes) ? map.nodes : []
const links = Array.isArray(map?.links) ? map.links : []
const lettersRoot = norm(map?.letters || `.mailings/storage/processes/${slug}`)

const eventsRes = loadYamlFile(join(dir, 'specs', 'events.yaml'))
const events = Array.isArray(eventsRes.data?.events) ? eventsRes.data.events : []
const eventByKey = new Map(events.filter(e => e && e.key).map(e => [e.key, e]))
const analyticsRes = loadYamlFile(join(dir, 'specs', 'analytics.yaml'))
const siteRes = loadYamlFile(join(dir, 'specs', 'site.yaml'))
const servicesRes = loadYamlFile(join(dir, 'specs', 'services.yaml'))
// URL события строится от процесса: workspaceEvent — event://account/<процесс>/<ключ>,
// customerEvent (captureCustomerEvent из @crm/sdk) — event://crm/customer/event/<процесс>/<ключ>
const EVENT_URL_PREFIX = {
  workspaceEvent: `event://account/${slug}/`,
  customerEvent: `event://crm/customer/event/${slug}/`,
}
const eventUrl = e => `${EVENT_URL_PREFIX[e.type] || EVENT_URL_PREFIX.workspaceEvent}${e.key}`
/** Событие процесса по URL; null — внешнее событие; { foreign } — событие чужого воркспейса. */
function eventFromUrl(url) {
  for (const [type, prefix] of Object.entries(EVENT_URL_PREFIX)) {
    if (url.startsWith(prefix)) return { type, key: url.slice(prefix.length), event: eventByKey.get(url.slice(prefix.length)) }
  }
  if (url.startsWith('event://account/') || url.startsWith('event://crm/customer/event/')) return { foreign: true }
  return null
}

/** Вызовы записи событий в коде: { file, key | null (не литерал), raw, via }. */
function eventWrites() {
  const out = []
  for (const [file, src] of codeSources) {
    for (const m of src.matchAll(/writeWorkspaceEvent\(\s*[\w.]+\s*,\s*([^,)]+)/g)) {
      const lit = /^['"`]([^'"`$]+)['"`]$/.exec(m[1].trim())
      out.push({ file, key: lit ? lit[1] : null, raw: m[1].trim(), via: 'workspaceEvent' })
    }
    for (const m of src.matchAll(/captureCustomerEvent\(\s*[\w.]+\s*,\s*\{[\s\S]*?\bevent:\s*([^,\n}]+)/g)) {
      const lit = /^['"`]([^'"`$]+)['"`]$/.exec(m[1].trim())
      out.push({ file, key: lit ? lit[1] : null, raw: m[1].trim(), via: 'customerEvent' })
    }
  }
  return out
}

const automationFiles = walk(dir).filter(f => f.endsWith('.automationConfig.json'))
const automations = automationFiles.map(f => {
  try {
    return { file: f, config: JSON.parse(readFileSync(f, 'utf8')) }
  } catch (e) {
    return { file: f, parseError: e.message }
  }
})

/** Шаги автоматизации по порядку выполнения, включая ветки условий. */
function flattenSteps(steps, out = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    out.push(step)
    if (step && (step.type === 'condition' || step.type === 'draft')) {
      flattenSteps(step.thenBranch?.steps, out)
      flattenSteps(step.elseBranch?.steps, out)
    }
  }
  return out
}

function moduleFile(modulePath) {
  for (const ext of ['.ts', '.tsx']) {
    const p = join(root, `${modulePath}${ext}`)
    if (isFile(p)) return p
  }
  return null
}

/** Все $ref и {{ path }} из $template/строк в значении параметра. */
function refsOf(value) {
  if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string') return [value.$ref]
    if (typeof value.$template === 'string') return templateRefs(value.$template)
    if ('$static' in value) return []
    return null // вложенный объект — рантайм его не разбирает
  }
  if (typeof value === 'string') return templateRefs(value)
  return []
}

function templateRefs(s) {
  return [...s.matchAll(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g)].map(m => m[1])
}

function letterVariables(letter) {
  const texts = ['subject', 'preheader', 'plain', 'html', 'short'].map(k => letter?.[k]).filter(v => typeof v === 'string')
  for (const b of Array.isArray(letter?.buttons) ? letter.buttons : []) {
    if (typeof b?.text === 'string') texts.push(b.text)
    if (typeof b?.url === 'string') texts.push(b.url)
  }
  const names = new Set()
  for (const t of texts) for (const m of t.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) names.add(m[1])
  return names
}

// Все шаги отправки писем по всем автоматизациям
const sendSteps = []
for (const a of automations) {
  for (const step of flattenSteps(a.config?.steps)) {
    if (step?.type === 'action' && step.params && ('letterPath' in step.params || 'messageKey' in step.params)) {
      sendSteps.push({ automation: a, step })
    }
  }
}

// ---------- проверки ----------

check('workspace', 'Воркспейс процесса', ({ error, warn }) => {
  const f = join(dir, '.workspace.json')
  if (!isFile(f)) return error(`нет ${slug}/.workspace.json`)
  let ws
  try {
    ws = JSON.parse(readFileSync(f, 'utf8'))
  } catch (e) {
    return error(`.workspace.json не разбирается: ${e.message}`)
  }
  if (ws.type !== 'process') error(`type = ${JSON.stringify(ws.type)}, нужен "process"`)
  const channels = ws.config?.senderChannels
  if (!Array.isArray(channels) || !channels.length || channels.some(id => typeof id !== 'string' || !id.trim())) {
    warn('config.senderChannels не заполнен корректно: укажите список ID выбранных каналов Sender; если они ещё не подключены, добавьте это в «Нужно от вас». Настройка каналов не блокирует сборку, доступность каналов проверяется отдельно.')
  }
  const vars = ws.config?.variables
  if (vars !== undefined && (!vars || typeof vars !== 'object' || Array.isArray(vars))) {
    error('config.variables должен быть объектом { key: { value, description } }')
  }
  for (const [k, v] of Object.entries(vars || {})) {
    if (typeof v?.value !== 'string') error(`переменная ${k}: value должен быть строкой`)
    if (!v?.description) warn(`переменная ${k}: нет description`)
  }
  const nested = walk(dir).filter(p => p.endsWith('.workspace.json') && dirname(p) !== dir)
  for (const p of nested) error(`вложенный воркспейс ${rel(root, p)} отрезает папку от процесса`)
  // переменные процесса, на которые ссылается код
  for (const [file, src] of codeSources) {
    for (const m of src.matchAll(/\bconfig\??\.\s*variables\??\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      if (!vars || !(m[1] in vars)) error(`${rel(root, file)}: переменная процесса ${m[1]} не объявлена в config.variables`)
    }
  }
})

if (options['task-stage'] === 'launch') check('launch.variables', 'Значения процесса перед запуском', ({ error }) => {
  const file = join(dir, '.workspace.json')
  if (!isFile(file)) return
  let vars
  try { vars = JSON.parse(readFileSync(file, 'utf8'))?.config?.variables }
  catch { return }
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return
  for (const [key, item] of Object.entries(vars))
    if (typeof item?.value === 'string' && !item.value.trim())
      error(`переменная ${key}: перед запуском заполните значение или удалите неиспользуемую переменную`)
})

check('map', 'Карта процесса process.yaml', ({ error, warn }) => {
  if (mapRes.missing) return error(`нет ${slug}/process.yaml`)
  if (mapRes.parseError) return error(`process.yaml не разбирается: ${mapRes.parseError}`)
  if (!map) return error('process.yaml пустой')
  for (const f of ['title', 'knowledge', 'stages', 'nodes']) if (map[f] === undefined) error(`нет поля ${f}`)
  const stages = Array.isArray(map.stages) ? map.stages : []
  if (stages.length === 0) error('stages пуст: этапы пути клиента обязательны')
  if (nodes.length === 0) error('nodes пуст: в карте нет ни одного узла')
  if (automations.length > 0 && !(Number.isInteger(map.accountId) && map.accountId > 0)) {
    error('accountId не задан: нужен для routeJson автоматизаций (chatium exec → return ctx.account.id)')
  }
  const ids = new Set()
  for (const [i, n] of nodes.entries()) {
    const where = `nodes[${i}]${n?.id ? ` (${n.id})` : ''}`
    for (const f of ['id', 'stage', 'kind', 'title', 'purpose', 'source']) if (!n?.[f]) error(`${where}: нет поля ${f}`)
    if (n?.id && ids.has(n.id)) error(`${where}: id повторяется`)
    if (n?.id) ids.add(n.id)
    if (n?.stage && !stages.includes(n.stage)) error(`${where}: stage «${n.stage}» нет в stages`)
    if (n?.kind && !NODE_KINDS.includes(n.kind)) error(`${where}: kind «${n.kind}», допустимы ${NODE_KINDS.join(', ')}`)
  }
  for (const [i, l] of links.entries()) {
    const where = `links[${i}] ${l?.from} → ${l?.to}`
    if (!ids.has(l?.from)) error(`${where}: нет узла ${l?.from}`)
    if (!ids.has(l?.to)) error(`${where}: нет узла ${l?.to}`)
    if (!l?.when) warn(`${where}: нет подписи when`)
    if (l?.signal !== undefined) {
      const m = /^event:([a-zA-Z0-9_-]+)$/.exec(String(l.signal))
      if (!m) error(`${where}: signal должен быть вида event:<ключ>`)
      else if (!eventByKey.has(m[1])) error(`${where}: событие ${m[1]} не объявлено в specs/events.yaml`)
    }
    if (l?.via !== undefined) {
      const via = norm(l.via)
      const a = automations.find(x => rel(root, dirname(x.file)) === via || rel(root, x.file) === via)
      if (!a) error(`${where}: в ${via} нет *.automationConfig.json`)
      else if (l.signal && a.config) {
        const ev = eventByKey.get(String(l.signal).replace(/^event:/, ''))
        if (ev && !(a.config.eventUrls || []).includes(eventUrl(ev))) {
          error(`${where}: автоматизация ${via} не слушает ${eventUrl(ev)}`)
        }
      }
    }
  }
})

check('retirements', 'Осознанный вывод компонентов', ({ error }) => {
  for (const issue of retirementStatus({ root, slug, map, automationFiles: automations.map(item => item.file) }).errors) error(issue)
})

check('components.contracts', 'Контракты сайта и сервисов', ({ error }) => {
  for (const [name, result] of [['site.yaml', siteRes], ['services.yaml', servicesRes]])
    if (result.parseError) error(`${name} не разбирается: ${result.parseError}`)
  if (siteRes.parseError || servicesRes.parseError) return
  for (const issue of validateComponentContracts({ map,
    ...(siteRes.missing ? {} : { site: siteRes.data }),
    ...(servicesRes.missing ? {} : { services: servicesRes.data }),
  }).errors) error(issue)
})

check('table.changes', 'Защита схемы действующих таблиц', ({ error }) => {
  for (const issue of tableChangeStatus({ root, slug, stage: options['task-stage'] || 'build' }).errors) error(issue)
})

check('map.sources', 'Узлы карты построены', ({ error, warn }) => {
  for (const n of nodes) {
    if (!n?.source) continue
    const src = norm(n.source)
    const abs = join(root, src)
    if (!existsSync(abs)) {
      if (options['task-stage'] === 'design') warn(`${n.id}: исходник ${src} появится на этапе сборки`)
      else error(`${n.id}: не построено — нет ${src}`)
      continue
    }
    if (n.kind === 'page' && !(isFile(join(abs, 'index.tsx')) || (isFile(abs) && abs.endsWith('.tsx')))) {
      error(`${n.id}: в ${src} нет index.tsx`)
    }
    if (n.kind === 'table' && !src.endsWith('.table.ts')) error(`${n.id}: source таблицы — файл *.table.ts`)
    if (n.kind === 'agent' && !src.endsWith('.agent.json')) error(`${n.id}: source агента — файл *.agent.json`)
    if (n.kind === 'series' && walk(abs).filter(f => f.endsWith('.message.yaml')).length === 0) {
      error(`${n.id}: в ${src} нет ни одного *.message.yaml`)
    }
  }
})

check('agents', 'Агенты процесса', ({ error, warn }) => {
  const report = validateProcessAgents({ root, slug, map })
  for (const issue of report.errors) error(issue)
  for (const issue of report.warnings) warn(issue)
})

check('agents.review', 'Независимое ревью помощников', ({ error, warn }) => {
  if (!validateProcessAgents({ root, slug, map }).enabled) return
  const result = agentReviewStatus({ root, slug })
  if (result.error) error(result.error)
  for (const gap of result.blocking || []) error(`${gap.id}: ${gap.reason} → ${gap.nextAction}`)
  for (const gap of result.advisory || []) warn(`${gap.id}: ${gap.reason} → ${gap.nextAction}`)
  for (const issue of result.structuralErrors || []) error(issue)
})

check('map.coverage', 'Всё построенное есть в карте', ({ error, warn }) => {
  const sourcesOf = kind => nodes.filter(n => n?.kind === kind && n.source).map(n => norm(n.source))
  const covered = (p, sources) => sources.some(s => p === s || p.startsWith(`${s}/`))
  const pageSources = sourcesOf('page')
  for (const f of walk(dir).filter(f => f.endsWith('/index.tsx'))) {
    const d = rel(root, dirname(f))
    if (!covered(d, pageSources)) error(`неучтённое: страница ${d}/ не отмечена в карте`)
  }
  const vias = links.filter(l => l?.via).map(l => norm(l.via))
  for (const a of automations) {
    const d = rel(root, dirname(a.file))
    if (!vias.includes(d) && !vias.includes(rel(root, a.file))) {
      error(`неучтённое: автоматизация ${rel(root, a.file)} не стоит ни на одной стрелке (via)`)
    }
  }
  const seriesSources = sourcesOf('series')
  for (const f of walk(join(root, lettersRoot)).filter(f => f.endsWith('.message.yaml'))) {
    const d = rel(root, dirname(f))
    if (!covered(d, seriesSources)) error(`неучтённое: серия ${d}/ не отмечена в карте`)
  }
  const tableSources = sourcesOf('table')
  for (const f of walk(dir).filter(f => f.endsWith('.table.ts'))) {
    const p = rel(root, f)
    if (!tableSources.includes(p)) warn(`таблица ${p} не отмечена в карте`)
  }
})

check('events.registry', 'Реестр событий specs/events.yaml', ({ error, warn }) => {
  if (eventsRes.missing) return error(`нет ${slug}/specs/events.yaml`)
  if (eventsRes.parseError) return error(`events.yaml не разбирается: ${eventsRes.parseError}`)
  if (!Array.isArray(eventsRes.data?.events)) return error('нет списка events')
  const keys = new Set()
  for (const [i, e] of events.entries()) {
    const where = `events[${i}]${e?.key ? ` (${e.key})` : ''}`
    for (const f of ['key', 'type', 'name', 'description', 'payloadMapping']) if (e?.[f] === undefined) error(`${where}: нет поля ${f}`)
    if (e?.key && !/^[a-z][a-z0-9_]*$/.test(e.key)) error(`${where}: ключ — латиница в snake_case`)
    if (e?.key && keys.has(e.key)) error(`${where}: ключ повторяется`)
    if (e?.key) keys.add(e.key)
    if (e?.type && !EVENT_TYPES.includes(e.type)) error(`${where}: type «${e.type}», допустимы ${EVENT_TYPES.join(', ')}`)
    if (e?.category && !EVENT_CATEGORIES.includes(e.category)) error(`${where}: category «${e.category}», допустимы ${EVENT_CATEGORIES.join(', ')}`)
    const slots = new Map()
    for (const [k, m] of Object.entries(e?.payloadMapping || {})) {
      for (const f of ['title', 'fieldName', 'type']) if (!m?.[f]) error(`${where}.${k}: нет поля ${f}`)
      if (m?.fieldName && !EVENT_FIELD_NAMES.includes(m.fieldName)) error(`${where}.${k}: fieldName «${m.fieldName}» — не слот метрики`)
      if (m?.type && !PAYLOAD_TYPES.includes(m.type)) error(`${where}.${k}: type «${m.type}», допустимы ${PAYLOAD_TYPES.join(', ')}`)
      if (m?.fieldName === 'customer_contacts') error(`${where}.${k}: customer_contacts формируется из контактов и не входит в payloadMapping`)
      if (CONTACT_MAPPING_KEY.test(k)) warn(`${where}.${k}: возможное дублирование контакта в payloadMapping; используй contacts/customer_contacts, если поле нужно только для адресата`)
      if (/\bcustomer_contacts\b/.test(m?.fieldExpr || ''))
        error(`${where}.${k}: не извлекай контакты через fieldExpr — используй контекст контактов`)
      if (/(?:^id$|Id$|_id$)/.test(k) && m?.fieldName && !/^action_param[123]$/.test(m.fieldName))
        error(`${where}.${k}: ID должен быть строкой в action_param1..3`)
      if (/(?:^id$|Id$|_id$)/.test(k) && m?.type && m.type !== 'string')
        error(`${where}.${k}: ID требует type: string`)
      if (/^action_param[1-3]_int$|^action_param[1-8]_float$/.test(m?.fieldName) && m?.type && m.type !== 'number')
        error(`${where}.${k}: числовой слот требует type: number`)
      const utm = UTM_MAPPING_KEY.exec(k)
      if (utm && m?.fieldName && m.fieldName !== `utm_${utm[1].toLowerCase()}`)
        error(`${where}.${k}: UTM используй в выделенном слоте utm_${utm[1].toLowerCase()}`)
      if (m?.fieldName && !m.fieldExpr && !/_(mapstrstr|arrstr|uint32arr)$|^action_params$|^customer_contacts$/.test(m.fieldName)) {
        if (slots.has(m.fieldName)) error(`${where}: слот ${m.fieldName} занят полями ${slots.get(m.fieldName)} и ${k}`)
        else slots.set(m.fieldName, k)
      }
    }
  }
})

check('events.data', 'Контакты и метрика в коде события', ({ error, warn }) => {
  for (const [file, src] of codeSources) {
    const where = rel(root, file)
    for (const block of src.matchAll(/metricEventData\s*:\s*\{([^}]*)\}/g)) {
      if (/\bcustomer_contacts\s*:/.test(block[1]))
        error(`${where}: customer_contacts нельзя передавать в metricEventData — CRM формирует его из contacts`)
      for (const field of block[1].matchAll(/\baction_param\w*\s*:\s*([^,\n}]+)/g)) {
        if (/\b(?:email|phone|mobile|telegram|whatsapp)\b/i.test(field[1]))
          warn(`${where}: возможное дублирование контакта в ${field[0].split(':')[0].trim()}; проверь источник и необходимость поля`)
      }
    }
  }
})

check('events.written', 'События из кода объявлены', ({ error }) => {
  for (const w of eventWrites()) {
    const where = rel(root, w.file)
    if (!w.key) {
      error(`${where}: ключ события передан не строкой (${w.raw}) — пиши ключ литералом`)
      continue
    }
    const ev = eventByKey.get(w.key)
    if (!ev) error(`${where}: событие ${w.key} не объявлено в specs/events.yaml`)
    else if (ev.type !== w.via) {
      const fn = w.via === 'customerEvent' ? 'captureCustomerEvent' : 'writeWorkspaceEvent'
      error(`${where}: ${w.key} пишется через ${fn}, а в реестре type: ${ev.type} — URL события не совпадёт`)
    }
  }
})

check('events.used', 'Каждое событие кто-то пишет и кто-то слушает', ({ error, warn }) => {
  const written = new Set(eventWrites().filter(w => w.key).map(w => w.key))
  const listened = new Set()
  for (const a of automations) {
    for (const url of a.config?.eventUrls || []) listened.add(url)
  }
  for (const e of events) {
    if (!e?.key || !EVENT_URL_PREFIX[e.type]) continue
    if (!written.has(e.key)) error(`событие ${e.key} объявлено, но его никто не пишет (writeWorkspaceEvent / captureCustomerEvent)`)
    if (!listened.has(eventUrl(e))) warn(`событие ${e.key} никто не слушает — только для аналитики?`)
  }
})

check('analytics.spec', 'Связность аналитической воронки', ({ error }) => {
  if (analyticsRes.missing) {
    if ([...codeSources.values()].some(source => /\bqueryAi\s*\(/.test(source)))
      error('Для собственного аналитического запроса нужен specs/analytics.yaml с вопросом владельца и реальными источниками.')
    return
  }
  if (analyticsRes.parseError) return error(`analytics.yaml не разбирается: ${analyticsRes.parseError}`)
  const funnels = analyticsRes.data?.funnels ?? []
  const metrics = analyticsRes.data?.metrics ?? []
  if (!Array.isArray(funnels) || !Array.isArray(metrics) ||
      funnels.length + metrics.length < 1 || funnels.length + metrics.length > 50)
    return error('analytics.yaml: нужны funnels или metrics (в сумме от 1 до 50).')
  const ids = new Set()
  for (const [index, metric] of metrics.entries()) {
    const where = `analytics.metrics[${index}]${metric?.id ? ` (${metric.id})` : ''}`
    if (typeof metric?.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(metric.id) || ids.has(metric.id))
      error(`${where}: нужен уникальный id в snake_case.`)
    if (metric?.id) ids.add(metric.id)
    if (typeof metric?.question !== 'string' || !metric.question.trim()) error(`${where}: нужен бизнес-вопрос question.`)
    if (!Array.isArray(metric?.sourceEvents) || metric.sourceEvents.length !== 1)
      error(`${where}: простая метрика должна ссылаться на одно событие; для конверсии разных событий опиши funnels.`)
    for (const key of Array.isArray(metric?.sourceEvents) ? metric.sourceEvents : [])
      if (!eventByKey.has(key)) error(`${where}: событие ${key} не объявлено в specs/events.yaml.`)
  }
  for (const [index, funnel] of funnels.entries()) {
    const where = `analytics.funnels[${index}]${funnel?.id ? ` (${funnel.id})` : ''}`
    if (typeof funnel?.id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(funnel.id) || ids.has(funnel.id))
      error(`${where}: нужен уникальный id в snake_case.`)
    if (funnel?.id) ids.add(funnel.id)
    if (typeof funnel?.question !== 'string' || !funnel.question.trim()) error(`${where}: нужен бизнес-вопрос question.`)
    if (funnel?.identity !== 'customer') error(`${where}: поддержана только identity: customer; для другой идентичности нужен явный проверенный механизм связывания.`)
    if (!Number.isInteger(funnel?.windowDays) || funnel.windowDays < 1 || funnel.windowDays > 3650)
      error(`${where}: windowDays должен быть целым числом от 1 до 3650.`)
    const steps = funnel?.steps
    if (!Array.isArray(steps) || steps.length < 2 || steps.length > 30 || new Set(steps).size !== steps.length)
      error(`${where}: нужны от 2 до 30 разных шагов steps в порядке пути клиента.`)
    const revenue = []
    for (const key of Array.isArray(steps) ? steps : []) {
      const event = eventByKey.get(key)
      if (!event) error(`${where}: событие ${key} не объявлено в specs/events.yaml.`)
      else {
        if (event.type !== 'customerEvent') error(`${where}: ${key} имеет type ${event.type}; его нельзя связывать с клиентской конверсией без подтверждённой идентичности.`)
        if (event.category === 'revenue') revenue.push(event)
      }
    }
    if (revenue.length && (!funnel.deduplicateBy || revenue.some(event =>
      !Object.hasOwn(event.payloadMapping || {}, funnel.deduplicateBy))))
      error(`${where}: для оплаты нужен deduplicateBy — одно поле заказа в payloadMapping каждого revenue-события.`)
  }
})

/** Модули действий, которые импортирует хук '@automations/actions' процесса. */
function registeredActionModules() {
  const mods = new Set()
  for (const [file, src] of codeSources) {
    if (!/accountHook\(\s*['"`]@automations\/actions['"`]/.test(src)) continue
    for (const m of src.matchAll(/from\s+['"`]([^'"`]+)['"`]/g)) {
      const spec = m[1]
      if (spec.startsWith('.')) mods.add(rel(root, join(dirname(file), spec)))
      else if (spec.startsWith('/')) mods.add(spec.slice(1))
    }
  }
  return mods
}

// A registry is read-only evidence from the target account, never a route guessed from a file name.
let registry = null, registryError = null
if (options.registry) {
  try {
    registry = JSON.parse(readFileSync(options.registry, 'utf8'))
    if (!Array.isArray(registry.actions) ||
        (registry.accountId !== undefined && registry.accountId !== map?.accountId))
      throw Error('нужен массив actions из реестра целевого аккаунта; если указан accountId, он должен совпадать с процессом')
  } catch (e) { registryError = e.message }
}
check('automations', 'Автоматизации: конфиг, шаги, ссылки на функции', ({ error, warn }) => {
  const registered = registeredActionModules()
  if (registryError) error(`Реестр: ${registryError}`)
  for (const a of automations) {
    const name = rel(root, a.file)
    if (a.parseError) {
      error(`${name}: не разбирается: ${a.parseError}`)
      continue
    }
    const c = a.config
    if (!c.title) error(`${name}: нет title`)
    if (c.defaultTimezone !== undefined) {
      try { new Intl.DateTimeFormat('ru', { timeZone: c.defaultTimezone }) }
      catch { error(`${name}: defaultTimezone должен быть действительным часовым поясом IANA, согласованным с владельцем`) }
    } else if ((c.steps || []).some(step => step?.delay?.type === 'waitForTime')) {
      error(`${name}: для ожидания по местному времени нужен согласованный defaultTimezone`)
    }
    if (!Array.isArray(c.eventUrls) || c.eventUrls.length === 0) error(`${name}: пустой eventUrls`)
    for (const url of c.eventUrls || []) {
      const found = eventFromUrl(url)
      if (!found) warn(`${name}: внешнее событие ${url} не проверяется`)
      else if (found.foreign) error(`${name}: ${url} — событие чужого воркспейса; события процесса — ${EVENT_URL_PREFIX.customerEvent}<ключ> или ${EVENT_URL_PREFIX.workspaceEvent}<ключ>`)
      else if (!found.event) error(`${name}: слушает ${url}, но события ${found.key} нет в specs/events.yaml`)
      else if (found.event.type !== found.type) error(`${name}: ${url} — у события ${found.key} type: ${found.event.type}, его URL — ${eventUrl(found.event)}`)
    }
    if (c.settings?.continueOnError === undefined) warn(`${name}: не задан settings.continueOnError`)
    const ids = new Set()
    for (const step of flattenSteps(c.steps)) {
      const where = `${name} шаг ${step?.id || '?'}`
      if (!step?.id) error(`${name}: у шага нет id`)
      else if (ids.has(step.id)) error(`${where}: id повторяется`)
      else ids.add(step.id)
      if (step?.thenBranch !== undefined || step?.elseBranch !== undefined)
        error(`${where}: thenBranch/elseBranch не поддерживаются; разделите сценарии на отдельные автоматизации`)
      if (!STEP_TYPES.includes(step?.type)) {
        error(`${where}: type «${step?.type}», допустимы ${STEP_TYPES.join(', ')}`)
        continue
      }
      if (step.type === 'draft') error(`${where}: шаг-черновик не реализован`)
      if (step.type === 'delay') {
        const d = step.delay || {}
        if (d.type === 'delay') {
          if (!(typeof d.amount === 'number' && d.amount >= 0)) error(`${where}: delay.amount — неотрицательное число`)
          if (!DELAY_UNITS.includes(d.units)) error(`${where}: delay.units — ${DELAY_UNITS.join(', ')}`)
        } else if (d.type === 'exactTime') {
          if (Number.isNaN(Date.parse(d.exactTime))) error(`${where}: exactTime — дата ISO`)
        } else if (d.type === 'waitForTime') {
          if (!Array.isArray(d.weekdays) || d.weekdays.some(w => !WEEKDAYS.includes(w))) error(`${where}: weekdays — дни недели по-английски`)
          if (!/^\d{1,2}:\d{2}$/.test(d.weekdayTime || '')) error(`${where}: weekdayTime — «10:00»`)
        } else if (d.type === 'dateExpression') {
          if (typeof d.dateExpression !== 'string' || !d.dateExpression.trim()) error(`${where}: пустой dateExpression`)
          else if (/\{\{|\}\}/.test(d.dateExpression)) error(`${where}: dateExpression должен быть JS-выражением, а не шаблоном {{ ... }}`)
          else warn(`${where}: dateExpression нужно проверить на реальных входных данных в тестовом прогоне; статическая проверка не исполняет JS`)
        } else error(`${where}: delay.type «${d.type}» неизвестен`)
      }
      const route = step.type === 'action' ? step.actionRoute : step.conditionRoute
      if (['action', 'condition', 'continueCondition'].includes(step.type)) {
        if (step.type === 'action' && !step.actionName) error(`${where}: нет actionName`)
        if (step.type !== 'action' && !step.conditionName) error(`${where}: нет conditionName`)
        const rj = route?.routeJson
        if (route?.routeType !== 'function' || !Array.isArray(rj) || rj.length !== 3) {
          error(`${where}: route — { routeType: "function", routeJson: [accountId, "модуль", "/"] }`)
          continue
        }
        const [accId, modulePath, fnPath] = rj
        if (!(Number.isInteger(accId) && accId > 0)) error(`${where}: routeJson[0] — числовой id аккаунта`)
        else if (Number.isInteger(map?.accountId) && accId !== map.accountId) {
          const entries = step.type === 'action' ? registry?.actions : registry?.conditions
          const entry = entries?.find(item => JSON.stringify(item.routeJson) === JSON.stringify(rj))
          if (!entry) error(`${where}: внешний маршрут не подтверждён — передайте --registry FILE с реестром целевого аккаунта`)
          else {
            for (const field of entry.inputSchema || [])
              if (field.required && !(field.name in (step.params || {}))) error(`${where}: нет обязательного параметра ${field.name} из реестра`)
          }
          continue
        }
        const mod = typeof modulePath === 'string' ? moduleFile(modulePath) : null
        if (!mod) error(`${where}: модуль ${modulePath} не найден (.ts/.tsx от корня аккаунта)`)
        else {
          const src = readFileSync(mod, 'utf8')
          const fnRe = new RegExp(`app\\s*\\.function\\(\\s*['"\`]${String(fnPath).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"\`]`)
          if (!fnRe.test(src)) error(`${where}: в ${rel(root, mod)} нет app.function('${fnPath}')`)
          const publishedAction = registry?.actions.some(entry => JSON.stringify(entry.routeJson) === JSON.stringify(rj))
          if (step.type === 'action' && !registered.has(String(modulePath).replace(/\.tsx?$/, '')) &&
              !(options['task-stage'] === 'launch' && publishedAction)) {
            const message = `${where}: действие ${modulePath} не зарегистрировано в хуке '@automations/actions' (actions/register.ts)`
            if (options['task-stage'] === 'launch') error(message)
            else warn(message)
          }
          if (step.type === 'action' && options['task-stage'] === 'launch' && !publishedAction)
            error(`${where}: локальное действие не подтверждено реестром опубликованного аккаунта — передайте --registry FILE`)
        }
      }
    }
  }
})

check('automations.refs', 'Параметры шагов ведут на существующие поля', ({ error, warn }) => {
  for (const a of automations) {
    if (!a.config) continue
    const name = rel(root, a.file)
    const listened = (a.config.eventUrls || [])
      .map(u => eventFromUrl(u)?.event)
      .filter(Boolean)
    const steps = flattenSteps(a.config.steps)
    const before = new Map() // id шага → модуль его функции
    for (const step of steps) {
      const params = step?.params && typeof step.params === 'object' ? step.params : {}
      for (const [k, v] of Object.entries(params)) {
        const where = `${name} шаг ${step.id}.${k}`
        const refs = refsOf(v)
        if (refs === null) {
          error(`${where}: вложенный объект — рантайм не разбирает $ref внутри; сделай параметры плоскими`)
          continue
        }
        for (const ref of refs) {
          const [head, ...rest] = ref.split('.')
          if (head === 'event') {
            const field = rest[0]
            if (!field) continue
            for (const ev of listened) {
              const mapping = ev.payloadMapping || {}
              if (Object.keys(mapping).length > 0 && !(field in mapping) && !EVENT_FIELD_NAMES.includes(field)) {
                error(`${where}: $ref event.${field} — нет в payloadMapping события ${ev.key}`)
              }
            }
          } else if (head === 'steps') {
            const [id, field] = rest
            if (!before.has(id)) {
              error(`${where}: $ref steps.${id} — нет шага-действия ${id} выше по списку`)
              continue
            }
            const mod = before.get(id)
            if (field && mod) {
              const src = readFileSync(mod, 'utf8')
              const resultBlock = /\.result\(([\s\S]*?)\)\s*\.handle\(/.exec(src)?.[1] || ''
              if (!new RegExp(`\\b${field}\\s*:`).test(resultBlock)) {
                warn(`${where}: поля ${field} не видно в .result(...) действия ${rel(root, mod)}`)
              }
            }
          } else if (!['user', 'customerContacts'].includes(head)) {
            error(`${where}: неизвестный корень ссылки «${head}» (есть event, steps, user, customerContacts)`)
          }
        }
      }
      if (step?.type === 'action') {
        const mp = step.actionRoute?.routeJson?.[1]
        before.set(step.id, typeof mp === 'string' ? moduleFile(mp) : null)
      }
    }
  }
})

check('letters', 'Письма шагов отправки и их переменные', ({ error, warn }) => {
  const sent = new Set()
  const manuallyInvoked = new Set()
  for (const node of nodes.filter(node => node.kind === 'series' && typeof node.creativeRef === 'string')) {
    let spec
    try { spec = loadYamlFile(safeTaskPath(root, node.creativeRef)) }
    catch { continue } // Creative checks report an unsafe or missing spec.
    const manual = spec.data?.deliveryMode === 'manual' &&
      ['caller', 'trigger', 'recipient', 'stop'].every(field => typeof spec.data.manualInvocation?.[field] === 'string' && spec.data.manualInvocation[field].trim())
    if (manual) for (const message of spec.data.messages || []) if (typeof message.path === 'string')
      manuallyInvoked.add(message.path)
  }
  for (const { automation, step } of sendSteps) {
    const where = `${rel(root, automation.file)} шаг ${step.id}`
    const route = step.actionRoute?.routeJson
    const localAction = (Number.isInteger(map?.accountId) || map?.accountId == null) && route?.[0] === map.accountId &&
      typeof route?.[1] === 'string' && moduleFile(route[1])
    let paths
    try { paths = templateFiles(root, step) }
    catch (e) { error(`${where}: ${e.message}`); continue }
    if (!paths.length) { error(`${where}: шаблон ${templatePath(step)} и его варианты не найдены`); continue }
    if (localAction) warn(`${where}: получателей и variables готовит локальное действие ${rel(root, localAction)}; проверьте их в ревью кода и тестовом вызове SDK — статическая проверка не подтверждает эти значения`)
    for (const letterPath of paths) {
      sent.add(letterPath)
      if (!letterPath.startsWith('.mailings/storage/')) error(`${where}: letterPath вне .mailings/storage/`)
      else if (!letterPath.startsWith(`${lettersRoot}/`)) warn(`${where}: письмо вне папки писем процесса ${lettersRoot}/`)
      const res = loadYamlFile(join(root, letterPath))
      if (res.missing) {
        error(`${where}: письма ${letterPath} нет`)
        continue
      }
      if (res.parseError) {
        error(`${where}: ${letterPath} не разбирается: ${res.parseError}`)
        continue
      }
      const letter = res.data || {}
      // Local actions can prepare SDK variables themselves; var_* is the shared action's contract.
      if (localAction) continue
      const declared = new Map((Array.isArray(letter.variables) ? letter.variables : []).map(v => [v?.name, v]))
      for (const [name, v] of declared) {
        if (!v?.required && v?.required !== undefined) continue
        if (!(`var_${name}` in step.params)) {
          error(`${where}: переменная {{${name}}} письма не передана — нужен параметр var_${name}`)
        }
      }
      for (const k of Object.keys(step.params)) {
        if (k.startsWith('var_') && !declared.has(k.slice(4))) warn(`${where}: ${k} передан, но в письме нет переменной ${k.slice(4)}`)
      }
    }
  }
  // Каждое письмо процесса разобрано и кем-то отправляется
  for (const f of walk(join(root, lettersRoot)).filter(f => f.endsWith('.message.yaml'))) {
    const p = rel(root, f)
    const res = loadYamlFile(f)
    if (res.parseError) {
      error(`${p}: не разбирается: ${res.parseError}`)
      continue
    }
    const letter = res.data || {}
    for (const field of LETTER_REQUIRED) {
      if (typeof letter[field] !== 'string' || !letter[field].trim()) error(`${p}: пустое или нет поле ${field}`)
    }
    if (typeof letter.short === 'string' && /(?:\.{3}|…)\s*$/.test(letter.short))
      warn(`${p}: короткая версия выглядит обрезанной (многоточие в конце); проверьте законченность мысли и ссылку`)
    for (const field of LETTER_FORBIDDEN) if (field in letter) error(`${p}: поля ${field} нет в схеме письма`)
    const used = letterVariables(letter)
    const declared = new Set((Array.isArray(letter.variables) ? letter.variables : []).map(v => v?.name))
    for (const name of used) {
      if (!/^[a-z][a-z0-9_]*$/.test(name)) error(`${p}: {{${name}}} — имя переменной латиницей в нижнем регистре, без фильтров`)
      else if (!declared.has(name)) error(`${p}: {{${name}}} используется, но не объявлена в variables`)
    }
    for (const v of Array.isArray(letter.variables) ? letter.variables : []) {
      if (!v?.name || !v?.description) error(`${p}: у переменной нет name или description`)
      else if (!used.has(v.name)) warn(`${p}: переменная ${v.name} объявлена, но не используется`)
    }
    if (!sent.has(p) && !manuallyInvoked.has(p)) error(`${p}: письмо не отправляет ни один шаг автоматизации и нет ручного контракта запуска`)
  }
})

check('letters.transport', 'Отправка через SDK Mailings', ({ error, warn }) => {
  if (sendSteps.some(({ step }) => 'letterPath' in step.params))
    warn('Есть прежние шаги letterPath: сохраните их до явного перехода на messageKey и SDK Mailings')
  for (const [file, src] of codeSources) {
    if (/readLetterFn|read-letter/.test(src)) warn(`${rel(root, file)}: прежний читатель писем; при переходе замените на readMessageFile из @mailings/sdk`)
  }
  if (!sendSteps.some(({ step }) => 'messageKey' in step.params)) return
  const ws = JSON.parse(readFileSync(join(dir, '.workspace.json'), 'utf8'))
  const policy = ws.config?.mailings
  if (!policy || typeof policy.testOnly !== 'boolean') return error('Нужен config.mailings.testOnly (boolean) в .workspace.json')
  if (!Array.isArray(policy.testContacts) || policy.testContacts.some(c => !c || typeof c.type !== 'string' || !c.type.trim() || typeof c.value !== 'string' || !c.value.trim()))
    error('config.mailings.testContacts должен содержать контакты {type, value}')
  else if (policy.testOnly && !policy.testContacts.length) warn('Тестовые контакты не заданы — SDK заблокирует отправки')
  if (!policy.testOnly) warn('config.mailings.testOnly = false — SDK разрешает боевые отправки')
})

check('sdk.writes', 'Нет записи файлов через SDK', ({ error }) => {
  const re = new RegExp(`\\b(${FILE_WRITE_APIS.join('|')})\\b`)
  for (const [file, src] of codeSources) {
    const m = re.exec(src)
    if (m) error(`${rel(root, file)}: ${m[1]} — запись файлов из кода процесса не работает, храни изменяемое в Heap`)
  }
})

check('tests', 'Реестр тестов tests/records.ts', ({ error, warn }) => {
  const f = join(dir, 'tests', 'records.ts')
  if (!isFile(f)) return error(`нет ${slug}/tests/records.ts`)
  const src = readFileSync(f, 'utf8')
  for (const name of ['TEST_RECORDS']) {
    if (!new RegExp(`export const ${name}\\b`).test(src)) error(`нет export const ${name}`)
  }
  if (!/export const TEST_ONLY\b/.test(src)) return
  const testOnly = /export const TEST_ONLY\s*=\s*true/.test(src)
  const contactsBlock = /export const TEST_CONTACTS[^=]*=\s*\[([\s\S]*?)\]\s*(?:\n|$)/.exec(src)?.[1] || ''
  if (testOnly && !/value:\s*['"`][^'"`]+['"`]/.test(contactsBlock)) {
    warn('TEST_ONLY = true, но TEST_CONTACTS пуст — письма не уйдут никому')
  }
  if (!testOnly) warn('TEST_ONLY = false — процесс шлёт реальным людям')
})

check('plan', 'План PLAN.md', ({ error, warn }) => {
  const f = join(dir, 'PLAN.md')
  if (!isFile(f)) return error(`нет ${slug}/PLAN.md`)
  const src = readFileSync(f, 'utf8')
  for (const h of ['## Задачи', '## Согласования']) if (!src.includes(h)) error(`нет раздела «${h.slice(3)}»`)
  const tasks = [...src.matchAll(/^- \[( |x|X)\] T\d+\s+(.*)$/gm)].filter(m => m[2].trim() !== '…')
  if (tasks.length === 0) error('нет задач вида «- [ ] T1 …»')
  const open = tasks.filter(m => m[1] === ' ').length
  if (open > 0) warn(`открытых задач: ${open} из ${tasks.length}`)
})

check('tasks', `Рабочие задачи (${options['task-stage'] || 'build'})`, ({ error, warn }) => {
  const report = getWorkReport()
  if (!report.enabled) return warn('Формат рабочих карточек не включён; существующий процесс требует явной миграции.')
  for (const issue of report.errors) error(issue)
  for (const issue of report.warnings) warn(issue)
})

check('creative', 'Задания страниц и серий', ({ error, warn }) => {
  const work = getWorkReport()
  if (!work.enabled || !map?.nodes) return
  const future = (options['task-stage'] || 'build') === 'design'
  for (const node of map.nodes.filter(n => ['page', 'series'].includes(n.kind))) {
    const result = creativeStatus({ root, slug, nodeId: node.id })
    for (const issue of result.errors) (future ? warn : error)(`${node.id}: ${issue}`)
  }
})

check('creative.review', 'Независимое ревью страниц и серий', ({ error, warn }) => {
  const work = getWorkReport()
  if (!work.enabled || !map?.nodes) return
  const taskStage = options['task-stage'] || 'build'
  for (const node of map.nodes.filter(n => ['page', 'series'].includes(n.kind))) {
    for (const stage of taskStage === 'design' ? [] : taskStage === 'build' ? ['spec'] : ['spec', 'result']) {
      const result = creativeReviewStatus({ root, slug, nodeId: node.id, stage })
      if (result.status !== 'ready') error(`${node.id}/${stage}: ${result.error || result.blocking?.map(a => a.reason).join('; ') || result.status}`)
      for (const gap of result.advisory || []) warn(`${node.id}/${stage}: ${gap.reason}`)
    }
  }
})

// Structural checks never stand in for an independent assessment of meaning.
try { checks.push(...collectKnowledge({ root, slug }).checks) }
catch (e) { check('kb-scope', 'Материалы процесса', ({ error }) => error(e.message)) }
const knowledgeStage = options['knowledge-stage'] ||
  (options['task-stage'] === 'design' ? 'design' :
    isFile(join(dir, 'PLAN.md')) && /^- Запуск: согласован/m.test(readFileSync(join(dir, 'PLAN.md'), 'utf8')) ? 'launch' : 'build')
check('knowledge.review', `Независимое ревью знаний (${knowledgeStage})`, ({ error, warn }) => {
  const result = reviewStatus({ root, slug, stage: knowledgeStage })
  if (result.error) error(result.error)
  for (const gap of result.blocking || []) error(`${gap.id}: ${gap.reason} → ${gap.nextAction}`)
  for (const gap of result.advisory || []) warn(`${gap.id}: ${gap.reason} → ${gap.nextAction}`)
  if (result.status !== 'ready' && !result.error && !result.blocking?.length)
    error('Готовность не подтверждена: исправьте структурные ошибки базы знаний.')
})

if ((options['task-stage'] || 'build') !== 'design') check('implementation.review', 'Независимое ревью реализации', ({ error, warn }) => {
  const result = codeReviewStatus({ root, slug })
  if (result.error) error(result.error)
  for (const gap of result.blocking || []) error(`${gap.id}: ${gap.reason} → ${gap.nextAction}`)
  for (const gap of result.advisory || []) warn(`${gap.id}: ${gap.reason} → ${gap.nextAction}`)
  for (const issue of result.structuralErrors || []) error(issue)
})

check('reviews', 'Обязательные заключения комиссии', ({ error }) => {
  const result = commissionStatus({ root, slug, stage: options['task-stage'] || 'build' })
  for (const item of result.requirements) if (item.status !== 'ready')
    error(`${item.id}: ${item.status}${item.error ? ` — ${item.error}` : ''}`)
})

if ((options['task-stage'] || 'build') !== 'design') check('owner.plan', 'Согласование плана владельцем', ({ error }) => {
  const decision = ownerDecisionStatus({ root, slug, kind: 'plan' })
  if (decision.status !== 'ready') error(decision.error || decision.status)
})
if (options['task-stage'] === 'launch') check('owner.launch', 'Согласование запуска владельцем', ({ error }) => {
  const decision = ownerDecisionStatus({ root, slug, kind: 'launch' })
  if (decision.status !== 'ready') error(decision.error || decision.status)
})
if (options['task-stage'] === 'launch') check('automation.smoke', 'Полный безопасный прогон автоматизаций', ({ error }) => {
  for (const issue of automationSmokeStatus({ root, slug, automationFiles: automations.map(item => item.file) }).errors) error(issue)
})

check('skill.clean', 'В скилле нет кода и файлов воркспейса', ({ error }) => {
  const skillRoot = dirname(dirname(dirname(SKILL_DIR))) // <аккаунт>/.agents/skills/<скилл>
  for (const f of walk(SKILL_DIR)) {
    if (SKILL_FORBIDDEN.some(re => re.test(f))) {
      error(`${rel(skillRoot, f)}: такой файл в скилле подхватит сборка аккаунта — держи его как *.tpl`)
    }
  }
})

if (options.typecheck) {
  check('typecheck', 'chatium typecheck', ({ error }) => {
    const r = spawnSync('chatium', ['typecheck'], { cwd: root, encoding: 'utf8' })
    if (r.error) return error(`не удалось запустить chatium: ${r.error.message}`)
    if (r.status !== 0) {
      const lines = `${r.stdout}\n${r.stderr}`.split('\n').filter(l => l.trim()).slice(-20)
      error(`typecheck упал (код ${r.status}):\n      ${lines.join('\n      ')}`)
    }
  })
}

// Snapshot failure is separate from validation. Never print a successful refresh
// after a failed write; offline checks remain explicitly available.
let snapshotResult = { saved: false, skipped: Boolean(options['no-snapshot']) }
try {
  if (!options['no-snapshot'] || options['snapshot-file']) {
    const snapshot = prepareSnapshot({ root, slug, map, checks, ...(sourceState ? { state: sourceState } : {}) })
    if (options['snapshot-file']) writeFileSync(options['snapshot-file'], JSON.stringify(snapshot, null, 2) + '\n')
    if (!options['publish-snapshot']) {
      snapshotResult = { saved: false, ...await verifySnapshot(root, snapshot) }
      if (sourceError) {
        if (snapshotResult.verified) throw sourceError
        snapshotResult.localError = sourceError.message
      }
    } else {
      if (sourceError) throw sourceError
      snapshotResult = await publishSnapshot(root, snapshot)
      snapshotResult = { ...snapshotResult, ...await verifySnapshot(root, snapshot,
        { expectedRevision: snapshotResult.revision }) }
    }
  }
} catch (e) {
  snapshotResult = { ...snapshotResult, verified: false, status: e instanceof SnapshotDrift ? 'stale' : 'unavailable', error: e.message }
}
if (options['task-stage'] === 'launch') check('owner.launch.board', 'Согласование текущей доски владельцем', ({ error }) => {
  if (!snapshotResult.verified) return error('Нельзя подтвердить показанную владельцу доску без актуального снимка.')
  const decision = ownerDecisionStatus({ root, slug, kind: 'launch', currentBoardRevision: snapshotResult.boardRevision })
  if (decision.status !== 'ready') error(decision.error || decision.status)
})

// ---------- вывод ----------

const passed = checks.filter(c => c.ok).length
const total = checks.length
const warnCount = checks.reduce((s, c) => s + c.warnings.length, 0)

if (options.json) {
  const { elements, ...snapshotSummary } = snapshotResult
  console.log(JSON.stringify({ process: slug, root, passed, total, checks, snapshot: snapshotSummary }, null, 2))
} else {
  console.log(`check ${slug}`)
  for (const c of checks) {
    console.log(`${c.ok ? '✔' : '✘'} ${c.id} — ${c.title}`)
    for (const e of c.errors) console.log(`    ✘ ${e}`)
    for (const w of c.warnings) console.log(`    ! ${w}`)
  }
  console.log('')
  console.log(`Итог: ${passed}/${total} проверок зелёные${warnCount ? `, предупреждений: ${warnCount}` : ''}.`)
}
if (!options.json) {
  if (snapshotResult.saved) console.log(`Снимок сохранён, ревизия ${snapshotResult.revision}.`)
  console.log(snapshotResult.verified
    ? `Карта актуальна: ${snapshotResult.branch} @ ${snapshotResult.commit}; снимок ${snapshotResult.revision}, доска ${snapshotResult.boardRevision}.`
    : snapshotResult.error || 'Актуальность карты не проверялась (--no-snapshot).')
}
process.exitCode = passed !== total || snapshotResult.status === 'stale' ? 1 : snapshotResult.error ? 2 : 0
