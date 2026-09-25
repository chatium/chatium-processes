#!/usr/bin/env node
// Пересобирает <process>/actions/letters.generated.json из писем процесса.
// Запускай после каждой правки писем, до коммита.
//
//   node .agents/skills/processes/scripts/letters.mjs <process> [--root DIR]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildLettersBundle, bundlePath, serializeBundle } from './lib/letters.mjs'
import { findRoot, isDir, parseArgs, rel } from './lib/project.mjs'
import { parseYaml, requireYaml } from './lib/yaml.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['help'])
const slug = positional[0]
if (options.help || !slug) {
  console.log('Использование: letters.mjs <process> [--root DIR]')
  process.exit(options.help ? 0 : 2)
}
try {
  requireYaml()
} catch (e) {
  console.error(e.message)
  process.exit(2)
}

const root = findRoot(options.root)
if (!isDir(join(root, slug))) {
  console.error(`Нет папки процесса ${slug}/ в ${root}`)
  process.exit(2)
}
let lettersRoot = `.mailings/storage/processes/${slug}`
const mapFile = join(root, slug, 'process.yaml')
if (existsSync(mapFile)) {
  try {
    const map = parseYaml(readFileSync(mapFile, 'utf8'))
    if (map?.letters) lettersRoot = String(map.letters).replace(/^\.\//, '').replace(/\/+$/, '')
  } catch {}
}

const { bundle, errors } = buildLettersBundle(root, lettersRoot)
for (const e of errors) console.error(`✘ ${e}`)
if (errors.length > 0) process.exit(1)

const target = bundlePath(root, slug)
const next = serializeBundle(bundle)
const prev = existsSync(target) ? readFileSync(target, 'utf8') : null
if (prev === next) {
  console.log(`${rel(root, target)} актуален: писем ${Object.keys(bundle.letters).length}`)
} else {
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, next)
  console.log(`${rel(root, target)} пересобран: писем ${Object.keys(bundle.letters).length}`)
}
