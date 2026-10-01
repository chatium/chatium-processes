import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { inspectProcessFormat, assertSkillProcess } from '../lib/process-format.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-format-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  const inspect = path => inspectProcessFormat(root, path)
  const run = (script, path = 'demo', flags = [], env = {}) => spawnSync(process.execPath,
    [fileURLToPath(new URL(`../${script}.mjs`, import.meta.url)), path, '--root', root, ...flags],
    { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 15_000 })
  const files = () => {
    const result = {}
    function visit(dir, prefix = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) visit(join(dir, entry.name), prefix + entry.name + '/')
        else result[prefix + entry.name] = readFileSync(join(dir, entry.name), 'utf8')
      }
    }
    visit(root); return result
  }
  return { root, put, inspect, run, files }
}
function skill(f, path = 'demo') {
  f.put(`${path}/.workspace.json`, '{"type":"process","processEngine":"processes-v2","config":{"variables":{}}}')
  f.put(`${path}/PLAN.md`, '# Demo\n')
  f.put(`${path}/process.yaml`, 'title: Demo\nstages: []\nnodes: []\nlinks: []\n')
}

test('workspace boundary, appearance and version do not identify a process generation', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', '{}')
  f.put('demo/.dir.json', '{"params":{"startWorkspaceAppearance":"ai"}}')
  assert.equal(f.inspect('demo').kind, 'workspace')
  f.put('demo/.workspace.json', '{"type":"process","version":2}')
  f.put('demo/.dir.json', '{"params":{"startWorkspaceAppearance":"process"}}')
  f.put('demo/specs/events.yaml', 'events: []\n')
  assert.equal(f.inspect('demo').kind, 'unknown-process')
  f.put('demo/PLAN.md', '# Business plan')
  assert.equal(f.inspect('demo').canUseSkillWorkflow, false)
  f.put('demo/process.yaml', 'title: Demo\nnodes: []\n')
  assert.equal(f.inspect('demo').kind, 'unknown-process')
  assert.throws(() => assertSkillProcess(f.root, 'demo'), /processEngine/)
  f.put('demo/.workspace.json', '{"type":"process","version":2,"processEngine":"processes-v2"}')
  assert.equal(f.inspect('demo').kind, 'skill-process')
})
test('legacy markers override new files; adding a plan is not a migration', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', '{"type":"process"}')
  f.put('demo/specs/index.yaml', 'passport:\n  status: approved\n')
  assert.equal(f.inspect('demo').kind, 'legacy-process')
  skill(f)
  assert.equal(f.inspect('demo').kind, 'mixed-process')
  assert.throws(() => assertSkillProcess(f.root, 'demo'), /mixed-process/)
})
test('a nested component retains its owning legacy process, including old emails v2', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', '{"type":"process"}')
  f.put('demo/specs/workspaces/welcome.yaml', 'workspace:\n  key: welcome\n  type: emails\n')
  f.put('demo/welcome/.workspace.json', '{"type":"emails","version":2}')
  f.put('demo/welcome/.dir.json', '{"params":{"startWorkspaceAppearance":"process-workspace"}}')
  f.put('demo/welcome/spec/current.yml', 'version: 2\n')
  f.put('demo/welcome/actions/send.ts', 'export const keep = true\n')
  const detected = f.inspect('demo/welcome/actions/send.ts')
  assert.equal(detected.kind, 'legacy-component')
  assert.equal(detected.processPath, 'demo')
  assert.equal(detected.workspacePath, 'demo/welcome')
  assert.equal(detected.workspaceType, 'emails')
  skill(f, 'demo/welcome')
  assert.equal(f.inspect('demo/welcome').kind, 'mixed-component')
})
test('new process components are not independent workspaces and nested workspaces require review', t => {
  const f = fixture(t); skill(f)
  f.put('demo/page/index.ts', 'export const page = true\n')
  assert.equal(f.inspect('demo/page').kind, 'skill-component')
  assert.equal(f.inspect('demo/page').workspacePath, 'demo')
  assert.equal(f.inspect('demo/page').canUseSkillWorkflow, false)
  f.put('demo/page/.workspace.json', '{"type":"landing"}')
  assert.equal(f.inspect('demo').kind, 'mixed-process')
})
test('invalid metadata, plain directories and escaping paths do not authorize new scaffolding', t => {
  const f = fixture(t); skill(f)
  f.put('demo/.workspace.json', 'not json')
  assert.equal(f.inspect('demo').kind, 'unknown-process')
  assert.ok(f.inspect('demo').errors.length)
  f.put('ordinary/page.ts', 'export const live = true')
  assert.throws(() => assertSkillProcess(f.root, 'ordinary', { creating: true }), /directory/)
  assert.throws(() => f.inspect('../demo'), /относительный/)
  symlinkSync(tmpdir(), join(f.root, 'escape'))
  assert.throws(() => f.inspect('escape'), /пределы/)
})
test('scaffold refuses legacy, ambiguous and mixed processes before any shared or local write', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', '{"type":"process","config":{"senderChannels":["live"]}}')
  for (const marker of [null, 'demo/specs/index.yaml', 'demo/PLAN.md', 'demo/process.yaml']) {
    if (marker) f.put(marker, '# Existing content\n')
    const before = f.files()
    const r = f.run('scaffold', 'demo', ['--title', 'Do not rebuild'])
    assert.equal(r.status, 2, r.stderr || r.stdout)
    assert.deepEqual(f.files(), before)
  }
  assert.equal(existsSync(join(f.root, '.knowledge-base')), false)
  assert.equal(existsSync(join(f.root, '.mailings')), false)
})
test('context describes legacy and check refuses before calling CLI or writing a snapshot', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', '{"type":"process"}')
  f.put('demo/specs/passport-sections/offer.yaml', 'section:\n  key: offer\n')
  f.put('bin/chatium', '#!/bin/sh\nprintf invoked >> "$PROCESSES_TEST_CALLS"\nexit 9\n')
  chmodSync(join(f.root, 'bin/chatium'), 0o755)
  const calls = join(f.root, 'called.txt')
  const env = { PATH: `${join(f.root, 'bin')}:${process.env.PATH}`, PROCESSES_TEST_CALLS: calls }
  const before = f.files()
  const context = f.run('context', 'demo', [], env)
  assert.equal(context.status, 0, context.stderr)
  assert.match(context.stdout, /legacy-process/)
  assert.doesNotMatch(context.stdout, /Этап:|создай каркас/)
  const snapshot = join(f.root, 'snapshot.json')
  const check = f.run('check', 'demo', ['--json', '--snapshot-file', snapshot], env)
  assert.equal(check.status, 2, check.stderr || check.stdout)
  const report = JSON.parse(check.stdout)
  assert.equal(report.checks[0].id, 'process.format')
  assert.equal(report.snapshot.saved, false)
  assert.equal(report.snapshot.verified, false)
  assert.equal(existsSync(calls), false)
  assert.equal(existsSync(snapshot), false)
  assert.deepEqual(f.files(), before)
})
test('fresh scaffold and repeat retain the new workflow without changing existing files', t => {
  const f = fixture(t)
  assert.equal(f.inspect('demo').kind, 'missing')
  const initial = f.run('scaffold', 'demo', ['--title', 'Demo'])
  assert.equal(initial.status, 0, initial.stderr)
  assert.equal(f.inspect('demo').kind, 'skill-process')
  const before = f.files()
  const repeat = f.run('scaffold', 'demo', ['--title', 'Changed title'])
  assert.equal(repeat.status, 0, repeat.stderr)
  assert.deepEqual(f.files(), before)
})

