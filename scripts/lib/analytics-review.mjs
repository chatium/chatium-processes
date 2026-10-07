import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { collectKnowledge } from './knowledge.mjs'
import { canonicalTarget, validateReview } from './knowledge-review.mjs'
import { isProcessSlug, rel, SKILL_DIR } from './project.mjs'
import { processSourceFiles } from './process-sources.mjs'
import { changedInspectedReferences, collectReferenceLibrary, informationalReferenceChanges, inspectedReferenceHashes, verifyReferenceSnapshot, withReferenceLibrary } from './review-library.mjs'

export function analyticsReviewPath(root, slug) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  const path = resolve(root, slug, 'reviews', 'analytics.json')
  const base = realpathSync(root), target = canonicalTarget(path)
  if (!target.startsWith(base + sep)) throw Error('Путь заключения выходит за пределы аккаунта.')
  return path
}

export function makeAnalyticsReviewPacket({ root, slug, skillDir = SKILL_DIR }) {
  analyticsReviewPath(root, slug)
  const knowledge = collectKnowledge({ root, slug })
  const account = realpathSync(root)
  const specFiles = ['events.yaml', 'analytics.yaml'].flatMap(name => {
    const path = join(root, slug, 'specs', name)
    if (!existsSync(path)) return []
    if (!realpathSync(path).startsWith(account + sep) || !statSync(path).isFile() || statSync(path).size > 80_000)
      throw Error(`Спецификация ${name} недоступна или слишком велика для ревью.`)
    return [{ path: `${slug}/specs/${name}`, content: readFileSync(path, 'utf8') }]
  })
  const codeFiles = processSourceFiles(root, join(root, slug)).filter(path => /\.(?:[cm]?jsx?|[cm]?tsx?|vue)$/.test(path)).map(path => {
    if (!realpathSync(path).startsWith(account + sep) || !statSync(path).isFile() || statSync(path).size > 80_000)
      throw Error(`Исходник ${rel(root, path)} недоступен или слишком велик для ревью.`)
    return { path: rel(root, path), content: readFileSync(path, 'utf8') }
  })
  if (codeFiles.length > 100) throw Error('Слишком много исходников для ревью аналитики.')
  const rubric = JSON.parse(readFileSync(join(skillDir, 'build/analytics-review-questions.json'), 'utf8'))
  if (rubric.version !== 1 || !Array.isArray(rubric.questions) || !rubric.questions.length ||
      new Set(rubric.questions.map(question => question.id)).size !== rubric.questions.length ||
      rubric.questions.some(question => typeof question.id !== 'string' || !question.id ||
        typeof question.question !== 'string' || !question.question))
    throw Error('Некорректная рубрика аналитики.')
  const base = { version: 1, process: slug, stage: 'analytics', rubricVersion: rubric.version,
    questions: rubric.questions, reviewerInstructions: readFileSync(join(skillDir, 'build/analytics-reviewer.md'), 'utf8'),
    files: [...knowledge.files, ...specFiles, ...codeFiles].sort((a, b) => a.path.localeCompare(b.path)), staticChecks: knowledge.checks }
  return withReferenceLibrary(base, collectReferenceLibrary({ root, slug, stage: 'analytics', skillDir }))
}

export function recordAnalyticsReview({ root, slug, packet, report, agentReference, packetDirectory, skillDir = SKILL_DIR }) {
  if (typeof agentReference !== 'string' || !agentReference.trim() || agentReference.length > 500)
    throw Error('Нужен идентификатор реального вызова reviewer.')
  const current = makeAnalyticsReviewPacket({ root, slug, skillDir })
  if (packet.inputDigest !== current.inputDigest) throw Error('План, карта, знания или рубрика изменились. Подготовьте новое заключение.')
  if (packetDirectory) verifyReferenceSnapshot(packetDirectory, packet.referenceLibrary)
  const referenceHashes = inspectedReferenceHashes(packet.referenceLibrary, report.inspectedReferences)
  const changed = changedInspectedReferences({ referenceHashes, ruleDigests: packet.referenceLibrary.ruleDigests }, current.referenceLibrary)
  if (changed.length) throw Error(`Прочитанные справки изменились: ${changed.join(', ')}`)
  const result = validateReview(report, current)
  const path = analyticsReviewPath(root, slug)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, process: slug, stage: 'analytics',
    status: result.status, inputDigest: current.inputDigest, rubricVersion: current.rubricVersion,
    reviewer: { kind: 'subagent', reference: agentReference }, reviewedAt: new Date().toISOString(),
    inspectedFiles: report.inspectedFiles, inspectedReferences: report.inspectedReferences,
    referenceHashes, ruleDigests: packet.referenceLibrary.ruleDigests,
    skillVersion: packet.referenceLibrary.files.find(file => file.path === 'skills/processes/SKILL.md')?.sha256,
    answers: result.answers }, null, 2) + '\n')
  return { ...result, path }
}

export function analyticsReviewStatus({ root, slug, skillDir = SKILL_DIR }) {
  const path = analyticsReviewPath(root, slug), packet = makeAnalyticsReviewPacket({ root, slug, skillDir })
  if (!existsSync(path)) return { status: 'missing', path, error: 'Нет независимого заключения по аналитике.' }
  const report = JSON.parse(readFileSync(path, 'utf8'))
  if (report.version !== 1 || report.process !== slug || report.stage !== 'analytics' ||
      report.reviewer?.kind !== 'subagent' || typeof report.reviewer.reference !== 'string' || !report.reviewer.reference.trim() ||
      !Number.isFinite(Date.parse(report.reviewedAt))) throw Error('Неверная принадлежность или происхождение заключения.')
  const changedReferences = changedInspectedReferences(report, packet.referenceLibrary)
  if (changedReferences.length) return { status: 'stale', path, changedReferences,
    error: `Изменились прочитанные справки: ${changedReferences.join(', ')}` }
  if (report.inputDigest !== packet.inputDigest) return { status: 'stale', path,
    error: 'План, карта, знания, рубрика или обязательные правила изменились.' }
  return { ...validateReview(report, packet), path, reviewedAt: report.reviewedAt, reviewer: report.reviewer,
    informationalReferences: informationalReferenceChanges(report, packet.referenceLibrary) }
}
