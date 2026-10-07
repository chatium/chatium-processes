import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { architectureReviewStatus } from './architecture-review.mjs'
import { agentReviewStatus } from './agent-review.mjs'
import { analyticsReviewStatus } from './analytics-review.mjs'
import { validateProcessAgents } from './agents.mjs'
import { codeReviewStatus } from './code-review.mjs'
import { creativeReviewStatus } from './creative-review.mjs'
import { reviewStatus } from './knowledge-review.mjs'
import { isProcessSlug, rel } from './project.mjs'
import { processSourceFiles } from './process-sources.mjs'
import { parseYaml } from './yaml.mjs'

export const COMMISSION_STAGES = ['design', 'build', 'test', 'launch']

export function reviewRequirements({ root, slug, stage = 'test' }) {
  if (!isProcessSlug(slug) || !COMMISSION_STAGES.includes(stage)) throw Error('Нужны процесс и этап design, build, test или launch.')
  const mapPath = join(root, slug, 'process.yaml')
  const map = existsSync(mapPath) ? parseYaml(readFileSync(mapPath, 'utf8')) : {}
  const nodes = Array.isArray(map?.nodes) ? map.nodes : []
  const requirements = [
    { id: `knowledge-${stage === 'launch' ? 'launch' : stage === 'design' ? 'design' : 'build'}`, role: 'methodology', stage },
    { id: 'architecture', role: 'architecture', stage },
  ]
  if (stage !== 'design') requirements.push({ id: 'implementation', role: 'implementation', stage })
  if (stage !== 'design') for (const node of nodes.filter(node => ['page', 'series'].includes(node.kind) && typeof node.id === 'string')) {
    requirements.push({ id: `creative-${node.id}-spec`, role: 'creative', nodeId: node.id, reviewStage: 'spec', stage })
    if (['test', 'launch'].includes(stage))
      requirements.push({ id: `creative-${node.id}-result`, role: 'creative', nodeId: node.id, reviewStage: 'result', stage })
  }
  if (stage !== 'design') {
    const mapped = kind => nodes.filter(node => node.kind === kind && typeof node.source === 'string')
      .map(node => node.source.replace(/\/$/, ''))
    const covered = (path, sources) => sources.some(source => path === source || path.startsWith(`${source}/`))
    const pages = processSourceFiles(root, join(root, slug, 'pages')).filter(path => /\.(?:[cm]?jsx?|[cm]?tsx?|vue)$/.test(path))
      .map(path => rel(root, path)).filter(path => !covered(path, mapped('page')))
    const messages = processSourceFiles(root, join(root, '.mailings/storage/processes', slug))
      .filter(path => path.endsWith('.message.yaml')).map(path => rel(root, path))
      .filter(path => !covered(path, mapped('series')))
    if (pages.length || messages.length) requirements.push({ id: 'unmapped-content', role: 'inventory', stage,
      files: [...pages, ...messages].sort() })
  }
  const agents = validateProcessAgents({ root, slug, map }).enabled
  if (agents && stage !== 'design') requirements.push({ id: 'agents', role: 'agents', stage })
  if (stage !== 'design') {
    const hasSpec = existsSync(join(root, slug, 'specs/analytics.yaml'))
    const hasQuery = processSourceFiles(root, join(root, slug)).some(path => {
      if (!/\.(?:[cm]?jsx?|[cm]?tsx?|vue)$/.test(path)) return false
      if (statSync(path).size > 80_000) throw Error(`Исходник ${rel(root, path)} слишком велик для определения комиссии.`)
      return /\bqueryAi\s*\(/.test(readFileSync(path, 'utf8'))
    })
    if (hasSpec || hasQuery) requirements.push({ id: 'analytics', role: 'analytics', stage })
  }
  return requirements
}

function readRequirement({ root, slug, requirement }) {
  if (requirement.role === 'methodology') return reviewStatus({ root, slug, stage: requirement.id.slice('knowledge-'.length) })
  if (requirement.role === 'architecture') return architectureReviewStatus({ root, slug })
  if (requirement.role === 'implementation') return codeReviewStatus({ root, slug })
  if (requirement.role === 'creative') return creativeReviewStatus({ root, slug, nodeId: requirement.nodeId, stage: requirement.reviewStage })
  if (requirement.role === 'agents') return agentReviewStatus({ root, slug })
  if (requirement.role === 'analytics') return analyticsReviewStatus({ root, slug })
  if (requirement.role === 'inventory') return { status: 'needs-work',
    error: `Исходники страниц или сообщений не привязаны к карте: ${requirement.files.join(', ')}` }
  throw Error(`Неизвестная роль ${requirement.role}`)
}

export function commissionStatus({ root, slug, stage = 'test' }) {
  const requirements = reviewRequirements({ root, slug, stage }).map(requirement => {
    try {
      const report = readRequirement({ root, slug, requirement })
      return { ...requirement, status: report.status, path: report.path,
        ...(report.error ? { error: report.error } : {}),
        ...(report.changedReferences ? { changedReferences: report.changedReferences } : {}),
        ...(report.informationalReferences?.length ? { informationalReferences: report.informationalReferences } : {}),
        blocking: (report.blocking || []).map(item => ({ id: item.id, reason: item.reason })) }
    } catch (error) { return { ...requirement, status: 'invalid', error: error.message } }
  })
  return { process: slug, stage, status: requirements.every(item => item.status === 'ready') ? 'ready' : 'needs-work', requirements }
}
