import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rel } from './project.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')
const commit = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)

/** Evidence of an actual main-branch test while Mailings was still restricted. */
export function automationSmokeStatus({ root, slug, automationFiles, ancestor = (tested, current) => {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', tested, current],
    { cwd: root, timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return result.status === 0
} }) {
  if (!automationFiles.length) return { status: 'ready', errors: [] }
  const file = join(root, slug, 'tests/automation-smoke.json')
  if (!existsSync(file)) return { status: 'missing', errors: ['Нет реестра полного тестового прогона автоматизаций.'] }
  if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 64 * 1024)
    return { status: 'invalid', errors: ['Реестр тестового прогона должен быть обычным JSON-файлом до 64 KB.'] }
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) }
  catch { return { status: 'invalid', errors: ['Реестр тестового прогона не разбирается как JSON.'] } }
  const errors = []
  if (data?.version !== 1 || !Array.isArray(data.runs) || data.runs.length > 100)
    return { status: 'invalid', errors: ['Нужны version: 1 и runs (не более 100).'] }
  const byPath = new Map()
  for (const run of data.runs) {
    if (typeof run?.path !== 'string' || byPath.has(run.path)) errors.push('В runs нужны уникальные пути автоматизаций.')
    else byPath.set(run.path, run)
  }
  for (const path of automationFiles) {
    const relative = rel(root, path), run = byPath.get(relative)
    if (!run) { errors.push(`${relative}: нет полного тестового прогона.`); continue }
    if (run.configSha256 !== sha256(readFileSync(path)) || run.result !== 'passed')
      errors.push(`${relative}: конфиг изменился после прогона или результат неуспешен.`)
    if (run.branch !== 'main' || !commit(run.testedCommit) || !ancestor(run.testedCommit, 'HEAD'))
      errors.push(`${relative}: прогон не привязан к предшествующему коммиту main.`)
    if (run.testOnly !== true || typeof run.executionId !== 'string' || !run.executionId.trim() ||
      !Number.isFinite(Date.parse(run.testedAt)) ||
      typeof run.testContact?.type !== 'string' || !run.testContact.type.trim() ||
      typeof run.testContact?.value !== 'string' || !run.testContact.value.trim())
      errors.push(`${relative}: не указаны безопасный контакт, время и ID исполнения.`)
  }
  for (const path of byPath.keys()) if (!automationFiles.some(file => rel(root, file) === path))
    errors.push(`${path}: запись не относится к текущим автоматизациям процесса.`)
  return { status: errors.length ? 'invalid' : 'ready', errors, path: file }
}
