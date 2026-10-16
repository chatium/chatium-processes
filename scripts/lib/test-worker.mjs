import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { hash, readTestRun, saveRun, testInputs, testPath } from './process-testing.mjs'
import { publishRun } from './test-remote.mjs'
import { readSession, redact, testSdk } from './test-exec.mjs'

// The parent enforces a wall-clock timeout for the complete scenario, including hung code.
const { root, slug, scenario, runId } = JSON.parse(readFileSync(0, 'utf8'))
const run = readTestRun(root, slug, runId), session = readSession(root, runId)
const secrets = [session.context.token, ...session.contacts.map(c => c.value)]
const clean = value => JSON.parse(redact(JSON.stringify(value), secrets))
const persist = () => { saveRun(root, clean(run)); publishRun(root, clean(run)) }
class Blocked extends Error {}
class Incomplete extends Error {}
const api = {
  runId, caseId: scenario.id, contacts: session.contacts, channels: session.channels || [],
  async attempt(operation, input = {}, requestId) {
    if (!scenario.capabilities?.includes(operation)) throw new Blocked(`Возможность ${operation} не объявлена в сценарии.`)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(requestId || '')) throw Error('Каждая операция требует устойчивый requestId третьим аргументом.')
    const result = testSdk(root, run.testedCommit, 'executeProcessTestOperation', { context: session.context, requestId, operation, input })
    run.operations.push(clean({ requestId, operation, input, status: result.status, duplicate: Boolean(result.duplicate), ...(result.error ? { error: result.error } : {}) }))
    if (operation.endsWith('.skipWait')) run.skippedWaits.push(clean({ requestId, result: result.result }))
    const scope = testSdk(root, run.testedCommit, 'getProcessTestScope', session.context, true)
    run.resources = scope.resources
    if (result.observationId) run.runtime.push({ module: operation.split('.')[0], kind: 'observation', id: result.observationId })
    for (const ref of scope.resources) if (!run.runtime.some(r => r.module === ref.module && r.kind === ref.kind && r.id === ref.id)) run.runtime.push(ref)
    for (const value of result.result?.limitations || []) if (!run.limitations.includes(value)) run.limitations.push(value)
    if (result.result?.limitation && !run.limitations.includes(result.result.limitation)) run.limitations.push(result.result.limitation)
    persist()
    return result
  },
  async operation(operation, input = {}, requestId) {
    const result = await api.attempt(operation, input, requestId)
    if (result.status === 'blocked') throw new Blocked(result.error || 'Операция не поддерживает безопасное тестирование.')
    if (result.status !== 'completed') throw new Incomplete(result.error || 'Исход операции неизвестен. Прочитайте состояние модуля.')
    return result.result
  },
  check(criterion, ok, actual) {
    if (!scenario.expected.includes(criterion)) throw Error('Критерий не объявлен в плане.')
    run.assertions.push(clean({ criterion, ok: Boolean(ok), ...(actual === undefined ? {} : { actual }) })); persist()
  },
  observe(title, summary) { run.observations.push(clean({ title, summary })); persist() },
  ref(module, kind, id) { run.runtime.push({ module, kind, id: String(id) }); persist() },
  limitation(value) { run.limitations.push(redact(value, secrets)); persist() },
  artifact(name, content, title = name) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.(txt|json|md)$/.test(name)) throw Error('Артефакт: имя файла .txt, .json или .md без каталогов.')
    const safe = redact(typeof content === 'string' ? content : JSON.stringify(content, null, 2), secrets)
    if (Buffer.byteLength(safe) > 256 * 1024) throw Error('Выдержка превышает 256 КиБ. Сократите её или используйте штатное хранилище.')
    run.artifacts.push({ title, name, content: safe, sha256: hash(safe) }); persist()
  },
  async waitFor(read, done, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
    if (timeoutMs < 1 || timeoutMs > 300000 || intervalMs < 250 || intervalMs > 10000) throw Error('Нужен ограниченный интервал ожидания: до 5 минут, шаг 250–10000 мс.')
    const end = Date.now() + timeoutMs
    while (Date.now() < end) { const state = await read(); if (done(state)) return state; await setTimeout(intervalMs) }
    throw new Incomplete('Истёк срок ожидания. Исполнение может продолжаться; запросите его состояние.')
  },
}
try {
  const scenarioModule = await import(pathToFileURL(testPath(root, scenario.script)).href)
  if (typeof scenarioModule.default !== 'function') throw Error('Сценарий должен экспортировать default async function(test).')
  await scenarioModule.default(api)
  if (JSON.stringify(testInputs(root, slug, scenario)) !== JSON.stringify(run.inputs)) throw new Incomplete('Исходники изменились во время прогона.')
  run.status = scenario.expected.every(criterion => run.assertions.some(a => a.criterion === criterion && a.ok)) &&
    run.assertions.every(a => a.ok) && run.observations.length && run.runtime.length ? 'passed' : 'failed'
} catch (error) {
  run.status = error instanceof Blocked ? 'blocked' : 'incomplete'
  run.limitations.push(redact(error.message, secrets))
} finally {
  run.finishedAt = new Date().toISOString(); persist()
}
