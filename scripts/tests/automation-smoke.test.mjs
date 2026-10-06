import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { automationSmokeStatus } from '../lib/automation-smoke.mjs'

test('launch requires a safe successful run for every current automation', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-automation-smoke-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = 'demo/automations/welcome/welcome.automationConfig.json'
  const file = join(root, path), record = join(root, 'demo/tests/automation-smoke.json')
  mkdirSync(dirname(file), { recursive: true }); mkdirSync(dirname(record), { recursive: true })
  writeFileSync(file, '{"steps":[]}')
  const args = { root, slug: 'demo', automationFiles: [file], ancestor: () => true }
  assert.equal(automationSmokeStatus(args).status, 'missing')
  const run = { path, configSha256: createHash('sha256').update('{"steps":[]}').digest('hex'),
    branch: 'main', testedCommit: 'a'.repeat(40), testedAt: '2026-10-07T10:00:00.000Z',
    testOnly: true, testContact: { type: 'email', value: 'test@example.com' },
    executionId: 'run-1', result: 'passed' }
  const save = value => writeFileSync(record, JSON.stringify({ version: 1, runs: [value] }))
  save({ ...run, testOnly: false })
  assert.match(automationSmokeStatus(args).errors.join('\n'), /безопасный контакт/)
  save(run)
  assert.equal(automationSmokeStatus(args).status, 'ready')
  writeFileSync(file, '{"steps":[{"id":"new"}]}')
  assert.match(automationSmokeStatus(args).errors.join('\n'), /конфиг изменился/)
  writeFileSync(file, '{"steps":[]}')
  assert.match(automationSmokeStatus({ ...args, ancestor: () => false }).errors.join('\n'), /предшествующему коммиту/)
})
