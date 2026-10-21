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
export async function syncBuildProgress(root, slug, { execute = startExec, executionRoot = root } = {}) {
  const pending = [], synced = [], discarded = []
  try {
    const origin = git(root, ['remote', 'get-url', 'origin'])
    if (!/^https:\/\/[^/]+\/s\/(?:source-git|git)\//.test(origin))
      return { status: 'local-only', reason: 'Локальные задачи сохранены; подключение к доске Source Git отсутствует.' }
    root = realpathSync(root)
    executionRoot = realpathSync(executionRoot)
    if (git(executionRoot, ['remote', 'get-url', 'origin']) !== origin)
      throw Error('SDK checkout должен принадлежать тому же Source Git аккаунту.')
    const state = gitState(root), hostState = gitState(executionRoot), workspaceId = hash(root).slice(0, 32)
    if (executionRoot !== root) assertLocalState(executionRoot, hostState)
    const call = code => execute(executionRoot, code, hostState.commit)
    const map = parseYaml(readFileSync(join(root, slug, 'process.yaml'), 'utf8'))
    const tasks = loadTasks(root, slug).tasks.filter(task => ['design', 'build'].includes(task.stage))
    const board = await call(`import { readProcessBoardForAgent } from '@start/sdk'\nreturn await readProcessBoardForAgent(ctx, ${JSON.stringify(slug)}, ${JSON.stringify(state.branch)})`)
    if (!board?.snapshot || board.snapshot.snapshot.branch !== state.branch || board.snapshot.snapshot.processPath !== slug)
      throw Error('Нет опубликованной карты выбранной ветки процесса.')
    const baseCommit = board.snapshot.snapshot.commit
    if (!/^[a-f0-9]{40}$/.test(baseCommit)) throw Error('Некорректная версия опубликованной карты.')
    try { git(root, ['merge-base', '--is-ancestor', baseCommit, state.commit]) }
    catch { throw Error('Доска опережает рабочую копию или относится к другой линии истории. Сначала синхронизируйте выбранную ветку.') }
    const local = tasks.filter(task => {
      const path = `${slug}/tasks/${task.id}.json`
      try { return git(root, ['show', `${baseCommit}:${path}`]) !== readFileSync(join(root, path), 'utf8').trim() }
      catch { return true }
    })
    const scope = { process: slug, branch: state.branch, baseCommit, snapshotRevision: board.snapshot.revision }
    const send = input => {
      const current = gitState(root)
      if (current.branch !== state.branch || current.commit !== state.commit) throw Error('Ветка изменилась во время синхронизации.')
      if (executionRoot !== root) assertLocalState(executionRoot, hostState)
      return call(`import { writeProcessBuildProgress } from '@start/sdk'\nreturn await writeProcessBuildProgress(ctx, ${JSON.stringify(input)})`)
    }
    const events = new Map(board.snapshot.snapshot.nodes.flatMap(node => node.progress || []).map(event => [event.taskId, event]))
    for (const task of local) {
      const nodeIds = (map.nodes || []).filter(node => task.targetNode === node.id ||
        (task.expectedOutputs || []).some(output => inside(output.path, node.source))).map(node => node.id).sort()
      if (!nodeIds.length) continue
      const taskSha256 = hash(readFileSync(join(root, slug, 'tasks', `${task.id}.json`)))
      const reason = task.status === 'needs-input' ? (task.questions || []).find(q => q.blocking && q.status === 'open')?.question
        : task.status === 'failed' ? task.attempts?.at(-1)?.failure?.reason : undefined
      const event = { taskId: task.id, taskRevision: task.revision,
        requestId: `build:${hash(`${workspaceId}:${state.branch}:${slug}:${task.id}:${task.revision}:${taskSha256}`).slice(0, 48)}`,
        title: task.title, state: task.status, nodeIds, taskSha256, workspaceId,
        ...(typeof reason === 'string' && reason.trim() ? { reason: reason.slice(0, 1000) } : {}) }
      if (events.get(task.id)?.requestId === event.requestId) { synced.push(task.id); continue }
      try {
        const result = await send({ ...scope, action: 'checkpoint', event })
        if (!result?.saved) throw Error(`Прогресс не записан: ${result?.reason || 'неподтверждённый ответ'}`)
        synced.push(task.id)
      } catch (error) { pending.push({ taskId: task.id, revision: task.revision, reason: error.message }) }
    }
    // Only a clean copy may retire its own reverted claims; another workspace's work stays visible.
    let clean = false
    try { assertLocalState(root, state); clean = state.commit === baseCommit && !local.length } catch {}
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
    return { status: pending.length ? 'pending' : 'synced', workingCommit: state.commit, baseCommit, tasks: synced, discarded, pending,
      ...(pending.length ? { next: `construction.mjs sync ${slug}; локальную операцию задачи повторять не нужно.` } : {}) }
  } catch (error) {
    return { status: 'pending', reason: error.message, next: `construction.mjs sync ${slug}; сначала уточните состояние доски, не повторяйте локальную операцию.` }
  }
}
