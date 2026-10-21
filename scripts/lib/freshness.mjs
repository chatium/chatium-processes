import { isDeepStrictEqual } from 'node:util'
import { assertPublishedState, SnapshotDrift } from './git-state.mjs'
import { startExec } from './snapshot.mjs'

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

export async function verifySnapshot(root, expected, { expectedRevision, reader = readBoard } = {}) {
  let board
  try {
    // Read even with local edits: context must still show shared notes to the agent.
    board = await reader(root, expected, { usage: 'check' })
    compareSnapshot(expected, board, expectedRevision)
    assertPublishedState(root, expected)
    return { verified: true, status: 'current', branch: expected.branch, commit: expected.commit,
      ...(board.snapshot.snapshot.producer ? { producer: board.snapshot.snapshot.producer } : {}),
      revision: board.snapshot.revision, boardRevision: board.revision, elements: board.elements }
  } catch (e) {
    return { verified: false, status: e instanceof SnapshotDrift ? 'stale' : 'unavailable', error: e.message,
      ...(board?.elements ? { elements: board.elements } : {}),
      ...(board?.snapshot?.snapshot ? { snapshotCommit: board.snapshot.snapshot.commit, revision: board.snapshot.revision } : {}) }
  }
}
