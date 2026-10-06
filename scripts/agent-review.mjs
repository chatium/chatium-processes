#!/usr/bin/env node
// Local packet and report validation; the harness invokes the reviewer.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { findRoot, parseArgs } from './lib/project.mjs'
import { canonicalTarget } from './lib/knowledge-review.mjs'
import { agentReviewStatus, makeAgentReviewPacket, recordAgentReview } from './lib/agent-review.mjs'
import { referencePrompt, writeReferenceSnapshot } from './lib/review-library.mjs'
import { markReviewPacket } from './lib/review-packets.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['help', 'json'])
const [command, slug] = positional
if (options.help || !command || !slug) {
  console.log('agent-review.mjs prepare|record|status <process> [--root DIR] [--json]\nprepare: [--out DIR]; record: --packet FILE --report FILE --agent TOOL_REFERENCE')
  process.exit(options.help ? 0 : 2)
}
try {
  if (positional.length !== 2) throw Error('Нужны одна команда и один слаг процесса.')
  for (const [key, value] of Object.entries(options)) {
    if (!['help', 'json', 'root', 'out', 'packet', 'report', 'agent'].includes(key)) throw Error(`Неизвестный параметр --${key}.`)
    if (!['help', 'json'].includes(key) && (typeof value !== 'string' || !value.trim() || value.startsWith('--'))) throw Error(`Нужно значение --${key}.`)
  }
  const root = findRoot(options.root)
  let result
  if (command === 'prepare') {
    const packet = makeAgentReviewPacket({ root, slug })
    const dir = options.out ? resolve(options.out) : mkdtempSync(join(existsSync('/data/external') ? '/data/external' : tmpdir(), `agent-review-${slug}-`))
    const canonical = canonicalTarget(dir), account = realpathSync(root)
    if (canonical === account || canonical.startsWith(account + sep)) throw Error('Пакет ревью храните вне репозитория в папке, доступной обоим агентам.')
    mkdirSync(dir, { recursive: true })
    const packetPath = join(dir, 'packet.json'), promptPath = join(dir, 'prompt.md')
    if (existsSync(packetPath) || existsSync(promptPath)) throw Error('Пакет уже существует; подготовьте новую папку.')
    const libraryPath = writeReferenceSnapshot(dir, packet)
    const prompt = `Проведи независимое ревью самостоятельных помощников процесса ${slug} перед живыми испытаниями.\n` +
      `Прочитай весь пакет ${packetPath}. Правила и JSON-схема — reviewerInstructions, вопросы — questions, исходники — files.\n` +
      referencePrompt(dir, packet) +
      'Проверь инструкцию каждой роли, знания, действия, маршруты, передачу и сценарии. Только чтение: не запускай код, модель, сеть, тесты и реальные эффекты; не исправляй файлы и не вызывай субагентов. Верни только JSON по схеме.\n'
    writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx' })
    writeFileSync(promptPath, prompt, { flag: 'wx' })
    markReviewPacket({ directory: dir, root, slug, role: 'agent-review', managed: !options.out })
    result = { process: slug, inputDigest: packet.inputDigest, packet: packetPath, prompt: promptPath,
      library: libraryPath, referenceDigest: packet.referenceLibrary.digest,
      files: packet.files.length, questions: packet.questions.length,
      staticErrors: packet.staticChecks.flatMap(c => c.errors),
      next: 'Передайте prompt.md независимому субагенту через инструмент текущего окружения; скрипт не вызывает модель.' }
  } else if (command === 'record') {
    if (!options.packet || !options.report || !options.agent) throw Error('Нужны --packet, --report и --agent.')
    result = recordAgentReview({ root, slug, packet: JSON.parse(readFileSync(options.packet, 'utf8')),
      report: JSON.parse(readFileSync(options.report, 'utf8')), agentReference: options.agent,
      packetDirectory: dirname(resolve(options.packet)) })
  } else if (command === 'status') result = agentReviewStatus({ root, slug })
  else throw Error('Команда должна быть prepare, record или status.')
  if (options.json || command === 'prepare') console.log(JSON.stringify(result, null, 2))
  else {
    console.log(`Ревью помощников ${slug}: ${result.status}.`)
    if (result.error) console.log(result.error)
    for (const gap of result.blocking || []) console.log(`✘ ${gap.id}: ${gap.reason}\n  → ${gap.nextAction}`)
    for (const gap of result.advisory || []) console.log(`! ${gap.id}: ${gap.reason}\n  → ${gap.nextAction}`)
    for (const error of result.structuralErrors || []) console.log(`✘ ${error}`)
    console.log(`Отчёт: ${result.path}`)
  }
  process.exitCode = result.status && result.status !== 'ready' ? 1 : 0
} catch (error) {
  if (options.json) console.log(JSON.stringify({ status: 'unavailable', error: error.message }))
  else console.error(error.message)
  process.exitCode = 2
}
