#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [action, accountArg] = process.argv.slice(2)
if (!['release', 'release-status', 'install-local'].includes(action) || !accountArg || process.argv.length !== 4) {
  console.error('Использование: node .github/sync-skill.mjs release|release-status <репозиторий chatium-agent-skills> либо install-local <корень Git-аккаунта>')
  process.exit(2)
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function fingerprint(root, ignored = new Set()) {
  const hash = createHash('sha256')
  function visit(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!prefix && ignored.has(entry.name)) continue
      const relative = prefix + entry.name
      const path = join(directory, entry.name)
      const mode = lstatSync(path)
      if (mode.isDirectory()) visit(path, relative + '/')
      else if (mode.isFile()) {
        hash.update(relative).update('\0').update('file').update('\0')
        hash.update(readFileSync(path)).update('\0')
      } else throw Error(`Неподдерживаемый файл скилла: ${relative}`)
    }
  }
  visit(root)
  return hash.digest('hex')
}

const account = realpathSync(accountArg)
if (git(account, 'rev-parse', '--show-toplevel') !== account) throw Error('Укажите корень Git-репозитория')
const releasing = action !== 'install-local'
if (releasing && !existsSync(join(account, 'skills/chatium-development/SKILL.md')))
  throw Error('В целевом репозитории нет skills/chatium-development/SKILL.md')
const targetRelative = releasing ? 'skills/chatium-processes' : '.agents/skills/chatium-processes'
const target = join(account, targetRelative)
for (const path of [join(account, releasing ? 'skills' : '.agents'), dirname(target), target]) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error(`Путь скилла не должен быть ссылкой: ${path}`)
}
const temp = mkdtempSync(join(tmpdir(), 'processes-sync-'))

try {
  if (action !== 'release-status' && git(source, 'status', '--porcelain')) {
    throw Error('Сначала зафиксируйте изменения исходника: копируется только выбранный HEAD')
  }
  const commit = git(source, 'rev-parse', 'HEAD')
  const unpacked = join(temp, 'archive')
  const distribution = join(temp, 'distribution')
  mkdirSync(unpacked)
  mkdirSync(distribution)
  const archive = execFileSync('git', ['archive', '--format=tar', commit], { cwd: source, maxBuffer: 64 * 1024 * 1024 })
  execFileSync('tar', ['-xf', '-', '-C', unpacked], { input: archive })
  const runtime = ['SKILL.md', 'WORKFLOW.md', 'LICENSE', 'package.json', 'package-lock.json',
    'blocks', 'build', 'creative', 'formats', 'method', 'scripts', 'specialists', 'tasks', 'templates']
  for (const entry of runtime) {
    cpSync(join(unpacked, entry), join(distribution, entry), { recursive: true, filter: path => {
      if (lstatSync(path).isSymbolicLink()) throw Error(`Ссылки не входят в поставку: ${path}`)
      return path !== join(unpacked, 'scripts', 'tests')
    } })
  }
  const packagePath = join(distribution, 'package.json')
  const packageInfo = JSON.parse(readFileSync(packagePath, 'utf8'))
  if (packageInfo.scripts) {
    delete packageInfo.scripts.test
    if (!Object.keys(packageInfo.scripts).length) delete packageInfo.scripts
  }
  writeFileSync(packagePath, JSON.stringify(packageInfo, null, 2) + '\n')
  const contentHash = fingerprint(distribution)
  const ignored = releasing ? new Set() : new Set(['node_modules', 'INSTALLATION.json'])
  if (action === 'release-status') {
    const installedHash = existsSync(target) ? fingerprint(target) : null
    console.log(JSON.stringify({ sourceCommit: commit, contentSha256: contentHash, target,
      installedSha256: installedHash, matches: installedHash === contentHash }, null, 2))
  } else {
    if (releasing) {
      if (git(account, 'branch', '--show-current') !== 'main') throw Error('Релизную копию обновляйте в main; чужую ветку не переключайте')
      if (git(account, 'status', '--porcelain', '--', targetRelative)) throw Error('В production-копии есть несохранённые изменения')
    } else {
      if (git(account, 'ls-files', '--', targetRelative)) throw Error('Копия chatium-processes не должна отслеживаться Git аккаунта')
      const exclude = resolve(account, git(account, 'rev-parse', '--git-path', 'info/exclude'))
      const rule = '/.agents/skills/chatium-processes/'
      const current = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
      if (!current.split(/\r?\n/).includes(rule)) writeFileSync(exclude, current + '\n' + rule + '\n')
      writeFileSync(join(distribution, 'INSTALLATION.json'), JSON.stringify({
        source: 'https://github.com/chatium/chatium-processes', sourceCommit: commit,
        contentSha256: contentHash, localCandidate: true,
      }, null, 2) + '\n')
    }
    mkdirSync(target, { recursive: true })
    execFileSync('rsync', ['-ac', '--delete', ...(!releasing ? ['--exclude=/node_modules/'] : []),
      distribution + sep, target + sep], { stdio: 'inherit' })
    if (!releasing) execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: target, stdio: 'inherit' })
    if (fingerprint(target, ignored) !== contentHash) {
      throw Error('Установленная копия отличается от исходника')
    }
    console.log(JSON.stringify({ sourceCommit: commit, contentSha256: contentHash, target,
      delivery: releasing ? 'production' : 'local-candidate' }, null, 2))
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
