import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commissionStatus, reviewRequirements } from '../lib/commission.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-commission-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'demo/agents'), { recursive: true })
  writeFileSync(join(root, 'demo/process.yaml'), `title: Demo
nodes:
  - { id: home, kind: page, source: demo/pages/home/ }
  - { id: welcome, kind: series, source: .mailings/storage/processes/demo/welcome/ }
links: []
`)
  return root
}

test('commission roster follows stage and process contents', t => {
  const root = fixture(t)
  const requirements = stage => reviewRequirements({ root, slug: 'demo', stage }).map(item => item.id)
  assert.deepEqual(requirements('design'), ['knowledge-design', 'architecture'])
  assert.deepEqual(requirements('build'), ['knowledge-build', 'architecture', 'implementation',
    'creative-home-spec', 'creative-welcome-spec'])
  assert.deepEqual(requirements('test'), ['knowledge-build', 'architecture', 'implementation',
    'creative-home-spec', 'creative-home-result', 'creative-welcome-spec', 'creative-welcome-result'])
  writeFileSync(join(root, 'demo/agents/helper.agent.json'), '{}')
  assert.ok(requirements('test').includes('agents'))
  assert.ok(!requirements('design').includes('agents'))
})

test('missing and invalid independent conclusions block the central status', t => {
  const root = fixture(t)
  const result = commissionStatus({ root, slug: 'demo', stage: 'design' })
  assert.equal(result.status, 'needs-work')
  assert.equal(result.requirements.length, 2)
  assert.ok(result.requirements.every(item => item.status !== 'ready'))
})
