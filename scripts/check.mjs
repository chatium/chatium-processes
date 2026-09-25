#!/usr/bin/env node
// Сверка процесса: карта ↔ код, события, автоматизации, письма, переменные.
// Итог честный — N/M проверок.
//
//   node .agents/skills/processes/scripts/check.mjs <process> [--json] [--typecheck] [--root DIR]
//
// Коды выхода: 0 — всё зелёное, 1 — есть провалы, 2 — не удалось запустить.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { findRoot, isDir, isFile, parseArgs, rel, SKILL_DIR, walk } from './lib/project.mjs'
import { parseYaml, requireYaml } from './lib/yaml.mjs'

const NODE_KINDS = ['page', 'table', 'series', 'payment', 'crm', 'external']
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
const STEP_TYPES = ['action', 'delay', 'continueCondition', 'condition', 'draft']
const DELAY_UNITS = ['seconds', 'minutes', 'hours', 'days']
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const LETTER_REQUIRED = ['title', 'description', 'subject', 'plain', 'html']
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

const { positional, options } = parseArgs(process.argv.slice(2), ['json', 'typecheck', 'help'])
const slug = positional[0]
if (options.help || !slug) {
  console.log('Использование: check.mjs <process> [--json] [--typecheck] [--root DIR]')
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
if (!isDir(dir)) {
  console.error(`Нет папки процесса ${slug}/ в ${root}`)
  process.exit(2)
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
    if (step?.type === 'action' && step.params && typeof step.params.letterPath === 'string') {
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
  const vars = ws.config?.variables
  if (vars !== undefined && (typeof vars !== 'object' || Array.isArray(vars))) {
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
    for (const m of src.matchAll(/variables\??\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
      if (!vars || !(m[1] in vars)) error(`${rel(root, file)}: переменная процесса ${m[1]} не объявлена в config.variables`)
    }
  }
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

check('map.sources', 'Узлы карты построены', ({ error }) => {
  for (const n of nodes) {
    if (!n?.source) continue
    const src = norm(n.source)
    const abs = join(root, src)
    if (!existsSync(abs)) {
      error(`${n.id}: не построено — нет ${src}`)
      continue
    }
    if (n.kind === 'page' && !(isFile(join(abs, 'index.tsx')) || (isFile(abs) && abs.endsWith('.tsx')))) {
      error(`${n.id}: в ${src} нет index.tsx`)
    }
    if (n.kind === 'table' && !src.endsWith('.table.ts')) error(`${n.id}: source таблицы — файл *.table.ts`)
    if (n.kind === 'series' && walk(abs).filter(f => f.endsWith('.message.yaml')).length === 0) {
      error(`${n.id}: в ${src} нет ни одного *.message.yaml`)
    }
  }
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

check('events.registry', 'Реестр событий specs/events.yaml', ({ error }) => {
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
      if (m?.fieldName && !m.fieldExpr && !/_(mapstrstr|arrstr|uint32arr)$|^action_params$|^customer_contacts$/.test(m.fieldName)) {
        if (slots.has(m.fieldName)) error(`${where}: слот ${m.fieldName} занят полями ${slots.get(m.fieldName)} и ${k}`)
        else slots.set(m.fieldName, k)
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

check('automations', 'Автоматизации: конфиг, шаги, ссылки на функции', ({ error, warn }) => {
  const registered = registeredActionModules()
  for (const a of automations) {
    const name = rel(root, a.file)
    if (a.parseError) {
      error(`${name}: не разбирается: ${a.parseError}`)
      continue
    }
    const c = a.config
    if (!c.title) error(`${name}: нет title`)
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
          if (!d.dateExpression) error(`${where}: пустой dateExpression`)
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
          error(`${where}: routeJson[0] = ${accId}, а accountId карты = ${map.accountId}`)
        }
        const mod = typeof modulePath === 'string' ? moduleFile(modulePath) : null
        if (!mod) error(`${where}: модуль ${modulePath} не найден (.ts/.tsx от корня аккаунта)`)
        else {
          const src = readFileSync(mod, 'utf8')
          const fnRe = new RegExp(`app\\s*\\.function\\(\\s*['"\`]${String(fnPath).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"\`]`)
          if (!fnRe.test(src)) error(`${where}: в ${rel(root, mod)} нет app.function('${fnPath}')`)
          if (step.type === 'action' && !registered.has(String(modulePath).replace(/\.tsx?$/, ''))) {
            warn(`${where}: действие ${modulePath} не зарегистрировано в хуке '@automations/actions' (actions/register.ts)`)
          }
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
  for (const { automation, step } of sendSteps) {
    const where = `${rel(root, automation.file)} шаг ${step.id}`
    const letterPath = norm(step.params.letterPath)
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
    if (!sent.has(p)) error(`${p}: письмо не отправляет ни один шаг автоматизации`)
  }
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
  for (const name of ['TEST_ONLY', 'TEST_CONTACTS', 'TEST_RECORDS']) {
    if (!new RegExp(`export const ${name}\\b`).test(src)) error(`нет export const ${name}`)
  }
  const testOnly = /export const TEST_ONLY\s*=\s*true/.test(src)
  if (testOnly && !/value:\s*['"`][^'"`]+['"`]/.test(src.split('TEST_CONTACTS')[1]?.split('TEST_RECORDS')[0] || '')) {
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

check('knowledge', 'Раздел процесса в базе знаний', ({ error, warn }) => {
  const kb = norm(map?.knowledge || `.knowledge-base/processes/${slug}`)
  const abs = join(root, kb)
  if (!isDir(abs)) return error(`нет раздела ${kb}/`)
  const metaRes = loadYamlFile(join(abs, '.knowledge.yml'))
  if (metaRes.missing) error(`нет ${kb}/.knowledge.yml`)
  if (metaRes.parseError) error(`${kb}/.knowledge.yml не разбирается: ${metaRes.parseError}`)
  const order = Array.isArray(metaRes.data?.order) ? metaRes.data.order : []
  const articles = walk(abs).filter(f => f.endsWith('.md') && dirname(f) === abs)
  if (articles.length === 0) error(`в ${kb}/ нет статей`)
  for (const a of articles) {
    const src = readFileSync(a, 'utf8')
    const fm = /^---\n([\s\S]*?)\n---/.exec(src)
    let title = null
    try {
      title = fm ? parseYaml(fm[1])?.title : null
    } catch {}
    const name = a.slice(abs.length + 1)
    if (!title) error(`${kb}/${name}: нет title во frontmatter`)
    if (/^\s*[-*]?\s*…\s*$/m.test(src)) warn(`${kb}/${name}: остались заглушки «…»`)
    if (!order.includes(name)) warn(`${kb}/${name}: нет в order у .knowledge.yml`)
  }
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

// ---------- вывод ----------

const passed = checks.filter(c => c.ok).length
const total = checks.length
const warnCount = checks.reduce((s, c) => s + c.warnings.length, 0)

if (options.json) {
  console.log(JSON.stringify({ process: slug, root, passed, total, checks }, null, 2))
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
process.exit(passed === total ? 0 : 1)
