// Local skill dependency first; environment-provided YAML remains supported.
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

function startDirs() {
  const dirs = []
  if (process.env.PROCESSES_YAML_PATH) dirs.push(process.env.PROCESSES_YAML_PATH)
  dirs.push(dirname(fileURLToPath(import.meta.url)), process.cwd())
  for (const p of (process.env.NODE_PATH || '').split(delimiter)) {
    if (p) dirs.push(p)
  }
  // Бинарь dsh в PATH → его пакет, у которого yaml в зависимостях
  for (const bin of (process.env.PATH || '').split(delimiter)) {
    const dsh = bin && join(bin, 'dsh')
    if (dsh && existsSync(dsh)) {
      try {
        dirs.push(dirname(realpathSync(dsh)))
      } catch {}
    }
  }
  const globalRoots = [
    join(dirname(dirname(process.execPath)), 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
  ]
  for (const root of globalRoots) {
    dirs.push(join(root, '@deepseek-ai', 'dsh'))
    dirs.push(root)
  }
  return dirs
}

function loadYaml() {
  for (const dir of startDirs()) {
    try {
      const resolved = require.resolve('yaml', { paths: [dir] })
      return require(resolved)
    } catch {}
  }
  return null
}

const yaml = loadYaml()

export function requireYaml() {
  if (!yaml) {
    const err = new Error(
      'Не найден пакет yaml. Из каталога скилла выполните npm ci --ignore-scripts ' +
        'либо задайте PROCESSES_YAML_PATH — каталог, ' +
        'от которого доступен node_modules/yaml. См. build/environment.md.',
    )
    err.code = 'NO_YAML'
    throw err
  }
  return yaml
}

export function parseYaml(source) {
  return requireYaml().parse(source)
}

export function stringifyYaml(value) {
  return requireYaml().stringify(value)
}
