import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { assessLiveBatches, assessTesterCandidate, parseRegister } from './tester-candidate.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const rows = parseRegister(readFileSync(`${root}/.github/REMEDIATION-REGISTER-2026-10-07.md`, 'utf8'))
const deferrals = JSON.parse(readFileSync(`${root}/.github/TESTER-DEFERRALS.json`, 'utf8'))
const liveBatches = JSON.parse(readFileSync(`${root}/.github/LIVE-BATCHES-2026-10-08.json`, 'utf8'))

test('tester handoff explicitly accounts for every unresolved audit item', () => {
  const result = assessTesterCandidate({ rows, deferrals })
  assert.deepEqual(result.errors, [])
  assert.equal(rows.length, 166)
  assert.ok(result.pendingCount > 0, 'tester candidate must not impersonate final release')
})

test('a newly unresolved item cannot silently enter the tester build', () => {
  const candidate = structuredClone(rows)
  const closed = candidate.find(row => row.status === 'закрыто')
  closed.status = 'открыто'
  assert.match(assessTesterCandidate({ rows: candidate, deferrals }).errors.join('\n'), /нет явного назначения/)
})

test('a missing contract or duplicate classification rejects the handoff', () => {
  const candidate = structuredClone(rows)
  const pending = candidate.find(row => row.status !== 'закрыто' && !['E11', 'I10'].includes(row.id))
  pending.check = '—'
  assert.match(assessTesterCandidate({ rows: candidate, deferrals }).errors.join('\n'), /нет ссылки/)
  const repeated = structuredClone(deferrals)
  repeated.groups.harness.ids.push(repeated.groups['live-process'].ids[0])
  assert.match(assessTesterCandidate({ rows, deferrals: repeated }).errors.join('\n'), /двум видам/)
})

test('every live finding belongs to exactly one grouped run', () => {
  const ids = deferrals.groups['live-process'].ids
  assert.deepEqual(assessLiveBatches(liveBatches.batches, ids).errors, [])
  const missing = structuredClone(liveBatches.batches)
  missing[0].ids.pop()
  assert.match(assessLiveBatches(missing, ids).errors.join('\n'), /назначен 0 пакетам/)
  const duplicate = structuredClone(liveBatches.batches)
  duplicate[1].ids.push(duplicate[0].ids[0])
  assert.match(assessLiveBatches(duplicate, ids).errors.join('\n'), /назначен 2 пакетам/)
})
