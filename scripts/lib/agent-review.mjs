import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { validateProcessAgents } from './agents.mjs'
import { collectImplementation } from './implementation.mjs'
import { canonicalTarget, validateReview } from './knowledge-review.mjs'
import { isProcessSlug, SKILL_DIR } from './project.mjs'
import { changedInspectedReferences, collectReferenceLibrary, informationalReferenceChanges, inspectedReferenceHashes, verifyReferenceSnapshot, withReferenceLibrary } from './review-library.mjs'
import { parseYaml } from './yaml.mjs'

export function agentReviewPath(root, slug) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  const path = resolve(root, slug, 'reviews', 'agents.json')
  const base = realpathSync(root), target = canonicalTarget(path)
  if (!target.startsWith(base + sep)) throw Error('Путь отчёта выходит за пределы аккаунта.')
  return path
}

function agentSubject(corpus, slug, agents) {
  const all = [...corpus.files, ...corpus.assets], known = new Set(all.map(file => file.path))
  const selected = new Set(), errors = []
  const include = (path, required = false) => {
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('\\') ||
        path.split('/').some(part => !part || part === '.' || part === '..')) {
      if (required) errors.push(`Некорректный путь источника помощника: ${path}`)
      return
    }
    const matches = all.filter(file => file.path === path || file.path.startsWith(`${path}/`) ||
      /^\.(?:[cm]?[jt]sx?|vue|json|ya?ml)$/.test(file.path.slice(path.length)) && file.path.startsWith(path))
    if (!matches.length && required) errors.push(`Нет источника помощника в пакете: ${path}`)
    for (const file of matches) selected.add(file.path)
  }
  for (const path of ['package.json', 'tsconfig.json', '.dir.json', `${slug}/.dir.json`,
    `${slug}/.workspace.json`, `${slug}/PLAN.md`, `${slug}/process.yaml`,
    `${slug}/agents`, `${slug}/specs/services.yaml`, `${slug}/review-scope.json`,
    `.knowledge-base/processes/${slug}/overview.md`]) include(path)
  for (const file of corpus.files) if (file.path.startsWith(`${slug}/tests/`) &&
      /\/(?:ai|agent)[^/]*\.(?:json|ya?ml|md)$/i.test(file.path)) selected.add(file.path)
  for (const agent of agents.filter(value => value && typeof value === 'object')) {
    include(agent.config, true)
    for (const source of (Array.isArray(agent.knowledge) ? agent.knowledge : [])) include(source, true)
    for (const tool of (Array.isArray(agent.tools) ? agent.tools : []))
      if (typeof tool?.source === 'string' && !/^(?:@|[a-z][a-z0-9+.-]*:)/i.test(tool.source)) include(tool.source, true)
    if (agent.delivery?.handler) include(agent.delivery.handler, true)
    const config = corpus.files.find(file => file.path === agent.config)
    if (!config) continue
    try {
      for (const tool of JSON.parse(config.content).enabledTools || [])
        if (tool?.isWorkspaceTool && typeof tool.path === 'string') include(`${slug}/${tool.path}`, true)
    } catch { /* validateProcessAgents reports malformed configuration */ }
  }
  const local = corpus.dependencies.filter(dep => dep.kind === 'local' || dep.kind === 'configured-local')
  for (const path of selected) {
    for (const dep of local) if (dep.source === path && dep.target && !selected.has(dep.target))
      include(dep.target, true)
  }
  const scopedErrors = corpus.checks.flatMap(check => check.errors).filter(error =>
    /Превышен лимит/.test(error) || [...selected].some(path => error.includes(path)))
  return { files: corpus.files.filter(file => selected.has(file.path)),
    assets: corpus.assets.filter(file => selected.has(file.path)),
    dependencies: corpus.dependencies.filter(dep => selected.has(dep.source)),
    errors: [...new Set([...errors, ...scopedErrors])] }
}

