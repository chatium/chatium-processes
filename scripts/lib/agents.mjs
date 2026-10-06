import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isFile } from './project.mjs'
import { parseYaml } from './yaml.mjs'

const KEY = /^[a-z][a-z0-9-]*$/
const DECISIONS = new Set(['accepted', 'declined', 'deferred'])

function agentFiles(dir, errors) {
  const files = []
  function visit(path) {
    for (const name of readdirSync(path)) {
      if (name === 'node_modules' || name === '.git') continue
      const child = join(path, name), stat = lstatSync(child)
      if (stat.isSymbolicLink()) {
        if (child.endsWith('.agent.json')) errors.push(`конфиг ${child} не должен быть символической ссылкой`)
      } else if (stat.isDirectory()) visit(child)
      else if (stat.isFile() && child.endsWith('.agent.json')) files.push(child)
    }
  }
  if (existsSync(dir)) visit(dir)
  return files
}

function localFile(root, value) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value)) return null
  const absolute = resolve(root, value)
  const rel = relative(root, absolute)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) return null
  if (existsSync(absolute)) {
    const canonical = realpathSync(absolute)
    const canonicalRel = relative(realpathSync(root), canonical)
    if (!canonicalRel || canonicalRel === '..' || canonicalRel.startsWith(`..${sep}`)) return null
  }
  return absolute
}

function loadYaml(path, errors, label) {
  if (!isFile(path)) {
    errors.push(`нет ${label}`)
    return null
  }
  try { return parseYaml(readFileSync(path, 'utf8')) }
  catch (error) { errors.push(`${label}: ${error.message}`); return null }
}

