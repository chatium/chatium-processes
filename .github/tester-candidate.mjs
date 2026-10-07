#!/usr/bin/env node
// Проверяет прозрачность передачи тестировщику. Не является выпускным барьером.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expectedIds } from './release-check.mjs'

export function assessTesterCandidate({ rows, deferrals }) {
  const errors = []
  const expected = new Set(expectedIds)
  const ids = rows.map(row => row.id)
  const absent = expectedIds.filter(id => !ids.includes(id))
  const extra = ids.filter(id => !expected.has(id))
  const duplicate = ids.filter((id, index) => ids.indexOf(id) !== index)
  if (absent.length || extra.length || duplicate.length)
    errors.push(`Реестр повреждён: нет ${absent.join(', ') || '—'}; лишние ${extra.join(', ') || '—'}; повторены ${duplicate.join(', ') || '—'}.`)

  const pending = new Map(rows.filter(row => row.status !== 'закрыто').map(row => [row.id, row]))
  const groups = deferrals?.groups || {}
  const classified = new Map()
  for (const [group, details] of Object.entries(groups)) {
    if (!details?.purpose || !details?.verification || !Array.isArray(details.ids) || !details.ids.length)
      errors.push(`${group}: нужна причина, способ проверки и непустой список ID.`)
    for (const id of details?.ids || []) {
      if (classified.has(id)) errors.push(`${id}: отнесён к двум видам проверки.`)
      classified.set(id, group)
      if (!pending.has(id)) errors.push(`${id}: указан как отложенный, хотя уже закрыт или отсутствует.`)
    }
  }
  for (const [id, row] of pending) {
    if (!classified.has(id)) errors.push(`${id}: нет явного назначения следующей проверки.`)
    if (!row.negative || row.negative === '—') errors.push(`${id}: нет отрицательного сценария.`)
    if (!['E11', 'I10'].includes(id) && (!row.check || row.check === '—'))
      errors.push(`${id}: нет ссылки на уже подготовленный контракт или проверку.`)
    if (classified.get(id) === 'owner-deferred' && row.status !== 'отложено')
      errors.push(`${id}: решение владельца об отсрочке не отражено в реестре.`)
  }
  for (const row of rows.filter(row => row.status === 'закрыто'))
    if (!row.negative || !row.check || row.check === '—' || !/^[0-9a-f]{7,40}$/.test(row.commit || ''))
      errors.push(`${row.id}: закрытая строка без сценария, проверки или коммита.`)
  return { errors, pendingCount: pending.size, groups: Object.fromEntries(
    Object.entries(groups).map(([group, details]) => [group, details.ids?.length || 0])) }
}

export function parseRegister(source) {
  return source.split(/\r?\n/)
    .filter(line => /^\| (?:R|F|M|A|D|C|E|I|Q|N)\d{2} \|/.test(line))
    .map(line => {
      const cells = line.split('|').map(value => value.trim())
      return { id: cells[1], negative: cells[4], check: cells[5], status: cells[6], commit: cells[7] }
    })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '..')
  const rows = parseRegister(readFileSync(resolve(root, '.github/REMEDIATION-REGISTER-2026-10-07.md'), 'utf8'))
  const deferrals = JSON.parse(readFileSync(resolve(root, '.github/TESTER-DEFERRALS.json'), 'utf8'))
  const result = assessTesterCandidate({ rows, deferrals })
  if (result.errors.length) {
    for (const error of result.errors) console.error(`✘ ${error}`)
    process.exitCode = 1
  } else {
    console.log(`Кандидат для тестировщика учтён: ${rows.length - result.pendingCount} закрыто, ${result.pendingCount} ожидают проверки.`)
    for (const [group, count] of Object.entries(result.groups)) console.log(`  ${group}: ${count}`)
    console.log('Это не разрешение на запуск процесса и не подтверждение готовности выпуска.')
  }
}
