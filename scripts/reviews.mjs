#!/usr/bin/env node
// One entry point for the review commission; existing role-specific commands remain usable.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { architectureReviewStatus, makeArchitectureReviewPacket, recordArchitectureReview } from './lib/architecture-review.mjs'
import { commissionStatus, reviewRequirements, COMMISSION_STAGES } from './lib/commission.mjs'
import { canonicalTarget } from './lib/knowledge-review.mjs'
import { findRoot, parseArgs } from './lib/project.mjs'
import { referencePrompt, writeReferenceSnapshot } from './lib/review-library.mjs'
import { markReviewPacket } from './lib/review-packets.mjs'

let parsed
try { parsed = parseArgs(process.argv.slice(2), ['help', 'json'],
  ['help', 'json', 'stage', 'role', 'node', 'out', 'packet', 'report', 'agent', 'root']) }
catch (error) { console.error(error.message); process.exit(2) }
const { positional, options } = parsed
const [command, slug] = positional
if (options.help || !command || !slug) {
  console.log('reviews.mjs requirements|prepare|record|status <process> [--stage design|build|test|launch] [--role ROLE] [--node ID] [--out DIR] [--packet FILE --report FILE --agent CALL_ID] [--root DIR] [--json]')
  process.exit(options.help ? 0 : 2)
}
try {
  const allowed = new Set(['help', 'json', 'stage', 'role', 'node', 'out', 'packet', 'report', 'agent', 'root'])
  if (positional.length !== 2) throw Error('Нужны команда и процесс.')
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw Error(`Неизвестный параметр --${key}.`)
    if (!['help', 'json'].includes(key) && (typeof value !== 'string' || !value.trim() || value.startsWith('--')))
      throw Error(`Нужно значение --${key}.`)
  }
  const root = findRoot(options.root), stage = options.stage || 'test'
  if (!COMMISSION_STAGES.includes(stage)) throw Error('Этап: design, build, test или launch.')
  if (command === 'requirements' || command === 'status') {
    const result = command === 'requirements' ? reviewRequirements({ root, slug, stage }) : commissionStatus({ root, slug, stage })
    console.log(JSON.stringify(result, null, 2))
    process.exitCode = command === 'status' && result.status !== 'ready' ? 1 : 0
  } else if (command === 'prepare' || command === 'record') {
    const role = options.role
    if (!role) throw Error('Укажите --role из reviews requirements.')
    if (role !== 'architecture') {
      const roleScripts = { methodology: 'kb-review.mjs', implementation: 'code-review.mjs', creative: 'creative-review.mjs', agents: 'agent-review.mjs' }
      const script = roleScripts[role]
      if (!script || !existsSync(join(import.meta.dirname, script))) throw Error(`Роль ${role} ещё не подключена.`)
      const args = [join(import.meta.dirname, script), command, slug, '--root', root, '--json']
      if (role === 'methodology') args.push('--stage', stage === 'launch' ? 'launch' : stage === 'design' ? 'design' : 'build')
      if (role === 'creative') {
        if (!options.node) throw Error('Для creative нужен --node ID.')
        args.splice(3, 0, options.node)
        args.push('--stage', stage === 'test' || stage === 'launch' ? 'result' : 'spec')
      }
      for (const key of ['out', 'packet', 'report', 'agent']) if (options[key]) args.push(`--${key}`, options[key])
      const child = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: root, stdio: ['inherit', 'pipe', 'pipe'] })
      if (child.stdout) process.stdout.write(child.stdout)
      if (child.stderr) process.stderr.write(child.stderr)
      process.exitCode = child.status ?? 2
    } else if (command === 'prepare') {
      const packet = makeArchitectureReviewPacket({ root, slug })
      const directory = options.out ? resolve(options.out) : mkdtempSync(join(existsSync('/data/external') ? '/data/external' : tmpdir(), `architecture-review-${slug}-`))
      const canonical = canonicalTarget(directory), account = realpathSync(root)
      if (canonical === account || canonical.startsWith(account + sep)) throw Error('Пакет reviewer должен находиться вне аккаунта.')
      mkdirSync(directory, { recursive: true })
      const packetPath = join(directory, 'packet.json'), promptPath = join(directory, 'prompt.md')
      if (existsSync(packetPath) || existsSync(promptPath)) throw Error('Пакет уже существует.')
      const libraryPath = writeReferenceSnapshot(directory, packet)
      const prompt = `Проведи независимое ревью архитектуры процесса ${slug} до реализации.\nПрочитай пакет ${packetPath}, reviewerInstructions и все questions.\n` +
        referencePrompt(directory, packet) + 'Работай только чтением, не вызывай других агентов. Верни JSON по схеме reviewerInstructions.\n'
      writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx' })
      writeFileSync(promptPath, prompt, { flag: 'wx' })
      markReviewPacket({ directory, root, slug, role: 'architecture-review', managed: !options.out })
      console.log(JSON.stringify({ packet: packetPath, prompt: promptPath, library: libraryPath, inputDigest: packet.inputDigest,
        files: packet.files.length, questions: packet.questions.length, staticErrors: packet.staticChecks.flatMap(item => item.errors) }, null, 2))
    } else {
      if (!options.packet || !options.report || !options.agent) throw Error('Нужны --packet, --report и --agent.')
      const result = recordArchitectureReview({ root, slug, packet: JSON.parse(readFileSync(options.packet, 'utf8')),
        report: JSON.parse(readFileSync(options.report, 'utf8')), agentReference: options.agent,
        packetDirectory: dirname(resolve(options.packet)) })
      console.log(JSON.stringify(result, null, 2))
      process.exitCode = result.status === 'ready' ? 0 : 1
    }
  } else throw Error('Команда: requirements, prepare, record или status.')
} catch (error) {
  if (options.json) console.log(JSON.stringify({ status: 'unavailable', error: error.message }))
  else console.error(error.message)
  process.exitCode = 2
}
