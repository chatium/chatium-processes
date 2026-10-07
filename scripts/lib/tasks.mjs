import { createHash } from 'node:crypto'
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { canonicalTarget, reviewStatus } from './knowledge-review.mjs'
import { codeReviewStatus } from './code-review.mjs'
import { creativeReviewStatus } from './creative-review.mjs'
import { architectureReviewStatus } from './architecture-review.mjs'
import { analyticsReviewStatus } from './analytics-review.mjs'
import { agentReviewStatus } from './agent-review.mjs'
import { isProcessSlug, SKILL_DIR } from './project.mjs'
import { parseYaml } from './yaml.mjs'

export const TASK_STAGES = ['design', 'build', 'test', 'launch']
export const TASK_STATUSES = ['queued', 'running', 'needs-input', 'ready-to-resume', 'result-ready', 'done', 'failed', 'cancelled']
const KINDS = new Set(['knowledge', 'contract', 'spec', 'build', 'reference', 'code', 'asset', 'report'])
const MODES = new Set(['implement', 'consult', 'produce', 'review', 'verify'])
const EVIDENCE_KINDS = new Set(['test', 'artifact', 'inspection', 'review'])
const SPECIALIST_ROLES = new Set(['marketing', 'copywriter', 'landing', 'email', 'reviewer'])
const str = value => typeof value === 'string' && value.trim().length > 0
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = value => hash(JSON.stringify(value))
const uniq = values => new Set(values).size === values.length
const inside = (base, target) => target === base || target.startsWith(base + sep)
const sensitive = path => path.split(/[\\/]/).some(part =>
  ['.git', 'node_modules', '.cache', '.typings'].includes(part) ||
  /^\.env(?:\.|$)|^(?:credentials|secrets?)\.(?:json|ya?ml|txt|md)$/i.test(part))

export function specialistRolePath(role) {
  if (!SPECIALIST_ROLES.has(role)) throw Error(`Неизвестная роль специалиста: ${role}`)
  const base = realpathSync(join(SKILL_DIR, 'specialists/roles'))
  const path = join(base, `${role}.md`)
  if (!inside(base, canonicalTarget(path)) || !existsSync(path) || !statSync(path).isFile())
    throw Error(`Не найдена безопасная методика роли ${role}`)
  return path
}

export function safeTaskPath(root, path, { mayBeMissing = false } = {}) {
  if (!str(path) || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => !part || part === '..' || part === '.'))
    throw Error(`Некорректный путь задачи: ${path}`)
  const base = realpathSync(root), target = resolve(base, path)
  if (!inside(base, target)) throw Error(`Путь вне аккаунта: ${path}`)
  const canonical = canonicalTarget(target)
  if (!inside(base, canonical)) throw Error(`Ссылка вне аккаунта: ${path}`)
  if (sensitive(path) || sensitive(canonical.slice(base.length + 1))) throw Error(`Нельзя читать секретный или служебный путь: ${path}`)
  if (!mayBeMissing && (!existsSync(target) || !statSync(target).isFile())) throw Error(`Нет файла ${path}`)
  return target
}

export function parseTaskPlan(source) {
  source = source.replace(/\r\n?/g, '\n')
  const section = /(?:^|\n)## Задачи[^\n]*\n([\s\S]*?)(?=\n## |$)/.exec(source)?.[1] || ''
  const tasks = [], byId = new Map(), criterionIds = new Set()
  for (const line of section.split('\n')) {
    const match = /^- \[( |x|X)\] (T\d+)\s+(.+)$/.exec(line)
    if (match) {
      if (byId.has(match[2])) throw Error(`Повторная задача плана ${match[2]}.`)
      const task = { id: match[2], done: match[1] !== ' ', title: match[3].trim(), criteria: [], work: [] }
      tasks.push(task); byId.set(task.id, task)
      continue
    }
    const task = tasks.at(-1)
    if (!task) continue
    const criterion = /^ {2,}- (T\d+\.A\d+) \[(design|build|test|launch)\] (.+)$/.exec(line)
    if (criterion && criterion[1].startsWith(task.id + '.')) {
      if (criterionIds.has(criterion[1])) throw Error(`Повторный критерий плана ${criterion[1]}.`)
      criterionIds.add(criterion[1])
      task.criteria.push({ id: criterion[1], stage: criterion[2], condition: criterion[3].trim() })
      continue
    }
    if (/^ {2,}- Рабочие задачи:/.test(line))
      task.work.push(...[...line.matchAll(/\[(W\d+)\]\(tasks\/(W\d+)\.json\)/g)].filter(m => m[1] === m[2]).map(m => m[1]))
  }
  return tasks.filter(t => t.title !== '…')
}

