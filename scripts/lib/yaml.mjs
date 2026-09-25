// Пакет yaml без npm install: берём его из поставки агента dsh или из
// глобальных node_modules. Для локальных тестов — PROCESSES_YAML_PATH:
// каталог, от которого искать node_modules/yaml.
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

function startDirs() {
  const dirs = []
  if (process.env.PROCESSES_YAML_PATH) dirs.push(process.env.PROCESSES_YAML_PATH)
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
  dirs.push(process.cwd())
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
      'Не найден пакет yaml. На VM он приходит с агентом; локально задайте ' +
        'PROCESSES_YAML_PATH — каталог, где лежит node_modules/yaml.',
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
