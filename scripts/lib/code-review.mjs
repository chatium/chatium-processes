import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { collectImplementation } from './implementation.mjs'
import { reviewPlan, reviewWorkspace } from './review-normalization.mjs'
import { canonicalTarget, validateReview } from './knowledge-review.mjs'
import { isProcessSlug, SKILL_DIR } from './project.mjs'
import { changedInspectedReferences, collectReferenceLibrary, informationalReferenceChanges, inspectedReferenceHashes, verifyReferenceSnapshot, withReferenceLibrary } from './review-library.mjs'
import { loadTasks, parseTaskPlan, taskDefinition } from './tasks.mjs'
import { parseYaml } from './yaml.mjs'

export function codeReviewPath(root, slug) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  const path = resolve(root, slug, 'reviews', 'implementation.json')
  const base = realpathSync(root), canonical = canonicalTarget(path)
  if (!canonical.startsWith(base + sep)) throw Error('Путь отчёта выходит за пределы аккаунта.')
  return path
}

function previousTableFiles(root, slug, files) {
  const registry = files.find(file => file.path === `${slug}/tables/schema-decisions.json`)
  if (!registry) return { files: [], errors: [] }
  const history = [], errors = []
  let historyBytes = 0
  let records
  try { records = JSON.parse(registry.content).changes }
  catch { return { files: [], errors: ['schema-decisions.json не разбирается для ревью прежних схем.'] } }
  if (!Array.isArray(records) || records.length > 100)
    return { files: [], errors: ['schema-decisions.json: нужен список changes до 100 записей.'] }
  const current = new Set(files.map(file => file.path))
  for (const record of records) {
    const path = record?.path, expected = record?.previousSha256
    if (typeof path !== 'string' || !path.startsWith(`${slug}/tables/`) ||
        path.split('/').some(part => part === '..' || part === '.') || !path.endsWith('.table.ts') ||
        !current.has(path) || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
      errors.push('Некорректный путь или SHA прежней таблицы в schema-decisions.json.')
      continue
    }
    const log = spawnSync('git', ['log', '--format=%H', '--max-count=2', '--', path],
      { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    if (log.status !== 0) { errors.push(`${path}: история Git недоступна для ревью схемы.`); continue }
    let previous
    for (const commit of log.stdout.split('\n').filter(Boolean)) {
      const shown = spawnSync('git', ['show', `${commit}:${path}`],
        { cwd: root, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
      if (shown.status !== 0 || shown.stdout.length > 1024 * 1024) continue
      if (createHash('sha256').update(shown.stdout).digest('hex') === expected) {
        previous = shown.stdout
        break
      }
    }
    if (previous === undefined) { errors.push(`${path}: прежняя версия ${expected} не найдена в истории Git.`); continue }
    historyBytes += Buffer.byteLength(previous)
    if (historyBytes > 4 * 1024 * 1024) {
      errors.push('Прежние схемы превышают 4 MB; разделите область ревью таблиц.')
      break
    }
    history.push({ path: `history/${expected}/${path}`, content: previous })
  }
  return { files: history, errors }
}

export function makeCodeReviewPacket({ root, slug }) {
  codeReviewPath(root, slug)
  const corpus = collectImplementation({ root, slug })
  // Progress and generated prompts must not invalidate a review. Keep only
  // the task requirements and real implementation sources in the packet.
  const planPath = `${slug}/PLAN.md`
  const files = corpus.files.filter(file => !file.path.startsWith(`${slug}/tasks/`) &&
    file.path !== `${slug}/tests/records.ts` && file.path !== `${slug}/tests/automation-smoke.json` &&
    !new RegExp(`^${slug}/creative/[^/]+/build\\.md$`).test(file.path))
    .map(file => file.path === planPath ? { ...file, content: reviewPlan(file.content) }
      : file.path === `${slug}/.workspace.json` ? { ...file, content: reviewWorkspace(file.content) }
      : file)
  const tableHistory = previousTableFiles(root, slug, files)
  files.push(...tableHistory.files)
  const plan = parseTaskPlan(files.find(file => file.path === planPath)?.content || '')
  const workTasks = loadTasks(root, slug).tasks.map(task => taskDefinition(task, plan.find(p => p.id === task.planTask)))
  const rubric = JSON.parse(readFileSync(join(SKILL_DIR, 'build/review-questions.json'), 'utf8'))
  if (rubric.version !== 1 || !Array.isArray(rubric.questions) || !rubric.questions.length ||
      rubric.questions.some(q => typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question))
    throw Error('Некорректная рубрика ревью реализации.')
  let paymentNode = false
  try { paymentNode = parseYaml(files.find(file => file.path === `${slug}/process.yaml`)?.content || '')?.nodes
    ?.some(node => node?.kind === 'payment') === true }
  catch { /* A malformed map is reported by the static checks. */ }
  const paymentCode = files.some(file => /\.(?:ts|tsx)$/.test(file.path) && /\brunAttemptPayment\s*\(/.test(file.content))
  const paymentQuestions = paymentNode || paymentCode ? [{ id: 'payments.smoke',
    question: 'Подготовлена ли тестовая оплата без риска списания через боевого провайдера?',
    lookFor: 'Для каждого тестового вызова runAttemptPayment проверь, что реальный providerId найден через @pay/sdk для ключа pay:sandbox, совпадает с найденным провайдером и передан явно. Без providerId Pay выбирает провайдера по умолчанию. Песочница может быть скрыта из списка; при её недоступности тест останавливается, а не переключается на боевой провайдер. Отдельно оцени контакты, чеки и побочные эффекты; до фактического smoke нужен безопасный сценарий, после него — ID попытки и результат. Не утверждай, что один только текст теста доказывает проведённую оплату.' }]
    : []
  const questions = [...rubric.questions, ...paymentQuestions, ...corpus.tasks.map(task => ({ id: `plan.${task.id}`,
    question: `Сопоставь задачу ${task.id} «${task.title}» с реализацией.`,
    lookFor: 'Конкретные файлы, цепочка вызовов и требование плана. Не считать отметку выполненности доказательством. Для теста/запуска оцени готовность сценариев и механизма до фактического выполнения.' }))]
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw Error('Повторяются вопросы или ID задач плана.')
  const base = { version: 1, process: slug, stage: 'implementation',
    rubricVersion: rubric.version, questions, tasks: corpus.tasks.map(({ markedDone, ...task }) => task), workTasks,
    reviewerInstructions: readFileSync(join(SKILL_DIR, 'build/reviewer.md'), 'utf8'),
    files, assets: corpus.assets, dependencies: corpus.dependencies,
    staticChecks: [...corpus.checks, { id: 'table-schema-history', title: 'Прежние схемы заполненных таблиц',
      ok: !tableHistory.errors.length, errors: tableHistory.errors, warnings: [] }] }
  return withReferenceLibrary(base, collectReferenceLibrary({ root, slug, stage: 'implementation' }))
}
export function recordCodeReview({ root, slug, packet, report, agentReference, packetDirectory }) {
  if (typeof agentReference !== 'string' || !agentReference.trim() || agentReference.length > 500) throw Error('Нужен идентификатор реального вызова reviewer.')
  const current = makeCodeReviewPacket({ root, slug })
  if (packet.inputDigest !== current.inputDigest) throw Error('Исходники, план, зависимости или критерии изменились. Подготовьте новый пакет и повторите ревью.')
  if (packetDirectory) verifyReferenceSnapshot(packetDirectory, packet.referenceLibrary)
  const referenceHashes = inspectedReferenceHashes(packet.referenceLibrary, report.inspectedReferences)
  const changed = changedInspectedReferences({ referenceHashes, ruleDigests: packet.referenceLibrary.ruleDigests }, current.referenceLibrary)
  if (changed.length) throw Error(`Прочитанные справки изменились после подготовки пакета: ${changed.join(', ')}`)
  const result = validateReview(report, current)
  const saved = { version: 1, process: slug, stage: 'implementation', status: result.status, inputDigest: current.inputDigest,
    reviewer: { kind: 'subagent', reference: agentReference }, reviewedAt: new Date().toISOString(),
    inspectedFiles: report.inspectedFiles, inspectedReferences: report.inspectedReferences,
    referenceHashes, ruleDigests: packet.referenceLibrary.ruleDigests, rubricVersion: current.rubricVersion,
    skillVersion: packet.referenceLibrary.files.find(file => file.path === 'skills/processes/SKILL.md')?.sha256,
    answers: result.answers }
  const path = codeReviewPath(root, slug)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(saved, null, 2) + '\n')
  return { ...result, path }
}
export function codeReviewStatus({ root, slug }) {
  const path = codeReviewPath(root, slug), packet = makeCodeReviewPacket({ root, slug })
  if (!existsSync(path)) return { status: 'missing', path, inputDigest: packet.inputDigest,
    error: 'Нет независимого ревью реализации. До тестового прогона выполните code-review.mjs prepare.' }
  const report = JSON.parse(readFileSync(path, 'utf8'))
  if (report.process !== slug || report.stage !== 'implementation' || report.version !== 1)
    throw Error('Отчёт не соответствует процессу или роли.')
  if (report.reviewer?.kind !== 'subagent' || typeof report.reviewer.reference !== 'string' || !report.reviewer.reference.trim() || !Number.isFinite(Date.parse(report.reviewedAt)))
    throw Error('В отчёте нет сведений о независимом reviewer и времени проверки.')
  const changedReferences = changedInspectedReferences(report, packet.referenceLibrary)
  if (changedReferences.length) return { status: 'stale', path, changedReferences,
    error: `Изменились прочитанные справки: ${changedReferences.join(', ')}. Повторите заключение по этой роли.` }
  if (report.inputDigest !== packet.inputDigest) return { status: 'stale', path,
    error: 'Код, зависимости, план, критерии или обязательные правила изменились после ревью. Нужна новая проверка реализации.' }
  return { ...validateReview(report, packet), path, inputDigest: packet.inputDigest,
    informationalReferences: informationalReferenceChanges(report, packet.referenceLibrary),
    reviewedAt: report.reviewedAt, reviewer: report.reviewer }
}
