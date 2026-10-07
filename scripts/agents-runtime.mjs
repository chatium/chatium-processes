#!/usr/bin/env node
// Compares published state without sending messages or changing routing. Agent lookup may lazy-sync; dry-run emits a metric.
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findRoot, parseArgs } from './lib/project.mjs'
import { parseYaml, requireYaml } from './lib/yaml.mjs'
import { assertSkillProcess } from './lib/process-format.mjs'
import { validateProcessAgents } from './lib/agents.mjs'
import { writeAgentRuntimeEvidence } from './lib/agent-runtime-evidence.mjs'

let parsed
try { parsed = parseArgs(process.argv.slice(2), ['help', 'json', 'record'], ['help', 'json', 'record', 'root']) }
catch (error) { console.error(error.message); process.exit(2) }
const { positional, options } = parsed
const slug = positional[0]
if (options.help || !slug) {
  console.log('agents-runtime.mjs <process> [--root DIR] [--json] [--record]')
  process.exit(options.help ? 0 : 2)
}
try {
  if (positional.length !== 1 || Object.keys(options).some(key => !['help', 'json', 'record', 'root'].includes(key))) throw Error('Неизвестный параметр или лишний аргумент.')
  requireYaml()
  const root = findRoot(options.root)
  assertSkillProcess(root, slug)
  const map = parseYaml(readFileSync(join(root, slug, 'process.yaml'), 'utf8'))
  const local = validateProcessAgents({ root, slug, map })
  if (!local.enabled) throw Error('В процессе нет самостоятельных помощников.')
  if (local.errors.length) throw Error(`Локальный контракт помощников не прошёл check: ${local.errors.join('; ')}`)
  const spec = parseYaml(readFileSync(join(root, slug, 'agents/spec.yaml'), 'utf8'))
  const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  const dirty = execFileSync('git', ['status', '--porcelain=v1', '--', slug], { cwd: root, encoding: 'utf8' }).trim()
  const agents = spec.agents.map(agent => ({ key: agent.key, config: agent.config,
    sha256: createHash('sha256').update(readFileSync(join(root, agent.config))).digest('hex'),
    model: JSON.parse(readFileSync(join(root, agent.config), 'utf8')).model || null }))
  const routes = Array.isArray(spec.routes) ? spec.routes : []
  for (const [index, route] of routes.entries())
    if (!Array.isArray(route.testContacts) || !route.testContacts.length || route.testContacts.length > 5 ||
        route.testContacts.some(contact => typeof contact?.type !== 'string' || !contact.type.trim() ||
          typeof contact?.value !== 'string' || !contact.value.trim()))
      throw Error(`routes[${index}]: для сухой проверки нужны 1–5 тестовых контактов testContacts с type и value`)
  const input = { agents: agents.map(({ key, config }) => ({ key, config })),
    routes: routes.map((route, index) => ({ index, channel: route.channel,
      contacts: route.testContacts || [], text: route.sampleText || 'Проверка маршрута',
      startParam: route.testStartParam || undefined })) }
  const code = `import { getPublishedAgentBySourcePath, getProcessChannelRouting, dryRunProcessChannelRouting, getAllAvailableTools, getEnabledToolEntry } from '@ai-agents/sdk/process'\n` +
    `const input = ${JSON.stringify(input)}\n` +
    `const agents = []\n` +
    `for (const item of input.agents) { try { agents.push({ key: item.key, value: await getPublishedAgentBySourcePath(ctx, item.config) }) } catch (error) { agents.push({ key: item.key, error: String(error?.message || error) }) } }\n` +
    `try { const catalog = await getAllAvailableTools(ctx); for (const row of agents) { if (!row.value) continue; const refs = row.value.enabledTools || []; row.toolChecks = []; if (refs.length > 40 || catalog.tools.length > 1000) { row.toolError = 'tool catalog limit exceeded'; continue } for (const ref of refs) { const candidates = catalog.tools.filter(item => Array.isArray(item.nativeJson) && Number(item.nativeJson[0]) === (ref.isWorkspaceTool ? ctx.account.id : ref.accountId) && String(item.nativeJson[1] || '').replace(/^\\/+/, '').includes(String(ref.path || '').replace(/^\\/+/, ''))); if (candidates.length > 10) { row.toolChecks.push({ ref, status: 'unverified', reason: 'ambiguous catalog entry' }); continue } let found = false; for (const item of candidates) { const entry = await getEnabledToolEntry(ctx, item.nativeJson, row.value.workspacePath ?? undefined); if (entry && entry.isWorkspaceTool === ref.isWorkspaceTool && (entry.accountId ?? null) === (ref.accountId ?? null) && entry.path === ref.path && entry.pattern === ref.pattern) { found = true; break } } row.toolChecks.push({ ref, status: found ? 'available' : 'missing' }) } } } catch (error) { for (const row of agents) if (row.value) row.toolError = String(error?.message || error) }\n` +
    `const routes = []\n` +
    `for (const item of input.routes) { try { routes.push({ index: item.index, value: await getProcessChannelRouting(ctx, item.channel), dryRun: await dryRunProcessChannelRouting(ctx, { channelId: item.channel, contacts: item.contacts, text: item.text, startParam: item.startParam }) }) } catch (error) { routes.push({ index: item.index, error: String(error?.message || error) }) } }\n` +
    `return { accountId: ctx.account.id, agents, routes }`
  const run = spawnSync('chatium', ['exec'], { cwd: root, input: code, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
  if (run.error || run.status !== 0) throw Error(`Не удалось проверить опубликованное состояние: ${run.error?.message || run.stderr.trim()}`)
  const published = JSON.parse(run.stdout)
  const errors = [], warnings = [], informational = [...local.warnings]
  if (dirty) errors.push('папка процесса содержит неопубликованные изменения')
  const executedCommit = run.stderr.match(/Executed commit: ([0-9a-f]{40})/)?.[1]
  if (!executedCommit) errors.push('CLI не подтвердил коммит исполненного кода')
  else if (executedCommit !== commit) errors.push(`опубликован коммит ${executedCommit}, локально ${commit}`)
  if (map.accountId && published.accountId !== map.accountId) errors.push(`Аккаунт ${published.accountId} не совпадает с картой ${map.accountId}`)
  if (!map.accountId) errors.push('В карте нет accountId для проверки опубликованных помощников')
  const ids = new Map()
  for (const agent of agents) {
    const row = published.agents?.find(item => item.key === agent.key)
    if (!row || row.error) { errors.push(`${agent.key}: ${row?.error || 'нет опубликованного ответа'}`); continue }
    const value = row.value
    if (value.branch !== branch) errors.push(`${agent.key}: проверен ${value.branch}, нужна ветка ${branch}; CLI не подменяет preview`)
    if (value.sourceSha256 !== agent.sha256) errors.push(`${agent.key}: опубликованный файл отличается от локального`)
    if (value.model !== agent.model) errors.push(`${agent.key}: опубликованная модель отличается от локальной`)
    if (!value.agentId) errors.push(`${agent.key}: платформа не вернула agentId`)
    else ids.set(agent.key, value.agentId)
    const node = map.nodes.find(node => node.id === spec.agents.find(item => item.key === agent.key)?.node)
    if (!node?.agentId) errors.push(`${agent.key}: запиши опубликованный agentId в узел карты и обнови снимок`)
    else if (node.agentId !== value.agentId) errors.push(`${agent.key}: agentId карты отличается от опубликованного`)
    if (row.toolError) warnings.push(`${agent.key}: каталог инструментов не проверен: ${row.toolError}`)
    for (const tool of row.toolChecks || []) {
      if (tool.status === 'missing') errors.push(`${agent.key}: включённый инструмент недоступен: ${tool.ref?.path}`)
      else if (tool.status !== 'available') warnings.push(`${agent.key}: инструмент не проверен: ${tool.ref?.path}`)
    }
  }
  for (const [index, route] of routes.entries()) {
    const row = published.routes?.find(item => item.index === index)
    if (!row || row.error) { errors.push(`routes[${index}]: ${row?.error || 'нет ответа'}`); continue }
    const id = ids.get(route.firstAgent)
    if (!id) { errors.push(`routes[${index}]: не установлен опубликованный ID первого агента`); continue }
    if (!row.value.config?.enabled || row.value.config.defaultAgentId !== id) errors.push(`routes[${index}]: канал не направлен к ${route.firstAgent}`)
    if (!row.value.linkedAgentIds?.includes(id)) errors.push(`routes[${index}]: агент не привязан к каналу`)
    if (row.dryRun?.mode !== 'selected' || row.dryRun?.agentId !== id) errors.push(`routes[${index}]: сухая проверка выбрала ${row.dryRun?.agentId || row.dryRun?.mode || 'ничего'}, ожидался ${id}`)
    if (row.value.config?.rulesCount) warnings.push(`routes[${index}]: в канале есть дополнительные правила; проверь отдельные случаи в интерфейсе`)
  }
  const status = errors.length ? 'unverified' : warnings.length ? 'partial' : 'verified'
  const report = { process: slug, root, accountId: published.accountId, branch, commit, executedCommit, checkedAt: new Date().toISOString(),
    scope: 'published-agents-and-new-conversation-routing',
    limitations: routes.length ? ['Продолжение существующего разговора dryRunProcessChannelRouting не проверяет; нужен отдельный контролируемый сценарий и ревью помощников.'] : [],
    status, errors, warnings, informational,
    agents: published.agents, routes: published.routes }
  if (options.record && status === 'verified')
    report.recordedPath = writeAgentRuntimeEvidence({ root, slug, branch, commit,
      checkedAt: report.checkedAt, accountId: published.accountId, map, spec })
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`Помощники ${slug}: ${report.status}.`)
    for (const issue of errors) console.log(`✘ ${issue}`)
    for (const issue of warnings) console.log(`! ${issue}`)
    for (const issue of informational) console.log(`i ${issue}`)
    if (report.recordedPath) console.log(`Результат записан: ${report.recordedPath}`)
  }
  process.exitCode = status === 'verified' ? 0 : 1
} catch (error) {
  if (options.json) console.log(JSON.stringify({ status: 'unavailable', error: error.message }))
  else console.error(error.message)
  process.exitCode = 2
}
