#!/usr/bin/env node
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { findRoot, parseArgs } from './lib/project.mjs'
import { reviewPacketCleanup } from './lib/review-packets.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['apply', 'help'])
if (options.help) {
  console.log('review-packets.mjs cleanup [--days 30] [--base /data/external] [--root DIR] [--apply]')
  process.exit(0)
}
try {
  if (positional.length !== 1 || positional[0] !== 'cleanup' ||
      Object.keys(options).some(key => !['days', 'base', 'root', 'apply'].includes(key)))
    throw Error('Команда: cleanup [--days N] [--base DIR] [--root DIR] [--apply].')
  if (options.apply !== undefined && options.apply !== true)
    throw Error('--apply не принимает значение; для предварительного просмотра просто опусти его.')
  const days = options.days === undefined ? 30 : Number(options.days)
  if (!Number.isInteger(days) || days < 7) throw Error('Для очистки укажи целое --days не менее 7.')
  const result = reviewPacketCleanup({ root: findRoot(options.root),
    base: resolve(options.base || (existsSync('/data/external') ? '/data/external' : tmpdir())),
    days, apply: options.apply === true })
  console.log(JSON.stringify({ ...result, dryRun: !options.apply }, null, 2))
} catch (error) { console.error(error.message); process.exitCode = 2 }
