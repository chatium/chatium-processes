import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { acceptanceErrors, expandedTaskInputs, loadTasks, parseTaskPlan, safeTaskPath,
  taskDefinitionDigest, taskInputDigest, taskReassessmentStatus, writeTask } from './tasks.mjs'
import { specialistContract } from './specialists.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const digest = value => sha(JSON.stringify(value))
const text = value => typeof value === 'string' && value.trim().length >= 20
const reference = value => typeof value === 'string' && value.trim().length > 0

function git(root, ...args) {
  try { return execFileSync('git', ['-C', root, ...args], { maxBuffer: 2 * 1024 * 1024 }) }
  catch (error) { throw Error(`Git не смог прочитать версию материалов: ${String(error.stderr || error.message).trim()}`) }
}

function inputParts(root, task, baselineCommit) {
  const outputs = new Set((task.expectedOutputs || []).map(item => item.path))
  const inputs = expandedTaskInputs(root, task).filter(item => !outputs.has(item.path))
  const parts = [], changed = []
  for (const input of inputs) {
    const beforeSha256 = sha(git(root, 'show', `${baselineCommit}:${input.path}`))
    const afterSha256 = sha(readFileSync(safeTaskPath(root, input.path)))
    parts.push({ kind: input.kind, path: input.path, sha256: beforeSha256 })
    if (beforeSha256 !== afterSha256)
      changed.push({ path: input.path, kind: input.kind, beforeSha256, afterSha256 })
  }
  const answers = (task.questions || []).filter(q => q.status === 'resolved')
    .map(q => ({ id: q.id, summary: q.answer?.summary, sourceRefs: q.answer?.sourceRefs }))
  const role = task.executor?.kind === 'specialist' ?
    { name: task.executor.role, sha256: specialistContract(task.executor).digest } : null
  return { baselineInputDigest: digest({ parts, answers, role }), changed }
}

export function prepareTaskReassessment({ root, slug, baselineCommit }) {
  if (!/^[a-f0-9]{7,40}$/.test(baselineCommit || '')) throw Error('Нужен --base с коммитом прежней приёмки.')
  const base = git(root, 'rev-parse', '--verify', `${baselineCommit}^{commit}`).toString().trim()
  const head = git(root, 'rev-parse', 'HEAD').toString().trim()
  try { git(root, 'merge-base', '--is-ancestor', base, head) }
  catch { throw Error('Базовый коммит должен быть предком текущего HEAD.') }
  if (git(root, 'status', '--porcelain').toString().trim())
    throw Error('Перед пакетной переоценкой зафиксируйте изменения аккаунта в Git.')
  const plan = parseTaskPlan(readFileSync(safeTaskPath(root, `${slug}/PLAN.md`), 'utf8'))
  const tasks = loadTasks(root, slug).tasks
  const eligible = [], ineligible = [], changes = new Map()
  for (const task of tasks.filter(item => item.status === 'done')) {
    let current, previous
    try {
      current = taskInputDigest(root, task)
      previous = taskReassessmentStatus(root, slug, task)
    } catch (error) {
      ineligible.push({ taskId: task.id, reasons: [error.message] })
      continue
    }
    if (previous.valid && previous.effectiveInputDigest === current) continue
    const reasons = []
    if (!previous.valid) reasons.push(previous.reason)
    if (taskDefinitionDigest(task, plan.find(item => item.id === task.planTask)) !== task.acceptance?.definitionDigest)
      reasons.push('изменились задание или критерии')
    if (digest(task.result) !== task.acceptance?.resultDigest) reasons.push('изменился записанный результат')
    // Existing tests still prove the unchanged output at the old input version.
    // A separate reviewer decides whether the input delta affects those proofs.
    reasons.push(...acceptanceErrors(root, slug, task, plan, tasks, new Map(), task.acceptance?.inputDigest))
    let parts
    try { parts = inputParts(root, task, base) }
    catch (error) { reasons.push(error.message) }
    if (parts && parts.baselineInputDigest !== previous.effectiveInputDigest)
      reasons.push('базовый коммит не совпадает с принятой версией входов')
    if (parts && !parts.changed.length) reasons.push('нет изменённых файлов входов; проверьте контракт роли или ответы')
    if (reasons.length) { ineligible.push({ taskId: task.id, reasons: [...new Set(reasons)].slice(0, 8) }); continue }
    for (const part of parts.changed) if (!changes.has(part.path)) {
      const diff = git(root, 'diff', '--no-ext-diff', '--unified=3', base, head, '--', part.path).toString('utf8')
      if (Buffer.byteLength(diff) > 64 * 1024) throw Error(`${part.path}: diff слишком велик для одного ревью.`)
      changes.set(part.path, { ...part, diff })
    }
    eligible.push({ taskId: task.id, fromInputDigest: previous.effectiveInputDigest,
      toInputDigest: current, definitionDigest: task.acceptance.definitionDigest,
      resultDigest: task.acceptance.resultDigest, changedInputs: parts.changed.map(item => item.path),
      title: task.title, objective: task.objective, scope: task.scope,
      executor: task.executor, planTask: task.planTask,
      inputs: expandedTaskInputs(root, task).map(item => ({ kind: item.kind, path: item.path, purpose: item.purpose })),
      criteria: task.acceptanceCriteria.map(item => item.id),
      criterionDetails: task.acceptanceCriteria.map(item => ({ id: item.id,
        condition: item.condition, verification: item.verification,
        evidence: task.result.criteriaResults.find(row => row.criterionId === item.id)?.evidence || [] })),
      outputs: task.result.outputs.map(item => ({ path: item.path, sha256: item.sha256 })) })
  }
  const packet = { version: 1, kind: 'task-reassessment-packet', process: slug, accountRoot: root,
    baselineCommit: base, headCommit: head, eligible, ineligible,
    changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)) }
  if (Buffer.byteLength(JSON.stringify(packet)) > 256 * 1024) throw Error('Пакет переоценки слишком велик; разделите входные материалы.')
  return { ...packet, packetDigest: digest(packet) }
}