export function taskDefinition(task, planTask) {
  const selected = task.acceptanceCriteria.flatMap(c => c.planCriteria || [])
  return {
    id: task.id, planTask: task.planTask, planTitle: planTask?.title,
    planCriteria: (planTask?.criteria || []).filter(c => selected.includes(c.id)),
    title: task.title, targetNode: task.targetNode, executor: task.executor,
    mode: task.mode, stage: task.stage, objective: task.objective, scope: task.scope,
    dependsOn: task.dependsOn, inputs: task.inputs, expectedOutputs: task.expectedOutputs,
    steps: task.steps.map(({ id, action }) => ({ id, action })),
    acceptanceCriteria: task.acceptanceCriteria,
  }
}
export const taskDefinitionDigest = (task, planTask) => digest(taskDefinition(task, planTask))

export function taskFile(root, slug, id) {
  if (!isProcessSlug(slug) || !/^W\d+$/.test(id)) throw Error('Нужны корректные ID процесса и задачи W…')
  return safeTaskPath(root, `${slug}/tasks/${id}.json`, { mayBeMissing: true })
}

export function loadTasks(root, slug) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  const dir = safeTaskPath(root, `${slug}/tasks`, { mayBeMissing: true })
  if (!existsSync(dir)) return { enabled: false, tasks: [] }
  if (!lstatSync(dir).isDirectory()) throw Error('tasks должен быть каталогом.')
  const names = readdirSync(dir)
  if (!names.includes('index.json') || lstatSync(join(dir, 'index.json')).isSymbolicLink() ||
      JSON.parse(readFileSync(safeTaskPath(root, `${slug}/tasks/index.json`), 'utf8')).version !== 1)
    throw Error('Нет корректного tasks/index.json версии 1.')
  const unexpected = names.filter(name => name.endsWith('.json') && name !== 'index.json' && !/^W\d+\.json$/.test(name))
  if (unexpected.length) throw Error(`Неизвестные JSON-карточки: ${unexpected.join(', ')}`)
  const files = names.filter(name => /^W\d+\.json$/.test(name)).sort()
  if (files.length > 200) throw Error('Слишком много рабочих задач (максимум 200).')
  const tasks = files.map(name => {
    const path = join(dir, name)
    if (lstatSync(path).isSymbolicLink()) throw Error(`Карточка ${name} не может быть ссылкой.`)
    if (lstatSync(path).size > 64 * 1024) throw Error(`Слишком большая карточка ${name}`)
    const task = JSON.parse(readFileSync(safeTaskPath(root, `${slug}/tasks/${name}`), 'utf8'))
    if (`${task?.id}.json` !== name) throw Error(`ID в карточке ${name} не совпадает с именем файла.`)
    return task
  })
  return { enabled: true, tasks }
}

