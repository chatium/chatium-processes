import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { makeArchitectureReviewPacket } from '../lib/architecture-review.mjs'

test('architecture reviewer receives actual component specifications and notices their change', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-architecture-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Demo\norder: [overview.md]\n')
  put('.knowledge-base/processes/demo/overview.md', '---\ntitle: Процесс\n---\nКлиент выбирает услугу.\n')
  put('demo/PLAN.md', '# План\n\nКлиент выбирает услугу.\n')
  put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\n')
  put('demo/specs/site.yaml', 'version: 1\ntitle: Сайт\n')
  const before = makeArchitectureReviewPacket({ root, slug: 'demo' })
  assert.ok(before.files.some(file => file.path === 'demo/specs/site.yaml'))
  assert.ok(before.questions.some(question => question.id === 'site-and-services'))
  put('demo/specs/site.yaml', 'version: 1\ntitle: Другой сайт\n')
  const after = makeArchitectureReviewPacket({ root, slug: 'demo' })
  assert.notEqual(after.inputDigest, before.inputDigest)
})
