import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { collectKnowledge } from './knowledge.mjs'
import { reviewPlan } from './review-normalization.mjs'
import { isProcessSlug, SKILL_DIR } from './project.mjs'
import { changedInspectedReferences, collectReferenceLibrary, informationalReferenceChanges, inspectedReferenceHashes, verifyReferenceSnapshot, withReferenceLibrary } from './review-library.mjs'

export const REVIEW_STAGES = ['design', 'build', 'launch']
const text = value => typeof value === 'string' && value.trim().length > 0
const normalized = value => value.replace(/\s+/gu, ' ').trim()

function collectRiskDecisions(root, slug) {
  const directory = join(root, slug, 'decisions/risk')
  if (!existsSync(directory)) return []
  const account = realpathSync(root)
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() ||
      !realpathSync(directory).startsWith(account + sep))
    throw Error('Каталог решений о рисках недоступен или небезопасен.')
  const names = readdirSync(directory).filter(name => name.endsWith('.json')).sort()
  if (names.length > 20) throw Error('Слишком много решений о рисках для одного пакета ревью.')
  return names.map(name => {
    if (!/^RD\d+\.json$/u.test(name)) throw Error(`Некорректное имя решения о риске: ${name}`)
    const file = join(directory, name)
    const stat = lstatSync(file)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 ||
        !realpathSync(file).startsWith(account + sep))
      throw Error(`Решение о риске ${name} недоступно или слишком велико.`)
    const content = readFileSync(file, 'utf8')
    const decision = JSON.parse(content)
    const id = basename(name, '.json')
    if (decision?.version !== 1 || decision.id !== id ||
        ['recommendation', 'choice', 'consequence', 'scope', 'control'].some(key =>
          !text(decision[key]) || decision[key].length > 3000) ||
        !text(decision.owner?.message) || !text(decision.owner?.messageReference) ||
        !Number.isFinite(Date.parse(decision.owner?.answeredAt)))
      throw Error(`${name}: нужен точный ответ владельца, альтернатива, последствие, граница и контроль по формату решений о рисках.`)
    return { id, path: `${slug}/decisions/risk/${name}`, content }
  })
}

// Resolve an absent target through its nearest existing ancestor. lstat keeps
// dangling symlinks visible, so realpath fails instead of following them on write.
export function canonicalTarget(path) {
  const target = resolve(path)
  let existing = target
  for (;;) {
    try { lstatSync(existing); break }
    catch (e) {
      if (e.code !== 'ENOENT') throw e
      const parent = dirname(existing)
      if (parent === existing) throw e
      existing = parent
    }
  }
  return resolve(realpathSync(existing), relative(existing, target))
}

export function reviewPath(root, slug, stage) {
  if (!isProcessSlug(slug) || !REVIEW_STAGES.includes(stage)) throw Error('Нужны корректный слаг и этап design, build или launch.')
  const target = resolve(root, slug, 'reviews', `knowledge-${stage}.json`)
  const base = realpathSync(root), canonical = canonicalTarget(target)
  if (canonical !== base && !canonical.startsWith(base + sep))
    throw Error('Путь отчёта выходит за пределы аккаунта.')
  return target
}

export function makeReviewPacket({ root, slug, stage = 'build' }) {
  reviewPath(root, slug, stage)
  const knowledge = collectKnowledge({ root, slug })
  const method = join(SKILL_DIR, 'method')
  const rubric = JSON.parse(readFileSync(join(method, 'review-questions.json'), 'utf8'))
  if (rubric.version !== 3 || !Array.isArray(rubric.questions) || !rubric.questions.length ||
      new Set(rubric.questions.map(q => q.id)).size !== rubric.questions.length ||
      rubric.questions.some(q => !text(q.id) || !text(q.question) || !REVIEW_STAGES.includes(q.fromStage)))
    throw Error('Некорректная рубрика ревью знаний.')
  const questions = rubric.questions.filter(q => REVIEW_STAGES.indexOf(q.fromStage) <= REVIEW_STAGES.indexOf(stage))
  const riskDecisions = collectRiskDecisions(root, slug)
  questions.push(...riskDecisions.map(item => ({ id: `risk.${item.id}`, topic: 'cross-cutting', fromStage: 'design',
    question: `Проверено ли отдельное решение ${item.id} вопреки существенной рекомендации и его последствие для этого этапа?`,
    lookFor: 'Точный ответ владельца, предложенная альтернатива, осознанный выбор, последствия, границы и контроль; открытый технический или правовой блокер не исчезает из-за согласия владельца.',
    applicability: 'Зарегистрированное решение обязательно проверяется на каждом зависимом этапе.',
    evidencePaths: [item.path], requiredEvidencePaths: [item.path], allowNotApplicable: false })))
  const reviewerInstructions = readFileSync(join(method, 'reviewer.md'), 'utf8')
  const base = { version: 1, process: slug, stage, rubricVersion: rubric.version, questions,
    reviewerInstructions, files: [...knowledge.files.map(file => file.path === `${slug}/PLAN.md`
      ? { ...file, content: reviewPlan(file.content) } : file),
    ...riskDecisions.map(({ path, content }) => ({ path, content }))], staticChecks: knowledge.checks }
  // Reports themselves, Git SHA, timestamps and unrelated processes are excluded.
  return withReferenceLibrary(base, collectReferenceLibrary({ root, slug, stage }))
}

