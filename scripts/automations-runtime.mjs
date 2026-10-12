#!/usr/bin/env node
// Read-only check of every published automation subscription in one CLI call.
import { spawnSync } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import { findRoot, parseArgs, rel, walk } from './lib/project.mjs'
import { assertSkillProcess } from './lib/process-format.mjs'
import { parseYaml, requireYaml } from './lib/yaml.mjs'
import { assessAutomationState } from './lib/automation-state.mjs'

let parsed
try { parsed = parseArgs(process.argv.slice(2), ['help', 'json'], ['help', 'json', 'root', 'expect']) }
catch (error) { console.error(error.message); process.exit(2) }
const { positional, options } = parsed
if (options.help) {
  console.log('automations-runtime.mjs <process> --expect disabled|enabled [--root DIR] [--json]')
  process.exit(0)
}
if (positional.length !== 1 || !['disabled', 'enabled'].includes(options.expect)) {
  console.error('Укажи один процесс и --expect disabled|enabled.')
  process.exit(2)
}

function run(command, args, root, input, timeout = 5000) {
  const result = spawnSync(command, args, { cwd: root, input, encoding: 'utf8', timeout,
    maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } })
  if (result.error || result.status !== 0)
    throw Error(`${command}: ${result.error?.message || result.stderr.trim() || `код ${result.status}`}`)
  return result
}

try {
  requireYaml()
  const root = findRoot(options.root), slug = positional[0]
  assertSkillProcess(root, slug)
  const map = parseYaml(readFileSync(join(root, slug, 'process.yaml'), 'utf8'))
  const accountRoot = realpathSync(root)
  const files = walk(join(root, slug)).filter(file => file.endsWith('.automationConfig.json')).sort()
  if (files.length > 100) throw Error('Для одной проверки допускается не более 100 автоматизаций.')
  const paths = files.map(file => {
    if (lstatSync(file).isSymbolicLink() || !realpathSync(file).startsWith(accountRoot + sep))
      throw Error('Файл автоматизации выходит за пределы аккаунта.')
    return rel(root, file)
  })
  const branch = run('git', ['symbolic-ref', '--short', 'HEAD'], root).stdout.trim()
  if (branch !== 'main') throw Error('Состояние подписок проверяется только для опубликованного main.')
  const commit = run('git', ['rev-parse', 'HEAD'], root).stdout.trim()
  if (run('git', ['status', '--porcelain=v1', '--', slug], root).stdout.trim())
    throw Error('В процессе есть неопубликованные локальные изменения.')
  const code = `import { getAutomationByPath } from '@automations/sdk'\n` +
    `const paths = ${JSON.stringify(paths)}\n` +
    `const rows = []\nfor (const path of paths) { try { rows.push({ path, value: await getAutomationByPath(ctx, path, 'main') }) } catch (error) { rows.push({ path, error: String(error?.message || error) }) } }\n` +
    `return { accountId: ctx.account.id, rows }\n`
  const execution = run('chatium', ['exec'], root, code, 60_000)
  const published = JSON.parse(execution.stdout)
  const errors = assessAutomationState(paths, published.rows, options.expect)
  const executedCommit = execution.stderr.match(/Executed commit: ([0-9a-f]{40})/)?.[1]
  if (executedCommit !== commit) errors.push(`Исполнен коммит ${executedCommit || 'неизвестен'}, локальный HEAD ${commit}.`)
  if (!Number.isInteger(map.accountId) || map.accountId !== published.accountId)
    errors.push(`Аккаунт ${published.accountId} не совпадает с process.yaml (${map.accountId ?? 'нет ID'}).`)
  const report = { status: errors.length ? 'needs-work' : 'verified', process: slug,
    expected: options.expect, commit, accountId: published.accountId, checkedAt: new Date().toISOString(),
    automations: published.rows, errors }
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`Автоматизации ${slug}: ${report.status}; ${paths.length} конфигов.`)
    for (const error of errors) console.log(`✘ ${error}`)
  }
  process.exitCode = errors.length ? 1 : 0
} catch (error) {
  if (options.json) console.log(JSON.stringify({ status: 'unavailable', error: error.message }))
  else console.error(error.message)
  process.exitCode = 2
}
