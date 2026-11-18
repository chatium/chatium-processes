#!/usr/bin/env node
// Проверка и детерминированная сборка подробного задания страницы/серии.
import { findRoot, parseArgs } from './lib/project.mjs'
import { ownerDecisionForCurrentBoard } from './lib/owner-decisions.mjs'
import { creativePacket, creativeStatus, writeCreativeBuild } from './lib/creative.mjs'

let parsed
try { parsed = parseArgs(process.argv.slice(2), ['help'], ['help', 'root']) }
catch (error) { console.error(error.message); process.exit(2) }
const { positional, options } = parsed
const [command, slug, nodeId] = positional
if (options.help || !command || !slug || !nodeId) {
  console.log('Использование: creative.mjs <validate|compile|status> <process> <node-id> [--root DIR]')
  process.exit(options.help ? 0 : 2)
}
if (positional.length !== 3) { console.error('Нужны команда, процесс и ID элемента без лишних аргументов.'); process.exit(2) }
try {
  const args = { root: findRoot(options.root), slug, nodeId }
  let result
  if (command === 'validate') {
    const packet = creativePacket(args)
    result = { status: packet.errors.length ? 'invalid' : 'valid', errors: packet.errors,
      inputDigest: packet.inputDigest, references: packet.referenceFiles.map(f => f.path) }
  } else if (command === 'compile') {
    const packet = creativePacket(args)
    if (packet.errors.length) result = { status: 'invalid', errors: packet.errors }
    else {
      const decision = await ownerDecisionForCurrentBoard({ ...args, kind: 'plan' })
      if (decision.status !== 'ready') throw Error(`Подробное задание собирается после согласования структуры: ${decision.error || decision.status}`)
      result = { status: 'compiled', ...writeCreativeBuild(args, packet) }
    }
  }
  else if (command === 'status') result = creativeStatus(args)
  else throw Error(`Неизвестная команда ${command}.`)
  console.log(JSON.stringify(result, null, 2))
  process.exit(['invalid', 'stale', 'missing'].includes(result.status) ? 1 : 0)
} catch (error) { console.error(error.message); process.exit(2) }
