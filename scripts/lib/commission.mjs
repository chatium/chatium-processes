import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { architectureReviewStatus } from './architecture-review.mjs'
import { agentReviewStatus } from './agent-review.mjs'
import { validateProcessAgents } from './agents.mjs'
import { codeReviewStatus } from './code-review.mjs'
import { creativeReviewStatus } from './creative-review.mjs'
import { reviewStatus } from './knowledge-review.mjs'
import { isProcessSlug } from './project.mjs'
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
  const agents = validateProcessAgents({ root, slug, map }).enabled
  if (agents && stage !== 'design') requirements.push({ id: 'agents', role: 'agents', stage })
  return requirements
}

function readRequirement({ root, slug, requirement }) {
  if (requirement.role === 'methodology') return reviewStatus({ root, slug, stage: requirement.id.slice('knowledge-'.length) })
  if (requirement.role === 'architecture') return architectureReviewStatus({ root, slug })
  if (requirement.role === 'implementation') return codeReviewStatus({ root, slug })
  if (requirement.role === 'creative') return creativeReviewStatus({ root, slug, nodeId: requirement.nodeId, stage: requirement.reviewStage })
  if (requirement.role === 'agents') return agentReviewStatus({ root, slug })
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
