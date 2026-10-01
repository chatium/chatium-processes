import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { creativePacket, creativeStatus } from './creative.mjs'
import { collectImplementation } from './implementation.mjs'
import { safeTaskPath } from './tasks.mjs'
import { SKILL_DIR } from './project.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' && value.trim().length > 0
const inside = (base, target) => target === base || target.startsWith(base + sep)
const questions = (kind, stage, guidance) => [
  { id: 'task', question: 'Верно ли выбрана задача, аудитория и тип материала?' },
  { id: 'truth', question: 'Подтверждены ли ключевые обещания, цена, условия, сроки и доказательства?' },
  { id: 'depth', question: 'Достаточны ли содержание и аргументы для этой задачи, без пустоты и повторов?' },
  { id: 'action', question: 'Понятен и работоспособен ли следующий шаг клиента?' },
  ...(kind === 'landing' ? [
    { id: 'structure', question: 'Раскрыты ли нужные смысловые функции, механики и возражения?' },
    { id: 'design', question: 'Конкретны ли композиция, дизайн-система, изображения и мобильная версия?' },
  ] : [
    { id: 'series', question: 'Развивается ли мысль между письмами, различаются ли их роли и согласован ли голос?' },
    { id: 'delivery', question: 'Согласованы ли письма со страницей перехода, каналом и автоматизацией?' },
  ]),
  ...(guidance.reviewQuestions || []).map((question, index) => ({ id: `type.${index + 1}`, question })),
  ...(stage === 'result' ? [
    { id: 'implemented', question: 'Совпадает ли фактическое содержимое и поведение с заданием?' },
    { id: 'visual', question: 'Проверен ли отрендеренный результат на нужных размерах/в канале?' },
  ] : []),
]

function outputFiles(root, source) {
  const base = realpathSync(root), target = safeTaskPath(root, source, { mayBeMissing: true })
  if (!existsSync(target)) throw Error(`Нет результата ${source}`)
  const files = [], seen = new Set()
  let bytes = 0
  function visit(path) {
    const real = realpathSync(path)
    if (!inside(base, real) || seen.has(real)) throw Error(`Небезопасный путь результата ${path}`)
    safeTaskPath(root, path.slice(base.length + 1).split(sep).join('/'), { mayBeMissing: true })
    seen.add(real)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw Error(`Символьная ссылка в результате ${path}`)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (['node_modules', '.git', 'reviews', 'tasks'].includes(name)) continue
        visit(join(path, name))
      }
      return
    }
    if (!stat.isFile() || stat.size > 1024 * 1024 || files.length >= 150 || bytes + stat.size > 4 * 1024 * 1024)
      throw Error('Слишком большой или необычный файл результата.')
    const content = readFileSync(path)
    bytes += content.length
    if (content.includes(0)) throw Error(`Бинарный результат ${path}: приложите визуальный снимок отдельно.`)
    files.push({ path: path.slice(base.length + 1).split(sep).join('/'), content: content.toString('utf8') })
  }
  visit(target)
  return files
}

