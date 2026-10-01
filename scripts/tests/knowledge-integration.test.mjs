import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeReviewPacket, recordReview } from '../lib/knowledge-review.mjs'

const script = name => fileURLToPath(new URL(`../${name}.mjs`, import.meta.url))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-integration-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nstages: [Request]\nnodes: []\n')
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'order: [overview.md]\n')
  const article = '.knowledge-base/processes/demo/overview.md'
  const quote = 'A manual service without payments.'
  put(article, `---\ntitle: Service\n---\n${quote}\n`)
  const plan = launch => put('demo/PLAN.md', `# Demo\n## Задачи\n- [x] T1 Сделать форму\n## Согласования\n- План: согласован\n- Запуск: ${launch ? 'согласован' : 'не согласован'}\n`)
  plan(false)
  const run = (name, args) => spawnSync(process.execPath, [script(name), 'demo', '--root', root, ...args],
    { encoding: 'utf8', timeout: 10_000 })
  const check = args => JSON.parse(run('check', ['--no-snapshot', '--json', ...args]).stdout)
  const record = stage => {
    const packet = makeReviewPacket({ root, slug: 'demo', stage })
    // Unit-only answers test integration of the gates, not marketing adequacy.
    const report = { version: 1, process: 'demo', stage, inputDigest: packet.inputDigest,
      inspectedFiles: packet.files.map(f => f.path),
      inspectedReferences: [...packet.referenceLibrary.required],
      answers: packet.questions.map(q => ({ id: q.id, status: 'covered', reason: 'Unit-only structural fixture.', evidence: [{ path: article, quote }] })) }
    recordReview({ root, slug: 'demo', stage, packet, report, agentReference: 'unit-test:integration' })
  }
  return { root, put, plan, run, check, record }
}
const review = result => result.checks.find(c => c.id === 'knowledge.review')

test('check includes static and independent gates and detects staleness without network', t => {
  const f = fixture(t)
  let result = f.check([])
  assert.equal(result.checks.filter(c => c.id.startsWith('kb-')).length, 4)
  assert.equal(review(result).ok, false)
  assert.match(review(result).errors.join(' '), /Нет независимого/)
  assert.equal(result.snapshot.skipped, true)
  f.record('build')
  assert.equal(review(f.check([])).ok, true)
  f.put('demo/PLAN.md', '# Changed plan\n')
  assert.equal(review(f.check([])).ok, false)
  assert.match(review(f.check([])).errors.join(' '), /изменились/)
})

test('launch approval chooses launch gate, explicit design remains possible without skipping technical checks', t => {
  const f = fixture(t)
  f.plan(true)
  f.record('build')
  assert.match(review(f.check([])).title, /launch/)
  assert.equal(review(f.check([])).ok, false)
  f.record('launch')
  assert.equal(review(f.check([])).ok, true)
  f.record('design')
  const design = f.check(['--knowledge-stage', 'design'])
  assert.equal(review(design).ok, true)
  assert.ok(design.checks.some(c => c.id === 'map.sources'))
  assert.equal(f.run('check', ['--no-snapshot', '--knowledge-stage', 'invalid']).status, 2)
})

test('offline context reports missing, ready and stale knowledge independently of board access', t => {
  const f = fixture(t)
  const context = () => f.run('context', ['--offline', '--no-cards']).stdout
  assert.match(context(), /Независимое ревью \(build\): missing/)
  f.record('build')
  assert.match(context(), /Независимое ревью \(build\): ready/)
  f.put('demo/PLAN.md', '# Changed\n')
  assert.match(context(), /Независимое ревью \(build\): stale/)
  f.plan(true)
  const output = context()
  assert.match(output, /Независимое ревью \(launch\): missing/)
  assert.doesNotMatch(output, /7–8\. Запущен/)
})
