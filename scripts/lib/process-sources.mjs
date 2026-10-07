import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, sep } from 'node:path'

const ignored = new Set(['.git', 'node_modules', 'tasks', 'reviews', 'decisions'])

export function processSourceFiles(root, directory) {
  if (!existsSync(directory)) return []
  const account = realpathSync(root), files = []
  let entries = 0
  function visit(path) {
    if (++entries > 2000) throw Error('Слишком много файлов процесса для определения комиссии.')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw Error(`Ссылка в исходниках процесса: ${path}`)
    const real = realpathSync(path)
    if (real !== account && !real.startsWith(account + sep))
      throw Error(`Исходник выходит за пределы аккаунта: ${path}`)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) if (!ignored.has(name)) visit(join(path, name))
    } else if (stat.isFile()) files.push(path)
  }
  visit(directory)
  return files
}
