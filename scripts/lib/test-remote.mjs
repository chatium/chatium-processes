import { writeFileSync, renameSync } from 'node:fs'
import { gitState } from './git-state.mjs'
import { readSession, sessionPath, testSdk, redact, redactData } from './test-exec.mjs'
import { readTestRun, saveRun, testCachePath, validateRun, hash } from './process-testing.mjs'
import { mkdirSync } from 'node:fs'

export function fetchRun(root, slug, runId) {
  const value = testSdk(root, gitState(root).commit, 'readProcessTestRun', { process: slug, branch: gitState(root).branch, runId })
  validateRun(value.report, { slug })
  mkdirSync(testCachePath(root, slug), { recursive: true, mode: 0o700 })
  writeFileSync(testCachePath(root, slug, `${runId}.json`), JSON.stringify(value.report), { mode: 0o600 })
  return value
}
export function publishRun(root, run) {
  const session = readSession(root, run.runId)
  const sequence = (session.sequence || 0) + 1
  const report = redactData(run, [session.context.token])
  for (const artifact of report.artifacts || []) if (typeof artifact.content === 'string') artifact.sha256 = hash(artifact.content)
  const path = sessionPath(root, run.runId), tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...session, pendingReport: report }), { mode: 0o600 }); renameSync(tmp, path)
  const result = testSdk(root, gitState(root).commit, 'writeProcessTestRun', { context: session.context, sequence, report })
  const { pendingReport: _pending, ...savedSession } = session
  writeFileSync(tmp, JSON.stringify({ ...savedSession, sequence: result.sequence }), { mode: 0o600 }); renameSync(tmp, path)
  return result
}
export function recoverSequence(root, slug, runId) {
  const value = fetchRun(root, slug, runId), session = readSession(root, runId)
  writeFileSync(sessionPath(root, runId), JSON.stringify({ ...session, sequence: value.sequence }), { mode: 0o600 })
  return value.report
}
// Retry only report persistence. Never re-run its scenario or overwrite a sealed server attempt.
export function recoverPendingTestReport(root, runId) {
  const session = readSession(root, runId), pending = session.pendingReport
  if (!pending || pending.status === 'running') return
  let saved
  try { saved = testSdk(root, gitState(root).commit, 'readProcessTestRun', { process: pending.process, branch: pending.branch, runId }) }
  catch { return publishRun(root, pending) } // A first report may not exist; the same sequence is safe to retry.
  const { pendingReport: _pending, ...base } = session
  const path = sessionPath(root, runId), tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...base, sequence: saved.sequence, ...(saved.report.status === 'running' ? { pendingReport: pending } : {}) }), { mode: 0o600 }); renameSync(tmp, path)
  if (saved.report.status === 'running') return publishRun(root, pending)
}

export function closeRun(root, runId, interruptedRun) {
  const results = []
  if (interruptedRun?.status === 'running') {
    const report = { ...interruptedRun, status: 'incomplete', finishedAt: new Date().toISOString(), limitations: [...interruptedRun.limitations, 'Прерванная попытка закрыта очисткой; эффекты не повторялись.'] }
    saveRun(root, report)
    try { publishRun(root, report) } catch { /* Pending report is retained for recovery below. */ }
  }
  try { recoverPendingTestReport(root, runId) }
  catch { results.push({ operation: 'run.finalize', status: 'uncertain', error: 'Итог сохранён в приватном кэше. Повторите cleanup, когда Start снова доступен.' }) }
  const { context } = readSession(root, runId), commit = gitState(root).commit
  let scope = testSdk(root, commit, 'closeProcessTestContext', context)
  let originalRun = interruptedRun
  for (const pending of (scope.pendingOperations || []).filter(p => !p.acknowledged)) {
    originalRun ||= readTestRun(root, scope.processPath, runId)
    const original = originalRun.operations?.find(o => o.requestId === pending.requestId && o.operation === pending.operation)
    // Nested callbacks may own receipts absent from the script report. Do not
    // replace their unknown input with {}; leave explicit SDK diagnosis to the caller.
    if (!original) continue
    testSdk(root, commit, 'executeProcessTestOperation', { context, operation: pending.operation, requestId: pending.requestId, input: original.input, reconcile: true })
  }
  if (scope.pendingOperations?.some(p => !p.acknowledged)) scope = testSdk(root, commit, 'closeProcessTestContext', context)
  if (scope.pendingOperations?.some(p => !p.acknowledged) || scope.operationsTruncated) return [...results, { operation: 'run.close', status: 'pending', pendingOperations: scope.pendingOperations, error: 'Выполняющаяся операция ещё не завершена. Повторите cleanup после проверки её состояния.' }]
  const capabilities = testSdk(root, commit, 'getProcessTestCapabilities')
  // Providers recover their own records even if registration failed after creation.
  const modules = cleanupModules(scope, capabilities.operations)
  return [...results, ...[...modules].map(module => {
    const operation = `${module}.cleanup`
    if (!capabilities.operations.some(o => o.id === operation)) return { operation, status: 'blocked', error: 'SDK очистки недоступен.' }
    return { operation, ...testSdk(root, commit, 'executeProcessTestOperation', { context, operation, requestId: `cleanup:${module}`, input: {}, reconcile: true }) }
  })]
}

// Only declared providers can have orphan resources; an unrelated installed SDK is not part of this run.
export function cleanupModules(scope, operations) {
  return new Set([...scope.resources.map(r => r.module), ...operations
    .filter(o => o.effect === 'cleanup' && o.available !== false && scope.requiredProviders?.includes(o.provider) && o.id.endsWith('.cleanup'))
    .map(o => o.id.split('.')[0])])
}
