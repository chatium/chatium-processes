import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { externalUrlForNode } from '../lib/external-url.mjs'
import { buildSnapshot } from '../lib/snapshot.mjs'

const externalUrl = 'https://mail.example.com/campaigns/1?view=content#letter'
const node = { id: 'external-mailing', kind: 'external', stage: 'Step', title: 'External mailing', purpose: 'Open the saved campaign', source: 'demo/integration.ts', externalUrl }
const map = { title: 'Demo', knowledge: '.knowledge-base/processes/demo/', stages: ['Step'], nodes: [node], links: [] }
const invalid = ['', null, 42, '/relative', '//mail.example.com', 'javascript:alert(1)', 'data:text/html,test', 'ftp://mail.example.com',
  'https://user:password@mail.example.com', 'https://mail.example.com/a b', 'https://mail.example.com/\npath', 'https://mail.example.com/\\path', 'https://mail.example.com/'+'x'.repeat(2048)]

test('externalUrl is optional and only accepts absolute HTTP(S) links on external nodes', () => {
  assert.equal(externalUrlForNode(node), externalUrl)
  assert.equal(externalUrlForNode({ ...node, externalUrl: 'http://mail.example.com/campaigns/1' }), 'http://mail.example.com/campaigns/1')
  assert.equal(externalUrlForNode({ ...node, externalUrl: undefined }), undefined)
  assert.throws(() => externalUrlForNode({ ...node, kind: 'series' }), /externalUrl/)
  for (const externalUrl of invalid) assert.throws(() => externalUrlForNode({ ...node, externalUrl }), /externalUrl/)
})

test('snapshot keeps the URL separately from source and does not certify construction', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-external-link-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const build = map => buildSnapshot({root, slug: 'demo', map, checks: [], branch: 'main', commit: 'a'.repeat(40)})
  const saved = build(map).nodes[0]
  assert.equal(saved.externalUrl, externalUrl)
  assert.equal(saved.source, node.source)
  assert.deepEqual(saved.build, build({...map, nodes:[{...node,externalUrl:undefined}]}).nodes[0].build)
  assert.throws(() => build({...map,nodes:[{...node,externalUrl:'javascript:alert(1)'}]}), /externalUrl/)
})

test('map check validates externalUrl before publication without requiring a service registry', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-external-map-'))
  t.after(() => rmSync(root, {recursive: true, force: true}))
  const put = (path, value) => {mkdirSync(dirname(join(root,path)),{recursive:true});writeFileSync(join(root,path),value)}
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put(node.source, 'export const integration = true\n')
  const check = node => {
    put('demo/process.yaml', JSON.stringify({...map,nodes:[node]}))
    const result = spawnSync(process.execPath,[fileURLToPath(new URL('../check.mjs',import.meta.url)),'demo','--root',root,'--no-snapshot','--json'],{encoding:'utf8',timeout:15000})
    assert.ok(result.stdout.startsWith('{'), result.stderr)
    return JSON.parse(result.stdout).checks.find(check => check.id === 'map')
  }
  assert.equal(check(node).ok,true)
  assert.match(check({...node,externalUrl:'javascript:alert(1)'}).errors.join('\n'), /externalUrl/)
  assert.match(check({...node,kind:'series'}).errors.join('\n'), /externalUrl/)
})
