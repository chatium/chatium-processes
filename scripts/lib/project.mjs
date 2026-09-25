// Общие помощники скриптов: корень аккаунта, пути, обход файлов, аргументы.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const SKIP_DIRS = new Set(['node_modules', '.git', '.typings'])

/** Корень аккаунта: вверх от cwd до package.json с секцией chatium или .git. */
export function findRoot(explicit) {
  if (explicit) return resolve(explicit)
  let dir = process.cwd()
  for (;;) {
    const pkg = join(dir, 'package.json')
    if (existsSync(pkg)) {
      try {
        if (JSON.parse(readFileSync(pkg, 'utf8')).chatium) return dir
      } catch {}
    }
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return process.cwd()
    dir = parent
  }
}

/** Путь от корня аккаунта в posix-виде. */
export function rel(root, abs) {
  return relative(root, abs).split(sep).join('/')
}

export function isDir(p) {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

export function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Все файлы под каталогом (без node_modules и .git). */
export function walk(dir, out = []) {
  if (!isDir(dir)) return out
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    if (isDir(p)) walk(p, out)
    else out.push(p)
  }
  return out
}

export function readText(p) {
  return readFileSync(p, 'utf8')
}

/**
 * Разбор аргументов: позиционные + --flag / --key value / --key=value.
 * Флаги из booleans не ждут значения.
 */
export function parseArgs(argv, booleans = []) {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    if (eq > 0) {
      options[a.slice(2, eq)] = a.slice(eq + 1)
    } else if (booleans.includes(a.slice(2))) {
      options[a.slice(2)] = true
    } else {
      options[a.slice(2)] = argv[i + 1]
      i++
    }
  }
  return { positional, options }
}

/** Слаг процесса: латиница в kebab-case. */
export function isProcessSlug(s) {
  return typeof s === 'string' && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(s)
}