function checkedString(value, field, max = 5000) {
  if (!text(value) || value.length > max) throw Error(`Некорректное поле ${field}.`)
  return value
}

export function validateReview(report, packet) {
  if (!report || report.version !== 1 || report.process !== packet.process || report.stage !== packet.stage || report.inputDigest !== packet.inputDigest)
    throw Error('Отчёт не соответствует процессу, этапу или версии входных материалов.')
  const files = new Map(packet.files.map(f => [f.path, f.content]))
  if (!Array.isArray(report.inspectedFiles) || report.inspectedFiles.length !== files.size ||
      new Set(report.inspectedFiles).size !== files.size || report.inspectedFiles.some(p => !files.has(p)))
    throw Error('inspectedFiles должен перечислять все файлы пакета ровно один раз.')
  const references = new Set(packet.referenceLibrary.files.map(f => f.path))
  if (!Array.isArray(report.inspectedReferences) || new Set(report.inspectedReferences).size !== report.inspectedReferences.length ||
      report.inspectedReferences.some(p => !references.has(p)) ||
      packet.referenceLibrary.required.some(p => !report.inspectedReferences.includes(p)))
    throw Error('inspectedReferences должен перечислять прочитанные справки без повторов, включая обязательные разделы.')
  const ids = new Set(packet.questions.map(q => q.id))
  const questionById = new Map(packet.questions.map(question => [question.id, question]))
  if (!Array.isArray(report.answers) || report.answers.length !== ids.size) throw Error('Нужен ответ на каждый вопрос рубрики.')
  const answers = report.answers.map(answer => {
    if (!answer || !ids.delete(answer.id)) throw Error('Неизвестный или повторный ID вопроса.')
    if (!['covered', 'gap', 'not-applicable'].includes(answer.status)) throw Error(`Неизвестный статус ${answer.id}.`)
    if (answer.status === 'not-applicable' && questionById.get(answer.id)?.allowNotApplicable === false)
      throw Error(`${answer.id}: зарегистрированное решение нельзя объявить неприменимым.`)
    checkedString(answer.reason, `${answer.id}.reason`)
    if (!Array.isArray(answer.evidence) || answer.evidence.length > 20) throw Error(`Некорректные evidence у ${answer.id}.`)
    if (answer.status !== 'gap' && !answer.evidence.length) throw Error(`Нужна цитата для ${answer.id}.`)
    const evidence = answer.evidence.map(item => {
      if (!item || !files.has(item.path)) throw Error(`Источник ${answer.id} отсутствует в пакете.`)
      const allowed = questionById.get(answer.id)?.evidencePaths
      if (Array.isArray(allowed) && allowed.length && !allowed.some(part =>
        part.endsWith('/') ? item.path.startsWith(part) || item.path.includes(part) : item.path.endsWith(part)))
        throw Error(`Источник ${answer.id} не относится к допустимой области доказательств.`)
      checkedString(item.quote, `${answer.id}.quote`, 2000)
      if (!normalized(files.get(item.path)).includes(normalized(item.quote))) throw Error(`Цитата ${answer.id} не найдена в ${item.path}.`)
      return { path: item.path, quote: item.quote }
    })
    const requiredPaths = questionById.get(answer.id)?.requiredEvidencePaths
    if (answer.status === 'covered' && Array.isArray(requiredPaths) && requiredPaths.length &&
        !evidence.some(item => requiredPaths.some(part => part.endsWith('/') ?
          item.path.startsWith(part) || item.path.includes(part) : item.path.endsWith(part))))
      throw Error(`Для ${answer.id} нужно доказательство из указанного первичного источника, а не только общее описание.`)
    if (answer.status === 'gap') {
      if (!['blocking', 'advisory'].includes(answer.priority)) throw Error(`Нужен приоритет пробела ${answer.id}.`)
      if (answer.id.startsWith('risk.') && answer.priority !== 'blocking')
        throw Error(`${answer.id}: незакрытый пробел в существенном решении блокирует этап.`)
      checkedString(answer.nextAction, `${answer.id}.nextAction`)
    } else if (answer.priority !== undefined || answer.nextAction !== undefined) throw Error(`priority/nextAction допустимы только для gap (${answer.id}).`)
    return { id: answer.id, status: answer.status, reason: answer.reason, evidence,
      ...(answer.status === 'gap' ? { priority: answer.priority, nextAction: answer.nextAction } : {}) }
  })
  const evidenced = answers.filter(answer => answer.status !== 'gap')
  if (evidenced.length >= 3) {
    const signatures = evidenced.map(answer => JSON.stringify(answer.evidence.map(item =>
      [item.path, normalized(item.quote)]).sort((a, b) => a[0].localeCompare(b[0]))))
    if (new Set(signatures).size === 1)
      throw Error('Одна и та же цитата механически повторена для разных вопросов. Нужны относящиеся к каждому выводу доказательства.')
  }
  const blocking = answers.filter(a => a.status === 'gap' && a.priority === 'blocking')
  const advisory = answers.filter(a => a.status === 'gap' && a.priority === 'advisory')
  const structuralErrors = packet.staticChecks.flatMap(c => c.errors)
  return { answers, blocking, advisory, structuralErrors,
    status: blocking.length || structuralErrors.length ? 'needs-work' : 'ready' }
}

