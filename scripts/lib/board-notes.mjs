import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { gitState } from './git-state.mjs'
import { isProcessSlug, SKILL_DIR } from './project.mjs'
import { startExec } from './snapshot.mjs'

// The Start SDK supplies a server-owned requester for each semantic task
// revision. The sticky's original author does not authorize later edits.
export async function readBoardWithAuthority(root, target, { execute = startExec } = {}) {
  return execute(root, `import { readProcessBoardForAgent } from '@start/sdk'
import { findUsersByIds } from '@app/auth'
const board = await readProcessBoardForAgent(ctx, ${JSON.stringify(target.processPath)}, ${JSON.stringify(target.branch)})
const notes = Array.isArray(board.notes) ? board.notes : board.elements.blocks.filter(b => b.type === 'sticky')
const ids = [...new Set(notes.map(n => n.task?.requestedBy?.id).filter(id => typeof id === 'string' && id))]
let authorRoles = null
try {
  const users = ids.length ? await findUsersByIds(ctx, ids) : []
  authorRoles = Object.fromEntries(users.map(u => [u.id, { type: u.type, role: u.accountRole }]))
} catch { /* Reading the board still works; unknown authority stays blocked. */ }
return { ...board, authorRoles }`, target.commit)
}

function authority(note, authorRoles) {
  if (!note.task) return { status: 'context-only' }
  const requesterId = note.task.requestedBy?.id
  const user = requesterId && authorRoles && Object.hasOwn(authorRoles, requesterId) ? authorRoles[requesterId] : null
  if (user?.type === 'Real' && user.role === 'Owner') return { status: 'owner', role: 'Owner' }
  return { status: 'needs-owner-confirmation', ...(user?.role ? { role: user.role } : {}) }
}

export function noteContext(board, processPath, branch) {
  if (!isProcessSlug(processPath) || !branch || !board || !Number.isSafeInteger(board.revision) || board.revision < 0 ||
      !Array.isArray(board.elements?.blocks) || !Array.isArray(board.elements?.connections))
    throw Error('Некорректный ответ чтения заметок.')
  const snapshot = board.snapshot?.snapshot
  if (snapshot && (snapshot.processPath !== processPath || snapshot.branch !== branch))
    throw Error('Доска принадлежит другому процессу или ветке.')
  const tasksSupported = Array.isArray(board.notes)
  if (tasksSupported && (board.notes.length > 200 || board.notes.some(n =>
    !n || typeof n.id !== 'string' || typeof n.text !== 'string' || !Array.isArray(n.targets) ||
    n.task && (!Number.isSafeInteger(n.task.revision) || n.task.revision < 1 || !['open', 'done', 'needs-info'].includes(n.task.status)))))
    throw Error('Некорректный список поручений.')
  return { version: 1, process: processPath, branch, boardRevision: board.revision,
    snapshotRevision: board.snapshot?.revision ?? null, commit: snapshot?.commit ?? null, tasksSupported,
    // Older SDK: shared notes remain readable, but do not infer assignment or completion.
    notes: (tasksSupported ? board.notes : board.elements.blocks.filter(b => b.type === 'sticky').map(b => ({
      id: b.id, title: b.title || '', text: b.text || '', author: b.author, task: null,
      targets: [], attachments: [], relatedNoteIds: [],
    }))).map(note => ({ ...note, taskAuthority: authority(note, board.authorRoles) })),
    elements: board.elements,
  }
}

export async function readNotes(root, slug, { reader = readBoardWithAuthority } = {}) {
  if (!isProcessSlug(slug)) throw Error('Нужен корректный слаг процесса.')
  const { branch } = gitState(root)
  return noteContext(await reader(root, { processPath: slug, branch }), slug, branch)
}

