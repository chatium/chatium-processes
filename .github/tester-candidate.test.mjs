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
  assert.equal(rows.length, 184)
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
  repeated.groups['production-release'].ids.push(repeated.groups['owner-deferred'].ids[0])
  assert.match(assessTesterCandidate({ rows, deferrals: repeated }).errors.join('\n'), /двум видам/)
})

test('every live finding belongs to exactly one grouped run', () => {
  const ids = deferrals.groups['live-process'].ids
  const grouped = assessLiveBatches(liveBatches.batches, ids)
  assert.deepEqual(grouped.errors, [])
  assert.equal(grouped.batchCount, 0)
  assert.equal(grouped.sessionCount, 0)
  const synthetic = { id: 'customer-delivery', fixture: 'funnels-git-3/main: plant-care',
    negative: 'не отправлять после отмены', positive: 'сверить состояние',
    evidence: 'evidence.md', ids: ['I09'], status: 'pending' }
  assert.match(assessLiveBatches([], ['I09']).errors.join('\n'), /1–4 пакета/)
  assert.deepEqual(assessLiveBatches([synthetic], ['I09']).errors, [])
  assert.match(assessLiveBatches([{ ...synthetic, ids: [] }], ['I09']).errors.join('\n'), /назначен 0 пакетам/)
  assert.match(assessLiveBatches([synthetic, { ...synthetic, id: 'duplicate-batch' }], ['I09']).errors.join('\n'), /назначен 2 пакетам/)
  assert.match(assessLiveBatches([{ ...synthetic, status: 'completed' }], ['I09']).errors.join('\n'), /допустимый статус/)
  const mismatched = [{ ...synthetic, sharedLiveSession: 'same-session' }]
  mismatched.push({ ...structuredClone(mismatched[0]), id: 'other-process',
    fixture: 'funnels-git-3/main: other-process', ids: [] })
  assert.match(assessLiveBatches(mismatched, ['I09']).errors.join('\n'), /разные аккаунты или процессы/)
  assert.match(assessLiveBatches([{ ...synthetic, sharedLiveSession: 'same-session' }], ['I09']).errors.join('\n'), /только одному пакету/)
})
