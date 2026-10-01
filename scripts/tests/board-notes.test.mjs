import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { noteContext, readNotes, responsePayload, respondToNote } from '../lib/board-notes.mjs'

const snapshot = { processPath: 'demo', branch: 'main', commit: 'a'.repeat(40) }
const board = () => ({ revision: 3, snapshot: { revision: 2, snapshot },
  elements: { blocks: [{ id: 'n', type: 'sticky', text: 'Change the title' }], connections: [], drawings: [] },
  notes: [{ id: 'n', text: 'Change the title', targets: [], task: { revision: 1, status: 'open' } }],
})
const context = () => noteContext(board(), 'demo', 'main')
const options = { slug: 'demo', noteId: 'n', status: 'done', message: 'Title updated.' }
test('read preserves assignment and revisions without inferring tasks from old SDK', () => {
  assert.equal(context().notes[0].task.status, 'open')
  const old = board(); delete old.notes
  assert.equal(noteContext(old, 'demo', 'main').tasksSupported, false)
  assert.equal(noteContext(old, 'demo', 'main').notes[0].task, null)
  assert.throws(() => responsePayload(noteContext(old, 'demo', 'main'), options, snapshot), /SDK/)
})
test('wrong scope, stale code, malformed tasks and ordinary notes cannot be acknowledged', () => {
  assert.throws(() => noteContext(board(), 'other', 'main'), /другому/)
  assert.throws(() => responsePayload(context(), options, { ...snapshot, branch: 'other' }), /другому/)
  assert.throws(() => responsePayload(context(), options, { ...snapshot, commit: 'b'.repeat(40) }), /Версия кода/)
  const c = context(); c.notes[0].task = null
  assert.throws(() => responsePayload(c, options, snapshot), /не отмечена/)
  const broken = board(); broken.notes[0].task.revision = 0
  assert.throws(() => noteContext(broken, 'demo', 'main'), /Некорректный/)
})
test('removed target needs clarification, while question is saved with the original concurrency fences', () => {
  const c = context(); c.notes[0].targets = [{ nodeId: 'removed', missing: true }]
  assert.throws(() => responsePayload(c, options, snapshot), /удалён/)
  const payload = responsePayload(c, { ...options, status: 'needs-info' }, { ...snapshot, commit: 'b'.repeat(40) })
  assert.deepEqual([payload.expectedRevision, payload.snapshotRevision, payload.taskRevision], [3, 2, 1])
})
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'board-note-response-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-b', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init')
  return { root, commit: git('rev-parse', 'HEAD') }
}
test('reading notes does not depend on a valid local process map', async t => {
  const { root } = repo(t)
  const c = await readNotes(root, 'demo', { reader: async () => board() })
  assert.equal(c.notes[0].text, 'Change the title')
})
test('done requires a verified unchanged map; conflict never retries or reports success', async t => {
  const { root, commit } = repo(t), c = { ...context(), commit }
  let writes = 0
  const execute = async () => { writes++; return { ok: false, reason: 'conflict' } }
  await assert.rejects(() => respondToNote(root, c, options, { execute, verify: () => ({ snapshot: { verified: false } }) }), /не проверены/)
  assert.equal(writes, 0)
  const verify = () => ({ snapshot: { verified: true, commit, boardRevision: 3, revision: 2 } })
  await assert.rejects(() => respondToNote(root, c, options, { execute, verify }), /conflict/)
  assert.equal(writes, 1)
  await assert.rejects(() => respondToNote(root, c, options, { execute, verify: () => ({ snapshot: { verified: true, commit, boardRevision: 4, revision: 2 } }) }), /изменились/)
  assert.equal(writes, 1)
})
test('response uses public SDK and escaped JSON; it does not invoke code from note text', async t => {
  const { root, commit } = repo(t), c = { ...context(), commit }
  const message = 'Question: "value"?\n`$(unsafe)`'
  let code
  const result = await respondToNote(root, c, { ...options, status: 'needs-info', message }, {
    execute: async (_, snippet) => { code = snippet; return { ok: true, revision: 4, noteId: 'n' } },
  })
  assert.equal(result.ok, true)
  assert.match(code, /from '@start\/sdk'/)
  const payload = JSON.parse(code.slice(code.indexOf('(ctx, ') + 6, code.lastIndexOf(')')))
  assert.equal(payload.message, message)
  assert.equal(payload.taskRevision, 1)
})
