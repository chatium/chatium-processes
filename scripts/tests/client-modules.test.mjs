import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateClientModules } from '../lib/client-modules.mjs'

const checkScript = fileURLToPath(new URL('../check.mjs', import.meta.url))

test('Vue shared import is rejected before runtime when @shared is missing', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-client-module-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, source) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
  }
  put('demo/pages/form/Form.vue', `<script setup lang="ts">\nimport { stableKey } from '../../shared/requestKey'\nimport { submitRoute } from '../../api/submit'\n</script>`)
  put('demo/shared/requestKey.ts', 'export const stableKey = () => "x"\n')
  put('demo/api/submit.ts', 'export const submitRoute = {}\n')
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', 'title: Demo\nnodes: []\nlinks: []\n')

  const before = validateClientModules({ root, slug: 'demo' })
  assert.equal(before.errors.length, 1)
  assert.match(before.errors[0], /shared\/requestKey\.ts.*@shared/)
  assert.doesNotMatch(before.errors[0], /api\/submit/)
  const run = () => JSON.parse(spawnSync(process.execPath,
    [checkScript, 'demo', '--root', root, '--no-snapshot', '--json'],
    { encoding: 'utf8', timeout: 15_000 }).stdout).checks.find(check => check.id === 'client.modules')
  assert.equal(run().ok, false)

  put('demo/shared/requestKey.ts', '// @shared\nexport const stableKey = () => "x"\n')
  assert.deepEqual(validateClientModules({ root, slug: 'demo' }).errors, [])
  assert.equal(run().ok, true)
})
