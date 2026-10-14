import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('a page-shaped file without an exported GET route cannot pass build check', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-page-route-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', `title: Demo\nknowledge: .knowledge-base/processes/demo\nstages: [Entry]\nnodes:\n  - id: privacy\n    kind: page\n    stage: Entry\n    title: Privacy\n    purpose: Show policy\n    source: privacy.tsx\n`)
  const path = 'privacy.tsx'
  const run = () => {
    const cli = fileURLToPath(new URL('../check.mjs', import.meta.url))
    const response = spawnSync(process.execPath, [cli, 'demo', '--root', root, '--no-snapshot', '--task-stage', 'build', '--json'], { encoding: 'utf8' })
    return JSON.parse(response.stdout).checks.find(check => check.id === 'map.sources')
  }
  put(path, 'export default async function Page(ctx) { return ctx.resp.html("ok") }\n')
  assert.match(run().errors.join(' '), /не экспортирует маршрут app\.get/)
  put(path, "export const privacyRoute = app.get('/other', async ctx => ctx.resp.html('ok'))\n")
  assert.match(run().errors.join(' '), /не экспортирует маршрут app\.get/)
  put(path, "// export const fake = app.get('/')\nexport const privacyRoute = app.get('/', async ctx => ctx.resp.html('ok'))\n")
  assert.deepEqual(run().errors, [])
})

test('two HTTP route definitions in one file fail the deterministic check', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-route-cardinality-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', 'title: Demo\nnodes: []\nlinks: []\n')
  const path = 'demo/api/notice.ts'
  const routeCheck = () => {
    const cli = fileURLToPath(new URL('../check.mjs', import.meta.url))
    const response = spawnSync(process.execPath, [cli, 'demo', '--root', root, '--no-snapshot', '--json'], { encoding: 'utf8' })
    return JSON.parse(response.stdout).checks.find(check => check.id === 'route.files')
  }
  put(path, "// app.delete('/')\nexport const read = app.get('/')\nexport const write = app.post('/')\n")
  assert.match(routeCheck().errors.join(' '), /demo\/api\/notice\.ts: объявлено 2 маршрута/)
  put(path, "// app.delete('/')\nconst example = \"app.post('/')\"\nclient.app.post('/')\nexport const read = app.get('/')\n")
  assert.deepEqual(routeCheck().errors, [])
})