function taskErrors(task, plan) {
  const errors = []
  const need = (ok, message) => { if (!ok) errors.push(`${task?.id || '?'}: ${message}`) }
  need(task?.version === 1, 'нужна version: 1')
  need(/^W\d+$/.test(task?.id || ''), 'некорректный ID')
  need(/^T\d+$/.test(task?.planTask || '') && plan.some(t => t.id === task.planTask), 'нет T-задачи в PLAN.md')
  need(str(task?.title) && str(task?.objective), 'нужны название и цель')
  need(['main', 'specialist'].includes(task?.executor?.kind) &&
    /^[a-z][a-z0-9-]{0,40}$/.test(task?.executor?.role || '') &&
    (task?.executor?.kind !== 'specialist' || SPECIALIST_ROLES.has(task.executor.role)), 'нужен известный безопасный исполнитель')
  need(MODES.has(task?.mode), 'неизвестный режим')
  if (task?.executor?.kind === 'specialist')
    need(task.mode !== 'implement', 'специалист не реализует код или итоговые файлы процесса; используй consult/produce/review/verify, реализация — задача main')
  if (task?.executor?.kind === 'specialist' && Array.isArray(task.expectedOutputs))
    need(task.expectedOutputs.every(o => typeof o.path === 'string' && /\/(?:proposals|reviews)\//.test(o.path) && /\.(?:md|json)$/.test(o.path)),
      'результат специалиста — предложение или отчёт в proposals/ или reviews/, не код, spec.yaml, build.md или финальное письмо')
  need(TASK_STAGES.includes(task?.stage), 'неизвестный рубеж готовности')
  need(TASK_STATUSES.includes(task?.status), 'неизвестное состояние')
  need(Number.isInteger(task?.revision) && task.revision >= 0, 'нужна revision')
  need(Array.isArray(task?.dependsOn) && task.dependsOn.every(id => /^W\d+$/.test(id)) && uniq(task.dependsOn || []), 'неверные зависимости')
  need(Array.isArray(task?.inputs) && task.inputs.every(i => KINDS.has(i.kind) && str(i.path) && str(i.purpose)) && uniq((task.inputs || []).map(i => i.path)), 'неверные inputs')
  need(Array.isArray(task?.expectedOutputs) && task.expectedOutputs.length > 0 &&
    task.expectedOutputs.every(o => str(o.path) && !o.path.endsWith('/') && str(o.purpose)) &&
    uniq((task.expectedOutputs || []).map(o => o.path)), 'нужны точные пути файлов результата, не папки')
  need(Array.isArray(task?.scope?.includes) && Array.isArray(task?.scope?.excludes), 'нужны границы задачи')
  need(Array.isArray(task?.steps) && task.steps.every(s => str(s.id) && str(s.action) && ['todo', 'doing', 'done', 'skipped'].includes(s.status) && (s.status !== 'skipped' || str(s.reason))) && uniq((task.steps || []).map(s => s.id)), 'неверные шаги')
  need(Array.isArray(task?.acceptanceCriteria) && task.acceptanceCriteria.length > 0 &&
    task.acceptanceCriteria.every(c => str(c.id) && str(c.condition) && Array.isArray(c.planCriteria) &&
      c.planCriteria.every(id => /^T\d+\.A\d+$/.test(id)) && EVIDENCE_KINDS.has(c.verification?.kind) && str(c.verification?.instruction)) &&
    uniq((task.acceptanceCriteria || []).map(c => c.id)), 'нужны конкретные критерии приёмки')
  need(Array.isArray(task?.questions) && task.questions.every(q => str(q.id) && str(q.question) && str(q.why) && typeof q.blocking === 'boolean' && ['open', 'resolved'].includes(q.status)) && uniq((task.questions || []).map(q => q.id)), 'неверные вопросы')
  need(Array.isArray(task?.drafts) && Array.isArray(task?.attempts), 'нужны drafts и attempts')
  const t = plan.find(t => t.id === task?.planTask)
  for (const c of task?.acceptanceCriteria || []) for (const id of c.planCriteria || []) {
    const target = t?.criteria.find(x => x.id === id)
    need(Boolean(target), `нет критерия плана ${id}`)
    if (target) need(TASK_STAGES.indexOf(task.stage) <= TASK_STAGES.indexOf(target.stage), `${id}: рабочая задача назначена позже срока`)
  }
  return errors
}

function fileHash(root, path) {
  const file = safeTaskPath(root, path)
  if (statSync(file).size > 10 * 1024 * 1024) throw Error(`Слишком большой файл задачи ${path}`)
  return hash(readFileSync(file))
}

function currentReviewStatus(root, slug, path) {
  if (path === `${slug}/reviews/implementation.json`) return codeReviewStatus({ root, slug })
  if (path === `${slug}/reviews/architecture.json`) return architectureReviewStatus({ root, slug })
  if (path === `${slug}/reviews/analytics.json`) return analyticsReviewStatus({ root, slug })
  if (path === `${slug}/reviews/agents.json`) return agentReviewStatus({ root, slug })
  const knowledge = new RegExp(`^${slug}/reviews/knowledge-(design|build|launch)\\.json$`).exec(path)
  if (knowledge) return reviewStatus({ root, slug, stage: knowledge[1] })
  const creative = new RegExp(`^${slug}/reviews/creative/([^/]+)-(spec|result)\\.json$`).exec(path)
  if (creative) return creativeReviewStatus({ root, slug, nodeId: creative[1], stage: creative[2] })
  throw Error(`Неподдерживаемый отчёт независимого ревью: ${path}`)
}

export function expandedTaskInputs(root, task) {
  const inputs = [...task.inputs]
  const seen = new Set(inputs.map(input => input.path))
  for (const question of task.questions || []) for (const path of question.status === 'resolved' ? question.answer?.sourceRefs || [] : []) {
    if (seen.has(path)) continue
    safeTaskPath(root, path)
    inputs.push({ kind: 'knowledge', path, purpose: `Ответ на ${question.id}` })
    seen.add(path)
  }
  for (const input of task.inputs.filter(i => i.kind === 'build')) {
    const first = readFileSync(safeTaskPath(root, input.path), 'utf8').split('\n', 1)[0]
    const match = /^<!-- creative-build-v1 (\{.*\}) -->$/.exec(first)
    if (!match) throw Error(`${input.path}: нет заголовка с версией задания.`)
    const manifest = JSON.parse(match[1])
    if (!Array.isArray(manifest.requiredReferences) || !Array.isArray(manifest.requiredInputs) ||
        !manifest.generated || !manifest.inputDigest) throw Error(`${input.path}: неполный заголовок задания.`)
    for (const item of manifest.requiredInputs) {
      const path = typeof item === 'string' ? item : item?.path
      const kind = typeof item === 'string' ? 'spec' : item?.kind
      if (!str(path) || !KINDS.has(kind)) throw Error(`${input.path}: неверный список обязательных входов.`)
      if (seen.has(path)) continue
      safeTaskPath(root, path)
      inputs.push({ kind, path, purpose: 'Исходный материал задания' })
      seen.add(path)
    }
    for (const path of manifest.requiredReferences) if (!seen.has(path)) {
      safeTaskPath(root, path)
      inputs.push({ kind: 'reference', path, purpose: 'Обязательный референс из задания' })
      seen.add(path)
    }
  }
  return inputs
}

export function taskInputDigest(root, task) {
  const outputs = new Set((task.expectedOutputs || []).map(o => o.path))
  const parts = expandedTaskInputs(root, task).filter(input => !outputs.has(input.path))
    .map(input => ({ kind: input.kind, path: input.path, sha256: fileHash(root, input.path) }))
  const answers = (task.questions || []).filter(q => q.status === 'resolved')
    .map(q => ({ id: q.id, summary: q.answer?.summary, sourceRefs: q.answer?.sourceRefs }))
  const role = task.executor?.kind === 'specialist' ?
    { name: task.executor.role, sha256: hash(readFileSync(specialistRolePath(task.executor.role))) } : null
  return digest({ parts, answers, role })
}

export function acceptanceErrors(root, slug, task, plan, allTasks, reviewCache = new Map()) {
  const errors = [], add = value => errors.push(`${task.id}: ${value}`)
  if (!task.result || !str(task.result.summary)) { add('нет результата'); return errors }
  if (!task.attempts?.some(a => a.id === task.result.attemptId)) add('нет попытки результата')
  const acceptedAttempt = task.attempts?.find(a => a.id === task.result.attemptId)
  if (acceptedAttempt?.baseInputs?.length && !str(acceptedAttempt.baseVerifiedAt)) add('не сверена исходная версия существующего файла')
  if (task.executor?.kind === 'specialist') {
    const attempt = task.attempts?.find(a => a.id === task.result.attemptId)
    if (!str(attempt?.session?.agentId) || !str(attempt?.responseRef)) add('нет привязанного вызова и ответа специалиста')
  }
  if (task.questions?.some(q => q.status !== 'resolved')) add('остались открытые вопросы')
  if (task.steps?.some(s => s.status !== 'done' && s.status !== 'skipped')) add('остались незавершённые шаги')
  for (const id of task.dependsOn || []) if (allTasks.find(t => t.id === id)?.status !== 'done') add(`зависимость ${id} не завершена`)
  const expected = new Set((task.expectedOutputs || []).map(o => o.path))
  const outputs = task.result.outputs || []
  if (outputs.length !== expected.size || !uniq(outputs.map(o => o.path)) || outputs.some(o => !expected.has(o.path))) add('набор результатов не совпадает с ожидаемым')
  for (const output of outputs) try {
    if (output.sha256 !== fileHash(root, output.path)) add(`неверный хеш результата ${output.path}`)
  } catch (e) { add(e.message) }
  const criteria = task.acceptanceCriteria || [], results = task.result.criteriaResults || []
  if (results.length !== criteria.length || !uniq(results.map(r => r.criterionId))) add('нет исхода ровно для каждого критерия')
  for (const criterion of criteria) {
    const result = results.find(r => r.criterionId === criterion.id)
    if (result?.outcome !== 'pass') { add(`${criterion.id}: не подтверждён pass`); continue }
    if (!Array.isArray(result.evidence) || !result.evidence.length) { add(`${criterion.id}: нет подтверждения`); continue }
    for (const evidence of result.evidence) {
      if (!str(evidence.path) || !str(evidence.sha256) || !str(evidence.locator) || !str(evidence.observation)) { add(`${criterion.id}: неполное подтверждение`); continue }
      try {
        if (evidence.sha256 !== fileHash(root, evidence.path)) { add(`${criterion.id}: подтверждение изменено`); continue }
        if (criterion.verification.kind === 'test') {
          const report = JSON.parse(readFileSync(safeTaskPath(root, evidence.path), 'utf8'))
          if (report.version !== 1 || !str(report.method) || report.inputDigest !== taskInputDigest(root, task) ||
              !Array.isArray(report.testedFiles)) add(`${criterion.id}: отчёт не привязан к версии входов и способу проверки`)
          else {
            const files = new Map(report.testedFiles.map(file => [file.path, file.sha256]))
            if (files.size !== report.testedFiles.length || outputs.some(output => files.get(output.path) !== output.sha256))
              add(`${criterion.id}: отчёт не проверял текущие результаты`)
          }
          if (!report.checks?.some(c => c.id === evidence.locator && c.status === 'pass')) add(`${criterion.id}: отчёт не содержит пройденную проверку ${evidence.locator}`)
        }
        if (criterion.verification.kind === 'review') {
          const report = JSON.parse(readFileSync(safeTaskPath(root, evidence.path), 'utf8'))
          if (report.status !== 'ready' || report.reviewer?.kind !== 'subagent' || !str(report.reviewer?.reference)) add(`${criterion.id}: нет независимого положительного ревью`)
          else {
            try {
              const current = reviewCache.has(evidence.path) ? reviewCache.get(evidence.path) :
                currentReviewStatus(root, slug, evidence.path)
              reviewCache.set(evidence.path, current)
              if (current.status !== 'ready') add(`${criterion.id}: ревью устарело (${current.status})`)
            } catch (error) { add(`${criterion.id}: ${error.message}`) }
          }
        }
      } catch (e) { add(`${criterion.id}: ${e.message}`) }
    }
  }
  if (!plan.find(p => p.id === task.planTask)) add('нет T-задачи')
  return errors
}

export function creativeNode(root, slug, nodeId, paths = []) {
  const mapPath = safeTaskPath(root, `${slug}/process.yaml`, { mayBeMissing: true })
  if (!existsSync(mapPath)) return null
  if (statSync(mapPath).size > 1024 * 1024) throw Error('Слишком большая карта процесса.')
  const map = parseYaml(readFileSync(mapPath, 'utf8'))
  const nodes = (map?.nodes || []).filter(item => ['page', 'series'].includes(item?.kind))
  const node = nodes.find(item => item.id === nodeId)
  const matched = nodes.filter(item => paths.some(path => creativeOutput(item, path) ||
    path === `${slug}/creative/${item.id}/build.md`))
  if (matched.length > 1) throw Error('Результаты одной карточки принадлежат разным страницам или сериям.')
  if (matched.length && matched[0].id !== nodeId)
    throw Error(`Результат ${matched[0].id} указан в карточке с targetNode ${nodeId}.`)
  return node || null
}

export function creativeOutput(node, path) {
  if (!str(node?.source) || !str(path)) return false
  return path === node.source || path.startsWith(node.source.endsWith('/') ? node.source : `${node.source}/`)
}

export function creativeTaskChain({ root, slug, node, tasks }) {
  const errors = [], role = node.kind === 'page' ? 'landing' : 'email'
  const active = tasks.filter(task => task.status !== 'cancelled' && task.targetNode === node.id)
  const experts = active.filter(task => task.executor?.kind === 'specialist' && task.executor.role === role && task.mode === 'produce')
  if (!experts.length) errors.push(`${node.id}: нет задачи специалиста ${role} на подготовку материала`)
  const specPath = `${slug}/creative/${node.id}/spec.yaml`
  const specTask = active.find(task => task.executor?.kind === 'main' && task.mode === 'produce' &&
    task.expectedOutputs?.some(output => output.path === specPath))
  if (!specTask) errors.push(`${node.id}: нет задачи main на итоговый ${specPath}`)
  else if (!experts.some(task => specTask.dependsOn?.includes(task.id)))
    errors.push(`${node.id}: задача main на spec.yaml не зависит от специалиста ${role}`)
  else if (!experts.some(task => specTask.dependsOn?.includes(task.id) &&
      task.expectedOutputs?.some(output => specTask.inputs?.some(input => input.path === output.path))))
    errors.push(`${node.id}: задача main на spec.yaml не читает предложение специалиста ${role}`)
  const buildPath = `${slug}/creative/${node.id}/build.md`
  const implementations = active.filter(task => task.executor?.kind === 'main' && task.mode === 'implement' &&
    (task.inputs?.some(input => input.kind === 'build' && input.path === buildPath) ||
      task.expectedOutputs?.some(output => creativeOutput(node, output.path))))
  if (node.kind === 'page') {
    const implementation = implementations.find(task => task.inputs?.some(input => input.kind === 'build' && input.path === buildPath))
    if (!implementation) errors.push(`${node.id}: нет задачи main на реализацию по ${buildPath}`)
    else if (!specTask || !implementation.dependsOn?.includes(specTask.id))
      errors.push(`${node.id}: реализация не зависит от принятого spec.yaml`)
  } else {
    const file = safeTaskPath(root, specPath, { mayBeMissing: true })
    if (!existsSync(file)) errors.push(`${node.id}: нет ${specPath} для учёта каждого сообщения`)
    else {
      if (statSync(file).size > 512 * 1024) throw Error('Слишком большой конфигуратор.')
      const spec = parseYaml(readFileSync(file, 'utf8'))
      if (!Array.isArray(spec?.messages) || !spec.messages.length)
        errors.push(`${node.id}: в spec.yaml нет сообщений для отдельных карточек`)
      else {
        const usedTasks = new Set()
        for (const message of spec.messages) {
          if (!str(message?.id) || !str(message?.path)) continue
          const owners = implementations.filter(task => task.expectedOutputs?.some(output => output.path === message.path))
          if (owners.length !== 1) {
            errors.push(`${node.id}/${message.id}: нужен один точный результат ${message.path} в отдельной задаче main/implement`)
            continue
          }
          const [task] = owners
          if (usedTasks.has(task.id)) errors.push(`${node.id}/${message.id}: каждое сообщение требует отдельную рабочую карточку`)
          usedTasks.add(task.id)
          if (!task.inputs?.some(input => input.kind === 'build' && input.path === buildPath))
            errors.push(`${task.id}: для письма ${message.id} нужен вход ${buildPath}`)
          if (!specTask || !task.dependsOn?.includes(specTask.id))
            errors.push(`${task.id}: письмо ${message.id} не зависит от принятого spec.yaml`)
        }
      }
    }
  }
  return { errors, experts, specTask, implementations }
}

export function taskReadiness({ root, slug, stage = 'build' }) {
  const planPath = safeTaskPath(root, `${slug}/PLAN.md`, { mayBeMissing: true })
  const plan = existsSync(planPath) ? parseTaskPlan(readFileSync(planPath, 'utf8')) : []
  const loaded = loadTasks(root, slug), errors = [], warnings = [], byId = new Map(), reviewCache = new Map()
  if (!loaded.enabled) return { enabled: false, plan, tasks: [], errors, warnings }
  if (!TASK_STAGES.includes(stage)) throw Error('Неизвестный рубеж задач.')
  for (const task of loaded.tasks) {
    errors.push(...taskErrors(task, plan))
    if (byId.has(task.id)) errors.push(`Повторный ID ${task.id}`)
    byId.set(task.id, task)
    const p = plan.find(p => p.id === task.planTask)
    if (p && !p.work.includes(task.id)) errors.push(`${task.id}: нет ссылки из ${p.id} в PLAN.md`)
    for (const input of task.inputs || []) {
      try {
        safeTaskPath(root, input.path, { mayBeMissing: true })
        if (!existsSync(safeTaskPath(root, input.path, { mayBeMissing: true })) &&
            !(task.dependsOn || []).some(id => loaded.tasks.find(t => t.id === id)?.expectedOutputs?.some(o => o.path === input.path)))
          errors.push(`${task.id}: нет обязательного материала ${input.path} и производящей задачи`)
      }
      catch (e) { errors.push(`${task.id}: ${e.message}`) }
    }
  }
  for (const p of plan) {
    for (const id of p.work) if (!byId.has(id)) errors.push(`${p.id}: нет карточки ${id}`)
    for (const c of p.criteria) {
      const covered = loaded.tasks.some(t => t.status !== 'cancelled' && t.planTask === p.id && t.acceptanceCriteria?.some(a => a.planCriteria.includes(c.id)))
      if (!covered) errors.push(`${c.id}: не назначена рабочая задача`)
    }
    if (!p.criteria.length) errors.push(`${p.id}: нужны критерии с ID и рубежом`)
  }
  if (stage !== 'design') {
    const mapPath = safeTaskPath(root, `${slug}/process.yaml`, { mayBeMissing: true })
    if (existsSync(mapPath)) {
      if (statSync(mapPath).size > 1024 * 1024) throw Error('Слишком большая карта процесса.')
      const map = parseYaml(readFileSync(mapPath, 'utf8'))
      for (const node of map?.nodes || []) {
        if (!['page', 'series'].includes(node?.kind)) continue
        errors.push(...creativeTaskChain({ root, slug, node, tasks: loaded.tasks }).errors)
      }
    }
  }
  const seen = new Set(), stack = new Set()
  function visit(id) {
    if (stack.has(id)) { errors.push(`${id}: цикл зависимостей`); return }
    if (seen.has(id)) return
    seen.add(id); stack.add(id)
    for (const dep of byId.get(id)?.dependsOn || []) {
      if (!byId.has(dep)) errors.push(`${id}: нет зависимости ${dep}`)
      else visit(dep)
    }
    stack.delete(id)
  }
  for (const id of byId.keys()) visit(id)
  for (const task of loaded.tasks) {
    const due = TASK_STAGES.indexOf(task.stage) <= TASK_STAGES.indexOf(stage)
    const issue = message => (due ? errors : warnings).push(`${task.id}: ${message}`)
    if (task.status === 'cancelled') {
      if (!str(task.cancellation?.reason) || !(task.cancellation?.replacementTaskIds?.length || str(task.cancellation?.decisionRef))) issue('отмена без причины и судьбы требования')
      continue
    }
    if (task.status !== 'done') { issue(`задача не завершена (${task.status})`); continue }
    try {
      for (const error of acceptanceErrors(root, slug, task, plan, loaded.tasks, reviewCache)) issue(error)
      const currentDefinition = taskDefinitionDigest(task, plan.find(p => p.id === task.planTask))
      if (task.acceptance?.definitionDigest !== currentDefinition) issue('изменилось задание/критерии после приёмки')
      if (task.acceptance?.inputDigest !== taskInputDigest(root, task)) issue('изменились входные материалы после приёмки')
      if (!task.result || task.acceptance?.resultDigest !== digest(task.result)) issue('результат изменён после приёмки')
      for (const o of task.result?.outputs || []) if (fileHash(root, o.path) !== o.sha256) issue(`изменён результат ${o.path}`)
      for (const c of task.result?.criteriaResults || []) for (const e of c.evidence || []) if (fileHash(root, e.path) !== e.sha256) issue(`изменено подтверждение ${e.path}`)
    } catch (e) { issue(e.message) }
  }
  for (const p of plan) {
    const due = p.criteria.filter(c => TASK_STAGES.indexOf(c.stage) <= TASK_STAGES.indexOf(stage))
    if (p.done && p.work.some(id => byId.get(id)?.status !== 'done' && byId.get(id)?.status !== 'cancelled'))
      errors.push(`${p.id}: в плане закрыта задача с незавершёнными рабочими карточками`)
    for (const criterion of due) {
      const assigned = loaded.tasks.filter(t => t.status !== 'cancelled' && t.planTask === p.id && t.acceptanceCriteria?.some(c => c.planCriteria.includes(criterion.id)))
      if (!assigned.length || assigned.some(t => t.status !== 'done')) errors.push(`${criterion.id}: связанные рабочие задачи не приняты`)
    }
    if (!p.done && p.criteria.length && due.length === p.criteria.length &&
        p.work.length && p.work.every(id => byId.get(id)?.status === 'done'))
      errors.push(`${p.id}: все карточки приняты, но задача в PLAN.md остаётся открытой`)
  }
  return { enabled: true, plan, tasks: loaded.tasks, errors, warnings }
}

export function writeTask(root, slug, task, expectedRevision = null) {
  const file = taskFile(root, slug, task.id)
  const exists = existsSync(file)
  if (expectedRevision === null && exists) throw Error(`${task.id} уже существует`)
  if (expectedRevision !== null && (!exists || JSON.parse(readFileSync(file, 'utf8')).revision !== expectedRevision)) throw Error(`${task.id}: карточка изменилась, повторите действие`)
  const planFile = safeTaskPath(root, `${slug}/PLAN.md`), plan = parseTaskPlan(readFileSync(planFile, 'utf8'))
  const issues = taskErrors(task, plan)
  if (issues.length) throw Error(issues.join('; '))
  const content = JSON.stringify(task, null, 2) + '\n'
  if (Buffer.byteLength(content) > 64 * 1024) throw Error(`${task.id}: карточка превышает 64 КБ.`)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, content, { flag: 'wx' })
  renameSync(temporary, file)
  return file
}

