import { isDeepStrictEqual } from 'node:util'
import { assertPublishedState, SnapshotDrift } from './git-state.mjs'
import { startExec } from './snapshot.mjs'

export async function readBoard(root, target) {
  return startExec(root,
    `import { readProcessBoardForAgent } from '@start/sdk'\nreturn await readProcessBoardForAgent(ctx, ${JSON.stringify(target.processPath)}, ${JSON.stringify(target.branch)})`)
}

// Time changes on every check. Object key order is not part of the contract.
// A previous optional typecheck need not be rerun just to read the board.
function content(snapshot) {
  const { checkedAt, ...rest } = snapshot
  // Validation gates vary with --task-stage and --knowledge-stage. The map is
  // tied to the published commit; a stage-only check must not stale the board.
  const stageChecks = new Set(['tasks', 'creative.review', 'knowledge.review', 'implementation.review', 'reviews', 'owner.plan', 'owner.launch', 'owner.launch.board'])
  return JSON.parse(JSON.stringify({ ...rest,
    checks: snapshot.checks.filter(c => !stageChecks.has(c.id) && c.id !== 'typecheck'),
  }))
}

export function compareSnapshot(expected, board, expectedRevision) {
  if (!board || !Number.isInteger(board.revision) || board.revision < 0 ||
      !board.elements || !['blocks', 'connections', 'drawings'].every(k => Array.isArray(board.elements[k])) ||
      !Object.hasOwn(board, 'snapshot')) throw Error('Некорректный ответ SDK чтения доски.')
  if (board.snapshot === null) throw new SnapshotDrift('Снимок карты отсутствует. Выполните check без --verify-snapshot.')
  const stored = board.snapshot
  if (!Number.isInteger(stored.revision) || stored.revision < 1 || !stored.snapshot || !Array.isArray(stored.snapshot.checks))
    throw Error('Некорректный снимок в ответе SDK.')
  const actual = stored.snapshot
  if (actual.processPath !== expected.processPath || actual.branch !== expected.branch)
    throw new SnapshotDrift('Снимок принадлежит другому процессу или ветке.')
  if (actual.commit !== expected.commit)
    throw new SnapshotDrift(`Карта отстала: снимок ${actual.commit}, HEAD ${expected.commit}. Повторите check после push.`)
  if (expectedRevision !== undefined && (stored.revision !== expectedRevision || actual.checkedAt !== expected.checkedAt))
    throw new SnapshotDrift('После записи снимок изменился. Прочитайте доску и повторите check.')
  if (!isDeepStrictEqual(content(expected), content(actual)))
    throw new SnapshotDrift('Коммит совпал, но содержимое карты или результаты проверок отличаются. Повторите check для обновления снимка.')
}

export async function verifySnapshot(root, expected, { expectedRevision, reader = readBoard } = {}) {
  let board
  try {
    // Read even with local edits: context must still show shared notes to the agent.
    board = await reader(root, expected)
    compareSnapshot(expected, board, expectedRevision)
    assertPublishedState(root, expected)
    return { verified: true, status: 'current', branch: expected.branch, commit: expected.commit,
      revision: board.snapshot.revision, boardRevision: board.revision, elements: board.elements }
  } catch (e) {
    return { verified: false, status: e instanceof SnapshotDrift ? 'stale' : 'unavailable', error: e.message,
      ...(board?.elements ? { elements: board.elements } : {}),
      ...(board?.snapshot?.snapshot ? { snapshotCommit: board.snapshot.snapshot.commit, revision: board.snapshot.revision } : {}) }
  }
}
