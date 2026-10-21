import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { isProcessSlug } from './project.mjs'
import { parseTestPlanYaml } from './yaml.mjs'
import { testSdk } from './test-exec.mjs'
import { git, gitState } from './git-state.mjs'

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/
const SHA = /^[a-f0-9]{64}$/
const RESULTS = ['running', 'passed', 'failed', 'blocked', 'incomplete']
export const canonicalTestJson = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
export const hash = value => createHash('sha256').update(value).digest('hex')
const fail = message => { throw Error(message) }
const text = (value, label, max = 4000) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u0008]/.test(value) ? value : fail(`${label}: нужна непустая строка до ${max} символов.`)
const list = (value, label, max = 100) => Array.isArray(value) && value.length <= max ? value : fail(`${label}: нужен массив до ${max} элементов.`)
const object = (value, label) => value && typeof value === 'object' && !Array.isArray(value) ? value : fail(`${label}: нужен объект.`)
const id = (value, label) => typeof value === 'string' && ID.test(value) ? value : fail(`${label}: некорректный ID.`)
const unique = (values, label) => new Set(values).size === values.length || fail(`${label}: повторяющиеся значения.`)

export function relativeTestPath(value) {
  text(value, 'Путь', 500)
  if (value.startsWith('/') || /[\\\u0000-\u001f?#]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..')) fail('Небезопасный путь теста.')
  return value
}

/** Reject links in existing parents as well as in the final file, including write destinations. */
export function testPath(root, path) {
  relativeTestPath(path)
  const base = realpathSync(root), target = resolve(base, path)
  if (!target.startsWith(base + sep)) fail('Путь выходит из аккаунта.')
  let part = base
  for (const name of path.split('/')) {
    part = join(part, name)
    if (existsSync(part) && lstatSync(part).isSymbolicLink()) fail('Символические ссылки в артефактах тестирования запрещены.')
  }
  return target
}

function read(root, path, max = 2 * 1024 * 1024) {
  const full = testPath(root, path), stat = lstatSync(full)
  if (!stat.isFile() || stat.size > max) fail(`${path}: нужен обычный файл до ${max} байт.`)
  return readFileSync(full, 'utf8')
}

export function targetKey(target) {
  if (!target || !['node', 'link', 'step'].includes(target.kind)) fail('Цель теста: нужен node, link или step.')
  if (target.kind === 'step') return `step:${relativeTestPath(target.source)}#${id(target.id, 'ID шага')}`
  return `${target.kind}:${id(target.id, 'ID цели')}`
}

export function validatePlan(value, { slug, map } = {}) {
  object(value, 'План тестирования')
  if (value.version !== 1) fail('План тестирования: нужен version: 1.')
  const cases = list(value.cases, 'Сценарии').map(item => {
    object(item, 'Сценарий'); id(item.id, 'ID сценария'); text(item.title, 'Название', 200)
    if (!['runtime', 'browser'].includes(item.kind)) fail(`${item.id}: kind должен быть runtime или browser.`)
    if (typeof item.required !== 'boolean') fail(`${item.id}: укажите required.`)
    if (!list(item.conditions, 'Условия').length || !list(item.expected, 'Критерии').length || !list(item.targets, 'Цели').length) fail(`${item.id}: нужны условия, критерии и цели.`)
    item.conditions.forEach(x => text(x, 'Условие')); item.expected.forEach(x => text(x, 'Критерий'))
    const keys = item.targets.map(targetKey); unique(keys, 'Цели')
    if (map) for (const target of item.targets) {
      if (target.kind === 'node' && !map.nodes?.some(n => n.id === target.id)) fail(`${item.id}: узел ${target.id} отсутствует.`)
      if (target.kind === 'link' && !map.links?.some(n => n.id === target.id)) fail(`${item.id}: связь ${target.id} должна иметь явный устойчивый ID.`)
    }
    if (!list(item.sources, 'Значимые исходники', 300).length) fail(`${item.id}: перечислите значимые исходники.`)
    item.sources.forEach(relativeTestPath); unique(item.sources, 'Исходники')
    if (slug && item.sources.some(p => p.startsWith(`${slug}/tests/runs/`) || p.startsWith(`${slug}/tests/artifacts/`) || p === `${slug}/tests/findings.yaml` || p === `${slug}/tests/index.json`)) fail('Результаты и замечания не могут быть входными исходниками теста.')
    list(item.capabilities ?? [], 'Возможности').forEach(x => text(x, 'Возможность', 100))
    if (item.kind === 'runtime') {
      relativeTestPath(item.script)
      if (slug && (!item.script.startsWith(`${slug}/tests/scenarios/`) || !item.script.endsWith('.mjs'))) fail('Скрипт сценария должен находиться в tests/scenarios и иметь расширение .mjs.')
    }
    if (item.timeoutMs !== undefined && (!Number.isInteger(item.timeoutMs) || item.timeoutMs < 1000 || item.timeoutMs > 1800000)) fail('timeoutMs: от 1000 до 1800000.')
    return item
  })
  unique(cases.map(c => c.id), 'Сценарии')
  return { version: 1, cases }
}

export function readTestPlan(root, slug, map) {
  if (!isProcessSlug(slug)) fail('Некорректный процесс.')
  const plan = validatePlan(parseTestPlanYaml(read(root, `${slug}/tests/plan.yaml`)), { slug, map })
  const hasStep = (steps, id) => (steps || []).some(s => s.id === id || hasStep(s.thenBranch?.steps, id) || hasStep(s.elseBranch?.steps, id))
  for (const scenario of plan.cases) for (const target of scenario.targets.filter(t => t.kind === 'step')) {
    if (!scenario.sources.includes(target.source) || !target.source.endsWith('.automationConfig.json') || !hasStep(JSON.parse(read(root, target.source)).steps, target.id)) fail(`${scenario.id}: шаг ${target.id} отсутствует в проверяемом исходнике.`)
  }
  return plan
}

/** Hash the case, script and explicit dependency closure, never run reports or unrelated cases. */
export function testInputs(root, slug, scenario) {
  const paths = [...new Set([`${slug}/.workspace.json`, ...scenario.sources, ...(scenario.script ? [scenario.script] : [])])].sort()
  const files = paths.map(path => ({ path, sha256: hash(read(root, path)) }))
  return { caseSha256: hash(canonicalTestJson(scenario)), files }
}

export function validateRun(run, { slug, caseId } = {}) {
  object(run, 'Результат')
  if (run.version !== 1 || !RESULTS.includes(run.status)) fail('Некорректная версия или статус результата.')
  id(run.runId, 'runId'); id(run.caseId, 'caseId')
  if ((slug && run.process !== slug) || (caseId && run.caseId !== caseId)) fail('Результат относится к другому процессу или сценарию.')
  if (!isProcessSlug(run.process)) fail('Некорректный процесс результата.')
  text(run.branch, 'Ветка', 240)
  if (!/^[a-f0-9]{40}$/.test(run.testedCommit)) fail('Нужен полный testedCommit.')
  if (!Number.isFinite(Date.parse(run.startedAt)) || (run.status !== 'running' && !Number.isFinite(Date.parse(run.finishedAt)))) fail('Некорректное время прогона.')
  if (!SHA.test(run.inputs?.caseSha256)) fail('Нет отпечатка сценария.')
  list(run.inputs.files, 'Исходники результата', 305).forEach(file => {
    relativeTestPath(file.path); if (!SHA.test(file.sha256)) fail('Некорректный SHA-256 исходника.')
  })
  unique(run.inputs.files.map(f => f.path), 'Исходники результата')
  if (!['runtime', 'browser'].includes(run.kind)) fail('Некорректный вид проверки.')
  list(run.assertions, 'Проверки').forEach(check => {
    text(check.criterion, 'Критерий'); if (typeof check.ok !== 'boolean') fail('Проверка должна иметь ok.')
  })
  list(run.observations, 'Наблюдения').forEach(item => {
    text(item.title, 'Наблюдение'); text(item.summary, 'Результат наблюдения')
  })
  list(run.artifacts, 'Артефакты').forEach(item => {
    text(item.title, 'Артефакт', 200)
    if (!SHA.test(item.sha256)) fail('Артефакту нужен SHA-256.')
    if (item.content !== undefined) {
      if (typeof item.content !== 'string' || item.content.length > 256 * 1024 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.(txt|json|md)$/.test(item.name || '') || hash(item.content) !== item.sha256) fail('Содержимое артефакта изменилось или имеет неверный формат.')
    } else if (typeof item.storageHash !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/.test(item.storageHash)) fail('Нужен текст либо устойчивый storageHash артефакта.')
  })
  list(run.runtime, 'Runtime references', 300).forEach(ref => {
    text(ref.module, 'Модуль', 100); text(ref.kind, 'Тип исполнения', 100); text(ref.id, 'ID исполнения', 300)
  })
  list(run.limitations, 'Ограничения').forEach(x => text(x, 'Ограничение'))
  object(run.scenario, 'Условия проверенной попытки')
  text(run.scenario.title, 'Название сценария', 200)
  list(run.scenario.conditions, 'Условия попытки').forEach(x => text(x, 'Условие'))
  list(run.scenario.expected, 'Критерии попытки').forEach(x => text(x, 'Критерий'))
  list(run.scenario.targets, 'Цели попытки').forEach(targetKey)
  list(run.operations || [], 'Операции', 1000)
  list(run.resources || [], 'Ресурсы', 500)
  if (run.previousRunId !== undefined) id(run.previousRunId, 'Предыдущая попытка')
  if (run.status === 'passed' && (!run.assertions.length || run.assertions.some(a => !a.ok) || !run.observations.length)) fail('Успех требует выполненных проверок и наблюдений.')
  if (run.kind === 'runtime' && run.status === 'passed' && !run.runtime.length) fail('Runtime-успех требует ID реального исполнения.')
  return run
}

/** Recoverable local cache only; Start tables are authoritative. Never part of a checkout. */
export function testCachePath(root, slug, name = '') {
  if (!isProcessSlug(slug) || (name && !/^[a-zA-Z0-9_.-]+$/.test(name))) fail('Некорректный путь кэша.')
  return join(resolve(root, git(root, ['rev-parse', '--git-common-dir'])), 'process-test-cache', slug, name)
}

export function readTestRun(root, slug, runId) {
  id(runId, 'runId')
  return validateRun(JSON.parse(readFileSync(testCachePath(root, slug, `${runId}.json`), 'utf8')), { slug })
}

export function saveRun(root, run, { create = false } = {}) {
  validateRun(run)
  const path = testCachePath(root, run.process, `${run.runId}.json`)
  mkdirSync(dirname(path), { recursive: true })
  if (create) writeFileSync(path, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' })
  else {
    const previous = readTestRun(root, run.process, run.runId)
    if (previous.status !== 'running' || previous.caseId !== run.caseId || previous.testedCommit !== run.testedCommit || JSON.stringify(previous.inputs) !== JSON.stringify(run.inputs)) fail('Завершённую попытку и её исходные данные нельзя перезаписать.')
    const temp = `${path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(run, null, 2) + '\n', { flag: 'wx' }); renameSync(temp, path)
  }
}

export function readFindings(root, slug) {
  const path = testCachePath(root, slug, 'findings.json')
  if (!existsSync(path)) return []
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (data?.version !== 1) fail('Замечания: нужен version: 1.')
  const findings = list(data.findings, 'Замечания', 300)
  for (const f of findings) {
    id(f.id, 'ID замечания'); id(f.caseId, 'Сценарий замечания'); text(f.title, 'Замечание', 500)
    if (!['blocking', 'advisory'].includes(f.severity) || !['open', 'resolved'].includes(f.status)) fail('Некорректный статус или важность замечания.')
    id(f.openedIn, 'Первая попытка'); if (f.status === 'resolved') id(f.resolvedIn, 'Подтверждающая попытка')
    list(f.history, 'История замечания').forEach(event => { text(event.note, 'Запись истории'); if (!Number.isFinite(Date.parse(event.at))) fail('Некорректная дата замечания.') })
  }
  unique(findings.map(f => f.id), 'Замечания')
  return findings
}

export function testStatus({ root, slug, map, branch, remote = false }) {
  if (!existsSync(testPath(root, `${slug}/tests/plan.yaml`))) return { version: 1, status: 'not-tested', cases: [], findings: [], errors: ['Нет плана тестирования.'], runs: [] }
  const plan = readTestPlan(root, slug, map)
  branch ??= gitState(root).branch
  if (remote) {
    for (const scenario of plan.cases) assertTestSourcesCommitted(root, testInputs(root, slug, scenario))
    const summary = testSdk(root, gitState(root).commit, 'readProcessTesting', { process: slug, branch })
    const errors = summary.cases.filter(c => c.required && c.status !== 'passed').map(c => `${c.id}: ${c.status}${c.reason ? ` — ${c.reason}` : ''}`)
    if (summary.error) errors.push(summary.error)
    else if (!summary.cases.length) errors.push('План тестирования пуст.')
    return { ...summary, status: errors.length ? 'incomplete' : 'passed', errors }
  }
  const findings = readFindings(root, slug)
  const directory = testCachePath(root, slug)
  const names = existsSync(directory) ? readdirSync(directory).filter(n => n.startsWith('run-') && n.endsWith('.json')).sort() : []
  if (names.length > 2000) fail('Более 2000 попыток: архивируйте завершённый период отдельным решением.')
  const runs = names.map(name => readTestRun(root, slug, name.slice(0, -5))).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId))
  const errors = []
  for (const finding of findings) {
    if (!plan.cases.some(c => c.id === finding.caseId) || !runs.some(r => r.runId === finding.openedIn && r.caseId === finding.caseId)) fail(`${finding.id}: нет исходного сценария или попытки.`)
    if (finding.status === 'resolved' && !runs.some(r => r.runId === finding.resolvedIn && r.caseId === finding.caseId && r.status === 'passed')) fail(`${finding.id}: закрытие не подтверждено успешной попыткой.`)
  }
  const cases = plan.cases.map(scenario => {
    const attempts = runs.filter(r => r.caseId === scenario.id && r.branch === branch)
    const latest = attempts[0]
    let status = latest?.status ?? 'not-tested'
    let reason
    if (latest) {
      let actual
      try { actual = testInputs(root, slug, scenario) } catch (error) { reason = error.message }
      if (!actual || JSON.stringify(latest.inputs) !== JSON.stringify(actual)) { status = 'stale'; reason ||= 'Сценарий или значимые исходники изменились.' }
      else if (latest.kind !== scenario.kind) { status = 'stale'; reason = 'Изменился вид проверки.' }
      else if (latest.status === 'passed' && scenario.expected.some(criterion => !latest.assertions.some(a => a.criterion === criterion && a.ok))) { status = 'incomplete'; reason = 'Не проверены все критерии сценария.' }

    }
    const issues = findings.filter(f => f.caseId === scenario.id && f.status === 'open')
    if (issues.some(f => f.severity === 'blocking')) { if (!['blocked', 'stale', 'incomplete', 'running'].includes(status)) status = 'failed'; reason = 'Есть открытое блокирующее замечание.' }
    if (scenario.required && status !== 'passed') errors.push(`${scenario.id}: ${status}${reason ? ` — ${reason}` : ''}`)
    return { ...scenario, status, ...(reason ? { reason } : {}), attempts: attempts.length,
      ...(latest ? { latestRunId: latest.runId, testedAt: latest.finishedAt ?? latest.startedAt, testedCommit: latest.testedCommit, inputs: latest.inputs, artifacts: latest.artifacts, limitations: latest.limitations } : {}) }
  })
  if (!cases.length) errors.push('План тестирования пуст.')
  const history = runs.map(({ runId, caseId, branch, status, startedAt, finishedAt, testedCommit }) => ({ runId, caseId, branch, status, startedAt, finishedAt, testedCommit }))
  return { version: 1, status: errors.length ? 'incomplete' : 'passed', cases, findings, errors, runs: history }
}

export function coverageForTargets(cases, targets) {
  const keys = new Set(targets.map(targetKey)), selected = cases.filter(c => c.targets.some(t => keys.has(targetKey(t))))
  if (!selected.length) return 'not-tested'
  const statuses = selected.map(c => c.status)
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('stale')) return 'stale'
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.every(s => s === 'passed')) return 'passed'
  if (statuses.every(s => s === 'not-tested')) return 'not-tested'
  return 'partial'
}

export function createRun({ root, slug, scenario, previousRunId, inputs = testInputs(root, slug, scenario), state = gitState(root) }) {
  if (previousRunId) {
    const previous = readTestRun(root, slug, previousRunId)
    if (previous.caseId !== scenario.id) fail('Предыдущая попытка относится к другому сценарию.')
  }
  return { version: 1, process: slug, runId: `run-${randomUUID()}`, caseId: scenario.id, kind: scenario.kind,
    scenario: { title: scenario.title, conditions: scenario.conditions, expected: scenario.expected, targets: scenario.targets },
    branch: state.branch, testedCommit: state.commit, startedAt: new Date().toISOString(), status: 'running', inputs,
    ...(previousRunId ? { previousRunId } : {}), assertions: [], observations: [], runtime: [], artifacts: [], limitations: [], operations: [], resources: [], skippedWaits: [], executedVersions: [] }
}

/** Tests may create evidence in an otherwise unchanged published checkout. */
export function assertTestSourcesCommitted(root, inputs) {
  for (const file of inputs.files) {
    let committed
    const result = spawnSync('git', ['show', `HEAD:${file.path}`], { cwd: root, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })
    if (result.error || result.status !== 0) fail(`Исходник ${file.path} не закоммичен.`)
    committed = result.stdout
    if (hash(committed) !== file.sha256 || hash(read(root, file.path)) !== file.sha256) fail(`Исходник ${file.path} изменён. Сначала опубликуйте проверяемую версию.`)
  }
}

/** Compact projection; server reads replace it with current table data. */
export function boardTesting(status) {
  return { version: 1, cases: status.cases.map(({ id, title, kind, required, conditions, expected, targets, status, reason, attempts, latestRunId, testedAt, testedCommit, limitations }) =>
    ({ id, title, kind, required, conditions, expected, targets, status, ...(reason ? { reason } : {}), attempts,
      ...(latestRunId ? { latestRunId, testedAt, testedCommit, limitations } : {}) })),
    findings: status.findings, runs: status.runs.slice(0, 100), totalRuns: status.runs.length }
}
