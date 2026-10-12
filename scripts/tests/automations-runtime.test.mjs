import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../automations-runtime.mjs', import.meta.url))
const automationPath = 'demo/automations/welcome.automationConfig.json'

test('one read checks all published subscriptions and binds the executed commit', t => {
  const base = mkdtempSync(join(tmpdir(), 'automations-runtime-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'account'), bin = join(base, 'bin'), capture = join(base, 'exec-input.txt')
  mkdirSync(join(root, 'demo', 'automations'), { recursive: true })
  mkdirSync(bin)
  writeFileSync(join(root, 'demo/.workspace.json'), '{"type":"process","processEngine":"processes-v2","config":{"variables":{}}}')
  writeFileSync(join(root, 'demo/process.yaml'), 'title: Demo\naccountId: 123\nstages: []\nnodes: []\nlinks: []\n')
  writeFileSync(join(root, automationPath), '{"eventUrls":[],"steps":[]}')
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('-c', 'user.name=Tester', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
  const commit = git('rev-parse', 'HEAD')
  const mock = join(bin, 'chatium')
  writeFileSync(mock, '#!/usr/bin/env node\n' +
    "const fs=require('node:fs');fs.writeFileSync(process.env.CAPTURE,fs.readFileSync(0,'utf8'));" +
    "process.stdout.write(process.env.MOCK_RESULT);process.stderr.write('Executed commit: '+process.env.EXECUTED_COMMIT+'\\n');\n")
  chmodSync(mock, 0o755)
  const value = { automationId: 'stable-id', branchName: 'main', filePath: automationPath,
    status: 'ready', error: null, enabled: false }
  const run = (item = value, executed = commit) => spawnSync(process.execPath,
    [script, 'demo', '--root', root, '--expect', 'disabled', '--json'], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: bin + ':' + process.env.PATH, CAPTURE: capture,
        MOCK_RESULT: JSON.stringify({ accountId: 123, rows: [{ path: automationPath, value: item }] }),
        EXECUTED_COMMIT: executed },
    })
  const ok = run()
  assert.equal(ok.status, 0, ok.stderr || ok.stdout)
  assert.equal(JSON.parse(ok.stdout).status, 'verified')
  const code = readFileSync(capture, 'utf8')
  assert.match(code, /getAutomationByPath/)
  assert.doesNotMatch(code, /enableAutomation|disableAutomation/)
  const wrongCommit = run(value, '0'.repeat(40))
  assert.equal(wrongCommit.status, 1)
  assert.match(JSON.parse(wrongCommit.stdout).errors.join(' '), /Исполнен коммит/)
  const oldSdk = run({ ...value, enabled: undefined })
  assert.equal(oldSdk.status, 1)
  assert.match(JSON.parse(oldSdk.stdout).errors.join(' '), /SDK не сообщает/)
})
