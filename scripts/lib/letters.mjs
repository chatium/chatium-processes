// Сборка писем процесса в JSON для рантайма.
//
// Письма живут в .mailings/storage/ (источник правды, их правит редактор
// писем). Код аккаунта Source Git не может читать файлы в рантайме, а импорт
// JSON сборка поддерживает. Поэтому хелпер отправки импортирует
// <process>/actions/letters.generated.json, а этот модуль его собирает.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { rel, walk } from './project.mjs'
import { parseYaml } from './yaml.mjs'

export const BUNDLE_NAME = 'letters.generated.json'
const LETTER_FIELDS = ['subject', 'preheader', 'plain', 'html', 'short', 'buttons', 'inlineButtons']

export function bundlePath(root, slug) {
  return join(root, slug, 'actions', BUNDLE_NAME)
}

/** Собирает содержимое бандла из всех *.message.yaml в папке писем процесса. */
export function buildLettersBundle(root, lettersRoot) {
  const files = walk(join(root, lettersRoot))
    .filter(f => f.endsWith('.message.yaml'))
    .sort()
  const letters = {}
  const errors = []
  for (const f of files) {
    const p = rel(root, f)
    let data
    try {
      data = parseYaml(readFileSync(f, 'utf8')) || {}
    } catch (e) {
      errors.push(`${p}: не разбирается: ${e.message}`)
      continue
    }
    const letter = {}
    for (const field of LETTER_FIELDS) if (data[field] !== undefined) letter[field] = data[field]
    letter.variables = (Array.isArray(data.variables) ? data.variables : [])
      .filter(v => v?.name)
      .map(v => ({ name: v.name, required: v.required !== false }))
    letters[p] = letter
  }
  return {
    bundle: {
      $generated: `Собрано скриптом letters.mjs из ${lettersRoot}/. Не правь руками — правь письма и пересобери.`,
      letters,
    },
    errors,
  }
}

export function serializeBundle(bundle) {
  return `${JSON.stringify(bundle, null, 2)}\n`
}
