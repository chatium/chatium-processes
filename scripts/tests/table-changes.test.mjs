import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { tableChangeStatus } from '../lib/table-changes.mjs'

test('changed existing table needs occupancy and migration evidence tied to both source versions', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-table-change-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = 'demo/tables/orders.table.ts', file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  const old = 'export const amount = Heap.Number()\n'
  const current = 'export const amount = Heap.String()\n'
  writeFileSync(file, old)
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  git('init', '-q'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test')
  git('add', '.'); git('commit', '-qm', 'initial table')
  assert.equal(tableChangeStatus({ root, slug: 'demo' }).status, 'ready')
  writeFileSync(file, current)
  git('add', '.'); git('commit', '-qm', 'change schema')
  const args = { root, slug: 'demo' }
  assert.match(tableChangeStatus(args).errors.join('\n'), /schema-decisions/)
  const ledgerPath = join(root, 'demo/tables/schema-decisions.json')
  const hash = value => createHash('sha256').update(value).digest('hex')
  const record = { path, previousSha256: hash(old), currentSha256: hash(current),
    occupancy: 'populated', rowsCheckedAt: new Date().toISOString(), rowCheckReference: 'exec:test-row-count',
    changeClass: 'migration', reason: 'Number → String changes existing values',
    ownerResponse: 'Согласен перенести данные', ownerMessageReference: 'conversation:test',
    migrationPlan: 'Convert values and verify all rows' }
  const save = value => writeFileSync(ledgerPath, JSON.stringify({ version: 1, changes: [value] }))
  save({ ...record, migrationPlan: '' })
  assert.match(tableChangeStatus(args).errors.join('\n'), /план миграции/)
  save(record)
  assert.equal(tableChangeStatus(args).status, 'ready')
  assert.match(tableChangeStatus({ ...args, stage: 'launch' }).errors.join('\n'), /перечитай сохранённую схему/)
  save({ ...record, persistedSchemaReference: 'exec:read-back', migrationResultReference: 'test:migration' })
  assert.equal(tableChangeStatus({ ...args, stage: 'launch' }).status, 'ready')
  writeFileSync(file, 'export const amount = Heap.DateTime()\n')
  assert.match(tableChangeStatus(args).errors.join('\n'), /другой версии/)
  symlinkSync(file, join(root, 'demo/tables/alias.table.ts'))
  assert.match(tableChangeStatus(args).errors.join('\n'), /ссылка в дереве таблиц/)
})
