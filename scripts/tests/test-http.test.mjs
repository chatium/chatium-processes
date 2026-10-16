import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

test('HTTP test boundary requires platform-confirmed branches and keeps credentials private', () => {
  const dir = mkdtempSync(join(tmpdir(), 'process-http-test-'))
  try {
    const mock = join(dir, 'fetch.mjs')
    writeFileSync(mock, `globalThis.fetch = async (_url, options) => {
      if (options.redirect !== 'error' || options.method !== 'POST') throw Error('Unsafe request');
      return {ok: process.env.HTTP_STATUS !== '403', status: 403,
        json: async () => JSON.parse(process.env.HTTP_BODY)};
    }`)
    const call = (body, status = '200') => spawnSync(process.execPath, ['--import', mock, fileURLToPath(new URL('../lib/test-http.mjs', import.meta.url))], {
      input: JSON.stringify({ url: 'https://account.test/control', cookie: 'apiToken=private-token', method: 'getProcessTestCapabilities', args: [], branch: 'main', plugins: { start: 'codex/test' } }),
      encoding: 'utf8', env: { ...process.env, HTTP_BODY: JSON.stringify(body), HTTP_STATUS: status },
    })
    const response = { protocol: 'process-testing-v1', preview: { app_start: { sourceGitVersionSpec: 'codex/test' } }, result: { operations: [] } }
    const success = call(response)
    assert.equal(success.status, 0, success.stderr)
    assert.deepEqual(JSON.parse(success.stdout), response.result)
    for (const result of [call({ ...response, preview: null }), call({}), call(response, '403')]) {
      assert.notEqual(result.status, 0)
      assert.equal(result.stdout, '')
      assert.doesNotMatch(result.stderr, /private-token|apiToken/)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
