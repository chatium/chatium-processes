// Служебные функции процесса для chatium exec (скрипт runtime.mjs скилла).
// Вызываются из модуля процесса, поэтому SDK Start видит его воркспейс.
import { listWorkspaceFiles } from '@start/sdk'

/** Файлы процесса с id. Id файла *.automationConfig.json — это id автоматизации. */
export const processFilesFn = app.function('/process-files').handle(async ctx => {
  const files = await listWorkspaceFiles(ctx)
  return files.map(f => ({ id: f.id, path: f.path }))
})