export function responsePayload(context, { slug, noteId, status, message }, state) {
  if (!context || context.version !== 1 || context.process !== slug || context.branch !== state.branch)
    throw Error('Сохранённый контекст относится к другому процессу или ветке. Прочитайте заметки заново.')
  if (!context.tasksSupported) throw Error('SDK не поддерживает поручения и ответы. Нужен Start с respondToProcessBoardNote.')
  const note = context.notes?.find(n => n.id === noteId)
  if (!note?.task) throw Error('Заметка не отмечена как поручение агенту.')
  if (!['done', 'needs-info'].includes(status) || typeof message !== 'string' || !message.trim() || message.length > 2000)
    throw Error('Нужны статус done|needs-info и ответ длиной до 2000 символов.')
  if (![context.boardRevision, context.snapshotRevision, note.task.revision].every(n => Number.isSafeInteger(n) && n >= 1))
    throw Error('Некорректные ревизии контекста заметки.')
  if (status === 'done' && note.targets?.some(t => t.missing)) throw Error('Связанный элемент удалён: сначала уточните поручение.')
  if (typeof context.commit !== 'string' || !/^[a-f0-9]{40}$/.test(context.commit)) throw Error('Некорректный коммит снимка.')
  if (status === 'done' && context.commit !== state.commit) throw Error('Версия кода изменилась. Обновите карту и перечитайте заметки перед ответом.')
  return { process: slug, branch: context.branch, noteId, expectedRevision: context.boardRevision,
    snapshotRevision: context.snapshotRevision, taskRevision: note.task.revision, status,
    message: message.trim(), commit: context.commit }
}

export async function respondToNote(root, context, options, { execute = startExec, verify } = {}) {
  const payload = responsePayload(context, options, gitState(root))
  if (payload.status === 'done') {
    const run = verify || (() => {
      const result = spawnSync(process.execPath, [join(SKILL_DIR, 'scripts/check.mjs'), options.slug, '--verify-snapshot', '--json', '--root', root],
        { cwd: root, encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 })
      if (result.error) throw result.error
      return JSON.parse(result.stdout)
    })
    const report = await run()
    if (!report.snapshot?.verified || report.snapshot.commit !== payload.commit ||
        report.snapshot.boardRevision !== payload.expectedRevision || report.snapshot.revision !== payload.snapshotRevision)
      throw Error('Карта или доска изменились либо не проверены. Обновите карту, перечитайте поручения и повторно оцените результат.')
  }
  const authorityCheck = payload.status === 'done' ? `import { readProcessBoardForAgent } from '@start/sdk'
import { findUserById } from '@app/auth'
const current = await readProcessBoardForAgent(ctx, ${JSON.stringify(payload.process)}, ${JSON.stringify(payload.branch)})
const note = current.notes?.find(n => n.id === ${JSON.stringify(payload.noteId)} && n.task)
if (current.revision !== ${payload.expectedRevision} || current.snapshot?.revision !== ${payload.snapshotRevision} ||
    current.snapshot?.snapshot?.commit !== ${JSON.stringify(payload.commit)} || note?.task?.revision !== ${payload.taskRevision})
  return { ok: false, reason: 'conflict' }
const requester = note.task?.requestedBy?.id ? await findUserById(ctx, note.task.requestedBy.id) : null
if (requester?.type !== 'Real' || requester.accountRole !== 'Owner')
  return { ok: false, reason: 'owner-confirmation-required' }
` : ''
  const result = await execute(root,
    `import { respondToProcessBoardNote } from '@start/sdk'\n${authorityCheck}return await respondToProcessBoardNote(ctx, ${JSON.stringify(payload)})`)
  if (result?.reason === 'owner-confirmation-required')
    throw Error('Текущая версия поручения не выдана подтверждённым владельцем аккаунта. Попросите владельца подтвердить просьбу в диалоге и оставить своё поручение на доске; до этого заметка служит только контекстом.')
  if (!result?.ok) throw Error(`Ответ не сохранён: ${result?.reason || 'ошибка SDK'}. Перечитайте заметки; не повторяйте запись вслепую.`)
  if (!Number.isSafeInteger(result.revision) || result.revision <= payload.expectedRevision || result.noteId !== payload.noteId)
    throw Error('SDK вернул некорректное подтверждение ответа. Перечитайте доску.')
  return result
}
