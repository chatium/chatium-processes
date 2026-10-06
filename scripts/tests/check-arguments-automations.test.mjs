import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkScript = fileURLToPath(new URL('../check.mjs', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-check-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', 'title: Demo\nnodes: []\nlinks: []\n')
  const run = (...flags) => spawnSync(process.execPath,
    [checkScript, 'demo', '--root', root, '--no-snapshot', '--json', ...flags],
    { encoding: 'utf8', timeout: 15_000 })
  return { root, put, run }
}

test('unknown option exits before any snapshot or output-file write', t => {
  const f = fixture(t)
  const target = join(f.root, 'should-not-exist.json')
  const result = f.run('--no-snapshto', '--snapshot-file', target)
  assert.equal(result.status, 2)
  assert.match(result.stderr, /--no-snapshto/)
  assert.throws(() => readFileSync(target))
})

test('unsupported branches and templated dateExpression fail automations check', t => {
  const f = fixture(t)
  f.put('demo/automations/a.automationConfig.json', JSON.stringify({
    title: 'Test', eventUrls: ['event://external/test'],
    steps: [
      { id: 'branch', type: 'condition', thenBranch: { steps: [] } },
      { id: 'wait', type: 'delay', delay: { type: 'dateExpression', dateExpression: '{{ steps.prepare.date }}' } },
    ],
  }))
  const result = f.run()
  assert.ok(result.stdout, result.stderr)
  const automations = JSON.parse(result.stdout).checks.find(check => check.id === 'automations')
  assert.equal(automations.ok, false)
  assert.match(automations.errors.join('\n'), /condition/)
  assert.match(automations.errors.join('\n'), /thenBranch/)
  assert.match(automations.errors.join('\n'), /JS-выражением/)
})
