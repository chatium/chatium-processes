import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { searchCatalog } from '../lib/catalog-search.mjs'

const styles = JSON.parse(readFileSync(new URL('../../creative/catalog/styles.json', import.meta.url))).styles

test('short overview lists every shipped style; Russian education queries also find English entries', () => {
  assert.equal(searchCatalog(styles).length, Object.keys(styles).length)
  for (const query of ['школа', 'школы', 'образование', 'обучение', 'школа английского', 'education']) {
    const ids = searchCatalog(styles, query).map(item => item.id)
    for (const id of ['academic', 'friendly_illustrated', 'paper_craft_layers']) assert.ok(ids.includes(id), `${query}: ${id}`)
  }
})

test('literal matches rank above related topics; mixed catalog names, descriptions and word forms are searchable', () => {
  const entries = {
    related: { title: 'Learning journal', suitedFor: 'education' },
    direct: { name: 'Школа', description: 'Съёмка предметов' },
    other: { title: 'Bank', suitedFor: 'finance' },
  }
  assert.deepEqual(searchCatalog(entries, 'ШКОЛА').map(item => item.id), ['direct', 'related'])
  assert.deepEqual(searchCatalog(entries, 'съемка'), [{ id: 'direct', title: 'Школа' }])
  assert.deepEqual(searchCatalog(entries, 'банковский').map(item => item.id), ['other'])
  assert.deepEqual(searchCatalog(entries, 'несуществующее'), [])
  assert.equal(searchCatalog(entries, 'для').length, 3)
})

test('catalog CLI keeps full style lookup and exposes the expanded search', () => {
  const cli = fileURLToPath(new URL('../catalog.mjs', import.meta.url))
  const run = args => {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  assert.deepEqual(run(['styles', 'academic']), { id: 'academic', ...styles.academic })
  const result = run(['styles', '--search', 'школа английского'])
  assert.ok(result.items.some(item => item.id === 'academic'))
  assert.equal(result.count, result.items.length)
})
