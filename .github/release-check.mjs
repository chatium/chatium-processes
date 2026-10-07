#!/usr/bin/env node
// Source-repository release gate. This file is excluded from installed skill copies.
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const expectedIds = [
  ...Array.from({ length: 49 }, (_, index) => `R${String(index + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, index) => `F${String(index + 1).padStart(2, '0')}`),
  ...Object.entries({ M: 20, A: 13, D: 13, C: 14, E: 14, I: 12, Q: 14, N: 5 })
    .flatMap(([prefix, count]) => Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1).padStart(2, '0')}`)),
]

export function assessRelease({ rows = [], version, licenseId, license, evidence = {}, changedFiles = [] }) {
  const errors = []
  const ids = rows.map(row => row.id), expected = new Set(expectedIds)
  const missing = expectedIds.filter(id => !ids.includes(id))
  const extra = ids.filter(id => !expected.has(id))
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (missing.length || extra.length || repeated.length)
    errors.push(`Реестр 166 пунктов нарушен: отсутствуют ${missing.join(', ') || '—'}; лишние ${extra.join(', ') || '—'}; повторные ${repeated.join(', ') || '—'}.`)
  const pending = rows.filter(row => row.status !== 'закрыто' &&
    !(row.status === 'отложено' && ['E11', 'I10'].includes(row.id)))
  if (pending.length) errors.push(`Не закрыты ${pending.length} обязательных замечаний: ${pending.map(row => row.id).join(', ')}.`)
  for (const row of rows.filter(row => row.status === 'закрыто'))
    if (!row.check || row.check === '—' || !/^[0-9a-f]{7,40}$/.test(row.commit || ''))
      errors.push(`${row.id}: нет проверки или коммита исправления.`)
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) errors.push('Перед выпуском укажи версию x.y.z в package.json.')
  if (licenseId !== 'MIT' || !license?.startsWith('MIT License\n') || license.trim().length < 500)
    errors.push('Нет выбранной владельцем лицензии MIT в package.json и LICENSE.')
  if (evidence.licenseDecision?.id !== licenseId || !evidence.licenseDecision?.reference ||
      !Number.isFinite(Date.parse(evidence.licenseDecision?.decidedAt)))
    errors.push('Нет записи о выборе лицензии владельцем и ссылки на ответ.')
  if (evidence.distribution?.decision !== 'public' || !evidence.distribution?.reference ||
      !Number.isFinite(Date.parse(evidence.distribution?.approvedAt)))
    errors.push('Нет записанного решения владельца о публичном распространении и ссылки на ответ.')
  if (!/^[0-9a-f]{40}$/.test(evidence.testedCommit || '')) errors.push('Нет SHA версии, проверенной сквозными прогонами.')
  for (const harness of ['dsh', 'claude-code', 'codex']) {
    const run = evidence.runs?.[harness]
    if (run?.status !== 'pass' || !run.account || !run.record)
      errors.push(`Нет подтверждённого полного прогона ${harness} в чистом аккаунте.`)
  }
  if (changedFiles.length) errors.push(`После сквозного прогона изменились файлы скилла: ${changedFiles.join(', ')}.`)
  return errors
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  if (result.error || result.status !== 0) throw Error(`Не удалось проверить Git: ${args.join(' ')}.`)
  return result.stdout.trim()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..')
  const register = readFileSync(resolve(root, '.github/REMEDIATION-REGISTER-2026-10-07.md'), 'utf8')
  const rows = register.split(/\r?\n/).filter(line => /^\| (?:R|F|M|A|D|C|E|I|Q|N)\d{2} \|/.test(line))
    .map(line => {
      const [, id, , , , check, status, commit] = line.split('|').map(value => value.trim())
      return { id, check, status, commit }
    })
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const licensePath = resolve(root, 'LICENSE'), evidencePath = resolve(root, '.github/RELEASE-EVIDENCE.json')
  const license = existsSync(licensePath) ? readFileSync(licensePath, 'utf8') : ''
  const evidence = existsSync(evidencePath) ? JSON.parse(readFileSync(evidencePath, 'utf8')) : {}
  const errors = []
  let changedFiles = []
  if (/^[0-9a-f]{40}$/.test(evidence.testedCommit || '')) try {
    git(root, ['merge-base', '--is-ancestor', evidence.testedCommit, 'HEAD'])
    changedFiles = git(root, ['diff', '--name-only', evidence.testedCommit, 'HEAD']).split('\n')
      .filter(path => path && !path.startsWith('.github/') && !['LICENSE', 'README.md'].includes(path))
  } catch (error) { errors.push(error.message) }
  errors.push(...assessRelease({ rows, version: pkg.version, licenseId: pkg.license, license, evidence, changedFiles }))
  if (errors.length) {
    for (const error of errors) console.error(`✘ ${error}`)
    process.exitCode = 1
  } else console.log('Выпуск готов к отдельному решению о публикации.')
}
