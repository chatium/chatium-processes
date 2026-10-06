// Run against a pinned copy of the adjacent documentation skill. No personal
// sibling checkout is required, and CI exercises the same contract locally.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = dirname(fileURLToPath(import.meta.url))
const repo = resolve(testsDir, '../..')
const referenceCommit = 'aae5e1f2acc6568998462418735b97bececacf69'
const referenceRepository = 'https://github.com/chatium/chatium-agent-skills.git'
let temporary

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: 'inherit', timeout: 180_000 })
  if (result.error || result.status !== 0) throw Error(`${command} ${args[0]} завершился с кодом ${result.status}: ${result.error?.message || ''}`)
}

try {
  let developmentSkill = process.env.PROCESSES_TEST_DEVELOPMENT_SKILL
  if (!developmentSkill) {
    temporary = mkdtempSync(join(tmpdir(), 'processes-test-reference-'))
    run('git', ['init', '-q'], temporary)
    run('git', ['remote', 'add', 'origin', referenceRepository], temporary)
    run('git', ['fetch', '--quiet', '--depth=1', 'origin', referenceCommit], temporary)
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], temporary)
    developmentSkill = join(temporary, 'skills/chatium-development')
  }
  const tests = readdirSync(testsDir).filter(name => name.endsWith('.test.mjs')).sort()
  const result = spawnSync(process.execPath, ['--test', ...tests.map(name => join(testsDir, name))],
    { cwd: repo, env: { ...process.env, PROCESSES_TEST_DEVELOPMENT_SKILL: developmentSkill }, stdio: 'inherit', timeout: 180_000 })
  process.exitCode = result.status ?? 2
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
} finally {
  if (temporary) rmSync(temporary, { recursive: true, force: true })
}
