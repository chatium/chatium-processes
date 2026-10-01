#!/usr/bin/env node
// Проверка и детерминированная сборка подробного задания страницы/серии.
import { findRoot, parseArgs } from './lib/project.mjs'
import { creativePacket, creativeStatus, writeCreativeBuild } from './lib/creative.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['help'])
const [command, slug, nodeId] = positional
if (options.help || !command || !slug || !nodeId) {
  console.log('Использование: creative.mjs <validate|compile|status> <process> <node-id> [--root DIR]')
  process.exit(options.help ? 0 : 2)
}
try {
  const args = { root: findRoot(options.root), slug, nodeId }
  let result
  if (command === 'validate') {
    const packet = creativePacket(args)
    result = { status: packet.errors.length ? 'invalid' : 'valid', errors: packet.errors,
      inputDigest: packet.inputDigest, references: packet.referenceFiles.map(f => f.path) }
  } else if (command === 'compile') result = { status: 'compiled', ...writeCreativeBuild(args) }
  else if (command === 'status') result = creativeStatus(args)
  else throw Error(`Неизвестная команда ${command}.`)
  console.log(JSON.stringify(result, null, 2))
  process.exit(['invalid', 'stale', 'missing'].includes(result.status) ? 1 : 0)
} catch (error) { console.error(error.message); process.exit(1) }
