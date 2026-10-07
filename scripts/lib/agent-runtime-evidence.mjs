import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isProcessSlug } from './project.mjs'
import { validateProcessAgents } from './agents.mjs'
import { parseYaml } from './yaml.mjs'
import { canonicalTarget } from './knowledge-review.mjs'

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
  if (!Number.isInteger(map?.accountId) || map.accountId <= 0) throw Error('В карте нужен accountId для проверки помощников.')
  const configs = spec.agents.map(agent => {
    const path = agent.config
    const absolute = resolve(root, path)
    if (!absolute.startsWith(resolve(root, slug, 'agents') + sep) ||
        !canonicalTarget(absolute).startsWith(realpathSync(resolve(root, slug, 'agents')) + sep) ||
        !path.endsWith('.agent.json') || lstatSync(absolute).isSymbolicLink())
      throw Error(`Недопустимый путь конфига ${path}`)
    return { path, sha256: hash(readFileSync(absolute)) }
  }).sort((a, b) => a.path.localeCompare(b.path))
  return { accountId: map.accountId, specSha256: hash(readFileSync(join(root, slug, 'agents/spec.yaml'))),
    agentNodesSha256: nodeDigest(map), configs }
}

function safeEvidenceFile(root, slug) {
  const base = resolve(root), process = join(base, slug), tests = join(process, 'tests')
  const file = join(tests, 'agents-runtime.json')
  for (const [path, kind] of [[process, 'dir'], [tests, 'dir'], [file, 'file']]) {
    let stat
    try { stat = lstatSync(path) }
    catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (stat.isSymbolicLink() || (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()))
      throw Error(`Путь результата проверки помощников содержит ссылку или неподходящий файл: ${path}`)
  }
  const canonical = canonicalTarget(file)
  if (!canonical.startsWith(realpathSync(base) + sep)) throw Error('Путь результата проверки помощников выходит за пределы аккаунта.')
  return file
}

export function writeAgentRuntimeEvidence({ root, slug, branch, commit, checkedAt, accountId, map, spec }) {
  if (!isProcessSlug(slug) || !isCommit(commit) || typeof branch !== 'string' || !branch ||
      !Number.isFinite(Date.parse(checkedAt))) throw Error('Нельзя записать неполную проверку помощников.')
  const file = safeEvidenceFile(root, slug)
  const checked = inputs(root, slug, map, spec)
  if (accountId !== checked.accountId) throw Error('Исполненный accountId не совпадает с картой процесса.')
  const data = { version: 2, process: slug, method: 'agents-runtime.mjs',
    runId: randomUUID(), branch, testedCommit: commit, checkedAt, ...checked }
  if (!existsSync(join(root, slug, 'tests'))) mkdirSync(join(root, slug, 'tests'))
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
  maxAgeMs = Infinity,
  readAtCommit = (commit, path) => gitRead(root, commit, path),
  ancestor = (tested, current) => gitAncestor(root, tested, current),
  currentBranch = () => gitBranch(root) }) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  const local = validateProcessAgents({ root, slug, map })
  if (!local.enabled) return { status: 'ready', errors: [] }
  if (local.errors.length) return { status: 'invalid', errors: local.errors }
  let file
  try { file = safeEvidenceFile(root, slug) }
  catch (error) { return { status: 'invalid', errors: [error.message] } }
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
  if (saved?.version !== 2 || saved.process !== slug || saved.method !== 'agents-runtime.mjs' ||
      typeof saved.runId !== 'string' || !/^[0-9a-f-]{36}$/.test(saved.runId) ||
      !Number.isFinite(Date.parse(saved.checkedAt)) || !isCommit(saved.testedCommit) ||
      typeof saved.branch !== 'string' || !saved.branch)
    errors.push('Неверная принадлежность или происхождение результата проверки помощников.')
  if (Number.isFinite(maxAgeMs) && Date.now() - Date.parse(saved.checkedAt) > maxAgeMs)
    errors.push('Проверка опубликованных помощников устарела по времени; повтори agents-runtime.mjs --record перед следующим этапом.')
  if (Date.parse(saved.checkedAt) - Date.now() > 5 * 60_000)
    errors.push('Время проверки опубликованных помощников находится в будущем.')
  if (saved.accountId !== expected.accountId || saved.specSha256 !== expected.specSha256 || saved.agentNodesSha256 !== expected.agentNodesSha256 ||
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
      const committedMap = parseYaml(mapAtCommit.toString('utf8'))
      if (nodeDigest(committedMap) !== saved.agentNodesSha256 || committedMap.accountId !== saved.accountId)
        errors.push('Аккаунт, ID или источники помощников в исполненном коммите отличались.')
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
