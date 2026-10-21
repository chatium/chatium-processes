import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { git, gitState, assertLocalState } from './git-state.mjs'
import { loadTasks } from './tasks.mjs'
import { parseYaml } from './yaml.mjs'
import { startExec } from './snapshot.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const inside = (path, source) => typeof source === 'string' && (path === source.replace(/\/$/, '') || path.startsWith(source.replace(/\/$/, '') + '/'))

/** Metadata only. A checkpoint can invalidate acceptance, never certify a build. */
export async function syncBuildProgress(root, slug, { execute = startExec } = {}) {
  const pending = [], synced = [], discarded = []
  try {
    const origin = git(root, ['remote', 'get-url', 'origin'])
    if (!/^https:\/\/[^/]+\/s\/(?:source-git|git)\//.test(origin))
      return { status: 'local-only', reason: 'Локальные задачи сохранены; подключение к доске Source Git отсутствует.' }
    const state = gitState(root), workspaceId = hash(realpathSync(root)).slice(0, 32)
    const map = parseYaml(readFileSync(join(root, slug, 'process.yaml'), 'utf8'))
    const tasks = loadTasks(root, slug).tasks.filter(task => ['design', 'build'].includes(task.stage))
    const local = tasks.filter(task => {
      const path = `${slug}/tasks/${task.id}.json`
      try { return git(root, ['show', `HEAD:${path}`]) !== readFileSync(join(root, path), 'utf8').trim() }
      catch { return true }
    })
    const board = await execute(root, `import { readProcessBoardForAgent } from '@start/sdk'\nreturn await readProcessBoardForAgent(ctx, ${JSON.stringify(slug)}, ${JSON.stringify(state.branch)})`, state.commit)
    if (!board?.snapshot || board.snapshot.snapshot.commit !== state.commit)
      throw Error('Доска не соответствует исходной версии. Опубликуйте каркас и сверяйте выбранную ветку.')
    const scope = { process: slug, branch: state.branch, baseCommit: state.commit, snapshotRevision: board.snapshot.revision }
    const send = input => {
      const current = gitState(root)
      if (current.branch !== state.branch || current.commit !== state.commit) throw Error('Ветка изменилась во время синхронизации.')
      return execute(root, `import { writeProcessBuildProgress } from '@start/sdk'\nreturn await writeProcessBuildProgress(ctx, ${JSON.stringify(input)})`, state.commit)
    }
    const events = new Map(board.snapshot.snapshot.nodes.flatMap(node => node.progress || []).map(event => [event.taskId, event]))
    for (const task of local) {
      const nodeIds = (map.nodes || []).filter(node => task.targetNode === node.id ||
        (task.expectedOutputs || []).some(output => inside(output.path, node.source))).map(node => node.id).sort()
      if (!nodeIds.length) continue
      const taskSha256 = hash(readFileSync(join(root, slug, 'tasks', `${task.id}.json`)))
      const event = { taskId: task.id, taskRevision: task.revision,
        requestId: `build:${hash(`${workspaceId}:${state.branch}:${slug}:${task.id}:${task.revision}:${taskSha256}`).slice(0, 48)}`,
        title: task.title, state: task.status, nodeIds, taskSha256, workspaceId,
        ...((task.questions || []).find(q => q.blocking && q.status === 'open') ? { reason: task.questions.find(q => q.blocking && q.status === 'open').question.slice(0, 1000) } : {}) }
      if (events.get(task.id)?.requestId === event.requestId) { synced.push(task.id); continue }
      try {
        const result = await send({ ...scope, action: 'checkpoint', event })
        if (!result?.saved) throw Error(`Прогресс не записан: ${result?.reason || 'неподтверждённый ответ'}`)
        synced.push(task.id)
      } catch (error) { pending.push({ taskId: task.id, revision: task.revision, reason: error.message }) }
    }
    // Only a clean copy may retire its own reverted claims; another workspace's work stays visible.
    let clean = false
    try { assertLocalState(root, state); clean = true } catch {}
    if (clean) for (const event of events.values()) {
      if (event.workspaceId !== workspaceId) continue
      assertLocalState(root, state)
      try {
        const result = await send({ ...scope, action: 'discard', taskId: event.taskId, taskRevision: event.taskRevision,
          requestId: event.requestId, workspaceId })
        if (!result?.saved) throw Error(`Сверка прогресса не записана: ${result?.reason || 'неподтверждённый ответ'}`)
        discarded.push(event.taskId)
      } catch (error) { pending.push({ taskId: event.taskId, reason: error.message }) }
    }
    return { status: pending.length ? 'pending' : 'synced', tasks: synced, discarded, pending,
      ...(pending.length ? { next: `construction.mjs sync ${slug}; локальную операцию задачи повторять не нужно.` } : {}) }
  } catch (error) {
    return { status: 'pending', reason: error.message, next: `construction.mjs sync ${slug}; сначала уточните состояние доски, не повторяйте локальную операцию.` }
  }
}
