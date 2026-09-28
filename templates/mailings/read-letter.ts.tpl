// Читатель писем хранилища для кода процессов. Лежит в воркспейсе
// .mailings/storage, поэтому readWorkspaceFile ищет файл здесь, а не в
// воркспейсе вызывающего процесса. Пути — от корня хранилища.
import { listWorkspaceFiles, readWorkspaceFile } from '@start/sdk'

function isSafePath(path: string) {
  return !path.startsWith('/') && !path.split('/').includes('..')
}

export const readLetterFn = app
  .function('/read-letter')
  .body(s => ({ path: s.string() }))
  .handle(async (ctx, body) => {
    if (!body.path.endsWith('.message.yaml') || !isSafePath(body.path)) {
      return { found: false as const, error: 'Ожидается путь к *.message.yaml внутри хранилища' }
    }
    const file = await readWorkspaceFile(ctx, body.path)
    return file ? { found: true as const, source: file.source } : { found: false as const, error: 'Письмо не найдено' }
  })

/** Письма папки хранилища, например processes/<process>/ — с содержимым. */
export const listLettersFn = app
  .function('/list-letters')
  .body(s => ({ prefix: s.string() }))
  .handle(async (ctx, body) => {
    const prefix = body.prefix.endsWith('/') ? body.prefix : `${body.prefix}/`
    if (!isSafePath(prefix)) return []
    const files = await listWorkspaceFiles(ctx, { includeSource: true })
    return files
      .filter(f => f.path.startsWith(prefix) && f.path.endsWith('.message.yaml'))
      .map(f => ({ path: f.path, source: f.source }))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
  })