function linkedPlanTask(source, task) {
  const lines = source.split('\n')
  const index = lines.findIndex(line => /^- \[(?: |x|X)\] (T\d+)\s/.exec(line)?.[1] === task.planTask)
  if (index < 0) throw Error(`${task.planTask} отсутствует в PLAN.md`)
  let end = index + 1
  while (end < lines.length && !/^(?:- \[(?: |x|X)\] T\d+\s|## )/.test(lines[end])) end++
  const ref = `[${task.id}](tasks/${task.id}.json)`
  const link = lines.findIndex((line, i) => i > index && i < end && /^  - Рабочие задачи:/.test(line))
  if (link >= 0) { if (!lines[link].includes(ref)) lines[link] += `, ${ref}` }
  else lines.splice(end, 0, `  - Рабочие задачи: ${ref}`)
  return lines.join('\n')
}

export function createTasksBatch(root, slug, tasks) {
  if (!Array.isArray(tasks) || !tasks.length || tasks.length > 200)
    throw Error('Пакет должен содержать от 1 до 200 карточек.')
  const lock = safeTaskPath(root, `${slug}/tasks/.create.lock`, { mayBeMissing: true })
  let lockFd
  try { lockFd = openSync(lock, 'wx') }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('Создание задач уже идёт или было прервано: проверьте tasks/.create.lock и состояние карточек перед повтором.')
    throw error
  }
  try {
  writeSync(lockFd, `${process.pid} ${new Date().toISOString()}\n`)
  const planFile = safeTaskPath(root, `${slug}/PLAN.md`)
  const original = readFileSync(planFile, 'utf8')
  const plan = parseTaskPlan(original)
  const current = loadTasks(root, slug)
  if (!current.enabled || current.tasks.length + tasks.length > 200)
    throw Error('Нужен tasks/index.json и не более 200 карточек всего.')
  const ids = tasks.map(task => task?.id)
  if (!uniq(ids)) throw Error('В пакете повторяется ID карточки.')
  let updated = original
  const files = tasks.map(task => {
    if (task?.status !== 'queued' || task?.revision !== 0 || task?.acceptance !== null || task?.result !== null)
      throw Error(`${task?.id || '?'}: новая карточка должна быть queued, revision: 0, без результата и приёмки.`)
    const file = taskFile(root, slug, task.id)
    if (existsSync(file)) throw Error(`${task.id} уже существует.`)
    const issues = taskErrors(task, plan)
    if (issues.length) throw Error(issues.join('; '))
    updated = linkedPlanTask(updated, task)
    const content = JSON.stringify(task, null, 2) + '\n'
    if (Buffer.byteLength(content) > 64 * 1024) throw Error(`${task.id}: карточка превышает 64 КБ.`)
    return { id: task.id, file, content }
  })
  const staged = [], created = []
  try {
    for (const [index, item] of files.entries()) {
      mkdirSync(dirname(item.file), { recursive: true })
      const temporary = `${item.file}.${process.pid}.${Date.now()}.${index}.tmp`
      writeFileSync(temporary, item.content, { flag: 'wx' })
      staged.push(temporary)
    }
    const planTemporary = `${planFile}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(planTemporary, updated, { flag: 'wx' })
    staged.push(planTemporary)
    if (readFileSync(planFile, 'utf8') !== original || files.some(item => existsSync(item.file)))
      throw Error('План или карточки изменились во время подготовки пакета; повторите создание.')
    for (let index = 0; index < files.length; index++) {
      linkSync(staged[index], files[index].file)
      created.push(files[index].file)
    }
    renameSync(planTemporary, planFile)
    return files.map(item => ({ id: item.id, path: item.file }))
  } catch (error) {
    for (const path of created) if (existsSync(path)) unlinkSync(path)
    throw error
  } finally {
    for (const path of staged) if (existsSync(path)) unlinkSync(path)
  }
  } finally {
    closeSync(lockFd)
    unlinkSync(lock)
  }
}
