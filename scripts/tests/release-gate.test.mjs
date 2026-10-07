import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const gate = fileURLToPath(new URL('../../.github/release-check.mjs', import.meta.url))

test('release gate needs closed findings, owner terms and unchanged cross-harness evidence',
  { skip: !existsSync(gate) }, async () => {
    const { assessRelease, expectedIds } = await import(gate)
    const rows = expectedIds.map(id => ({ id, status: ['E11', 'I10'].includes(id) ? 'отложено' : 'закрыто',
      check: 'scripts/tests/example.test.mjs', commit: 'a'.repeat(40) }))
    const evidence = { testedCommit: 'b'.repeat(40), licenseDecision: { id: 'MIT',
      reference: 'owner/message/mit', decidedAt: '2026-10-07T00:00:00Z' }, distribution: { decision: 'public',
      reference: 'owner/message/42', approvedAt: '2026-10-07T00:00:00Z' },
    runs: Object.fromEntries(['dsh', 'claude-code', 'codex'].map(harness =>
      [harness, { status: 'pass', account: 'clean-test-account', record: `test-record/${harness}` }])) }
    const input = { rows, version: '1.0.0', licenseId: 'MIT',
      license: readFileSync(fileURLToPath(new URL('../../LICENSE', import.meta.url)), 'utf8'),
      evidence, changedFiles: [] }
    assert.deepEqual(assessRelease(input), [])
    assert.match(assessRelease({ ...input, rows: rows.map(row => row.id === 'R01' ? { ...row, status: 'в работе' } : row) }).join('\n'), /R01/)
    assert.match(assessRelease({ ...input, rows: [...rows, rows[0]] }).join('\n'), /повторные R01/)
    assert.match(assessRelease({ ...input, license: '' }).join('\n'), /LICENSE/)
    assert.match(assessRelease({ ...input, evidence: { ...evidence, licenseDecision: null } }).join('\n'), /выборе лицензии/)
    assert.match(assessRelease({ ...input, changedFiles: ['SKILL.md'] }).join('\n'), /SKILL.md/)
    assert.match(assessRelease({ ...input, evidence: { ...evidence, runs: { ...evidence.runs, dsh: { status: 'missing' } } } }).join('\n'), /dsh/)
  })