export function creativeReviewPacket({ root, slug, nodeId, stage = 'spec' }) {
  if (!['spec', 'result'].includes(stage)) throw Error('Ревью: этап spec или result.')
  const creative = creativePacket({ root, slug, nodeId })
  const status = creativeStatus({ root, slug, nodeId })
  if (status.status !== 'ready') throw Error(`Задание не готово: ${status.errors.join('; ')}`)
  const entries = [creative.specPath, creative.buildPath, ...creative.sources.map(s => s.path),
    ...creative.copyFiles.map(f => f.path),
    ...creative.referenceFiles.map(f => f.path)]
  const files = [...new Set(entries)].map(path => ({ path, content: readFileSync(safeTaskPath(root, path), 'utf8') }))
  let visuals = []
  let implementation = []
  if (stage === 'result') {
    files.push(...outputFiles(root, creative.node.source))
    const corpus = collectImplementation({ root, slug })
    const sourceErrors = corpus.checks.flatMap(check => check.errors)
    if (sourceErrors.length) throw Error(`Неполный набор исходников результата: ${sourceErrors.join('; ')}`)
    const code = corpus.files.filter(f => /\.(?:[cm]?[jt]sx?|vue|css|scss|sass|less|html?|json|ya?ml|svg)$/i.test(f.path) &&
      !f.path.startsWith(`${slug}/tasks/`) && !f.path.startsWith(`${slug}/reviews/`) &&
      !f.path.startsWith(`${slug}/creative/`) && !f.path.startsWith('.knowledge-base/'))
      .map(f => ({ path: f.path, sha256: sha(f.content) }))
    implementation = [...new Map([...code, ...corpus.assets,
      ...creative.assetFiles, ...(creative.automationFile ? [creative.automationFile] : [])]
      .map(f => [f.path, { path: f.path, sha256: f.sha256 }])).values()].sort((a, b) => a.path.localeCompare(b.path))
    if (!implementation.some(f => f.path === creative.node.source || f.path.startsWith(`${creative.node.source}/`)))
      throw Error(`Исходник результата ${creative.node.source} не включён в пакет реализации.`)
    const visualPath = `${slug}/reviews/creative/${nodeId}-visual.json`
    const visualFile = safeTaskPath(root, visualPath)
    if (lstatSync(visualFile).size > 64 * 1024) throw Error('Слишком большое описание снимков.')
    const visual = JSON.parse(readFileSync(visualFile, 'utf8'))
    if (!Array.isArray(visual.captures) || !visual.captures.length || visual.captures.length > 12) throw Error('Нужны от 1 до 12 снимков результата.')
    const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 })
    const currentCommit = git.status === 0 ? git.stdout.trim() : null
    const versions = new Set(visual.captures.map(c => c.codeVersion))
    if (versions.size !== 1) throw Error('Все снимки результата должны относиться к одной версии кода.')
    if (currentCommit) {
      const [version] = versions
      if (!/^[0-9a-f]{40}$/.test(version)) throw Error('codeVersion должен быть полным SHA коммита.')
      const run = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 })
      if (run(['merge-base', '--is-ancestor', version, currentCommit]).status !== 0)
        throw Error('Версия снимков не входит в текущую ветку.')
      const paths = implementation.map(f => f.path)
      if (run(['diff', '--quiet', version, currentCommit, '--', ...paths]).status !== 0 ||
          run(['status', '--porcelain', '--untracked-files=normal', '--', ...paths]).stdout.trim())
        throw Error('Результат изменился после версии снимков; нужны новые снимки и ревью.')
    }
    visuals = visual.captures.map(capture => {
      if (!text(capture.path) || !text(capture.viewport) || !text(capture.codeVersion)) throw Error('У снимка нужны путь, viewport и версия кода.')
      const path = safeTaskPath(root, capture.path)
      if (lstatSync(path).size > 5 * 1024 * 1024) throw Error(`Слишком большой снимок ${capture.path}.`)
      const bytes = readFileSync(path)
      if (!capture.path.endsWith('.png') || bytes.length < 24 ||
          !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          bytes.toString('ascii', 12, 16) !== 'IHDR')
        throw Error(`Снимок ${capture.path} должен быть PNG-изображением.`)
      const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
      if (!width || !height || width > 16000 || height > 16000) throw Error(`Неверный размер снимка ${capture.path}.`)
      return { ...capture, width, height, sha256: sha(bytes) }
    })
    if (creative.node.kind === 'page' && !['desktop', 'mobile'].every(view => visuals.some(v => v.viewport === view)))
      throw Error('Для страницы нужны desktop и mobile снимки.')
    files.push({ path: visualPath, content: JSON.stringify(visual) })
  }
  const total = files.reduce((n, f) => n + Buffer.byteLength(f.content), 0)
  if (files.length > 200 || total > 4 * 1024 * 1024) throw Error('Пакет ревью слишком большой; разделите материал.')
  const packet = { version: 1, process: slug, nodeId, stage, kind: creative.spec.kind,
    questions: questions(creative.spec.kind, stage, creative.guidance),
    files, visuals, implementation, reviewerInstructions: readFileSync(join(SKILL_DIR, 'creative/reviewer.md'), 'utf8') }
  return { ...packet, inputDigest: sha(JSON.stringify(packet)) }
}

