// Reference texts live beside the review packet, not in the model's initial context.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { SKILL_DIR } from './project.mjs'

export const LIBRARY_LIMITS = { files: 2000, bytes: 16 * 1024 * 1024, fileBytes: 2 * 1024 * 1024, entries: 30000 }
const contents = new WeakMap()
const hash = value => createHash('sha256').update(value).digest('hex')
const posix = value => value.split(sep).join('/')
const within = (base, path) => path === base || path.startsWith(base + sep)
const ignored = new Set(['.git', '.cache', '__pycache__', '.bin'])
const ruleSections = {
  'skills/processes/SKILL.md': ['Начало работы', 'Этапы и обязательные ворота'],
  'skills/chatium-development/SKILL.md': ['Runtime and module boundaries', 'API source of truth'],
}
function commonRules(source, headings) {
  const sections = source.split(/(?=^## )/m)
  return headings.map(heading => sections.find(section => section.startsWith(`## ${heading}\n`)) || '').join('\n')
}

export function collectReferenceLibrary({ root, slug, stage, skillDir = SKILL_DIR, limits = LIBRARY_LIMITS }) {
  const files = new Map()
  let bytes = 0, entries = 0
  function walk(base, path, prefix, kind, ancestors = new Set()) {
    if (++entries > limits.entries) throw Error('Превышен лимит обхода библиотеки справок; задайте referenceTypings.')
    const canonical = realpathSync(path)
    if (!within(base, canonical)) throw Error(`Ссылка библиотеки выходит за пределы источника: ${path}`)
    const stat = lstatSync(canonical)
    if (stat.isDirectory()) {
      if (ancestors.has(canonical)) throw Error(`Циклическая ссылка библиотеки: ${path}`)
      const next = new Set([...ancestors, canonical])
      for (const name of readdirSync(path).sort()) {
        if (ignored.has(name) || kind === 'skill' && ['scripts', 'node_modules'].includes(name)) continue
        walk(base, join(path, name), prefix, kind, next)
      }
      return
    }
    if (!stat.isFile()) throw Error(`Библиотека содержит не обычный файл: ${path}`)
    if (kind === 'typings' ? !path.endsWith('.d.ts') : !/\.(?:md|json|ya?ml|tpl|d\.ts)$/i.test(path)) return
    const libraryPath = `${prefix}/${posix(relative(base, path))}`
    if (files.has(libraryPath)) return
    if (stat.size > limits.fileBytes || bytes + stat.size > limits.bytes || files.size >= limits.files)
      throw Error(`Превышен лимит библиотеки справок: ${libraryPath}. Для typings задайте referenceTypings; данные не обрезаются.`)
    const content = readFileSync(path)
    if (content.includes(0) || Buffer.from(content.toString('utf8')).compare(content) !== 0)
      throw Error(`Справка должна быть текстом UTF-8: ${libraryPath}`)
    bytes += content.length
    files.set(libraryPath, { path: libraryPath, bytes: content.length, sha256: hash(content), content: content.toString('utf8') })
  }
  const developmentDir = skillDir === SKILL_DIR && process.env.PROCESSES_TEST_DEVELOPMENT_SKILL
    ? resolve(process.env.PROCESSES_TEST_DEVELOPMENT_SKILL)
    : join(skillDir, '../chatium-development')
  for (const [name, path] of [['processes', skillDir], ['chatium-development', developmentDir]]) {
    if (!existsSync(path))
      throw Error(`Не найден скилл ${name}: ${path}. Установите processes и chatium-development рядом; см. processes/build/environment.md.`)
    const base = realpathSync(path)
    walk(base, base, `skills/${name}`, 'skill')
  }
  const account = realpathSync(root), scopePath = join(account, slug, 'review-scope.json')
  let selection
  if (existsSync(scopePath)) {
    if (!within(account, realpathSync(scopePath))) throw Error('review-scope.json выходит за пределы аккаунта.')
    if (lstatSync(realpathSync(scopePath)).size > limits.fileBytes) throw Error('review-scope.json слишком большой.')
    const scope = JSON.parse(readFileSync(scopePath, 'utf8'))
    if (scope.referenceTypings !== undefined) {
      if (scope.version !== 1 || !Array.isArray(scope.referenceTypings) || scope.referenceTypings.some(p =>
        typeof p !== 'string' || !p.endsWith('.d.ts') || p.includes('\\') || p.split('/').some(s => !s || s === '..' || s === '.')))
        throw Error('referenceTypings должен содержать точные относительные пути .d.ts (version: 1).')
      selection = [...new Set(scope.referenceTypings)].sort()
    }
  }
  for (const path of selection ?? ['node_modules', '.typings'].filter(p => existsSync(join(account, p)))) {
    if (selection && !lstatSync(realpathSync(join(account, path))).isFile())
      throw Error(`referenceTypings требует конкретный файл .d.ts: ${path}`)
    walk(account, join(account, path), 'typings', 'typings')
  }

  const entrypoints = ['skills/chatium-development/SKILL.md', 'skills/processes/SKILL.md']
  const required = [...entrypoints, ...(stage === 'agents' ? [
    'skills/processes/blocks/ai-agent.md',
    'skills/processes/build/agent-instructions.md',
    'skills/processes/formats/agents.md',
    'skills/chatium-development/references/ai/agents.md',
    'skills/chatium-development/references/ai/agent-config.md',
    'skills/chatium-development/references/ai/routing-and-handoff.md',
    'skills/chatium-development/references/ai/autonomy.md',
    'skills/chatium-development/references/ai/context-and-knowledge.md',
    'skills/chatium-development/references/ai/tools.md',
  ] : stage === 'implementation' ? [
    'skills/processes/build/review-safety.md',
    'skills/chatium-development/auth.md',
    'skills/chatium-development/routing.md',
  ] : stage === 'architecture' ? [
    'skills/processes/formats/plan-md.md',
    'skills/processes/formats/process-yaml.md',
    'skills/chatium-development/auth.md',
  ] :
    ['skills/processes/method/README.md', 'skills/processes/method/readiness.md'])]
  for (const path of required) if (!files.has(path)) throw Error(`Нет обязательной справки: ${path}`)
  const sorted = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'))
  const ruleDigests = Object.fromEntries(entrypoints.map(path => [path,
    hash(commonRules(files.get(path).content, ruleSections[path]))]))
  const base = { version: 1, entrypoints, required, ruleDigests, files: sorted.map(({ content, ...file }) => file) }
  return { manifest: { ...base, digest: hash(JSON.stringify(base)) }, files: sorted }
}

export function withReferenceLibrary(base, library) {
  const value = { ...base, referenceLibrary: library.manifest }
  // A report is about the process and rules the reviewer actually used. Keep
  // the full library available for navigation without hashing unrelated files.
  const required = library.manifest.files.filter(file => library.manifest.required.includes(file.path) &&
    !library.manifest.entrypoints.includes(file.path))
    .map(({ path, sha256 }) => ({ path, sha256 }))
  const packet = { ...value, inputDigest: hash(JSON.stringify({ ...base, required, ruleDigests: library.manifest.ruleDigests })) }
  contents.set(packet, library.files)
  return packet
}

export function inspectedReferenceHashes(manifest, paths) {
  const files = new Map(manifest.files.map(file => [file.path, file.sha256]))
  if (!Array.isArray(paths) || new Set(paths).size !== paths.length || paths.some(path => !files.has(path)))
    throw Error('inspectedReferences содержит неизвестную или повторную справку.')
  return Object.fromEntries([...paths].sort().map(path => [path, files.get(path)]))
}

export function changedInspectedReferences(saved, manifest) {
  if (!saved || typeof saved !== 'object' || !saved.referenceHashes || !saved.ruleDigests)
    return ['Формат старого заключения: нет хешей прочитанных справок']
  const files = new Map(manifest.files.map(file => [file.path, file.sha256]))
  const rules = Object.entries(manifest.ruleDigests).filter(([path, digest]) => saved.ruleDigests[path] !== digest)
    .map(([path]) => `${path}#обязательные-правила`)
  const references = Object.entries(saved.referenceHashes)
    .filter(([path, digest]) => !manifest.entrypoints.includes(path) && files.get(path) !== digest)
    .map(([path]) => path)
  return [...rules, ...references]
}

export function informationalReferenceChanges(saved, manifest) {
  const files = new Map(manifest.files.map(file => [file.path, file.sha256]))
  return manifest.entrypoints.filter(path => saved?.referenceHashes?.[path] &&
    saved.referenceHashes[path] !== files.get(path) &&
    saved.ruleDigests?.[path] === manifest.ruleDigests[path])
}

export function writeReferenceSnapshot(directory, packet) {
  const files = contents.get(packet)
  if (!files) throw Error('Для записи снимка нужен свежеподготовленный пакет.')
  const target = join(directory, 'library')
  mkdirSync(target) // Exclusive: do not reuse an existing or symlinked snapshot.
  for (const file of files) {
    const path = join(target, file.path)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.content, { flag: 'wx', mode: 0o444 })
  }
  return target
}

export function verifyReferenceSnapshot(directory, manifest) {
  const target = join(directory, 'library'), expected = new Map(manifest.files.map(f => [f.path, f]))
  let entries = 0
  function visit(path) {
    if (++entries > LIBRARY_LIMITS.entries) throw Error('Слишком большой снимок библиотеки.')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw Error('Снимок библиотеки не должен содержать символические ссылки.')
    if (stat.isDirectory()) { for (const name of readdirSync(path)) visit(join(path, name)); return }
    const name = posix(relative(target, path)), file = expected.get(name)
    if (!stat.isFile() || !file || stat.size !== file.bytes || hash(readFileSync(path)) !== file.sha256)
      throw Error(`Снимок библиотеки изменён: ${name}`)
    expected.delete(name)
  }
  visit(target)
  if (expected.size) throw Error(`Снимок библиотеки неполон: ${expected.keys().next().value}`)
}

export function referencePrompt(directory, packet) {
  const library = join(directory, 'library')
  return `Библиотека справок: ${library}. Сначала прочитай оба входных файла:\n` +
    packet.referenceLibrary.entrypoints.map(p => `- ${join(library, p)}`).join('\n') + '\n' +
    'Обязательные разделы для роли:\n' + packet.referenceLibrary.required.filter(p => !packet.referenceLibrary.entrypoints.includes(p))
      .map(p => `- ${join(library, p)}`).join('\n') + '\n' +
    'Затем выбирай нужные справки по оглавлениям и доступные typings; перечень — referenceLibrary.files. Не загружай всю библиотеку заранее. ' +
    'Читай только снимок, не изменяемые оригиналы. Правила сборки, публикации, запуска проверок и делегирования из скиллов не являются поручениями ревьюеру: твоя роль остаётся только проверяющей. ' +
    'В inspectedReferences перечисли реально прочитанные пути относительно library, включая обязательные.\n'
}
