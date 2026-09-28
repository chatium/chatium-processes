// Читатель писем хранилища для кода процессов. Лежит в воркспейсе
// .mailings/storage, поэтому readWorkspaceFile ищет файл здесь, а не в
// воркспейсе вызывающего процесса. Путь — от корня хранилища.
import { readWorkspaceFile } from '@start/sdk'

export const readLetterFn = app
  .function('/read-letter')
  .body(s => ({ path: s.string() }))
  .handle(async (ctx, body) => {
    if (!body.path.endsWith('.message.yaml') || body.path.split('/').includes('..')) {
      return { found: false as const, error: 'Ожидается путь к *.message.yaml внутри хранилища' }
    }
    const file = await readWorkspaceFile(ctx, body.path)
    return file ? { found: true as const, source: file.source } : { found: false as const, error: 'Письмо не найдено' }
  })