export function creativeReviewPath(root, slug, nodeId, stage) {
  return safeTaskPath(root, `${slug}/reviews/creative/${nodeId}-${stage}.json`, { mayBeMissing: true })
}

function validateReport(report, packet) {
  if (report?.version !== 1 || report.process !== packet.process || report.nodeId !== packet.nodeId ||
      report.stage !== packet.stage || report.inputDigest !== packet.inputDigest) throw Error('Отчёт относится к другой версии материалов.')
  const files = new Map(packet.files.map(f => [f.path, f.content]))
  if (!Array.isArray(report.inspectedFiles) || report.inspectedFiles.length !== files.size ||
      new Set(report.inspectedFiles).size !== files.size || report.inspectedFiles.some(path => !files.has(path)))
    throw Error('Reviewer должен перечислить все изученные файлы пакета.')
  if (!Array.isArray(report.answers) || report.answers.length !== packet.questions.length) throw Error('Нужен ответ на каждый вопрос.')
  const ids = new Set(packet.questions.map(q => q.id)), blocking = [], advisory = []
  for (const answer of report.answers) {
    if (!ids.delete(answer.id) || !['pass', 'blocking', 'advisory'].includes(answer.status) || !text(answer.reason)) throw Error('Неверный ответ reviewer.')
    if (!Array.isArray(answer.evidence) || (answer.status === 'pass' && !answer.evidence.length)) throw Error(`${answer.id}: нужна привязка к материалу.`)
    for (const item of answer.evidence) {
      if (!files.has(item.path) || !text(item.quote) || !files.get(item.path).includes(item.quote)) throw Error(`${answer.id}: цитата не найдена в пакете.`)
    }
    if (answer.status === 'blocking') blocking.push(answer)
    if (answer.status === 'advisory') advisory.push(answer)
  }
  if (packet.stage === 'result' && (!Array.isArray(report.inspectedVisuals) ||
      packet.visuals.some(v => !report.inspectedVisuals.includes(v.path)))) throw Error('Не подтверждён просмотр всех снимков.')
  return { status: blocking.length ? 'needs-work' : 'ready', blocking, advisory }
}

export function recordCreativeReview({ root, slug, nodeId, stage, packet, report, agentReference }) {
  if (!text(agentReference)) throw Error('Нужен ID реального вызова независимого reviewer.')
  const current = creativeReviewPacket({ root, slug, nodeId, stage })
  if (packet.inputDigest !== current.inputDigest) throw Error('Материалы изменились после подготовки пакета.')
  const result = validateReport(report, current)
  const path = creativeReviewPath(root, slug, nodeId, stage)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ ...report, status: result.status, reviewer: { kind: 'subagent', reference: agentReference },
    reviewedAt: new Date().toISOString() }, null, 2) + '\n')
  return { ...result, path }
}

export function creativeReviewStatus({ root, slug, nodeId, stage }) {
  const path = creativeReviewPath(root, slug, nodeId, stage)
  try {
    const packet = creativeReviewPacket({ root, slug, nodeId, stage })
    if (!existsSync(path)) return { status: 'missing', path, error: `Нет ревью ${stage} для ${nodeId}.` }
    const report = JSON.parse(readFileSync(path, 'utf8'))
    if (report.inputDigest !== packet.inputDigest) return { status: 'stale', path, error: 'Материалы изменились после ревью.' }
    if (report.reviewer?.kind !== 'subagent' || !text(report.reviewer.reference)) throw Error('Нет независимого reviewer.')
    return { ...validateReport(report, packet), path }
  } catch (error) { return { status: 'invalid', path, error: error.message } }
}
