import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const helper = fileURLToPath(new URL('../../.github/sync-skill.mjs', import.meta.url))

function fixture(t) {
  if (!existsSync(helper)) { t.skip('Release tools are deliberately absent from the installed runtime'); return }
  const base = mkdtempSync(join(tmpdir(), 'processes-release-test-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const source = join(base, 'source'), destination = join(base, 'destination')
  const put = (root, path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof content === 'string' ? content : JSON.stringify(content) + '\n')
  }
  const git = (root, ...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  for (const root of [source, destination]) {
    mkdirSync(root)
    git(root, 'init', '-q', '-b', 'main')
    git(root, 'config', 'user.name', 'Release test')
    git(root, 'config', 'user.email', 'release@example.invalid')
  }
  put(source, '.github/sync-skill.mjs', readFileSync(helper, 'utf8'))
  put(source, '.local-context/private.md', 'Internal development notes')
  put(source, 'AGENTS.md', 'Internal rules')
  put(source, '.gitignore', 'node_modules/\n')
  put(source, '.prettierignore', '*\n')
  put(source, 'README.md', 'Developer instructions')
  put(source, 'SKILL.md', '---\nname: chatium-processes\ndescription: Business processes\n---\n# Processes\n')
  put(source, 'WORKFLOW.md', 'Workflow')
  put(source, 'LICENSE', 'License')
  const pkg = { name: 'release-fixture', version: '1.0.0', private: true,
    type: 'module', scripts: { test: 'node scripts/tests/run.mjs' }, engines: { node: '>=22.0.0' } }
  put(source, 'package.json', pkg)
  put(source, 'package-lock.json', { name: pkg.name, version: pkg.version, lockfileVersion: 3,
    requires: true, packages: { '': { name: pkg.name, version: pkg.version } } })
  for (const directory of ['blocks', 'build', 'creative', 'formats', 'method', 'scripts', 'specialists', 'tasks', 'templates'])
    put(source, `${directory}/runtime.txt`, directory)
  put(source, 'scripts/tests/private.test.mjs', 'Source tests')
  put(source, 'node_modules/private.txt', 'Dependency cache')
  put(destination, 'skills/chatium-development/SKILL.md', '# Development')
  put(destination, 'README.md', 'Keep this file')
  git(source, 'add', '.')
  git(source, 'commit', '-qm', 'Source version')
  const run = action => spawnSync(process.execPath, [join(source, '.github/sync-skill.mjs'), action, destination],
    { encoding: 'utf8', timeout: 15_000 })
  return { source, destination, target: join(destination, 'skills/chatium-processes'), put, git, run }
}

test('release copies only the committed runtime, keeps required schemas and verifies exact contents', t => {
  const f = fixture(t)
  if (!f) return
  const result = f.run('release')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).delivery, 'production')
  for (const excluded of ['.git', '.github', '.local-context', 'AGENTS.md', '.gitignore', '.prettierignore',
    'README.md', 'node_modules', 'scripts/tests', 'INSTALLATION.json'])
    assert.equal(existsSync(join(f.target, excluded)), false, excluded)
  for (const directory of ['scripts', 'templates', 'tasks', 'method'])
    assert.equal(readFileSync(join(f.target, directory, 'runtime.txt'), 'utf8'), directory)
  assert.equal(JSON.parse(readFileSync(join(f.target, 'package.json'))).scripts, undefined)
  assert.equal(readFileSync(join(f.destination, 'README.md'), 'utf8'), 'Keep this file')
  assert.equal(JSON.parse(f.run('release-status').stdout).matches, true)
  f.put(f.target, 'scripts/unexpected.mjs', 'Unexpected file')
  assert.equal(JSON.parse(f.run('release-status').stdout).matches, false)
  assert.equal(f.git(f.source, 'status', '--porcelain'), '')
})

test('release refuses uncommitted source or production edits without overwriting them', t => {
  const f = fixture(t)
  if (!f) return
  f.put(f.source, 'SKILL.md', 'Uncommitted source')
  assert.notEqual(f.run('release').status, 0)
  assert.equal(existsSync(f.target), false)
  f.git(f.source, 'checkout', '--', 'SKILL.md')
  assert.equal(f.run('release').status, 0)
  f.put(f.target, 'SKILL.md', 'Uncommitted production')
  assert.notEqual(f.run('release').status, 0)
  assert.equal(readFileSync(join(f.target, 'SKILL.md'), 'utf8'), 'Uncommitted production')
})

test('release refuses a source symlink before creating the production folder', t => {
  const f = fixture(t)
  if (!f) return
  symlinkSync('../AGENTS.md', join(f.source, 'scripts/private-link'))
  f.git(f.source, 'add', 'scripts/private-link')
  f.git(f.source, 'commit', '-qm', 'Unsafe link')
  const result = f.run('release')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Ссылки не входят в поставку/)
  assert.equal(existsSync(f.target), false)
})

test('local candidate installs under the CLI skill name and stays outside account Git', t => {
  const f = fixture(t)
  if (!f) return
  f.git(f.destination, 'add', '.')
  f.git(f.destination, 'commit', '-qm', 'Account files')
  const result = f.run('install-local')
  assert.equal(result.status, 0, result.stderr)
  const target = join(f.destination, '.agents/skills/chatium-processes')
  assert.equal(JSON.parse(readFileSync(join(target, 'INSTALLATION.json'))).localCandidate, true)
  assert.equal(readdirSync(join(target, 'scripts')).includes('tests'), false)
  assert.equal(f.git(f.destination, 'status', '--porcelain'), '')
})
