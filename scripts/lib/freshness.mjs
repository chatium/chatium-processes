import { isDeepStrictEqual } from 'node:util'
import { assertPublishedState, SnapshotDrift } from './git-state.mjs'
import { startExec } from './snapshot.mjs'
import { resolveBuildState } from './build-state.mjs'

export async function readBoard(root, target, { usage, execute = startExec } = {}) {
  return execute(root,
    `import { readProcessBoardForAgent } from '@start/sdk'\nreturn await readProcessBoardForAgent(ctx, ${JSON.stringify(target.processPath)}, ${JSON.stringify(target.branch)}, ${JSON.stringify(usage)})`, target.commit)
}

// Graph freshness and construction acceptance are separate. Live working-copy
// progress and optional checks must not make an otherwise current graph stale.
function visualContent(snapshot) {
  const { checkedAt, producer, checks, build, nodes, ...rest } = snapshot
  return JSON.parse(JSON.stringify({ ...rest, nodes: nodes.map(node => {
    const { status, reason, build, progress, ...visible } = node
    return visible
  }) }))
}

const ordered = (items, select) => (items || []).map(select).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
function sameConstructionInputs(expected, actual) {
  const inputs = proof => ordered(proof?.inputs, item => [item.path, item.sha256])
  return actual.build?.kind === 'check' && actual.build.contract === expected.build?.contract &&
    isDeepStrictEqual(inputs(expected.build), inputs(actual.build)) &&
    isDeepStrictEqual([...(expected.build?.inventory || [])].sort(), [...(actual.build.inventory || [])].sort())
}

/** An unchanged proof may retain the last typecheck; it never invents a new one. */
export function inheritedTypecheck(expected, actual) {
  // Typecheck covers the whole account. A process-only fingerprint cannot
  // certify a different account commit (tsconfig, typings or another process).
  if (!actual || !/^[a-f0-9]{40}$/.test(expected.commit || '') ||
      actual.build?.checkedCommit !== expected.commit || !sameConstructionInputs(expected, actual)) return null
  const gate = actual.build.gates.find(item => item.id === 'typecheck')
  const check = actual.checks.find(item => item.id === 'typecheck')
  if (!gate || !['passed', 'failed'].includes(gate.state) || !check || check.ok !== (gate.state === 'passed')) return null
  return { id: 'typecheck', title: check.title, ok: check.ok, errors: check.errors, warnings: [
    ...(check.warnings || []).filter(item => !item.startsWith('Сохранён результат typecheck')),
    `Сохранён результат typecheck от ${actual.build.checkedCommit}: входы и контракт проверки не изменились.`,
  ] }
}

/** Compare acceptance separately from the graph. Reading never changes a status. */
export function compareConstruction(expected, actual, { taskStage = 'build', knowledgeStage = taskStage === 'design' ? 'design' : taskStage === 'launch' ? 'launch' : 'build' } = {}) {
  const errors = [], warnings = [], nodes = []
  const next = `node .agents/skills/chatium-processes/scripts/check.mjs ${expected.processPath} --typecheck --task-stage ${taskStage} --knowledge-stage ${knowledgeStage} --publish-snapshot`
  const gates = items => ordered(items, gate => [gate.id, gate.state])
  const taskStates = items => ordered(items, task => [task.id, task.status, task.acceptance])
  const sameInputs = sameConstructionInputs(expected, actual)
  const common = (expected.build?.gates || []).map(gate => {
    // A read without --typecheck must not invalidate an unchanged, checked build.
    const saved = actual.build?.gates?.find(item => item.id === 'typecheck')
    return gate.id === 'typecheck' && gate.state === 'pending' && sameInputs && saved ? saved : gate
  })
  if (actual.build?.kind !== 'check') errors.push('На доске не опубликованы проверки и приёмка сборки; наличие снимка сборки их не заменяет.')
  else if (!sameInputs) errors.push('Приёмка на доске относится к другим входам или контракту проверки. Опубликуйте актуальный check.')
  else if (!isDeepStrictEqual(gates(common), gates(actual.build.gates)))
    errors.push('Общие условия приёмки на доске отличаются от текущей проверки.')
  for (const node of expected.nodes) {
    const stored = actual.nodes.find(item => item.id === node.id)
    if (!stored) { errors.push(`${node.id}: блока нет на доске.`); continue }
    if (!node.build || !stored.build) { errors.push(`${node.id}: факты сборки на доске недоступны.`); continue }
    const local = resolveBuildState(node.build, common)
    const progress = stored.progress || []
    const server = resolveBuildState(stored.build, actual.build?.gates || [])
    if (progress.length) {
      errors.push(`${node.id}: на доске есть неопубликованная работа (${progress.map(item => `${item.taskId}: ${item.state}`).join(', ')}). Сверьте construction.mjs sync; чужую работу не удаляйте.`)
    } else if (stored.status !== local.status ||
        !isDeepStrictEqual(taskStates(node.build.tasks), taskStates(stored.build.tasks)) ||
        !isDeepStrictEqual(gates(node.build.gates), gates(stored.build.gates)) ||
        !isDeepStrictEqual(ordered(node.build.blockers, item => [item.title, item.blocks]), ordered(stored.build.blockers, item => [item.title, item.blocks])))
      errors.push(`${node.id}: доска «${stored.status}», текущая приёмка «${local.status}». ${local.reason}`)
    if (stored.status !== server.status) errors.push(`${node.id}: статус на доске не соответствует её собственным фактам приёмки.`)
    nodes.push({ id: node.id, title: node.title, actual: stored.status, expected: local.status,
      reason: local.reason, boardReason: stored.reason, tasks: node.build.tasks.map(task => ({
        id: task.id, status: task.status, acceptance: task.acceptance, details: task.details,
      })), ...(progress.length ? { progress: progress.map(({ taskId, state, workspaceId }) => ({ taskId, state, workspaceId })) } : {}) })
  }
  if (nodes.some(node => node.expected === 'in-progress' && node.tasks.some(task => task.status === 'result-ready')))
    warnings.push('Есть result-ready: проверьте результат и выполните tasks.mjs accept; одно наличие кода не завершает задачу.')
  return { status: errors.length ? 'stale' : 'current', nodes, errors, warnings,
    next: errors.length ? [`node .agents/skills/chatium-processes/scripts/construction.mjs sync ${expected.processPath}`, next] : [] }
}

