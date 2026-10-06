import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const register = fileURLToPath(new URL('../../.github/REMEDIATION-REGISTER-2026-10-07.md', import.meta.url))
const expected = [
  ...Array.from({ length: 49 }, (_, i) => `R${String(i + 1).padStart(2, '0')}`),
  ...Array.from({ length: 12 }, (_, i) => `F${String(i + 1).padStart(2, '0')}`),
  ...Object.entries({ M: 20, A: 13, D: 13, C: 14, E: 14, I: 12, Q: 14, N: 5 })
    .flatMap(([prefix, count]) => Array.from({ length: count }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`)),
]

test('the remediation register retains all 166 findings and evidence for closed rows',
  { skip: !existsSync(register) }, () => {
  const lines = readFileSync(register, 'utf8').split(/\r?\n/)
  const rows = lines.filter(line => /^\| (?:R|F|M|A|D|C|E|I|Q|N)\d{2} \|/.test(line))
  const ids = rows.map(line => line.split('|')[1].trim())
  assert.deepEqual([...ids].sort(), [...expected].sort())
  assert.equal(new Set(ids).size, 166)
  for (const line of rows) {
    const [, id, initial, block, caseText, check, status, commit] = line.split('|').map(value => value.trim())
    assert.match(initial, /^[ОПВЖ]$/, id)
    assert.match(block, /^P[0-8]$/, id)
    assert.ok(caseText.length > 20 && !/^[—-]$/.test(caseText), `${id}: missing negative case`)
    assert.ok(['открыто', 'в работе', 'требует подтверждения', 'отложено', 'закрыто'].includes(status), `${id}: ${status}`)
    if (status === 'закрыто') {
      assert.notEqual(check, '—', `${id}: no check`)
      assert.match(commit, /^[0-9a-f]{7,40}$/, `${id}: no fix commit`)
    }
  }
  })
