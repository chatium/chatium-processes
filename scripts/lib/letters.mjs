import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const PREFIX = '.mailings/storage/'
const SUFFIX = '.message.yaml'
// Read old letterPath configs as well; installing a skill must not rewrite them.
export function templatePath(step) {
  const params = step?.params
  if (!params || !('messageKey' in params || 'letterPath' in params)) return null
  if ('messageKey' in params && 'letterPath' in params) throw Error('Укажите messageKey либо прежний letterPath, не оба')
  const sdk = 'messageKey' in params
  let path = sdk ? params.messageKey : params.letterPath
  if (typeof path !== 'string') throw Error('Ключ письма должен быть статической строкой для проверки шаблонов')
  if (!sdk) {
    if (!path.startsWith(PREFIX) || !path.endsWith(SUFFIX)) throw Error('letterPath должен вести на .mailings/storage/*.message.yaml')
    path = path.slice(PREFIX.length)
  }
  if (!path || path.length > 500 || /[\\\u0000-\u001f\u007f]/.test(path) || path.split('/').some(p => !p || p.startsWith('.') || p.trim() !== p))
    throw Error('Некорректный путь шаблона Mailings')
  if (sdk) path = (path.endsWith(SUFFIX) ? path.slice(0, -SUFFIX.length) : path).replace(/\.v\d+$/, '') + SUFFIX
  return PREFIX + path
}

export function templateFiles(root, step) {
  const path = templatePath(step)
  if (!path) return []
  const folder = dirname(join(root, path))
  if (!existsSync(folder)) return []
  if (!realpathSync(folder).startsWith(realpathSync(root) + sep)) throw Error('Папка писем выходит за пределы аккаунта')
  const base = path.slice(0, -SUFFIX.length)
  const paths = 'messageKey' in step.params
    ? readdirSync(folder).map(name => dirname(path) + '/' + name).filter(p => p === path || (p.startsWith(base + '.v') && /^\d+\.message\.yaml$/.test(p.slice(base.length + 2))))
    : existsSync(join(root, path)) ? [path] : []
  for (const p of paths) if (!realpathSync(resolve(root, p)).startsWith(realpathSync(root) + sep)) throw Error('Письмо выходит за пределы аккаунта')
  return paths.sort()
}
