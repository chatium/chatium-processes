import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { git, gitState } from './git-state.mjs'

/** Opaque runtime credentials stay in Git's private directory, never in a report. */
export function sessionPath(root, runId) {
  if (!/^run-[a-zA-Z0-9-]+$/.test(runId)) throw Error('Некорректный runId.')
  return join(resolve(root, git(root, ['rev-parse', '--git-common-dir'])), 'process-tests', `${runId}.json`)
}
export function saveSession(root, runId, value) {
  const path = sessionPath(root, runId)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
}
export function readSession(root, runId) { return JSON.parse(readFileSync(sessionPath(root, runId), 'utf8')) }

export function saveTestPluginBranches(root, plugins) {
  const allowed = ['start', 'automations', 'agent-process', 'mailings', 'sender', 'crm']
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins) || Object.entries(plugins).some(([slug, branch]) => !allowed.includes(slug) || typeof branch !== 'string' || !branch || /[,;=\s\u0000-\u001f]/.test(branch))) throw Error('Некорректный выбор веток тестовых плагинов.')
  const path = join(resolve(root, git(root, ['rev-parse', '--git-common-dir'])), 'process-test-plugins.json')
  writeFileSync(path, JSON.stringify(plugins), { mode: 0o600 })
}

export function testExec(root, commit, code) {
  const result = spawnSync('chatium', ['exec'], { cwd: root, input: code, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 })
  // Do not echo CLI output: runtime errors may contain request bodies and capability tokens.
  if (result.error || result.status !== 0) throw Error('chatium exec не завершился успешно. Исход операции неизвестен; запросите состояние модуля, не повторяйте отправку с новым requestId.')
  const executedCommit = result.stderr.match(/^Executed commit: ([a-f0-9]{40})$/m)?.[1]
  if (executedCommit !== commit) throw Error('Исполненная версия изменилась или не подтверждена CLI. Прогон неполный.')
  return JSON.parse(result.stdout)
}

const gatewayPath = '/app/start/process-map/api/testingGateway~control'
export function testSdk(root, commit, method, ...args) {
  return scopedSdk(root, commit, method, args)
}

