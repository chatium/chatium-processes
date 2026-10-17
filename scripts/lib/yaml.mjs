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

function loadYaml(packageName) {
  for (const dir of startDirs()) {
    try {
      const resolved = require.resolve(packageName, { paths: [dir] })
      return require(resolved)
    } catch {}
  }
  return null
}

const yaml = loadYaml('yaml')
const testYaml = loadYaml('js-yaml')

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

export function parseYaml(source, options) {
  return requireYaml().parse(source, options)
}

export function stringifyYaml(value) {
  return requireYaml().stringify(value)
}

// Same schema as the Start runtime: date-like scalars remain strings; numeric syntax matches js-yaml.
export function parseTestPlanYaml(source) {
  if (!testYaml) throw Error('Не найден js-yaml для плана тестирования. Из каталога скилла выполните npm ci --ignore-scripts.')
  const schema = testYaml.JSON_SCHEMA.extend({ implicit: ['int', 'float'].map(name => {
    const type = testYaml.types[name]
    return new testYaml.Type(`tag:yaml.org,2002:${name}`, { kind: 'scalar',
      resolve: value => typeof value === 'string' && !value.includes('_') && type.resolve(value),
      construct: value => type.construct(value) })
  }) })
  return testYaml.load(source, { schema })
}