test('explicit marker permits completing a partial scaffold without replacing configuration', t => {
  const f = fixture(t)
  const ws = '{"type":"process","processEngine":"processes-v2","config":{"variables":{"keep":"value"}}}'
  f.put('demo/.workspace.json', ws)
  assert.equal(f.inspect('demo').canUseSkillWorkflow, true)
  assert.equal(f.run('scaffold', 'demo', ['--title', 'Demo']).status, 0)
  assert.equal(readFileSync(join(f.root, 'demo/.workspace.json'), 'utf8'), ws)
  assert.ok(existsSync(join(f.root, 'demo/PLAN.md')))
  assert.ok(existsSync(join(f.root, 'demo/process.yaml')))
  f.put('demo/specs/index.yaml', 'passport: {}')
  assert.equal(f.inspect('demo').kind, 'mixed-process')
})
test('unsupported, malformed or misplaced engine markers never enable new workflow', t => {
  const f = fixture(t)
  for (const engine of [null, 2, {}, 'processes-v3', '']) {
    f.put('demo/.workspace.json', JSON.stringify({type: 'process', processEngine: engine}))
    assert.equal(f.inspect('demo').canUseSkillWorkflow, false)
    assert.ok(f.inspect('demo').errors.length)
    assert.throws(() => assertSkillProcess(f.root, 'demo', {creating: true}), /processEngine/)
  }
  f.put('demo/.workspace.json', '{"type":"landing","processEngine":"processes-v2"}')
  assert.equal(f.inspect('demo').canUseSkillWorkflow, false)
  assert.ok(f.inspect('demo').errors.length)
})
