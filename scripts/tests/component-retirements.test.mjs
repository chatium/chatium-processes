import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { historicalComponents, retirementStatus } from '../lib/component-retirements.mjs'

test('removing a reviewed node requires owner decision and no live sources or subscriptions', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-retirement-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content) }
  const git = args => { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr) }
  git(['init', '-q']); git(['config', 'user.email', 'test@example.invalid']); git(['config', 'user.name', 'Test'])
  put('demo/process.yaml', 'nodes:\n  - id: old-page\n    kind: page\n    source: demo/old-page.ts\n')
  put('demo/old-page.ts', 'export const page = true\n')
  git(['add', '.']); git(['commit', '-qm', 'Old page'])
  const history = historicalComponents(root, 'demo')
  assert.deepEqual(history.nodes.map(node => node.id), ['old-page'])
  const map = { nodes: [], links: [] }
  let status = retirementStatus({ root, slug: 'demo', map, history })
  assert.equal(status.status, 'missing')
  const record = { version: 1, components: [{ id: 'old-page', kind: 'page', source: 'demo/old-page.ts',
    reason: 'Путь клиента изменён', replacement: null, ownerResponse: 'Да, убираем старую страницу',
    ownerMessageReference: 'conversation/message-1', decidedAt: '2026-10-07T10:00:00.000Z' }] }
  put('demo/retirements.json', JSON.stringify(record))
  status = retirementStatus({ root, slug: 'demo', map, history })
  assert.match(status.errors.join('\n'), /исходники/)
  rmSync(join(root, 'demo/old-page.ts'))
  const automation = 'demo/automations/old.automationConfig.json'
  put(automation, '{"target":"demo/old-page.ts"}')
  status = retirementStatus({ root, slug: 'demo', map, history, automationFiles: [join(root, automation)] })
  assert.match(status.errors.join('\n'), /автоматизация/)
  rmSync(join(root, automation))
  assert.equal(retirementStatus({ root, slug: 'demo', map, history }).status, 'ready')
})
