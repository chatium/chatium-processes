import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { boardContext, readProcessBoard, readMaterial, writeBoardElements } from '../lib/board.mjs'

const snapshot = { processPath: 'demo', branch: 'main', commit: 'a'.repeat(40),
  nodes: [{ id: 'landing', title: 'Landing', source: 'demo/page.vue' }], links: [{ from: 'landing', to: 'form' }] }
const board = () => ({ revision: 3, snapshot: { revision: 2, snapshot }, elements: {
  blocks: [
    { id: 'note', type: 'sticky', text: 'Use as a visual reference' },
    { id: 'reference', type: 'image', image: { hash: 'image-reference', alt: 'Description is not visual inspection' } },
    { id: 'standalone', type: 'image', image: { hash: 'image-standalone' } },
  ],
  connections: [
    { id: 'a', from: { block: 'note' }, to: { block: 'reference' }, label: 'example' },
    { id: 'b', from: { block: 'reference' }, to: { block: 'node-landing' }, label: 'appearance' },
  ], drawings: [],
} })
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-board-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git('init', '-b', 'main')
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'init')
  return root
}
function runtime(current, signed) {
  // Run the actual emitted SDK program with only its two documented dependencies injected.
  return async (_, code) => {
    const body = code.replace(/^import .* from '@(?:start\/sdk|app\/storage)'\n/gm, '')
    const run = new Function('readProcessBoardForAgent', 'getOriginalUrl', 'ctx', `return (async () => {${body}})()`)
    return run(async (_ctx, process, branch) => {
      assert.equal(process, 'demo'); assert.equal(branch, 'main')
      return current
    }, (_ctx, hash) => { signed.push(hash); return `https://files.example.invalid/${hash}` }, {})
  }
}
test('whole board includes process graph, standalone images and labelled connections on older SDK', () => {
  const b = board(), c = boardContext(b, 'demo', 'main')
  assert.deepEqual(c.snapshot, snapshot)
  assert.deepEqual(c.elements, b.elements)
  assert.deepEqual(c.materials.map(m => m.id), ['reference', 'standalone'])
  assert.equal(c.materials[0].targets[0].source, 'demo/page.vue')
  assert.deepEqual(c.materials[0].relatedIds, ['note'])
  assert.deepEqual(c.materials[1].targets, [])
  assert.equal(c.tasksSupported, false)
  assert.deepEqual(c.notes[0].relatedIds, ['reference'])
  assert.deepEqual(c.notes[0].targets, []) // no fabricated transitive target
})
test('unknown future objects are retained and flagged, not silently dropped', () => {
  const b = board(); b.elements.blocks.push({ id: 'audio', type: 'audio', media: { hash: 'audio-hash' } })
  const c = boardContext(b, 'demo', 'main')
  assert.deepEqual(c.unsupportedTypes, ['audio'])
  assert.equal(c.elements.blocks.at(-1).media.hash, 'audio-hash')
})
test('board read works before local scaffolding; missing snapshot is explicit', async t => {
  const root = repo(t), b = board(); b.snapshot = null
  const c = await readProcessBoard(root, 'demo', { reader: async () => b })
  assert.equal(c.snapshot, null)
  assert.equal(c.snapshotRevision, null)
  assert.equal(c.materials.length, 2)
})
test('material resolves an image directly linked to the process without a note task', async t => {
  const root = repo(t), b = board(), signed = []
  const result = await readMaterial(root, boardContext(b, 'demo', 'main'), { slug: 'demo', elementId: 'reference' }, { execute: runtime(b, signed) })
  assert.equal(result.url, 'https://files.example.invalid/image-reference')
  assert.deepEqual(signed, ['image-reference'])
})
test('stale, replaced, hidden or forged materials cannot obtain a storage URL', async t => {
  const root = repo(t), c = boardContext(board(), 'demo', 'main')
  for (const change of [
    b => { b.revision++ },
    b => { b.snapshot.revision++ },
    b => { b.elements.blocks[1].image.hash = 'replacement' },
    b => { b.elements.blocks.splice(1, 1) },
  ]) {
    const current = board(), signed = []; change(current)
    await assert.rejects(() => readMaterial(root, c, { slug: 'demo', elementId: 'reference' }, { execute: runtime(current, signed) }), /измени|удалено|недоступно/)
    assert.deepEqual(signed, [])
  }
  const forged = structuredClone(c); forged.elements.blocks[1].image.hash = 'private-image'
  const signed = []
  await assert.rejects(() => readMaterial(root, forged, { slug: 'demo', elementId: 'reference' }, { execute: runtime(board(), signed) }), /недоступно/)
  assert.deepEqual(signed, [])
})
test('scope and object kind are validated before requesting a material', async t => {
  const root = repo(t), c = boardContext(board(), 'demo', 'main')
  const execute = () => { throw Error('must not execute') }
  await assert.rejects(() => readMaterial(root, c, { slug: 'other', elementId: 'reference' }, { execute }), /другому/)
  await assert.rejects(() => readMaterial(root, c, { slug: 'demo', elementId: 'note' }, { execute }), /Нужно изображение/)
})

test('board writes execute the public SDK once with saved revisions and literal JSON', async t => {
  const root = repo(t), context = boardContext(board(), 'demo', 'main')
  const text = 'Quote: "value"\n`$(unsafe)`'
  for (const [operation, changes, method] of [
    ['create', { blocks: [{ id: 'new', type: 'sticky', text }] }, 'createProcessBoardElements'],
    ['update', { blocks: [{ id: 'note', type: 'sticky', text }] }, 'updateProcessBoardElements'],
    ['delete', { blockIds: ['note'] }, 'deleteProcessBoardElements'],
  ]) {
    let calls = 0
    const result = await writeBoardElements(root, context, { slug: 'demo', operation, changes }, {
      execute: async (_, code) => {
        assert.ok(code.startsWith(`import { ${method} } from '@start/sdk'`))
        const run = new Function(method, 'ctx', `return (async () => {${code.replace(/^import .*\n/, '')}})()`)
        return run(async (_ctx, payload) => {
          calls++
          assert.deepEqual(payload, { ...changes, process: 'demo', branch: 'main', expectedRevision: 3, snapshotRevision: 2 })
          return { ok: true, revision: 4, changed: true }
        }, {})
      },
    })
    assert.equal(result.revision, 4)
    assert.equal(calls, 1)
  }
})

test('write scope, payload shape and hidden targets fail before execution; conflicts never retry', async t => {
  const root = repo(t), context = boardContext(board(), 'demo', 'main')
  const execute = () => { throw Error('must not execute') }
  for (const options of [
    { slug: 'other', operation: 'create', changes: { blocks: [{}] } },
    { slug: 'demo', operation: 'update', changes: { blocks: [{ id: 'hidden' }] } },
    { slug: 'demo', operation: 'delete', changes: { blockIds: ['hidden'] } },
    { slug: 'demo', operation: 'create', changes: { blocks: [], process: 'other' } },
    { slug: 'demo', operation: 'create', changes: { blocks: [] } },
    { slug: 'demo', operation: '__proto__', changes: { blocks: [{}] } },
  ]) await assert.rejects(() => writeBoardElements(root, context, options, { execute }), /Контекст|общего слоя|пакет|100|операция/)
  let calls = 0
  await assert.rejects(() => writeBoardElements(root, context, { slug: 'demo', operation: 'delete', changes: { blockIds: ['note'] } }, {
    execute: async () => { calls++; return { ok: false, reason: 'conflict' } },
  }), /conflict/)
  assert.equal(calls, 1)
})
