import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isProcessSlug, rel } from './project.mjs'
import { parseYaml } from './yaml.mjs'

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return result.status === 0 ? result.stdout.trim() : null
}
const identity = node => `${node.id}\0${node.kind}\0${node.source}`
const lifecycleKey = node => node.kind === 'table' ? identity(node) : `${node.id}\0${node.kind}`

/** Git history is only a detection aid; a shallow clone cannot prove absence. */
export function historicalComponents(root, slug, { commits, show } = {}) {
  if (!isProcessSlug(slug)) throw Error('Некорректный процесс.')
  const path = `${slug}/process.yaml`
  const revisions = commits || git(root, ['log', '--format=%H', '--max-count=100', '--', path])?.split('\n').filter(Boolean)
  if (!revisions) return { available: false, nodes: [] }
  const seen = new Map()
  for (const revision of revisions) {
    const body = show ? show(revision, path) : git(root, ['show', `${revision}:${path}`])
    if (!body) continue
    let map
    try { map = parseYaml(body) } catch { continue }
    for (const node of Array.isArray(map?.nodes) ? map.nodes : [])
      if (typeof node?.id === 'string' && typeof node?.kind === 'string' &&
          typeof node?.source === 'string' && !seen.has(lifecycleKey(node)))
        seen.set(lifecycleKey(node), { id: node.id, kind: node.kind, source: node.source })
  }
  return { available: true, nodes: [...seen.values()] }
}

export function retirementStatus({ root, slug, map, automationFiles = [], history = historicalComponents(root, slug) }) {
  const errors = [], current = Array.isArray(map?.nodes) ? map.nodes : []
  const currentIds = new Set(current.map(lifecycleKey))
  const removed = history.nodes.filter(node => !currentIds.has(lifecycleKey(node)))
  if (!history.available) return { status: 'unverified', errors: ['История карты недоступна: вывод компонентов нельзя подтвердить.'], removed }
  if (!removed.length) return { status: 'ready', errors, removed }
  const path = join(root, slug, 'retirements.json')
  if (!existsSync(path)) return { status: 'missing', errors: [`Нет ${rel(root, path)} для выведенных компонентов: ${removed.map(n => n.id).join(', ')}.`], removed }
  if (lstatSync(path).isSymbolicLink() || lstatSync(path).size > 64 * 1024)
    return { status: 'invalid', errors: ['retirements.json должен быть обычным JSON-файлом до 64 KB.'], removed }
  let ledger
  try { ledger = JSON.parse(readFileSync(path, 'utf8')) }
  catch { return { status: 'invalid', errors: ['retirements.json не разбирается как JSON.'], removed } }
  if (ledger?.version !== 1 || !Array.isArray(ledger.components) || ledger.components.length > 150)
    return { status: 'invalid', errors: ['retirements.json: нужны version: 1 и components (до 150).'], removed }
  const records = new Map()
  for (const record of ledger.components) {
    if (!record || typeof record.id !== 'string' || typeof record.kind !== 'string' ||
        typeof record.source !== 'string' || records.has(identity(record)))
      errors.push('В retirements.json повторяется или отсутствует ID, вид либо источник.')
    else records.set(identity(record), record)
  }
  for (const node of removed) {
    const record = records.get(identity(node))
    if (!record) { errors.push(`${node.id} (${node.source}): нет решения о выводе компонента.`); continue }
    if (record.kind !== node.kind || record.source !== node.source ||
        typeof record.reason !== 'string' || !record.reason.trim() ||
        typeof record.ownerResponse !== 'string' || !record.ownerResponse.trim() ||
        typeof record.ownerMessageReference !== 'string' || !record.ownerMessageReference.trim() ||
        !Number.isFinite(Date.parse(record.decidedAt)) ||
        !(record.replacement === null || typeof record.replacement === 'string'))
      errors.push(`${node.id}: неполная запись о причинах, замене и решении владельца.`)
    if (!current.some(active => active.id === node.id) &&
        (map.links || []).some(link => link.from === node.id || link.to === node.id))
      errors.push(`${node.id}: на выведенный компонент осталась живая связь карты.`)
    const source = resolve(root, node.source)
    if (!source.startsWith(resolve(root) + sep)) errors.push(`${node.id}: исходный путь небезопасен.`)
    else if (existsSync(source) && !current.some(active => active.id === record.replacement && active.source === node.source))
      errors.push(`${node.id}: исходники ${node.source} ещё присутствуют без явной замены.`)
    for (const file of automationFiles) if (readFileSync(file, 'utf8').includes(node.source))
      errors.push(`${node.id}: автоматизация ${rel(root, file)} ещё ссылается на прежний источник.`)
  }
  const removedIds = new Set(removed.map(identity))
  for (const [key, record] of records) if (!removedIds.has(key))
    errors.push(`${record.id} (${record.source}): запись о выводе не соответствует удалённому узлу истории.`)
  return { status: errors.length ? 'invalid' : 'ready', errors, removed, path }
}
