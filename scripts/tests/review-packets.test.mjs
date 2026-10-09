import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { markReviewPacket, reviewPacketCleanup } from '../lib/review-packets.mjs'

test('cleanup previews and removes only old generated packets for the selected account', t => {
  const base = mkdtempSync(join(tmpdir(), 'process-packets-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'account'), other = join(base, 'other'), external = join(base, 'external')
  for (const path of [root, other, external]) mkdirSync(path)
  const create = (name, account, managed = true, role = 'kb-review') => {
    const directory = join(external, name)
    mkdirSync(directory)
    writeFileSync(join(directory, 'packet.json'), '{}')
    writeFileSync(join(directory, 'prompt.md'), 'Read only')
    markReviewPacket({ directory, root: account, slug: 'demo', role, managed })
    return directory
  }
  const ours = create('kb-review-demo-a', root)
  const analytics = create('analytics-review-demo-a', root, true, 'analytics-review')
  const theirs = create('kb-review-demo-b', other)
  const manual = create('kb-review-demo-c', root, false)
  const recent = reviewPacketCleanup({ base: external, root, days: 30 })
  assert.deepEqual(recent.candidates, [])
  const now = Date.now() + 31 * 86_400_000
  const preview = reviewPacketCleanup({ base: external, root, days: 30, now })
  assert.deepEqual(preview.candidates, [analytics, ours])
  assert.equal(existsSync(ours), true)
  assert.equal(existsSync(analytics), true)
  const removed = reviewPacketCleanup({ base: external, root, days: 30, now, apply: true })
  assert.deepEqual(removed.removed, [analytics, ours])
  assert.equal(existsSync(ours), false)
  assert.equal(existsSync(analytics), false)
  assert.equal(existsSync(theirs), true)
  assert.equal(existsSync(manual), true)
})
