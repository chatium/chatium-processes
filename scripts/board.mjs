#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs'
import { findRoot, parseArgs } from './lib/project.mjs'
import { readProcessBoard, readMaterial } from './lib/board.mjs'
import { respondToNote } from './lib/board-notes.mjs'

let parsed
try { parsed = parseArgs(process.argv.slice(2), ['help'], ['help', 'root', 'from', 'element', 'note', 'status', 'message-file']) }
catch (error) { console.error(error.message); process.exit(2) }
const { positional, options } = parsed
const [command, slug] = positional
if (options.help || !command || !slug) {
  console.log(`board.mjs read <process> [--root DIR]
board.mjs material <process> --from FILE --element ID [--root DIR]
board.mjs respond-note <process> --from FILE --note ID --status done|needs-info --message-file FILE [--root DIR]
read prints the whole shared board as JSON; material returns a fresh image URL, not a visual interpretation.
Store context/response files outside the account. No command starts the process.`)
  process.exit(options.help ? 0 : 2)
}
try {
  if (positional.length !== 2) throw Error('Нужны команда и слаг процесса.')
  const allowed = { read: ['root'], material: ['root', 'from', 'element'],
    'respond-note': ['root', 'from', 'note', 'status', 'message-file'] }[command]
  if (!allowed) throw Error('Команда должна быть read, material или respond-note.')
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.includes(key) || !value || value.startsWith('--')) throw Error(`Некорректный параметр --${key}.`)
  }
  const root = findRoot(options.root)
  const read = (file, limit) => {
    if (!file) throw Error('Не указан обязательный файл.')
    if (statSync(file).size > limit) throw Error('Файл слишком большой.')
    return readFileSync(file, 'utf8')
  }
  let result
  if (command === 'read') result = await readProcessBoard(root, slug)
  else {
    const context = JSON.parse(read(options.from, 4 * 1024 * 1024))
    if (command === 'material') result = await readMaterial(root, context, { slug, elementId: options.element })
    else result = await respondToNote(root, context, {
      slug, noteId: options.note, status: options.status, message: read(options['message-file'], 8000),
    })
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
