import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gitState, assertPublishedState, SnapshotDrift } from '../lib/git-state.mjs'
import { buildSnapshot } from '../lib/snapshot.mjs'
import { compareSnapshot, verifySnapshot } from '../lib/freshness.mjs'

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'process-freshness-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'account'), remote = join(base, 'remote.git')
  mkdirSync(root)
  const run = args => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  run(['init', '--initial-branch=process/demo'])
  run(['config', 'user.email', 'test@example.invalid'])
  run(['config', 'user.name', 'Test'])
  run(['init', '--bare', remote])
  run(['remote', 'add', 'origin', remote])
  mkdirSync(join(root, 'demo'))
  writeFileSync(join(root, 'demo/code.txt'), 'initial')
  run(['add', '.']); run(['commit', '-m', 'Initial']); run(['push', '-u', 'origin', 'HEAD'])
  const checks = [{ id: 'map', title: 'Map', ok: true, errors: [], warnings: [] }]
  const expected = buildSnapshot({ root, slug: 'demo', checks, ...gitState(root),
    map: { title: 'Demo', stages: ['Start'], nodes: [{ id: 'first', stage: 'Start', kind: 'external', title: 'First', purpose: 'Start', source: 'demo/code.txt' }] } })
  const board = { snapshot: { snapshot: expected, revision: 3 }, revision: 8,
    elements: { blocks: [{ id: 'note', text: 'Change the title' }], connections: [], drawings: [] } }
  return { base, root, run, expected, board, reader: async () => structuredClone(board) }
}

test('fresh board matches local HEAD and actual remote; preserves shared notes', async t => {
  const f = fixture(t)
  const result = await verifySnapshot(f.root, f.expected, { reader: f.reader, expectedRevision: 3 })
  assert.equal(result.verified, true)
  assert.equal(result.boardRevision, 8)
  assert.equal(result.elements.blocks[0].text, 'Change the title')
})

test('missing, old and wrong-branch snapshots fail', async t => {
  const f = fixture(t)
  for (const change of [b => { b.snapshot = null }, b => { b.snapshot.snapshot.commit = '0'.repeat(40) },
    b => { b.snapshot.snapshot.branch = 'main' }, b => { b.snapshot.snapshot.processPath = 'other' }]) {
    const board = structuredClone(f.board); change(board)
    const r = await verifySnapshot(f.root, f.expected, { reader: async () => board })
    assert.equal(r.verified, false)
    assert.equal(r.status, 'stale')
  }
})

test('same SHA does not conceal changed map, letters, checks or automation steps', t => {
  const f = fixture(t)
  for (const change of [s => { s.title = 'Wrong title' }, s => { s.nodes[0].status = 'missing' },
    s => { s.nodes[0].letters = [{ title: 'Wrong', subject: 'Subject', source: 'x' }] },
    s => { s.links.push({ id: 'unexpected', steps: [{ kind: 'delay', detail: '7 days' }] }) },
    s => { s.checks[0].ok = false; s.checks[0].errors.push('broken') }]) {
    const board = structuredClone(f.board); change(board.snapshot.snapshot)
    assert.throws(() => compareSnapshot(f.expected, board), SnapshotDrift)
  }
})

test('readback detects a replaced revision even at the same commit', t => {
  const f = fixture(t)
  assert.throws(() => compareSnapshot(f.expected, f.board, 2), SnapshotDrift)
  const board = structuredClone(f.board)
  board.snapshot.snapshot.checkedAt = '2026-01-01T00:00:00.000Z'
  assert.throws(() => compareSnapshot(f.expected, board, 3), SnapshotDrift)
  assert.doesNotThrow(() => compareSnapshot(f.expected, board))
})

test('serialization order and a previous optional typecheck do not cause false drift', t => {
  const f = fixture(t), board = structuredClone(f.board)
  board.snapshot.snapshot = Object.fromEntries(Object.entries(board.snapshot.snapshot).reverse())
  board.snapshot.snapshot.checks.push({ id: 'typecheck', title: 'Typecheck', ok: true, errors: [], warnings: [] })
  assert.doesNotThrow(() => compareSnapshot(f.expected, board))
})

