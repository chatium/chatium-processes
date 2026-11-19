import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { boardDecisionDigest, ownerDecisionForCurrentBoard, ownerDecisionStatus, prepareOwnerDecision } from './owner-decisions.mjs'
import { assertPublishedState, gitState } from './git-state.mjs'
import { readProcessBoard } from './board.mjs'
import { safeTaskPath } from './tasks.mjs'
import { processSourceFiles } from './process-sources.mjs'
import { emptyDesignSource } from './design-content.mjs'
import { assertSkillProcess } from './process-format.mjs'

export async function adoptBuiltPlan({ root, slug, readBoard = readProcessBoard }) {
  const args = { root, slug, kind: 'plan' }
  const existing = ownerDecisionStatus(args)
  if (existing.status !== 'missing') return ownerDecisionForCurrentBoard({ ...args, readBoard })
  assertSkillProcess(root, slug)
  const state = gitState(root)
  const board = await readBoard(root, slug)
  const snapshot = board.snapshot
  if (snapshot?.commit !== state.commit || snapshot.branch !== state.branch ||
      snapshot.processPath !== slug || !snapshot.nodes?.length || !snapshot.nodes.every(node => {
        if (node.build?.source !== 'present' || !node.source) return false
        const source = safeTaskPath(root, node.source.replace(/\/$/, ''), { mayBeMissing: true })
        return processSourceFiles(root, source).some(file => {
          if (basename(file).startsWith('.') || basename(file) === 'process.yaml' || emptyDesignSource(file)) return false
          if (node.kind === 'series') return file.endsWith('.message.yaml')
          if (node.kind === 'page') return file.endsWith('.tsx')
          return /\.(?:[cm]?[jt]sx?|vue|json|ya?ml)$/.test(file)
        })
      })) return existing
  const packet = prepareOwnerDecision({ ...args, boardRevision: board.boardRevision, boardContentDigest: boardDecisionDigest(board) })
  assertPublishedState(root, state)
  const record = { version: 1, process: slug, kind: 'plan', decision: 'approve', authority: 'published-build',
    recordedAt: new Date().toISOString(), shownCommit: state.commit, boardRevision: packet.boardRevision,
    boardContentDigest: packet.boardContentDigest, scopeDigest: packet.digest, scopeManifest: packet.manifest }
  const directory = dirname(existing.path)
  mkdirSync(directory, { recursive: true })
  const temp = mkdtempSync(join(directory, '.adopt-'))
  try {
    const file = join(temp, 'plan.json')
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
    try { linkSync(file, existing.path) } catch (error) { if (error.code !== 'EEXIST') throw error }
  } finally { rmSync(temp, { recursive: true, force: true }) }
  return ownerDecisionForCurrentBoard({ ...args, readBoard })
}
