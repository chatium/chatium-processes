import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, realpathSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { isUtf8 } from 'node:buffer'
import { commissionStatus } from './commission.mjs'
import { ownerDecisionStatus } from './owner-decisions.mjs'
import { taskAcceptanceState, taskReadiness, safeTaskPath, expandedTaskInputs } from './tasks.mjs'
import { processSourceFiles } from './process-sources.mjs'
import { buildContractFingerprint } from './build-state.mjs'
import { rel } from './project.mjs'
import { canonicalTarget } from './knowledge-review.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const limit = values => values.slice(0, 12).map(value => String(value).slice(0, 1000))
const gate = (id, title, state, details = [], evidence = []) => ({ id, title, state, details: limit(details), evidence })
const inside = (path, source) => path === source.replace(/\/$/, '') || path.startsWith(source.replace(/\/$/, '') + '/')
const separate = new Set(['tasks', 'creative', 'creative.review', 'knowledge.review', 'implementation.review', 'reviews', 'owner.plan', 'owner.plan.board', 'owner.launch', 'owner.launch.board', 'process.testing', 'launch.variables', 'owner.questions', 'agents.review', 'typecheck'])
const runtime = path => /\.(?:[cm]?[jt]sx?|vue|json|ya?ml|css|scss|svg)$/.test(path) && !/\/(?:tasks|reviews|decisions|tests)\//.test(path)

