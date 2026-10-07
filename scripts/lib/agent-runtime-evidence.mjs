import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { isProcessSlug } from './project.mjs'
import { validateProcessAgents } from './agents.mjs'
import { parseYaml } from './yaml.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const isCommit = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
const sha256 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const agentNodes = map => (Array.isArray(map?.nodes) ? map.nodes : [])
  .filter(node => node?.kind === 'agent')
  .map(node => ({ id: node.id, source: node.source, agentId: node.agentId || null }))
  .sort((a, b) => String(a.id).localeCompare(String(b.id)))
const nodeDigest = map => hash(JSON.stringify(agentNodes(map)))

function inputs(root, slug, map, spec) {
  const errors = validateProcessAgents({ root, slug, map })
  if (!errors.enabled || errors.errors.length) throw Error(`Локальный контракт помощников не готов: ${errors.errors.join('; ')}`)
  const configs = spec.agents.map(agent => {
    const path = agent.config
    const absolute = resolve(root, path)
    if (!absolute.startsWith(resolve(root, slug, 'agents') + sep) ||
        !path.endsWith('.agent.json') || lstatSync(absolute).isSymbolicLink())
      throw Error(`Недопустимый путь конфига ${path}`)
    return { path, sha256: hash(readFileSync(absolute)) }
  }).sort((a, b) => a.path.localeCompare(b.path))
  return { specSha256: hash(readFileSync(join(root, slug, 'agents/spec.yaml'))),
    agentNodesSha256: nodeDigest(map), configs }
}

export function writeAgentRuntimeEvidence({ root, slug, branch, commit, checkedAt, map, spec }) {
  if (!isProcessSlug(slug) || !isCommit(commit) || typeof branch !== 'string' || !branch ||
      !Number.isFinite(Date.parse(checkedAt))) throw Error('Нельзя записать неполную проверку помощников.')
  const file = join(root, slug, 'tests/agents-runtime.json')
  const data = { version: 1, process: slug, method: 'agents-runtime.mjs',
    runId: randomUUID(), branch, testedCommit: commit, checkedAt, ...inputs(root, slug, map, spec) }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
  return file
}

function gitRead(root, commit, path) {
  const result = spawnSync('git', ['show', '--no-ext-diff', `${commit}:${path}`],
    { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } })
  return result.status === 0 ? result.stdout : null
}

function gitAncestor(root, tested, current) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', tested, current],
    { cwd: root, timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return result.status === 0
}

function gitBranch(root) {
  const result = spawnSync('git', ['symbolic-ref', '--short', 'HEAD'],
    { cwd: root, timeout: 5000, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  return result.status === 0 ? result.stdout.trim() : null
}

/** A published runtime check is required at test/launch; a hand-written file is still trust-based. */
export function agentRuntimeEvidenceStatus({ root, slug, map,
  readAtCommit = (commit, path) => gitRead(root, commit, path),
  ancestor = (tested, current) => gitAncestor(root, tested, current),
  currentBranch = () => gitBranch(root) }) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  const local = validateProcessAgents({ root, slug, map })
  if (!local.enabled) return { status: 'ready', errors: [] }
  if (local.errors.length) return { status: 'invalid', errors: local.errors }
  const file = join(root, slug, 'tests/agents-runtime.json')
  if (!existsSync(file)) return { status: 'missing', errors: ['Нет проверки опубликованных помощников. Запусти agents-runtime.mjs <process> --record после публикации ветки.'] }
  if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 64 * 1024)
    return { status: 'invalid', errors: ['Результат проверки помощников должен быть обычным JSON-файлом до 64 KB.'] }
  let saved, spec, expected
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
    spec = parseYaml(readFileSync(join(root, slug, 'agents/spec.yaml'), 'utf8'))
    expected = inputs(root, slug, map, spec)
  } catch (error) { return { status: 'invalid', errors: [`Проверка помощников: ${error.message}`] } }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved))
    return { status: 'invalid', errors: ['Результат проверки помощников должен быть JSON-объектом.'] }
  const errors = []
  if (saved?.version !== 1 || saved.process !== slug || saved.method !== 'agents-runtime.mjs' ||
      typeof saved.runId !== 'string' || !/^[0-9a-f-]{36}$/.test(saved.runId) ||
      !Number.isFinite(Date.parse(saved.checkedAt)) || !isCommit(saved.testedCommit) ||
      typeof saved.branch !== 'string' || !saved.branch)
    errors.push('Неверная принадлежность или происхождение результата проверки помощников.')
  if (saved.specSha256 !== expected.specSha256 || saved.agentNodesSha256 !== expected.agentNodesSha256 ||
      JSON.stringify(saved.configs) !== JSON.stringify(expected.configs))
    errors.push('Спецификация, конфиг или ID помощника изменились после проверки.')
  if (!sha256(saved.specSha256) || !sha256(saved.agentNodesSha256) ||
      !Array.isArray(saved.configs) || saved.configs.length !== expected.configs.length ||
      saved.configs.some(item => !sha256(item?.sha256)))
    errors.push('Неверные хеши входов проверки помощников.')
  if (saved.branch !== currentBranch())
    errors.push(`Проверка выполнена для ветки ${saved.branch}, нужна текущая ветка.`)
  if (isCommit(saved.testedCommit)) {
    if (!ancestor(saved.testedCommit, 'HEAD')) errors.push('Исполненный коммит проверки помощников не предшествует текущему HEAD.')
    const atCommit = readAtCommit(saved.testedCommit, `${slug}/agents/spec.yaml`)
    const mapAtCommit = readAtCommit(saved.testedCommit, `${slug}/process.yaml`)
    if (!atCommit || hash(atCommit) !== saved.specSha256)
      errors.push('Спецификация помощников отсутствовала в исполненном коммите или отличалась.')
    if (!mapAtCommit) errors.push('Карта помощников отсутствовала в исполненном коммите.')
    else try {
      if (nodeDigest(parseYaml(mapAtCommit.toString('utf8'))) !== saved.agentNodesSha256)
        errors.push('ID или источники помощников в исполненном коммите отличались.')
    } catch { errors.push('Карта помощников в исполненном коммите не разбирается.') }
    for (const item of expected.configs) {
      const content = readAtCommit(saved.testedCommit, item.path)
      if (!content || hash(content) !== item.sha256)
        errors.push(`${item.path}: конфиг отличался от проверенного опубликованного файла.`)
    }
  }
  return { status: errors.length ? 'invalid' : 'ready', errors, path: file,
    ...(errors.length ? {} : { testedCommit: saved.testedCommit, checkedAt: saved.checkedAt }) }
}
