import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gitState, assertPublishedState, SnapshotDrift } from '../lib/git-state.mjs'
import { buildSnapshot } from '../lib/snapshot.mjs'
import { compareSnapshot, verifySnapshot } from '../lib/freshness.mjs'
import { fileURLToPath } from 'node:url'

const checkCli = fileURLToPath(new URL('../check.mjs', import.meta.url))

test('missing Git checkout explains why snapshot freshness is unavailable', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-no-git-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.throws(() => gitState(root), /Не удалось выполнить git branch; актуальность снимка не подтверждена/)
})

test('remote Git check refuses interactive credentials instead of hanging', t => {
  const base = mkdtempSync(join(tmpdir(), 'process-git-prompt-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const bin = join(base, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$GIT_TERMINAL_PROMPT" != "0" ] || [ "$GCM_INTERACTIVE" != "never" ]; then sleep 20; fi\nexit 13\n', { mode: 0o755 })
  const moduleUrl = new URL('../lib/git-state.mjs', import.meta.url).href
  const code = `import { git } from ${JSON.stringify(moduleUrl)}; try { git(${JSON.stringify(base)}, ['ls-remote', 'origin']); process.exitCode = 3 } catch { console.log('noninteractive refusal') }`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8', timeout: 3000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  })
  assert.equal(result.status, 0, result.stderr || String(result.error))
  assert.match(result.stdout, /noninteractive refusal/)
})

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
  run(['push', 'origin', 'HEAD:main']) // The new-process scaffold requires the published base.
  const checks = [
    { id: 'map', title: 'Map', ok: true, errors: [], warnings: [] },
    { id: 'events.schema', title: 'Event contract', ok: true, errors: [], warnings: [] },
  ]
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
    s => { s.checks[1].ok = false; s.checks[1].errors.push('broken') }]) {
    const board = structuredClone(f.board); change(board.snapshot.snapshot)
    assert.throws(() => compareSnapshot(f.expected, board), SnapshotDrift)
  }
})

