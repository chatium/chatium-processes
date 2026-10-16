import { writeFileSync, renameSync } from 'node:fs'
import { gitState } from './git-state.mjs'
import { readSession, sessionPath, testSdk, redact, redactData } from './test-exec.mjs'
import { saveRun, testCachePath, validateRun } from './process-testing.mjs'
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
  const report = redactData(run, [session.context.token, ...session.contacts.map(c => c.value)])
  const result = testSdk(root, gitState(root).commit, 'writeProcessTestRun', { context: session.context, sequence, report })
  const path = sessionPath(root, run.runId), tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...session, sequence: result.sequence }), { mode: 0o600 }); renameSync(tmp, path)
  return result
}
export function recoverSequence(root, slug, runId) {
  const value = fetchRun(root, slug, runId), session = readSession(root, runId)
  writeFileSync(sessionPath(root, runId), JSON.stringify({ ...session, sequence: value.sequence }), { mode: 0o600 })
  return value.report
}
export function closeRun(root, runId) {
  const { context } = readSession(root, runId), commit = gitState(root).commit
  let scope = testSdk(root, commit, 'closeProcessTestContext', context)
  for (const pending of scope.pendingOperations || []) {
    testSdk(root, commit, 'executeProcessTestOperation', { context, operation: pending.operation, requestId: pending.requestId, reconcile: true })
  }
  if (scope.pendingOperations?.length) scope = testSdk(root, commit, 'closeProcessTestContext', context)
  if (scope.pendingOperations?.length || scope.operationsTruncated) return [{ operation: 'run.close', status: 'pending', pendingOperations: scope.pendingOperations, error: 'Выполняющаяся операция ещё не завершена. Повторите cleanup после проверки её состояния.' }]
  const capabilities = testSdk(root, commit, 'getProcessTestCapabilities')
  // Providers recover their own records even if registration failed after creation.
  const modules = cleanupModules(scope, capabilities.operations)
  return [...modules].map(module => {
    const operation = `${module}.cleanup`
    if (!capabilities.operations.some(o => o.id === operation)) return { operation, status: 'blocked', error: 'SDK очистки недоступен.' }
    return { operation, ...testSdk(root, commit, 'executeProcessTestOperation', { context, operation, requestId: `cleanup:${module}`, input: {}, reconcile: true }) }
  })
}

// Only declared providers can have orphan resources; an unrelated installed SDK is not part of this run.
export function cleanupModules(scope, operations) {
  return new Set([...scope.resources.map(r => r.module), ...operations
    .filter(o => o.effect === 'cleanup' && o.available !== false && scope.requiredProviders?.includes(o.provider) && o.id.endsWith('.cleanup'))
    .map(o => o.id.split('.')[0])])
}
