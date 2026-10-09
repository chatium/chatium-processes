import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const ignored = new Set(['.git', '.github', 'node_modules', 'README.md', 'tests'])

function installedSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (ignored.has(entry.name) || directory.endsWith('/scripts') && entry.name === 'tests') return []
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return installedSources(path)
    return entry.isFile() && /\.(?:md|json|yaml|yml)$/.test(entry.name) ? [path] : []
  })
}

function leakedFiles(directory) {
  const sources = directory === root && existsSync(join(root, '.git'))
    ? execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
      .toString().split('\0').filter(Boolean)
      .filter(path => !ignored.has(path.split('/')[0]) && !path.startsWith('scripts/tests/'))
      .filter(path => /\.(?:md|json|yaml|yml)$/.test(path))
      .map(path => join(root, path))
    : installedSources(directory)
  return sources.flatMap(path => {
    const content = readFileSync(path, 'utf8')
    return /\/Users\/[^\s/]+\/|\/Projects\/chatium accounts\/start\.chatium\.ru|\bV4\b/u.test(content)
      ? [relative(directory, path)] : []
  })
}

test('installable instructions contain no developer home paths or legacy V4 jargon', () => {
  const leaked = leakedFiles(root)
  assert.deepEqual(leaked, [], `В устанавливаемой копии внутренние пути или термины: ${leaked.join(', ')}`)
})

test('distribution check catches an internal path and V4 jargon outside developer-only files', t => {
  const directory = mkdtempSync(join(tmpdir(), 'processes-distribution-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'SKILL.md'), 'См. /Users/ratmir/Projects/chatium accounts/start.chatium.ru; прежний V4.\n')
  writeFileSync(join(directory, 'README.md'), 'Этот файл не входит в установленный скилл.\n')
  assert.deepEqual(leakedFiles(directory), ['SKILL.md'])
})
