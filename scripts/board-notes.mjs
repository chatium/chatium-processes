#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs'
import { findRoot, parseArgs } from './lib/project.mjs'
import { respondToNote } from './lib/board-notes.mjs'
import { readProcessBoard } from './lib/board.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['help'])
const [command, slug] = positional
if (options.help || !command || !slug) {
  console.log('board-notes.mjs read <process> [--root DIR]\nboard-notes.mjs respond <process> --from FILE --note ID --status done|needs-info --message-file FILE [--root DIR]\nread prints JSON; save it outside the account for --from. Responses never start the process.')
  process.exit(options.help ? 0 : 2)
}
try {
  if (positional.length !== 2) throw Error('Нужны команда и слаг процесса.')
  for (const [key, value] of Object.entries(options)) {
    if (!['root', 'from', 'note', 'status', 'message-file'].includes(key) || !value || value.startsWith('--'))
      throw Error(`Некорректный параметр --${key}.`)
  }
  const root = findRoot(options.root)
  let result
  if (command === 'read') result = await readProcessBoard(root, slug)
  else if (command === 'respond') {
    if (!options.from || !options.note || !options.status || !options['message-file'])
      throw Error('Нужны --from, --note, --status и --message-file.')
    if (statSync(options.from).size > 4 * 1024 * 1024 || statSync(options['message-file']).size > 8000)
      throw Error('Файл контекста или ответа слишком большой.')
    result = await respondToNote(root, JSON.parse(readFileSync(options.from, 'utf8')), {
      slug, noteId: options.note, status: options.status, message: readFileSync(options['message-file'], 'utf8'),
    })
  } else throw Error('Команда должна быть read или respond.')
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 2
}