/** Local, read-only checks. Published agents, routing and tool availability require separate verification. */
export function validateProcessAgents({ root, slug, map }) {
  const errors = [], warnings = []
  const dir = resolve(root, slug)
  const configs = agentFiles(dir, errors)
  const agentNodes = (map?.nodes || []).filter(node => node?.kind === 'agent')
  const specPath = resolve(dir, 'agents/spec.yaml')
  const casesPath = resolve(dir, 'agents/cases.yaml')
  if (!configs.length && !agentNodes.length && !existsSync(specPath) && !errors.length) return { errors, warnings, enabled: false }

  const spec = loadYaml(specPath, errors, `${slug}/agents/spec.yaml`)
  const cases = loadYaml(casesPath, errors, `${slug}/agents/cases.yaml`)
  if (!spec || !cases) return { errors, warnings, enabled: true }
  if (spec.version !== 1) errors.push('agents/spec.yaml: version должен быть 1')
  if (cases.version !== 1) errors.push('agents/cases.yaml: version должен быть 1')
  if (!Array.isArray(spec.opportunities)) errors.push('agents/spec.yaml: нужен список opportunities с решениями владельца')
  if (!Array.isArray(spec.agents)) errors.push('agents/spec.yaml: нужен список agents')
  if (!Array.isArray(cases.cases)) errors.push('agents/cases.yaml: нужен список cases')
  const opportunities = new Map()
  for (const [i, item] of (Array.isArray(spec.opportunities) ? spec.opportunities : []).entries()) {
    const where = `opportunities[${i}]`
    if (!KEY.test(item?.id || '')) errors.push(`${where}: нужен устойчивый id`)
    if (!DECISIONS.has(item?.decision)) errors.push(`${where}: decision — accepted, declined или deferred`)
    if (!item?.need || !item?.reason) errors.push(`${where}: нужны need и reason`)
    if (opportunities.has(item?.id)) errors.push(`${where}: повторный id ${item.id}`)
    opportunities.set(item?.id, item)
  }
  const byKey = new Map(), byNode = new Map(), byConfig = new Map()
  for (const [i, agent] of (Array.isArray(spec.agents) ? spec.agents : []).entries()) {
    const where = `agents[${i}]`
    if (!KEY.test(agent?.key || '')) errors.push(`${where}: нужен устойчивый key`)
    if (byKey.has(agent?.key)) errors.push(`${where}: повторный key ${agent.key}`)
    byKey.set(agent?.key, agent)
    for (const field of ['role', 'outcome', 'boundary']) if (!agent?.[field]) errors.push(`${where}: нет ${field}`)
    if (!Array.isArray(agent?.inputs) || !agent.inputs.length) errors.push(`${where}: опиши входы в inputs`)
    if (!Array.isArray(agent?.knowledge)) errors.push(`${where}: knowledge должен быть списком фактически доступных источников`)
    if (!Array.isArray(agent?.tools)) errors.push(`${where}: tools должен быть списком доступных действий`)
    if (!Array.isArray(agent?.cases) || !agent.cases.length) errors.push(`${where}: нужны связанные сценарии cases`)
    if (opportunities.get(agent?.opportunity)?.decision !== 'accepted') errors.push(`${where}: opportunity должен ссылаться на принятое применение`)
    const configPath = localFile(root, agent?.config)
    if (!configPath || !configPath.startsWith(`${resolve(dir, 'agents')}${sep}`) || !configPath.endsWith('.agent.json')) errors.push(`${where}: config должен вести к *.agent.json внутри ${slug}/agents/`)
    else {
      if (byConfig.has(configPath)) errors.push(`${where}: config повторяется`)
      byConfig.set(configPath, agent)
      if (!isFile(configPath)) errors.push(`${where}: нет ${agent.config}`)
      else try {
        const config = JSON.parse(readFileSync(configPath, 'utf8'))
        if (!config.title || !config.model || !Array.isArray(config.instructions) || !config.instructions.some(s => typeof s === 'string' && s.trim())) errors.push(`${where}: в конфиге нужны title, model и непустые instructions[]`)
        if (config.enabledTools !== undefined && (!Array.isArray(config.enabledTools) || config.enabledTools.some(ref =>
          !ref || typeof ref !== 'object' || typeof ref.isWorkspaceTool !== 'boolean' ||
          typeof ref.path !== 'string' || !ref.path || typeof ref.pattern !== 'string' || !ref.pattern ||
          (!ref.isWorkspaceTool && !Number.isInteger(ref.accountId)))))
          errors.push(`${where}: enabledTools должен содержать канонические ссылки на инструменты`)
        for (const field of ['department', 'specialists', 'supervisorAgentId']) if (field in config) errors.push(`${where}: ${field} относится к старой схеме отделов`)
      } catch (error) { errors.push(`${where}: ${agent.config} не разбирается как JSON: ${error.message}`) }
    }
    const node = agentNodes.find(node => node.id === agent?.node)
    if (!node) errors.push(`${where}: нет узла карты ${agent?.node}`)
    else if (configPath && resolve(root, node.source || '') !== configPath) errors.push(`${where}: source узла ${agent.node} не совпадает с config`)
    if (byNode.has(agent?.node)) errors.push(`${where}: узел ${agent.node} назначен дважды`)
    byNode.set(agent?.node, agent)
    for (const [j, source] of (Array.isArray(agent?.knowledge) ? agent.knowledge : []).entries()) {
      const file = localFile(root, source)
      if (!file || !existsSync(file)) errors.push(`${where}.knowledge[${j}]: нет локального источника ${source}`)
    }
  }
  for (const node of agentNodes) if (!byNode.has(node.id)) errors.push(`узел ${node.id} не описан в agents/spec.yaml`)
  for (const path of configs) if (!byConfig.has(path)) errors.push(`конфиг ${relative(root, path)} не описан в agents/spec.yaml`)

  const caseIds = new Set()
  for (const [i, item] of (Array.isArray(cases.cases) ? cases.cases : []).entries()) {
    const where = `cases[${i}]`
    if (!KEY.test(item?.id || '') || caseIds.has(item?.id)) errors.push(`${where}: нужен уникальный id`)
    caseIds.add(item?.id)
    if (!byKey.has(item?.agent)) errors.push(`${where}: неизвестный agent ${item?.agent}`)
    for (const field of ['situation', 'expected', 'evidence']) if (!item?.[field]) errors.push(`${where}: нет ${field}`)
  }
  for (const agent of byKey.values()) for (const id of (Array.isArray(agent?.cases) ? agent.cases : [])) if (!caseIds.has(id)) errors.push(`агент ${agent.key}: нет сценария ${id}`)

  const routes = Array.isArray(spec.routes) ? spec.routes : []
  if (spec.routes !== undefined && !Array.isArray(spec.routes)) errors.push('routes должен быть списком')
  const channels = new Set()
  for (const [i, route] of routes.entries()) {
    const where = `routes[${i}]`
    if (!route?.channel) errors.push(`${where}: нет channel`)
    if (channels.has(route?.channel)) errors.push(`${where}: повторный маршрут канала ${route.channel}`)
    channels.add(route?.channel)
    if (!byKey.has(route?.firstAgent)) errors.push(`${where}: неизвестный firstAgent ${route?.firstAgent}`)
    if (route?.fallback && !byKey.has(route.fallback)) errors.push(`${where}: неизвестный fallback ${route.fallback}`)
    if (route?.fallback && route.fallback !== route.firstAgent) warnings.push(`${where}: отдельный запасной агент требует явных правил маршрутизации; простой SDK задаёт только одного адресата по умолчанию`)
    if (!route?.existingConversation) errors.push(`${where}: опиши существующий разговор в existingConversation`)
  }
  for (const [i, handoff] of (Array.isArray(spec.handoffs) ? spec.handoffs : []).entries()) {
    const where = `handoffs[${i}]`
    if (!byKey.has(handoff?.from) || !byKey.has(handoff?.to) || handoff.from === handoff.to) errors.push(`${where}: нужны разные существующие from и to`)
    for (const field of ['when', 'summary', 'context', 'onFailure']) if (!handoff?.[field]) errors.push(`${where}: нет ${field}`)
  }
  if (byKey.size && !routes.length) warnings.push('Нет routes: если агент принимает сообщения из общего канала, укажи первый адресат и поведение существующего разговора')
  return { errors, warnings, enabled: true }
}
