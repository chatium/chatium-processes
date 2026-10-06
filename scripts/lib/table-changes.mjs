import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { isProcessSlug, rel } from './project.mjs'

const sha = body => createHash('sha256').update(body).digest('hex')
const text = value => typeof value === 'string' && value.trim().length > 0
function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000,
    maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return result.status === 0 ? result.stdout : null
}

/** Conservative source-change gate; the reviewer must still assess schema semantics and real occupancy. */
export function tableChangeStatus({ root, slug, stage = 'build' }) {
  if (!isProcessSlug(slug)) throw Error('Некорректный процесс.')
  const changed = [], errors = []
  const files = []
  let entries = 0
  function visit(path) {
    if (++entries > 5000) throw Error('Слишком много файлов при поиске схем таблиц.')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) { errors.push(`${rel(root, path)}: ссылка в дереве таблиц не проверяется.`); return }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) if (!['node_modules', '.git', 'reviews', 'tasks'].includes(name))
        visit(join(path, name))
    } else if (stat.isFile() && path.endsWith('.table.ts')) files.push(path)
  }
  if (existsSync(join(root, slug))) visit(join(root, slug))
  for (const file of files) {
    const path = rel(root, file), current = readFileSync(file, 'utf8'), currentSha256 = sha(current)
    const revisions = git(root, ['log', '--format=%H', '--max-count=2', '--', path])?.split('\n').filter(Boolean)
    if (!revisions) { errors.push(`${path}: история Git недоступна; сравнение схемы не подтверждено.`); continue }
    const latest = revisions[0] ? git(root, ['show', `${revisions[0]}:${path}`]) : null
    const prior = revisions[1] ? git(root, ['show', `${revisions[1]}:${path}`]) : null
    const previous = latest === current ? prior : latest
    if (previous !== null && previous !== current)
      changed.push({ path, currentSha256, previousSha256: sha(previous) })
  }
  if (!changed.length) return { status: errors.length ? 'unverified' : 'ready', changed, errors }
  const path = join(root, slug, 'tables/schema-decisions.json')
  if (!existsSync(path)) return { status: 'missing', changed,
    errors: [...errors, `Нет ${rel(root, path)} для изменённых таблиц: ${changed.map(item => item.path).join(', ')}.`] }
  if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 64 * 1024)
    return { status: 'invalid', changed, errors: [...errors, 'Реестр изменений таблиц должен быть обычным JSON до 64 KB.'] }
  let registry
  try { registry = JSON.parse(readFileSync(path, 'utf8')) }
  catch { return { status: 'invalid', changed, errors: [...errors, 'Реестр изменений таблиц не разбирается.'] } }
  if (registry?.version !== 1 || !Array.isArray(registry.changes) || registry.changes.length > 100)
    return { status: 'invalid', changed, errors: [...errors, 'Нужны version: 1 и changes (до 100).'] }
  const records = new Map()
  for (const record of registry.changes)
    if (!text(record?.path) || records.has(record.path)) errors.push('В changes повторяется или отсутствует путь таблицы.')
    else records.set(record.path, record)
  for (const item of changed) {
    const record = records.get(item.path)
    if (!record) { errors.push(`${item.path}: нет проверки изменения схемы.`); continue }
    if (record.currentSha256 !== item.currentSha256 || record.previousSha256 !== item.previousSha256)
      errors.push(`${item.path}: решение относится к другой версии таблицы.`)
    if (!['empty', 'populated', 'unknown'].includes(record.occupancy) ||
        !text(record.rowCheckReference) || !Number.isFinite(Date.parse(record.rowsCheckedAt)))
      errors.push(`${item.path}: нет проверки фактических строк через Chatium.`)
    if (!['additive-or-metadata', 'confirmation', 'migration'].includes(record.changeClass) || !text(record.reason))
      errors.push(`${item.path}: нужна классификация изменения и её обоснование.`)
    if (record.occupancy !== 'empty' && ['confirmation', 'migration'].includes(record.changeClass) &&
        (!text(record.ownerResponse) || !text(record.ownerMessageReference)))
      errors.push(`${item.path}: нужно решение владельца для заполненной таблицы.`)
    if (record.changeClass === 'migration' && !text(record.migrationPlan))
      errors.push(`${item.path}: нужен план миграции, а не прямая смена типа или ссылок.`)
    if (stage === 'launch' && (!text(record.persistedSchemaReference) ||
        record.changeClass === 'migration' && !text(record.migrationResultReference)))
      errors.push(`${item.path}: перед запуском перечитай сохранённую схему и результат миграции.`)
  }
  return { status: errors.length ? 'invalid' : 'ready', changed, errors, path }
}