export function makeAgentReviewPacket({ root, slug }) {
  agentReviewPath(root, slug)
  const corpus = collectImplementation({ root, slug })
  const mapFile = corpus.files.find(file => file.path === `${slug}/process.yaml`)
  let map = null
  if (mapFile) {
    try { map = parseYaml(mapFile.content) }
    catch (error) { /* static checks report malformed map */ }
  }
  const validation = validateProcessAgents({ root, slug, map })
  if (!validation.enabled) throw Error('В процессе нет помощников для отдельного ревью.')
  const rubric = JSON.parse(readFileSync(join(SKILL_DIR, 'build/agent-review-questions.json'), 'utf8'))
  if (rubric.version !== 2 || !Array.isArray(rubric.questions) || !rubric.questions.length ||
      rubric.questions.some(q => typeof q.id !== 'string' || !q.id || typeof q.question !== 'string' || !q.question) ||
      new Set(rubric.questions.map(q => q.id)).size !== rubric.questions.length)
    throw Error('Некорректная рубрика ревью помощников.')
  const specFile = corpus.files.find(file => file.path === `${slug}/agents/spec.yaml`)
  let agents = []
  if (specFile) {
    try {
      const spec = parseYaml(specFile.content)
      agents = Array.isArray(spec?.agents) ? spec.agents : []
    } catch { /* static checks report malformed spec */ }
  }
  const questions = [...rubric.questions, ...agents.filter(a => a?.key).map(a => ({
    id: `role.${a.key}`,
    question: `Проверь самостоятельную роль ${a.key} от согласованной задачи до реального действия и безопасного выхода.`,
    lookFor: 'Фактический конфиг, инструкции, знания, вход, инструменты, сценарии, полномочия, эффект и передача. Укажи конкретные источники и пробелы.',
  }))]
  if (new Set(questions.map(q => q.id)).size !== questions.length) throw Error('Повторяются ID вопросов ревью помощников.')
  const subject = agentSubject(corpus, slug, agents)
  const staticChecks = [{ id: 'agent-source-scope', title: 'Полнота исходников помощника', ok: !subject.errors.length,
    errors: subject.errors, warnings: [] }, { id: 'agents', title: 'Агенты процесса', ok: !validation.errors.length,
    errors: validation.errors, warnings: validation.warnings }]
  const base = { version: 1, process: slug, stage: 'agents', rubricVersion: rubric.version, questions,
    reviewerInstructions: readFileSync(join(SKILL_DIR, 'build/agent-reviewer.md'), 'utf8'),
    files: subject.files, assets: subject.assets, dependencies: subject.dependencies, staticChecks }
  return withReferenceLibrary(base, collectReferenceLibrary({ root, slug, stage: 'agents' }))
}

export function recordAgentReview({ root, slug, packet, report, agentReference, packetDirectory }) {
  if (typeof agentReference !== 'string' || !agentReference.trim() || agentReference.length > 500)
    throw Error('Нужен идентификатор реального вызова reviewer.')
  const current = makeAgentReviewPacket({ root, slug })
  if (packet.inputDigest !== current.inputDigest) throw Error('Материалы или критерии изменились. Подготовьте новый пакет и повторите ревью.')
  if (packetDirectory) verifyReferenceSnapshot(packetDirectory, packet.referenceLibrary)
  const referenceHashes = inspectedReferenceHashes(packet.referenceLibrary, report.inspectedReferences)
  const changed = changedInspectedReferences({ referenceHashes, ruleDigests: packet.referenceLibrary.ruleDigests }, current.referenceLibrary)
  if (changed.length) throw Error(`Прочитанные справки изменились: ${changed.join(', ')}`)
  const result = validateReview(report, current)
  const path = agentReviewPath(root, slug)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ version: 1, process: slug, stage: 'agents', status: result.status,
    inputDigest: current.inputDigest, reviewer: { kind: 'subagent', reference: agentReference },
    reviewedAt: new Date().toISOString(), inspectedFiles: report.inspectedFiles,
    inspectedReferences: report.inspectedReferences, referenceHashes,
    ruleDigests: packet.referenceLibrary.ruleDigests,
    rubricVersion: current.rubricVersion,
    skillVersion: packet.referenceLibrary.files.find(file => file.path === 'skills/processes/SKILL.md')?.sha256,
    answers: result.answers }, null, 2) + '\n')
  return { ...result, path }
}

export function agentReviewStatus({ root, slug }) {
  const path = agentReviewPath(root, slug), packet = makeAgentReviewPacket({ root, slug })
  if (!existsSync(path)) return { status: 'missing', path, inputDigest: packet.inputDigest,
    error: 'Нет независимого ревью помощников. До тестового прогона выполните agent-review.mjs prepare.' }
  const report = JSON.parse(readFileSync(path, 'utf8'))
  if (report.process !== slug || report.stage !== 'agents' || report.version !== 1 ||
      report.reviewer?.kind !== 'subagent' || typeof report.reviewer.reference !== 'string' ||
      !report.reviewer.reference.trim() || !Number.isFinite(Date.parse(report.reviewedAt)))
    throw Error('Неверная принадлежность или происхождение заключения помощников.')
  const changedReferences = changedInspectedReferences(report, packet.referenceLibrary)
  if (changedReferences.length) return { status: 'stale', path, changedReferences,
    error: `Изменились прочитанные справки: ${changedReferences.join(', ')}` }
  if (report.inputDigest !== packet.inputDigest) return { status: 'stale', path,
    error: 'Инструкции, знания, инструменты, сценарии или обязательные правила изменились после ревью помощников.' }
  return { ...validateReview(report, packet), path, inputDigest: packet.inputDigest,
    informationalReferences: informationalReferenceChanges(report, packet.referenceLibrary),
    reviewedAt: report.reviewedAt, reviewer: report.reviewer }
}
