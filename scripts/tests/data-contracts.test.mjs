import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateDataContracts } from '../lib/data-contracts.mjs'
import { makeArchitectureReviewPacket } from '../lib/architecture-review.mjs'

const map = { nodes: [{ id: 'requests', kind: 'table', source: 'demo/tables/requests.table.ts' }] }
const contract = () => ({ version: 1, tables: [{ id: 'requests', source: 'demo/tables/requests.table.ts',
  purpose: 'Сохранить заявку', owner: 'Менеджер', readers: ['Менеджер', 'Администратор'],
  identity: { key: 'requestId', rule: 'Повтор не создаёт вторую заявку' },
  fields: [{ name: 'requestId', type: 'string', purpose: 'Устойчивый ID' }] }],
retention: { decided: true, current: 'Удаляем по запросу клиента' } })

test('table inventory rejects missing ownership, phantom tables and undecided launch retention', () => {
  const data = contract()
  assert.deepEqual(validateDataContracts({ map, data, stage: 'launch' }).errors, [])
  data.tables[0].owner = ''
  assert.match(validateDataContracts({ map, data }).errors.join(' '), /owner/)
  data.tables[0].owner = 'Менеджер'
  data.tables[0].source = 'demo/tables/new-empty.table.ts'
  assert.match(validateDataContracts({ map, data }).errors.join(' '), /тем же source/)
  data.tables[0].source = map.nodes[0].source
  data.tables.push({ ...data.tables[0], id: 'handoffs', source: 'demo/tables/handoffs.table.ts' })
  assert.match(validateDataContracts({ map, data }).errors.join(' '), /таблица handoffs должна иметь узел карты/)
  data.tables.pop()
  data.retention.decided = false
  assert.equal(validateDataContracts({ map, data, stage: 'build' }).errors.length, 0)
  assert.match(validateDataContracts({ map, data, stage: 'launch' }).errors.join(' '), /retention.decided=false/)
})

test('central launch check and architecture packet see table lifecycle', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-data-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', `title: Demo
knowledge: .knowledge-base/processes/demo
stages: [Заявка]
nodes:
  - id: requests
    kind: table
    stage: Заявка
    title: Заявки
    purpose: Сохранить заявку
    source: demo/tables/requests.table.ts
`)
  const cli = fileURLToPath(new URL('../check.mjs', import.meta.url))
  const run = () => {
    const response = spawnSync(process.execPath,
      [cli, 'demo', '--root', root, '--no-snapshot', '--task-stage', 'launch', '--json'], { encoding: 'utf8' })
    return JSON.parse(response.stdout).checks.find(check => check.id === 'data.contracts')
  }
  assert.match(run().errors.join(' '), /нужен specs\/data.yaml/)
  put('demo/specs/data.yaml', JSON.stringify(contract()))
  assert.equal(run().ok, true)
  const packet = makeArchitectureReviewPacket({ root, slug: 'demo' })
  assert.ok(packet.files.some(file => file.path === 'demo/specs/data.yaml'))
})