/** Uses the same acceptance and review functions as the CLI; no second acceptance engine. */
export function collectBuildEvidence({ root, slug, map, checks = [] }) {
  root = realpathSync(root)
  const referencePath = path => isAbsolute(path) ? rel(root, canonicalTarget(path)) : path
  let work
  const gates = [], nodes = new Map(), inputs = new Set([`${slug}/process.yaml`, `${slug}/.workspace.json`])
  const warnings = []
  try {
    work = taskReadiness({ root, slug, stage: 'build' })
    gates.push(gate('task-structure', 'Связность рабочих задач', !work.enabled ? 'pending' : work.structuralErrors?.length ? 'failed' : 'passed',
      !work.enabled ? ['Нет реестра рабочих задач.'] : work.structuralErrors))
  } catch (error) {
    work = { enabled: false, tasks: [], plan: [] }
    gates.push(gate('task-structure', 'Связность рабочих задач', 'unavailable', [error.message]))
  }
  const technical = checks.filter(check => !separate.has(check.id))
  gates.push(gate('technical', 'Проверки кода и контрактов', !technical.length ? 'pending' : technical.every(c => c.ok) ? 'passed' : 'failed',
    technical.length ? technical.filter(c => !c.ok).flatMap(c => [`${c.title}: ${c.errors[0] || 'проверка не пройдена'}`]) : ['Нужен полный check процесса.']))
  const typecheck = checks.find(check => check.id === 'typecheck')
  gates.push(gate('typecheck', 'Проверка типов аккаунта', typecheck ? typecheck.ok ? 'passed' : 'failed' : 'pending',
    typecheck?.errors || ['Для подтверждения сборки выполните check --typecheck --publish-snapshot.']))
  let reviews = []
  try { reviews = commissionStatus({ root, slug, stage: 'build' }).requirements }
  catch (error) { gates.push(gate('reviews', 'Комиссия сборки', 'unavailable', [error.message])) }
  for (const requirement of reviews) {
    if (requirement.path) inputs.add(referencePath(requirement.path))
    if (!requirement.nodeId) gates.push(reviewGate(requirement))
  }
  try {
    const decision = ownerDecisionStatus({ root, slug, kind: 'plan' })
    if (decision.path) inputs.add(referencePath(decision.path))
    gates.push(gate('owner-plan', 'Согласование проекта', decision.status === 'ready' ? 'passed' : decision.status === 'stale' ? 'stale' : 'pending',
      decision.error ? [decision.error] : []))
  } catch (error) { gates.push(gate('owner-plan', 'Согласование проекта', 'unavailable', [error.message])) }
  const tasks = work.tasks.filter(task => task.status !== 'cancelled' && ['design', 'build'].includes(task.stage))
  const byId = new Map(tasks.map(task => [task.id, task])), acceptance = new Map(), reviewCache = new Map()
  for (const task of tasks) {
    const path = `${slug}/tasks/${task.id}.json`
    inputs.add(path)
    try { for (const input of expandedTaskInputs(root, { ...task, inputs: task.inputs || [] })) inputs.add(input.path) }
    catch (error) { warnings.push(error.message) }
    for (const output of task.result?.outputs || []) inputs.add(output.path)
    for (const criterion of task.result?.criteriaResults || []) for (const proof of criterion.evidence || []) inputs.add(proof.path)
    acceptance.set(task.id, taskAcceptanceState(root, slug, task, work.plan, work.tasks, reviewCache))
  }
  // Source inventory invalidates technical evidence when a new implementation file is added.
  const prefixes = new Set([slug, map.knowledge || `.knowledge-base/processes/${slug}`, map.letters, ...(map.nodes || []).map(node => node.source), ...(map.links || []).map(link => link.via)].filter(Boolean))
  const inventory = new Set()
  for (const prefix of prefixes) {
    try {
      const directory = safeTaskPath(root, prefix.replace(/\/$/, ''), { mayBeMissing: true })
      for (const file of processSourceFiles(root, directory)) {
        const path = rel(root, file)
        if (runtime(path) || path.startsWith('.knowledge-base/')) { inputs.add(path); inventory.add(path) }
      }
    } catch (error) { warnings.push(error.message) }
  }
  // Criteria matter; implementation receipts are already checked through taskAcceptanceState.
  if (existsSync(join(root, slug, 'PLAN.md'))) inputs.add(`${slug}/PLAN.md`)
  for (const node of map.nodes || []) {
    const direct = tasks.filter(task => task.targetNode === node.id || (task.expectedOutputs || []).some(output => inside(output.path, node.source)))
    const selected = new Map()
    const add = task => {
      if (!task || selected.has(task.id)) return
      selected.set(task.id, task)
      for (const id of task.dependsOn || []) add(byId.get(id))
    }
    direct.forEach(add)
    const summaries = [...selected.values()].map(task => {
      const result = acceptance.get(task.id)
      return { id: task.id, title: task.title, path: `${slug}/tasks/${task.id}.json`, status: task.status,
        acceptance: result.state === 'cancelled' ? 'pending' : result.state, details: limit(result.errors.length ? result.errors : task.status === 'needs-input' ? (task.questions || []).filter(q => q.blocking && q.status === 'open').map(q => q.question) : task.status === 'failed' ? [task.attempts?.at(-1)?.failure?.reason || task.title] : []) }
    })
    const implementations = direct.filter(task => task.mode === 'implement' && task.stage === 'build'
      && task.expectedOutputs.some(output => inside(output.path, node.source)))
    const covered = new Set(implementations.flatMap(task => task.expectedOutputs.map(output => output.path)))
    const uncovered = [...inventory].filter(path => inside(path, node.source) && !covered.has(path))
    const taskState = !implementations.length || uncovered.length ? 'pending' : summaries.some(task => task.acceptance === 'failed') ? 'failed'
      : summaries.some(task => task.acceptance === 'stale') ? 'stale' : summaries.every(task => task.acceptance === 'accepted') ? 'passed' : 'pending'
    const nodeReviews = reviews.filter(requirement => requirement.nodeId === node.id)
    const nodeGates = [gate('tasks', 'Приёмка реализации', taskState,
      !implementations.length ? ['Нет рабочей задачи реализации этого блока.'] : uncovered.length ? uncovered.map(path => `Нет задачи реализации для ${path}`) : summaries.filter(task => task.acceptance !== 'accepted')
        .map(task => `${task.id}: ${task.details[0] || (task.status === 'result-ready' ? 'результат ещё не принят' : task.status)}`))]
    nodeGates.push(gate('review', 'Проверка результата и задания', nodeReviews.every(r => r.status === 'ready') ? 'passed'
      : nodeReviews.some(r => r.blocking?.length) ? 'failed' : nodeReviews.some(r => r.status === 'stale') ? 'stale' : 'pending',
      nodeReviews.filter(r => r.status !== 'ready').flatMap(r => [r.error || `${r.id}: ${r.status}`, ...(r.blocking || []).map(b => b.reason)])))
    const path = safeTaskPath(root, node.source.replace(/\/$/, ''), { mayBeMissing: true })
    const blockers = (map.needsInput || []).filter(item => (!item.nodeId || item.nodeId === node.id) && Array.isArray(item.blocks)
      && item.blocks.some(stage => stage === 'design' || stage === 'build')).map(item => ({ title: item.title, blocks: item.blocks }))
    nodes.set(node.id, { source: existsSync(path) ? 'present' : 'missing', tasks: summaries, gates: nodeGates, blockers })
  }
  const references = []
  let bytes = 0
  for (const path of [...inputs].sort()) {
    try {
      const file = safeTaskPath(root, path)
      const stat = statSync(file)
      if (!stat.isFile()) throw Error(`Для доказательства нужен файл: ${path}`)
      if (stat.size > 1024 * 1024 || (bytes += stat.size) > 8 * 1024 * 1024) throw Error('Слишком большой объём входов проверки сборки.')
      const content = readFileSync(file)
      if (!isUtf8(content)) throw Error(`Бинарный вход ${path}: нужна проверяемая ссылка штатного хранилища.`)
      references.push({ path, sha256: hash(content) })
    } catch (error) { warnings.push(error.message) }
  }
  if (references.length > 1000) throw Error('Более 1000 входов проверки сборки.')
  if (warnings.length) gates.push(gate('inputs', 'Проверяемые входы сборки', 'unavailable', warnings))
  return { assessment: { contract: buildContractFingerprint, kind: 'check', inputs: references, inventory: [...inventory].sort(), gates }, nodes }
}

function reviewGate(requirement) {
  const state = requirement.status === 'ready' ? 'passed' : requirement.status === 'stale' ? 'stale'
    : requirement.blocking?.length ? 'failed' : 'pending'
  return gate(requirement.id, `Ревью: ${requirement.id}`, state,
    [requirement.error, ...(requirement.blocking || []).map(issue => issue.reason)].filter(Boolean))
}