test('build-hook map verifies visible content without claiming independent checks passed', async t => {
  const f = fixture(t), board = structuredClone(f.board)
  const automatic = board.snapshot.snapshot
  automatic.producer = 'build-hook'
  automatic.nodes[0].status = 'planned'
  automatic.nodes[0].reason = 'Исходники опубликованы; готовность проверяется отдельно'
  automatic.checks = [{ id: 'build-map', title: 'Проверка готовности процесса', ok: false,
    errors: ['Проверки готовности выполняются отдельно'], warnings: [] }]
  const result = await verifySnapshot(f.root, f.expected, { reader: async () => board })
  assert.equal(result.verified, true)
  assert.equal(result.producer, 'build-hook')
  automatic.nodes[0].title = 'Другой шаг'
  assert.throws(() => compareSnapshot(f.expected, board), SnapshotDrift)
  automatic.nodes[0].title = f.expected.nodes[0].title
  automatic.commit = '0'.repeat(40)
  assert.throws(() => compareSnapshot(f.expected, board), SnapshotDrift)
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

test('changing only the validation stage does not stale an unchanged board', t => {
  const f = fixture(t), board = structuredClone(f.board)
  board.snapshot.snapshot.checks.push({ id: 'tasks', title: 'Test stage', ok: false, errors: ['pending test'], warnings: [] })
  board.snapshot.snapshot.checks.push({ id: 'knowledge.review', title: 'Launch', ok: false, errors: ['pending launch'], warnings: [] })
  board.snapshot.snapshot.checks.push({ id: 'automation.smoke', title: 'Launch smoke', ok: false, errors: ['pending smoke'], warnings: [] })
  const expected = structuredClone(f.expected)
  expected.checks.push({ id: 'tasks', title: 'Build stage', ok: true, errors: [], warnings: [] })
  expected.checks.push({ id: 'launch.variables', title: 'Launch variables', ok: false, errors: ['empty price'], warnings: [] })
  assert.doesNotThrow(() => compareSnapshot(expected, board))
})

test('design and build diagnostics do not make the same published map stale', t => {
  const f = fixture(t), board = structuredClone(f.board)
  board.snapshot.snapshot.checks.push(
    { id: 'map', title: 'Map', ok: true, errors: [], warnings: ['automation will be built'] },
    { id: 'map.sources', title: 'Sources', ok: true, errors: [], warnings: ['page will be built'] },
    { id: 'events.used', title: 'Events', ok: true, errors: [], warnings: ['writer will be built'] },
  )
  const expected = structuredClone(f.expected)
  expected.checks.push(
    { id: 'map', title: 'Map', ok: false, errors: ['automation is missing'], warnings: [] },
    { id: 'map.sources', title: 'Sources', ok: false, errors: ['page is missing'], warnings: [] },
    { id: 'events.used', title: 'Events', ok: false, errors: ['writer is missing'], warnings: [] },
  )
  assert.doesNotThrow(() => compareSnapshot(expected, board))
})

test('a published design map stays readable when build detects its future automation is absent', t => {
  const f = fixture(t)
  writeFileSync(join(f.root, 'demo/.workspace.json'), '{"type":"process","processEngine":"processes-v2"}\n')
  writeFileSync(join(f.root, 'demo/process.yaml'), `title: Demo
knowledge: .knowledge-base/processes/demo
stages: [Start]
nodes:
  - id: first
    stage: Start
    kind: external
    title: First
    purpose: Start
    source: demo/code.txt
links:
  - from: first
    to: first
    when: Then
    via: demo/automations/future/
`)
  f.run(['add', '.']); f.run(['commit', '-m', 'Plan']); f.run(['push', 'origin', 'HEAD'])
  const collect = (stage, snapshotFile, publish = false) => {
    const result = spawnSync(process.execPath, [checkCli, 'demo', '--root', f.root, '--json',
      '--task-stage', stage, '--snapshot-file', snapshotFile, publish ? '--publish-snapshot' : '--no-snapshot'],
    { encoding: 'utf8', timeout: 15_000 })
    assert.ok(result.stdout, result.stderr)
    return JSON.parse(result.stdout)
  }
  const designFile = join(f.base, 'design.json'), buildFile = join(f.base, 'build.json')
  const design = collect('design', designFile)
  assert.equal(design.checks.find(check => check.id === 'map').ok, true,
    JSON.stringify(design.checks.find(check => check.id === 'map')))
  const build = collect('build', buildFile)
  assert.equal(build.checks.find(check => check.id === 'map').ok, false)
  const stored = JSON.parse(readFileSync(designFile, 'utf8'))
  const expected = JSON.parse(readFileSync(buildFile, 'utf8'))
  assert.doesNotThrow(() => compareSnapshot(expected, { snapshot: { revision: 1, snapshot: stored },
    revision: 1, elements: { blocks: [], connections: [], drawings: [] } }))
  const refused = spawnSync(process.execPath, [checkCli, 'demo', '--root', f.root, '--json',
    '--task-stage', 'build', '--snapshot-file', join(f.base, 'denied.json'), '--publish-snapshot'],
  { encoding: 'utf8', timeout: 15_000 })
  assert.equal(refused.status, 2, refused.stderr)
  assert.match(JSON.parse(refused.stdout).snapshot.error, /Нельзя публиковать снимок с некорректной картой процесса/)
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

test('branch or HEAD changed while reading the board cannot be reported current', async t => {
  const branch = fixture(t)
  const changedBranch = await verifySnapshot(branch.root, branch.expected, { reader: async () => {
    branch.run(['checkout', '-b', 'process/other'])
    return branch.board
  } })
  assert.equal(changedBranch.status, 'stale')
  assert.equal(changedBranch.verified, false)

  const head = fixture(t)
  const changedHead = await verifySnapshot(head.root, head.expected, { reader: async () => {
    writeFileSync(join(head.root, 'demo/code.txt'), 'new published version')
    head.run(['add', '.']); head.run(['commit', '-m', 'Concurrent change'])
    return head.board
  } })
  assert.equal(changedHead.status, 'stale')
  assert.equal(changedHead.verified, false)
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
  const publishedCommit = f.run(['rev-parse', 'HEAD'])
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
process.stderr.write('Executed commit: ' + (process.env.TEST_EXECUTED_SHA || process.env.TEST_PUBLISHED_SHA) + '\\n')
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
    TEST_CALLS_FILE: callsFile, TEST_NODE: process.execPath, TEST_CLI: cli, TEST_PUBLISHED_SHA: publishedCommit }
  const check = flags => {
    const result = spawnSync(process.execPath, [join(scripts, 'check.mjs'), 'demo', '--json', ...flags], { cwd: f.root, encoding: 'utf8', env })
    return { ...result, report: JSON.parse(result.stdout) }
  }
  let result = check(['--verify-snapshot'])
  assert.equal(result.report.snapshot.verified, true, JSON.stringify(result.report.snapshot))
  assert.equal(result.report.snapshot.elements, undefined)
  assert.doesNotMatch(result.stdout, /Please review/)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\n')
  assert.equal(result.status, result.report.passed === result.report.total ? 0 : 1)
  result = check([])
  assert.equal(result.report.snapshot.saved, false)
  assert.equal(result.report.snapshot.verified, true)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\nread\n')
  result = check(['--publish-snapshot'])
  assert.equal(result.report.snapshot.saved, true)
  assert.equal(result.report.snapshot.verified, true)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\nread\nwrite\nread\n')
  result = check(['--no-snapshot'])
  assert.equal(result.report.snapshot.skipped, true)
  assert.notEqual(result.report.snapshot.verified, true)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\nread\nwrite\nread\n')
  const context = spawnSync(process.execPath, [join(scripts, 'context.mjs'), 'demo', '--no-cards'], { cwd: f.root, encoding: 'utf8', env })
  assert.equal(context.status, 0)
  assert.match(context.stdout, /Please review/)
  assert.match(context.stdout, /актуальна/)
  result = check(['--typecheck'])
  assert.equal(result.report.checks.find(c => c.id === 'typecheck').ok, true)
  assert.equal(result.report.snapshot.verified, true)
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\nread\nwrite\nread\nread\nread\ntypecheck\nread\n')
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
  assert.equal(readFileSync(callsFile, 'utf8'), 'read\nread\nwrite\nread\nread\nread\ntypecheck\nread\n')
  env.TEST_EXECUTED_SHA = '0'.repeat(40)
  const wrongCommit = check(['--verify-snapshot'])
  assert.equal(wrongCommit.report.snapshot.verified, false)
  assert.match(wrongCommit.report.snapshot.error, /исполнен|коммит/i)
  const wrongPublish = check(['--publish-snapshot'])
  assert.equal(wrongPublish.report.snapshot.verified, false)
  assert.equal(wrongPublish.report.snapshot.saved, false)
  assert.match(wrongPublish.report.snapshot.error, /исполнен|коммит/i)
  f.run(['commit', '--allow-empty', '-m', 'Same published tree'])
  f.run(['push', 'origin', 'HEAD'])
  const reusedCommit = f.run(['rev-parse', 'HEAD'])
  const reusedBoard = JSON.parse(readFileSync(boardFile, 'utf8'))
  reusedBoard.snapshot.snapshot.commit = reusedCommit
  writeFileSync(boardFile, JSON.stringify(reusedBoard))
  env.TEST_EXECUTED_SHA = publishedCommit
  const reusedBuild = check(['--verify-snapshot'])
  assert.equal(reusedBuild.report.snapshot.verified, true, JSON.stringify(reusedBuild.report.snapshot))
  writeFileSync(join(f.root, 'demo/code.txt'), 'different published tree')
  f.run(['add', '.']); f.run(['commit', '-m', 'Different tree']); f.run(['push', 'origin', 'HEAD'])
  const changedBoard = JSON.parse(readFileSync(boardFile, 'utf8'))
  changedBoard.snapshot.snapshot.commit = f.run(['rev-parse', 'HEAD'])
  writeFileSync(boardFile, JSON.stringify(changedBoard))
  const differentBuild = check(['--verify-snapshot'])
  assert.equal(differentBuild.report.snapshot.verified, false)
  assert.match(differentBuild.report.snapshot.error, /исполнен|коммит/i)
  delete env.TEST_EXECUTED_SHA
})
