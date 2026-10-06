import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { collectImplementation } from './implementation.mjs'
import { canonicalTarget, validateReview } from './knowledge-review.mjs'
import { isProcessSlug, SKILL_DIR } from './project.mjs'
import { changedInspectedReferences, collectReferenceLibrary, inspectedReferenceHashes, verifyReferenceSnapshot, withReferenceLibrary } from './review-library.mjs'
import { loadTasks, parseTaskPlan, taskDefinition } from './tasks.mjs'

export function codeReviewPath(root, slug) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  const path = resolve(root, slug, 'reviews', 'implementation.json')
  const base = realpathSync(root), canonical = canonicalTarget(path)
  if (!canonical.startsWith(base + sep)) throw Error('Путь отчёта выходит за пределы аккаунта.')
  return path
}
export function makeCodeReviewPacket({ root, slug }) {
  codeReviewPath(root, slug)
  const corpus = collectImplementation({ root, slug })
  // Progress and generated prompts must not invalidate a review. Keep only
  // the task requirements and real implementation sources in the packet.
  const planPath = `${slug}/PLAN.md`
  const files = corpus.files.filter(file => !file.path.startsWith(`${slug}/tasks/`) &&
    !new RegExp(`^${slug}/creative/[^/]+/build\\.md$`).test(file.path))
    .map(file => file.path === planPath ? { ...file, content: file.content.replace(/^- \[[xX ]\] (T\d+)/gm, '- [ ] $1') } : file)
  const plan = parseTaskPlan(files.find(file => file.path === planPath)?.content || '')
  const workTasks = loadTasks(root, slug).tasks.map(task => taskDefinition(task, plan.find(p => p.id === task.planTask)))
  const rubric = JSON.parse(readFileSync(join(SKILL_DIR, 'build/review-questions.json'), 'utf8'))
  if (rubric.version !== 1 || !Array.isArray(rubric.questions) || !rubric.questions.length ||
      rubric.questions.some(q => typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question))
    throw Error('Некорректная рубрика ревью реализации.')
  const questions = [...rubric.questions, ...corpus.tasks.map(task => ({ id: `plan.${task.id}`,
    question: `Сопоставь задачу ${task.id} «${task.title}» с реализацией.`,
    lookFor: 'Конкретные файлы, цепочка вызовов и требование плана. Не считать отметку выполненности доказательством. Для теста/запуска оцени готовность сценариев и механизма до фактического выполнения.' }))]
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw Error('Повторяются вопросы или ID задач плана.')
  const base = { version: 1, process: slug, stage: 'implementation',
    rubricVersion: rubric.version, questions, tasks: corpus.tasks.map(({ markedDone, ...task }) => task), workTasks,
    reviewerInstructions: readFileSync(join(SKILL_DIR, 'build/reviewer.md'), 'utf8'),
    files, assets: corpus.assets, dependencies: corpus.dependencies, staticChecks: corpus.checks }
  return withReferenceLibrary(base, collectReferenceLibrary({ root, slug, stage: 'implementation' }))
}
export function recordCodeReview({ root, slug, packet, report, agentReference, packetDirectory }) {
  if (typeof agentReference !== 'string' || !agentReference.trim() || agentReference.length > 500) throw Error('Нужен идентификатор реального вызова reviewer.')
  const current = makeCodeReviewPacket({ root, slug })
  if (packet.inputDigest !== current.inputDigest) throw Error('Исходники, план, зависимости или критерии изменились. Подготовьте новый пакет и повторите ревью.')
  if (packetDirectory) verifyReferenceSnapshot(packetDirectory, packet.referenceLibrary)
  const referenceHashes = inspectedReferenceHashes(packet.referenceLibrary, report.inspectedReferences)
  const changed = changedInspectedReferences({ referenceHashes }, current.referenceLibrary)
  if (changed.length) throw Error(`Прочитанные справки изменились после подготовки пакета: ${changed.join(', ')}`)
  const result = validateReview(report, current)
  const saved = { version: 1, process: slug, stage: 'implementation', status: result.status, inputDigest: current.inputDigest,
    reviewer: { kind: 'subagent', reference: agentReference }, reviewedAt: new Date().toISOString(),
    inspectedFiles: report.inspectedFiles, inspectedReferences: report.inspectedReferences,
    referenceHashes, rubricVersion: current.rubricVersion,
    skillVersion: current.referenceLibrary.files.find(file => file.path === 'skills/processes/SKILL.md')?.sha256,
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
    reviewedAt: report.reviewedAt, reviewer: report.reviewer }
}
