import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rel } from './project.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')
const commit = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
function gitFile(root, revision, path) {
  const result = spawnSync('git', ['show', '--no-ext-diff', `${revision}:${path}`],
    { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } })
  return result.status === 0 ? result.stdout : null
}

/** Evidence of an actual main-branch test while Mailings was still restricted. */
export function automationSmokeStatus({ root, slug, automationFiles,
  readAtCommit = (revision, path) => gitFile(root, revision, path), ancestor = (tested, current) => {
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
    const testedCommitValid = run.branch === 'main' && commit(run.testedCommit) && ancestor(run.testedCommit, 'HEAD')
    if (!testedCommitValid)
      errors.push(`${relative}: прогон не привязан к предшествующему коммиту main.`)
    else {
      const testedConfig = readAtCommit(run.testedCommit, relative)
      if (!testedConfig || sha256(testedConfig) !== run.configSha256)
        errors.push(`${relative}: конфиг отсутствовал в исполненной версии или изменился после неё.`)
      const testedWorkspace = readAtCommit(run.testedCommit, `${slug}/.workspace.json`)
      let testOnly = false
      try { testOnly = JSON.parse(testedWorkspace?.toString('utf8') || '').config?.mailings?.testOnly === true }
      catch { /* Missing or malformed settings cannot prove a safe run. */ }
      if (!testOnly) errors.push(`${relative}: в исполненной версии main не подтверждён config.mailings.testOnly: true.`)
    }
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
