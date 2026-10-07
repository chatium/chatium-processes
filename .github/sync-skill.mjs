#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [action, accountArg] = process.argv.slice(2)
if (!['status', 'install'].includes(action) || !accountArg || process.argv.length !== 4) {
  console.error('Использование: node .github/sync-skill.mjs status|install <корень Git-аккаунта>')
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
      else if (mode.isFile() || mode.isSymbolicLink()) {
        hash.update(relative).update('\0').update(mode.isSymbolicLink() ? 'link' : 'file').update('\0')
        hash.update(mode.isSymbolicLink() ? readlinkSync(path) : readFileSync(path)).update('\0')
      } else throw Error(`Неподдерживаемый файл скилла: ${relative}`)
    }
  }
  visit(root)
  return hash.digest('hex')
}

const account = realpathSync(accountArg)
if (git(account, 'rev-parse', '--show-toplevel') !== account) throw Error('Укажите корень Git-аккаунта')
const target = join(account, '.agents', 'skills', 'processes')
for (const path of [join(account, '.agents'), join(account, '.agents', 'skills'), target]) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw Error(`Путь скилла не должен быть ссылкой: ${path}`)
}
const temp = mkdtempSync(join(tmpdir(), 'processes-sync-'))

try {
  git(source, 'fetch', '--quiet', 'origin', 'main')
  const commit = git(source, 'rev-parse', 'FETCH_HEAD')
  const unpacked = join(temp, 'archive')
  const distribution = join(temp, 'distribution')
  mkdirSync(unpacked)
  mkdirSync(distribution)
  const archive = execFileSync('git', ['archive', '--format=tar', commit], { cwd: source, maxBuffer: 64 * 1024 * 1024 })
  execFileSync('tar', ['-xf', '-', '-C', unpacked], { input: archive })
  for (const entry of readdirSync(unpacked)) {
    if (entry === '.github' || entry === 'README.md' || entry === 'node_modules') continue
    cpSync(join(unpacked, entry), join(distribution, entry), { recursive: true })
  }
  const contentHash = fingerprint(distribution)
  const installedHash = existsSync(target)
    ? fingerprint(target, new Set(['node_modules', 'README.md', 'INSTALLATION.json'])) : null
  const markerPath = join(target, 'INSTALLATION.json')
  const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null

  if (action === 'status') {
    console.log(`Установлен: ${marker?.sourceCommit || 'коммит неизвестен'}`)
    console.log(`Файлы: ${installedHash || 'скилл отсутствует'}`)
    console.log(`Опубликован: ${commit}`)
    console.log(`Состояние: ${marker?.contentSha256 && marker.contentSha256 !== installedHash ? 'копия изменена' : installedHash === contentHash ? 'актуален' : 'требует обновления'}`)
  } else {
    if (git(account, 'status', '--porcelain')) throw Error('В аккаунте есть несохранённые изменения')
    if (git(account, 'branch', '--show-current') !== 'main' ||
        git(account, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}') !== 'origin/main' ||
        git(account, 'rev-parse', 'HEAD') !== git(account, 'rev-parse', 'origin/main')) {
      throw Error('Сначала синхронизируйте чистую ветку main аккаунта с origin/main')
    }
    writeFileSync(join(distribution, 'INSTALLATION.json'), JSON.stringify({
      source: 'https://github.com/chatium/chatium-processes',
      sourceCommit: commit,
      contentSha256: contentHash,
    }, null, 2) + '\n')
    mkdirSync(target, { recursive: true })
    execFileSync('rsync', ['-ac', '--delete', '--exclude=/node_modules/', distribution + sep, target + sep], { stdio: 'inherit' })
    execFileSync('npm', ['ci', '--ignore-scripts'], { cwd: target, stdio: 'inherit' })
    if (fingerprint(target, new Set(['node_modules', 'README.md', 'INSTALLATION.json'])) !== contentHash) {
      throw Error('Установленная копия отличается от исходника')
    }
    console.log(`Установлен ${commit}. Проверьте diff, затем отдельно закоммитьте и опубликуйте аккаунт.`)
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