/** The preview branch is established by the platform HTTP request, never by mutating ctx.env. */
export function scopedSdk(root, commit, method, args, { executionRoot = root, plugins: selectedPlugins } = {}) {
  if (!/^[A-Za-z]+$/.test(method)) throw Error('Некорректный метод SDK.')
  const privateDir = resolve(root, git(root, ['rev-parse', '--git-common-dir']))
  const path = join(privateDir, 'process-test-plugins.json')
  const plugins = selectedPlugins ?? (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {})
  const branch = gitState(root).branch
  if (/[,;=\s\u0000-\u001f]/.test(branch)) throw Error('Ветка несовместима с селектором preview.')
  const remote = new URL(git(root, ['remote', 'get-url', 'origin']))
  if (remote.protocol !== 'https:' || !/^\/s\/(git|source-git)\//.test(remote.pathname)) throw Error('Нужен origin Source Git аккаунта.')
  if (git(executionRoot, ['remote', 'get-url', 'origin']) !== remote.href) throw Error('SDK checkout должен принадлежать тому же Source Git аккаунту.')
  const sessionFile = join(privateDir, 'process-test-http-session.json')
  let session = existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : null
  const http = input => spawnSync(process.execPath, [fileURLToPath(new URL('./test-http.mjs', import.meta.url))], { cwd: root,
    input: JSON.stringify(input), encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024 })
  if (!session || session.origin !== remote.origin || session.expiresAt < Date.now()) {
    const value = testExec(executionRoot, commit, `import { authenticateCurrentUserInNewDomainOrBrowser } from '@app/auth'\nreturn {url: await authenticateCurrentUserInNewDomainOrBrowser(ctx, ${JSON.stringify(remote.hostname)}, ${JSON.stringify(gatewayPath)})}`)
    const authenticated = http({ url: new URL(gatewayPath, remote.origin).href, authUrl: value.url })
    if (authenticated.error || authenticated.status !== 0) throw Error('Не удалось подтвердить HTTP-сессию текущего разработчика.')
    session = { cookie: JSON.parse(authenticated.stdout).cookie, origin: remote.origin, expiresAt: Date.now() + 480000 }
    writeFileSync(sessionFile, JSON.stringify(session), { mode: 0o600 })
  }
  const preview = [`account:${branch}`, ...Object.entries(plugins).map(([slug, branch]) => `app_${slug}:${branch}`)].join(',')
  const result = http({ url: new URL(gatewayPath, remote.origin).href, cookie: `${session.cookie}; __chtmPreviewMode__=${preview}`, method, args, branch, plugins })
  if (result.error || result.status !== 0) throw Error('Запрос тестового SDK не завершился: ' + redact(result.stderr || 'неизвестный исход', [session.cookie]))
  return JSON.parse(result.stdout)
}

export function redact(value, secrets = [], contacts = []) {
  let text = String(value)
  for (const secret of secrets.filter(s => typeof s === 'string' && s.length)) text = text.split(secret).join('[redacted]')
  for (const contact of contacts.filter(Boolean)) {
    const escaped = contact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    text = text.replace(new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'gu'), '$1[redacted]')
  }
  return text.replace(/\b(Bearer\s+)[\w.+\/-]+/gi, '$1[redacted]')
    .replace(/("(?:[\w-]*(?:token|password|secret|authorization|api[_-]?key|cookie|credential))"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
}

export function platformTestLogs(root, commit, run) {
  const quote = value => "'" + String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'") + "'"
  const start = new Date(Date.parse(run.startedAt) - 60000).toISOString()
  const end = new Date(Math.min(Date.now(), Date.parse(run.finishedAt || new Date().toISOString()) + 300000)).toISOString()
  const ids = [...new Set([run.runId, ...run.runtime.map(r => r.id)])].slice(0, 100)
  const matches = ids.map(id => `(trace_id = ${quote(id)} OR job_id = ${quote(id)} OR position(json_str, ${quote(id)}) > 0)`)
  const sql = `SELECT ts64, level, msg, trace_id, job_id, app_slug, workspace_path, error_message, json_str
    FROM chatium_ai.account_logs
    WHERE dt >= subtractDays(toDate(parseDateTimeBestEffort(${quote(start)})), 1)
      AND dt <= addDays(toDate(parseDateTimeBestEffort(${quote(end)})), 1)
      AND ts64 >= parseDateTime64BestEffort(${quote(start)}) AND ts64 <= parseDateTime64BestEffort(${quote(end)})
      AND (${matches.join(' OR ')}) ORDER BY dt DESC, ts64 DESC LIMIT 100`
  return testExec(root, commit, `import { queryAccountLogs } from '@app/ugc'\nreturn await queryAccountLogs(ctx, ${JSON.stringify(sql)})`)
}

export function redactData(value, secrets = [], contacts = []) {
  const identityKeys = new Set(['id', 'kind', 'source', 'sourcePath', 'name', 'fingerprint', 'storageHash', 'nodeId', 'linkId', 'provider', 'model', 'turnId', 'sendId', 'chainId', 'executionId', 'jobId', 'observationId', 'ids', 'requestIds', 'chatIds', 'sentToChatIds', 'version', 'protocol', 'sequence', 'runId', 'caseId', 'process', 'processPath', 'branch', 'testedCommit', 'caseSha256', 'sha256', 'path', 'operation', 'requestId'])
  const visit = (v, key) => {
    const identity = identityKeys.has(key)
    if (typeof v === 'string') return redact(v, secrets, identity ? [] : contacts)
    if (typeof v === 'number' && (secrets.includes(String(v)) || (!identity && contacts.includes(String(v))))) return '[redacted]'
    if (v instanceof Date) return v.toISOString()
    if (Array.isArray(v)) return v.map(item => visit(item, key))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k,item]) => [k,
      /(?:token|password|secret|authorization|apikey|cookie|credential)$/i.test(k.replace(/[_-]/g, '')) ? '[redacted]' : visit(item, k)]))
    return v
  }
  return visit(value)
}
