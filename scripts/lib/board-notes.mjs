import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { gitState } from './git-state.mjs'
import { isProcessSlug, SKILL_DIR } from './project.mjs'
import { readBoard } from './freshness.mjs'
import { startExec } from './snapshot.mjs'

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
    notes: tasksSupported ? board.notes : board.elements.blocks.filter(b => b.type === 'sticky').map(b => ({
      id: b.id, title: b.title || '', text: b.text || '', author: b.author, task: null,
      targets: [], attachments: [], relatedNoteIds: [],
    })),
    elements: board.elements,
  }
}

export async function readNotes(root, slug, { reader = readBoard } = {}) {
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
  const result = await execute(root,
    `import { respondToProcessBoardNote } from '@start/sdk'\nreturn await respondToProcessBoardNote(ctx, ${JSON.stringify(payload)})`)
  if (!result?.ok) throw Error(`Ответ не сохранён: ${result?.reason || 'ошибка SDK'}. Перечитайте заметки; не повторяйте запись вслепую.`)
  if (!Number.isSafeInteger(result.revision) || result.revision <= payload.expectedRevision || result.noteId !== payload.noteId)
    throw Error('SDK вернул некорректное подтверждение ответа. Перечитайте доску.')
  return result
}
