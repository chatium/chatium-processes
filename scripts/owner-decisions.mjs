#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { prepareOwnerDecision, recordOwnerDecision, ownerDecisionStatus } from './lib/owner-decisions.mjs'
import { findRoot, parseArgs } from './lib/project.mjs'

let parsed
try { parsed = parseArgs(process.argv.slice(2), ['help', 'json'],
  ['help', 'json', 'kind', 'board-revision', 'out', 'packet', 'response', 'root']) }
catch (error) { console.error(error.message); process.exit(2) }
const { positional, options } = parsed
const [command, slug] = positional
if (options.help || !command || !slug) {
  console.log('owner-decisions.mjs prepare|record|status <process> --kind plan|launch [--board-revision NUMBER|none] [--out FILE] [--packet FILE --response FILE] [--root DIR] [--json]')
  process.exit(options.help ? 0 : 2)
}
try {
  const allowed = new Set(['help', 'json', 'kind', 'board-revision', 'out', 'packet', 'response', 'root'])
  if (positional.length !== 2) throw Error('Нужны команда и процесс.')
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw Error(`Неизвестный параметр --${key}.`)
    if (!['help', 'json'].includes(key) && (typeof value !== 'string' || !value.trim() || value.startsWith('--')))
      throw Error(`Нужно значение --${key}.`)
  }
  const root = findRoot(options.root), kind = options.kind
  if (!['plan', 'launch'].includes(kind)) throw Error('Укажите --kind plan или launch.')
  let result
  if (command === 'prepare') {
    if (options['board-revision'] === undefined) throw Error('Укажите --board-revision NUMBER или none после чтения доски.')
    const boardRevision = options['board-revision'] === 'none' ? null : Number(options['board-revision'])
    result = prepareOwnerDecision({ root, slug, kind, boardRevision })
    if (options.out) writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  } else if (command === 'record') {
    if (!options.packet || !options.response) throw Error('Нужны --packet и --response с реальным ответом владельца.')
    result = recordOwnerDecision({ root, slug, kind,
      packet: JSON.parse(readFileSync(options.packet, 'utf8')),
      response: JSON.parse(readFileSync(options.response, 'utf8')) })
  } else if (command === 'status') result = ownerDecisionStatus({ root, slug, kind })
  else throw Error('Команда: prepare, record или status.')
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = ['missing', 'stale', 'declined', 'invalid'].includes(result.status) ? 1 : 0
} catch (error) {
  if (options.json) console.log(JSON.stringify({ status: 'unavailable', error: error.message }))
  else console.error(error.message)
  process.exitCode = 2
}
