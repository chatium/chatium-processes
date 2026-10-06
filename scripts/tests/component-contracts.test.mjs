import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { validateComponentContracts } from '../lib/component-contracts.mjs'

const map = { nodes: [
  { id: 'home', kind: 'page', source: 'demo/pages/home/' },
  { id: 'catalog', kind: 'page', source: 'demo/pages/catalog/' },
  { id: 'availability', kind: 'external', source: 'demo/api/availability.ts', serviceRef: 'availability' },
] }

test('site contract catches omitted required page and filter without a field', () => {
  const pagesOnly = { nodes: map.nodes.filter(node => node.kind === 'page') }
  const site = { version: 1, title: 'Запись', businessModel: 'Услуги',
    requiredRoles: ['home', 'catalog', 'detail'], entityFields: ['serviceId', 'category'],
    pages: [
      { nodeId: 'home', role: 'home', route: '/', purpose: 'Начать путь', filters: [] },
      { nodeId: 'catalog', role: 'catalog', route: '/catalog', purpose: 'Выбрать услугу', filters: ['unknown'] },
    ] }
  const errors = validateComponentContracts({ map: pagesOnly, site }).errors.join('\n')
  assert.match(errors, /роль detail/)
  assert.match(errors, /фильтр unknown/)
  site.requiredRoles = ['home', 'catalog']
  site.pages[1].filters = ['category']
  assert.deepEqual(validateComponentContracts({ map: pagesOnly, site }).errors, [])
})

test('service contract requires access, repeat behavior and failure outcomes', () => {
  const services = { version: 1, services: [{ id: 'availability', nodeId: 'availability',
    input: 'ID услуги и дата', output: 'Доступные слоты', access: '', repeat: '', errors: [] }] }
  const errors = validateComponentContracts({ map, services }).errors.join('\n')
  assert.match(errors, /access/)
  assert.match(errors, /repeat/)
  assert.match(errors, /errors/)
  services.services[0] = { ...services.services[0], access: 'Только сотрудник аккаунта',
    repeat: 'Повторный запрос только читает слоты', errors: ['Услуга не найдена', 'Нет свободных слотов'] }
  assert.deepEqual(validateComponentContracts({ map, services }).errors, [])
  const missing = validateComponentContracts({ map }).errors.join('\n')
  assert.match(missing, /services.yaml/)
})

test('central check reports a missing service contract', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-component-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content)
  }
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', `title: Demo
stages: [Запись]
knowledge: .knowledge-base/processes/demo
nodes:
  - id: availability
    kind: external
    stage: Запись
    title: Свободное время
    purpose: Проверить слот
    source: demo/api/availability.ts
    serviceRef: availability
links: []
`)
  const cli = fileURLToPath(new URL('../check.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'demo', '--root', root, '--no-snapshot', '--json'], { encoding: 'utf8' })
  const check = JSON.parse(result.stdout).checks.find(item => item.id === 'components.contracts')
  assert.equal(check.ok, false)
  assert.match(check.errors.join('\n'), /services.yaml/)
})
