import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
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
  const testedFiles = new Map([[path, Buffer.from('{"steps":[]}')],
    ['demo/.workspace.json', Buffer.from('{"config":{"mailings":{"testOnly":true}}}')]])
  const args = { root, slug: 'demo', automationFiles: [file], ancestor: () => true,
    readAtCommit: (_commit, relative) => testedFiles.get(relative) || null }
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
  testedFiles.set(path, Buffer.from('{"steps":[{"id":"not-tested"}]}'))
  assert.match(automationSmokeStatus(args).errors.join('\n'), /исполненной версии/)
  testedFiles.set(path, Buffer.from('{"steps":[]}'))
  testedFiles.set('demo/.workspace.json', Buffer.from('{"config":{"mailings":{"testOnly":false}}}'))
  assert.match(automationSmokeStatus(args).errors.join('\n'), /testOnly/)
  testedFiles.set('demo/.workspace.json', Buffer.from('{"config":{"mailings":{"testOnly":true}}}'))
  writeFileSync(file, '{"steps":[{"id":"new"}]}')
  assert.match(automationSmokeStatus(args).errors.join('\n'), /конфиг изменился/)
  writeFileSync(file, '{"steps":[]}')
  assert.match(automationSmokeStatus({ ...args, ancestor: () => false }).errors.join('\n'), /предшествующему коммиту/)
})

test('recorded automation run is checked against the actual Git commit', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-automation-git-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q')
  git('checkout', '-qb', 'main')
  const path = 'demo/automations/welcome/welcome.automationConfig.json'
  const file = join(root, path), workspace = join(root, 'demo/.workspace.json')
  const record = join(root, 'demo/tests/automation-smoke.json')
  for (const target of [file, workspace, record]) mkdirSync(dirname(target), { recursive: true })
  const original = '{"steps":[]}'
  writeFileSync(file, original)
  writeFileSync(workspace, '{"config":{"mailings":{"testOnly":true}}}')
  git('add', '.')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'safe automation')
  const testedCommit = git('rev-parse', 'HEAD')
  const run = { path, configSha256: createHash('sha256').update(original).digest('hex'),
    branch: 'main', testedCommit, testedAt: '2026-10-07T10:00:00.000Z', testOnly: true,
    testContact: { type: 'email', value: 'test@example.com' }, executionId: 'run-1', result: 'passed' }
  writeFileSync(record, JSON.stringify({ version: 1, runs: [run] }))
  const args = { root, slug: 'demo', automationFiles: [file] }
  assert.equal(automationSmokeStatus(args).status, 'ready')
  const changed = '{"steps":[{"id":"new"}]}'
  writeFileSync(file, changed)
  run.configSha256 = createHash('sha256').update(changed).digest('hex')
  writeFileSync(record, JSON.stringify({ version: 1, runs: [run] }))
  assert.match(automationSmokeStatus(args).errors.join('\n'), /исполненной версии/)
})