test('dirty and untracked files prevent freshness, shared notes still returned', async t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'untracked.txt'), 'new')
  let r = await verifySnapshot(f.root, f.expected, { reader: f.reader })
  assert.equal(r.status, 'stale'); assert.ok(r.elements)
  rmSync(join(f.root, 'untracked.txt'))
  writeFileSync(join(f.root, 'demo/code.txt'), 'changed')
  r = await verifySnapshot(f.root, f.expected, { reader: f.reader })
  assert.equal(r.status, 'stale')
})

test('unpublished HEAD and a newer remote with stale tracking refs fail', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'demo/code.txt'), 'next')
  f.run(['add', '.']); f.run(['commit', '-m', 'Next'])
  assert.throws(() => assertPublishedState(f.root, gitState(f.root)), SnapshotDrift)
  f.run(['push', 'origin', 'HEAD'])
  f.run(['reset', '--hard', f.expected.commit]) // Only the disposable test repository.
  f.run(['update-ref', 'refs/remotes/origin/process/demo', f.expected.commit])
  assert.throws(() => assertPublishedState(f.root, f.expected), SnapshotDrift)
})

test('switching branch or committing during board read fails', async t => {
  const f = fixture(t)
  const result = await verifySnapshot(f.root, f.expected, { reader: async () => {
    f.run(['checkout', '-b', 'other'])
    return f.board
  } })
  assert.equal(result.status, 'stale')
})

test('post-read remote changes fail and transport errors stay unavailable', async t => {
  const f = fixture(t)
  const r = await verifySnapshot(f.root, f.expected, { reader: async () => {
    f.run(['push', 'origin', '--delete', 'process/demo'])
    return f.board
  } })
  assert.equal(r.status, 'stale')
  const failed = await verifySnapshot(f.root, f.expected, { reader: async () => { throw Error('SDK unavailable') } })
  assert.equal(failed.verified, false); assert.equal(failed.status, 'unavailable')
  assert.throws(() => compareSnapshot(f.expected, {}), /SDK/)
})

