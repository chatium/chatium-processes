import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { collectKnowledge } from './knowledge.mjs'
import { canonicalTarget, validateReview } from './knowledge-review.mjs'
import { isProcessSlug, SKILL_DIR } from './project.mjs'
import { changedInspectedReferences, collectReferenceLibrary, informationalReferenceChanges, inspectedReferenceHashes, verifyReferenceSnapshot, withReferenceLibrary } from './review-library.mjs'

export function architectureReviewPath(root, slug) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  const path = resolve(root, slug, 'reviews', 'architecture.json')
  const base = realpathSync(root), target = canonicalTarget(path)
  if (!target.startsWith(base + sep)) throw Error('Путь заключения выходит за пределы аккаунта.')
  return path
}

export function makeArchitectureReviewPacket({ root, slug, skillDir = SKILL_DIR }) {
  architectureReviewPath(root, slug)
  const knowledge = collectKnowledge({ root, slug })
  const account = realpathSync(root)
  const specFiles = ['events.yaml', 'analytics.yaml', 'site.yaml', 'services.yaml', 'data.yaml'].flatMap(name => {
    const path = join(root, slug, 'specs', name)
    if (!existsSync(path)) return []
    if (!realpathSync(path).startsWith(account + sep) || !statSync(path).isFile() || statSync(path).size > 80_000)
      throw Error(`Спецификация ${name} недоступна или слишком велика для ревью.`)
    return [{ path: `${slug}/specs/${name}`, content: readFileSync(path, 'utf8') }]
  })
  const rubric = JSON.parse(readFileSync(join(skillDir, 'build/architecture-review-questions.json'), 'utf8'))
  if (rubric.version !== 1 || !Array.isArray(rubric.questions) || !rubric.questions.length ||
      new Set(rubric.questions.map(question => question.id)).size !== rubric.questions.length ||
      rubric.questions.some(question => typeof question.id !== 'string' || !question.id ||
        typeof question.question !== 'string' || !question.question))
    throw Error('Некорректная рубрика архитектуры.')
  const base = { version: 1, process: slug, stage: 'architecture', rubricVersion: rubric.version,
    questions: rubric.questions, reviewerInstructions: readFileSync(join(skillDir, 'build/architecture-reviewer.md'), 'utf8'),
    files: [...knowledge.files, ...specFiles].sort((a, b) => a.path.localeCompare(b.path)), staticChecks: knowledge.checks }
  return withReferenceLibrary(base, collectReferenceLibrary({ root, slug, stage: 'architecture', skillDir }))
}

export function recordArchitectureReview({ root, slug, packet, report, agentReference, packetDirectory, skillDir = SKILL_DIR }) {
  if (typeof agentReference !== 'string' || !agentReference.trim() || agentReference.length > 500)
    throw Error('Нужен идентификатор реального вызова reviewer.')
  const current = makeArchitectureReviewPacket({ root, slug, skillDir })
  if (packet.inputDigest !== current.inputDigest) throw Error('План, карта, знания или рубрика изменились. Подготовьте новое заключение.')
  if (packetDirectory) verifyReferenceSnapshot(packetDirectory, packet.referenceLibrary)
  const referenceHashes = inspectedReferenceHashes(packet.referenceLibrary, report.inspectedReferences)
  const changed = changedInspectedReferences({ referenceHashes, ruleDigests: packet.referenceLibrary.ruleDigests }, current.referenceLibrary)
  if (changed.length) throw Error(`Прочитанные справки изменились: ${changed.join(', ')}`)
  const result = validateReview(report, current)
  const path = architectureReviewPath(root, slug)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, process: slug, stage: 'architecture',
    status: result.status, inputDigest: current.inputDigest, rubricVersion: current.rubricVersion,
    reviewer: { kind: 'subagent', reference: agentReference }, reviewedAt: new Date().toISOString(),
    inspectedFiles: report.inspectedFiles, inspectedReferences: report.inspectedReferences,
    referenceHashes, ruleDigests: packet.referenceLibrary.ruleDigests,
    skillVersion: packet.referenceLibrary.files.find(file => file.path === 'skills/processes/SKILL.md')?.sha256,
    answers: result.answers }, null, 2) + '\n')
  return { ...result, path }
}

export function architectureReviewStatus({ root, slug, skillDir = SKILL_DIR }) {
  const path = architectureReviewPath(root, slug), packet = makeArchitectureReviewPacket({ root, slug, skillDir })
  if (!existsSync(path)) return { status: 'missing', path, error: 'Нет независимого заключения по архитектуре.' }
  const report = JSON.parse(readFileSync(path, 'utf8'))
  if (report.version !== 1 || report.process !== slug || report.stage !== 'architecture' ||
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