export function recordReview({ root, slug, stage, packet, report, agentReference, packetDirectory }) {
  checkedString(agentReference, 'agentReference', 500)
  const current = makeReviewPacket({ root, slug, stage })
  if (packet.inputDigest !== current.inputDigest) throw Error('Материалы или рубрика изменились после подготовки пакета. Подготовьте новый пакет и повторите ревью.')
  if (packetDirectory) verifyReferenceSnapshot(packetDirectory, packet.referenceLibrary)
  const referenceHashes = inspectedReferenceHashes(packet.referenceLibrary, report.inspectedReferences)
  const changed = changedInspectedReferences({ referenceHashes, ruleDigests: packet.referenceLibrary.ruleDigests }, current.referenceLibrary)
  if (changed.length) throw Error(`Прочитанные справки изменились после подготовки пакета: ${changed.join(', ')}`)
  // Validate against freshly read sources, never a potentially modified packet.
  const result = validateReview(report, current)
  const saved = { version: 1, process: slug, stage, status: result.status, inputDigest: current.inputDigest,
    reviewer: { kind: 'subagent', reference: agentReference }, reviewedAt: new Date().toISOString(),
    inspectedFiles: report.inspectedFiles, inspectedReferences: report.inspectedReferences,
    referenceHashes, ruleDigests: packet.referenceLibrary.ruleDigests, rubricVersion: current.rubricVersion,
    skillVersion: packet.referenceLibrary.files.find(file => file.path === 'skills/processes/SKILL.md')?.sha256,
    answers: result.answers }
  const path = reviewPath(root, slug, stage)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(saved, null, 2) + '\n')
  return { ...result, path }
}

export function reviewStatus({ root, slug, stage = 'build' }) {
  const path = reviewPath(root, slug, stage)
  const packet = makeReviewPacket({ root, slug, stage })
  if (!existsSync(path)) return { status: 'missing', stage, path, inputDigest: packet.inputDigest,
    error: `Нет независимого ревью знаний для этапа ${stage}. Запустите kb-review.mjs prepare.` }
  const report = JSON.parse(readFileSync(path, 'utf8'))
  if (report.process !== slug || report.stage !== stage || report.version !== 1)
    throw Error('Отчёт не соответствует процессу или этапу.')
  if (report.reviewer?.kind !== 'subagent' || !text(report.reviewer.reference) || !Number.isFinite(Date.parse(report.reviewedAt)))
    throw Error('В отчёте нет сведений о независимом ревьюере и времени проверки.')
  const changedReferences = changedInspectedReferences(report, packet.referenceLibrary)
  if (changedReferences.length) return { status: 'stale', stage, path, changedReferences,
    error: `Изменились прочитанные справки: ${changedReferences.join(', ')}. Повторите заключение по этой роли.` }
  if (report.inputDigest !== packet.inputDigest) return { status: 'stale', stage, path,
    error: 'Знания, план, карта, критерии или обязательные правила изменились после ревью. Нужна новая проверка субагентом.' }
  return { ...validateReview(report, packet), stage, path, inputDigest: packet.inputDigest,
    informationalReferences: informationalReferenceChanges(report, packet.referenceLibrary),
    reviewedAt: report.reviewedAt, reviewer: report.reviewer }
}