export function recordTaskReassessment({ root, slug, report }) {
  if (report?.version !== 1 || report.kind !== 'task-reassessment' || report.process !== slug ||
      report.reviewer?.kind !== 'subagent' || !reference(report.reviewer?.reference) ||
      Number.isNaN(Date.parse(report.reviewedAt || '')) || !Array.isArray(report.findings))
    throw Error('Нужен независимый отчёт переоценки с reviewer, reviewedAt и findings.')
  const packet = prepareTaskReassessment({ root, slug, baselineCommit: report.baselineCommit })
  if (packet.packetDigest !== report.packetDigest || packet.headCommit !== report.headCommit)
    throw Error('Отчёт относится к другой версии пакета; подготовьте новую переоценку.')
  const ids = packet.eligible.map(item => item.taskId)
  if (report.findings.length !== ids.length || new Set(report.findings.map(item => item.taskId)).size !== ids.length ||
      report.findings.some(item => !ids.includes(item.taskId)))
    throw Error('Нужен ровно один вывод по каждой подходящей карточке пакета.')
  for (const candidate of packet.eligible) {
    const finding = report.findings.find(item => item.taskId === candidate.taskId)
    if (!['unaffected', 'affected'].includes(finding.decision) ||
        finding.fromInputDigest !== candidate.fromInputDigest ||
        finding.toInputDigest !== candidate.toInputDigest || !text(finding.rationale) ||
        !Array.isArray(finding.changedInputs) || !Array.isArray(finding.criteria) ||
        finding.changedInputs.length !== candidate.changedInputs.length ||
        finding.criteria.length !== candidate.criteria.length ||
        new Set(finding.changedInputs.map(item => item.path)).size !== candidate.changedInputs.length ||
        new Set(finding.criteria.map(item => item.id)).size !== candidate.criteria.length ||
        finding.changedInputs.some(item => !candidate.changedInputs.includes(item.path) || !text(item.reason)) ||
        finding.criteria.some(item => !candidate.criteria.includes(item.id) || !text(item.reason)))
      throw Error(`${candidate.taskId}: неполный вывод о влиянии изменений на входы и критерии.`)
  }
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + '\n')
  if (reportBytes.length > 256 * 1024) throw Error('Отчёт переоценки слишком велик.')
  const reportSha256 = sha(reportBytes)
  const reportPath = `${slug}/reviews/tasks/reassessments/${reportSha256}.json`
  const target = safeTaskPath(root, reportPath, { mayBeMissing: true })
  const affected = report.findings.filter(item => item.decision === 'affected').map(item => item.taskId)
  const accepted = packet.eligible.filter(item => report.findings.find(row => row.taskId === item.taskId).decision === 'unaffected')
  const byId = new Map(loadTasks(root, slug).tasks.map(task => [task.id, task]))
  for (const item of accepted) {
    const task = byId.get(item.taskId)
    const next = structuredClone(task)
    next.acceptance.reassessments ||= []
    next.acceptance.reassessments.push({ fromInputDigest: item.fromInputDigest,
      toInputDigest: item.toInputDigest, definitionDigest: item.definitionDigest,
      resultDigest: item.resultDigest, packetDigest: report.packetDigest,
      reportPath, reportSha256, at: new Date().toISOString() })
    const size = Buffer.byteLength(JSON.stringify({ ...next, revision: next.revision + 1 }, null, 2) + '\n')
    if (size > 64 * 1024) throw Error(`${task.id}: карточка превысит 64 КБ после переоценки.`)
  }
  mkdirSync(dirname(target), { recursive: true })
  if (existsSync(target)) throw Error('Этот отчёт уже записан.')
  writeFileSync(target, reportBytes, { flag: 'wx' })
  for (const item of accepted) {
    const task = byId.get(item.taskId), previous = task.revision
    task.acceptance.reassessments ||= []
    task.acceptance.reassessments.push({ fromInputDigest: item.fromInputDigest,
      toInputDigest: item.toInputDigest, definitionDigest: item.definitionDigest,
      resultDigest: item.resultDigest, packetDigest: report.packetDigest,
      reportPath, reportSha256, at: new Date().toISOString() })
    task.revision++
    task.updatedAt = new Date().toISOString()
    writeTask(root, slug, task, previous)
  }
  return { reportPath, accepted: accepted.map(item => item.taskId), affected,
    ineligible: packet.ineligible }
}