test('public SDK works through a CLI wrapper: readback, offline and typecheck preserve the entrypoint', t => {
  const f = fixture(t)
  const scripts = resolve(import.meta.dirname, '..')
  const runNode = args => spawnSync(process.execPath, args, { cwd: f.root, encoding: 'utf8', env: process.env })
  // Scaffold is only for an empty destination; then add the code used by the snapshot fixture.
  const initialCode = readFileSync(join(f.root, 'demo/code.txt'), 'utf8')
  rmSync(join(f.root, 'demo/code.txt'))
  let r = runNode([join(scripts, 'scaffold.mjs'), 'demo', '--title', 'Demo', '--account-id', '1'])
  assert.equal(r.status, 0, r.stderr)
  writeFileSync(join(f.root, 'demo/code.txt'), initialCode)
  // A valid map with an unfinished plan: red checks must not block a truthful snapshot.
  writeFileSync(join(f.root, 'demo/process.yaml'), 'title: Demo\nknowledge: .knowledge-base/processes/demo\nstages: [Start]\nnodes:\n  - id: first\n    stage: Start\n    kind: external\n    title: First\n    purpose: Start\n    source: demo/code.txt\nlinks: []\n')
  f.run(['add', '.']); f.run(['commit', '-m', 'Scaffold']); f.run(['push', 'origin', 'HEAD'])
  const snapshotFile = join(f.base, 'snapshot.json'), boardFile = join(f.base, 'board.json'), callsFile = join(f.base, 'calls.txt')
  r = runNode([join(scripts, 'check.mjs'), 'demo', '--no-snapshot', '--snapshot-file', snapshotFile, '--json'])
  const payload = JSON.parse(readFileSync(snapshotFile, 'utf8'))
  const initial = { snapshot: { snapshot: payload, revision: 1 }, revision: 0, elements: { blocks: [{ id: 'note', text: 'Please review' }], connections: [], drawings: [] } }
  writeFileSync(boardFile, JSON.stringify(initial))
  const bin = join(f.base, 'bin'); mkdirSync(bin)
  // The image exposes a shell wrapper, not a symlink to CLI internals.
  // There are deliberately no account.js/session.js beside this entrypoint.
  writeFileSync(join(bin, 'chatium'), `#!/bin/sh
if [ "$1" = "typecheck" ]; then
  printf 'typecheck\\n' >> "$TEST_CALLS_FILE"
  exit 0
fi
exec "$TEST_NODE" "$TEST_CLI" "$@"
`, { mode: 0o755 })
  const cli = join(f.base, 'public-cli.mjs')
  writeFileSync(cli, `
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
if (process.argv[2] !== 'exec') process.exit(8)
const code = readFileSync(0, 'utf8')
if (!code.includes("from '@start/sdk'")) process.exit(7)
const file = process.env.TEST_BOARD_FILE
const board = JSON.parse(readFileSync(file, 'utf8'))
if (code.includes('writeProcessSnapshot')) {
  appendFileSync(process.env.TEST_CALLS_FILE, 'write\\n')
  const snapshot = JSON.parse(code.slice(code.indexOf('(ctx, ') + 6, code.lastIndexOf(')')))
  board.snapshot = { snapshot, revision: board.snapshot.revision + 1 }
  writeFileSync(file, JSON.stringify(board))
  console.log(JSON.stringify({ saved: true, revision: board.snapshot.revision }))
} else if (code.includes('readProcessBoardForAgent')) {
  appendFileSync(process.env.TEST_CALLS_FILE, 'read\\n')
  console.log(JSON.stringify(board))
} else process.exit(9)
`)
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_BOARD_FILE: boardFile,
    TEST_CALLS_FILE: callsFile, TEST_NODE: process.execPath, TEST_CLI: cli }
  const check = flags => {
    const result = spawnSync(process.execPath, [join(scripts, 'check.mjs'), 'demo', '--json', ...flags], { cwd: f.root, encoding: 'utf8', env })
    return { ...result, report: JSON.parse(result.stdout) }
  }
  let result = check(['--verify-snapshot'])
  assert.equal(result.report.snapshot.verified, true)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\n')
  assert.equal(result.status, result.report.passed === result.report.total ? 0 : 1)
  result = check([])
  assert.equal(result.report.snapshot.saved, true)
  assert.equal(result.report.snapshot.verified, true)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\nwrite\nread\n')
  result = check(['--no-snapshot'])
  assert.equal(result.report.snapshot.skipped, true)
  assert.notEqual(result.report.snapshot.verified, true)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\nwrite\nread\n')
  const context = spawnSync(process.execPath, [join(scripts, 'context.mjs'), 'demo', '--no-cards'], { cwd: f.root, encoding: 'utf8', env })
  assert.equal(context.status, 0)
  assert.match(context.stdout, /Please review/)
  assert.match(context.stdout, /актуальна/)
  result = check(['--typecheck'])
  assert.equal(result.report.checks.find(c => c.id === 'typecheck').ok, true)
  assert.equal(result.report.snapshot.verified, true)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\nwrite\nread\nread\nread\ntypecheck\nwrite\nread\n')
  // Missing workspace metadata makes the local generation uncertain; do not run the new workflow.
  const marker = join(f.root, 'demo/.workspace.json')
  const markerContent = readFileSync(marker, 'utf8')
  rmSync(marker)
  const missing = spawnSync(process.execPath, [join(scripts, 'context.mjs'), 'demo', '--root', f.root, '--no-cards'],
    { cwd: f.root, encoding: 'utf8', env })
  writeFileSync(marker, markerContent)
  assert.equal(missing.status, 0, missing.stderr)
  assert.match(missing.stdout, /unknown-process/)
  assert.doesNotMatch(missing.stdout, /Please review/)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\nwrite\nread\nread\nread\ntypecheck\nwrite\nread\n')
})