export function compareSnapshot(expected, board, expectedRevision) {
  if (!board || !Number.isInteger(board.revision) || board.revision < 0 ||
      !board.elements || !['blocks', 'connections', 'drawings'].every(k => Array.isArray(board.elements[k])) ||
      !Object.hasOwn(board, 'snapshot')) throw Error('Некорректный ответ SDK чтения доски.')
  if (board.snapshot === null) throw new SnapshotDrift('Снимок карты отсутствует. Дождитесь сборки ветки; при сбое используйте check --publish-snapshot.')
  const stored = board.snapshot
  if (!Number.isInteger(stored.revision) || stored.revision < 1 || !stored.snapshot || !Array.isArray(stored.snapshot.checks))
    throw Error('Некорректный снимок в ответе SDK.')
  const actual = stored.snapshot
  if (actual.processPath !== expected.processPath || actual.branch !== expected.branch)
    throw new SnapshotDrift('Снимок принадлежит другому процессу или ветке.')
  if (actual.commit !== expected.commit)
    throw new SnapshotDrift(`Карта отстала: снимок ${actual.commit}, HEAD ${expected.commit}. Дождитесь хука сборки после push.`)
  if (expectedRevision !== undefined && (stored.revision !== expectedRevision || actual.checkedAt !== expected.checkedAt))
    throw new SnapshotDrift('После записи снимок изменился. Прочитайте доску и повторите check.')
  if (!isDeepStrictEqual(visualContent(expected), visualContent(actual)))
    throw new SnapshotDrift('Коммит совпал, но содержимое карты отличается. Проверьте сборку и при необходимости восстановите снимок через check --publish-snapshot.')
  if (expectedRevision !== undefined && (!actual.build || actual.build.contract !== expected.build?.contract ||
      actual.build.checkedCommit !== expected.build?.checkedCommit || actual.build.checkedAt !== expected.build?.checkedAt ||
      !isDeepStrictEqual(actual.build.inputs, expected.build?.inputs)))
    throw new SnapshotDrift('После записи доказательства сборки изменились. Прочитайте доску и повторите check.')
}

export async function verifySnapshot(root, expected, { expectedRevision, reader = readBoard, taskStage, knowledgeStage } = {}) {
  let board, construction
  try {
    // Read even with local edits: context must still show shared notes to the agent.
    board = await reader(root, expected, { usage: 'check' })
    if (board?.snapshot?.snapshot?.processPath === expected.processPath && board.snapshot.snapshot.branch === expected.branch)
      construction = compareConstruction(expected, board.snapshot.snapshot, { taskStage, knowledgeStage })
    compareSnapshot(expected, board, expectedRevision)
    assertPublishedState(root, expected)
    return { verified: true, status: 'current', branch: expected.branch, commit: expected.commit,
      ...(board.snapshot.snapshot.producer ? { producer: board.snapshot.snapshot.producer } : {}),
      revision: board.snapshot.revision, boardRevision: board.revision, elements: board.elements, construction }
  } catch (e) {
    return { verified: false, status: e instanceof SnapshotDrift ? 'stale' : 'unavailable', error: e.message,
      ...(construction ? { construction } : {}),
      ...(board?.elements ? { elements: board.elements } : {}),
      ...(board?.snapshot?.snapshot ? { snapshotCommit: board.snapshot.snapshot.commit, revision: board.snapshot.revision } : {}) }
  }
}
