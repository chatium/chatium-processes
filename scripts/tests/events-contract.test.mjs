import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkScript = fileURLToPath(new URL('../check.mjs', import.meta.url))

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-events-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  put('demo/process.yaml', 'title: Demo\nnodes: []\nlinks: []\n')
  const run = () => {
    const result = spawnSync(process.execPath, [checkScript, 'demo', '--root', root, '--no-snapshot', '--json'],
      { encoding: 'utf8', timeout: 15_000 })
    assert.ok(result.stdout, result.stderr)
    return JSON.parse(result.stdout).checks
  }
  return { put, run }
}

const named = (checks, id) => checks.find(check => check.id === id)

test('event registry blocks reserved contact slot, numeric IDs and misplaced UTM, and warns on contact mapping', t => {
  const f = fixture(t)
  f.put('demo/specs/events.yaml', `events:
  - key: lead_created
    type: customerEvent
    name: Заявка
    description: Клиент оставил заявку
    payloadMapping:
      email: { title: Почта, fieldName: action_param1, type: string }
      leadId: { title: ID заявки, fieldName: action_param1_int, type: number }
      contacts: { title: Контакты, fieldName: customer_contacts, type: array }
      utmSource: { title: Источник, fieldName: action_param2, type: string }
`)
  const registry = named(f.run(), 'events.registry')
  assert.equal(registry.ok, false)
  assert.match(registry.warnings.join('\n'), /дублирование контакта в payloadMapping/)
  assert.match(registry.errors.join('\n'), /ID должен быть строкой/)
  assert.match(registry.errors.join('\n'), /customer_contacts формируется/)
  assert.match(registry.errors.join('\n'), /utm_source/)
})

test('valid business mapping passes event contract; obvious metric contact duplication warns', t => {
  const f = fixture(t)
  f.put('demo/specs/events.yaml', `events:
  - key: lead_created
    type: customerEvent
    name: Заявка
    description: Клиент оставил заявку
    payloadMapping:
      leadId: { title: ID заявки, fieldName: action_param1, type: string }
      amount: { title: Сумма, fieldName: action_param1_float, type: number }
      utmSource: { title: Источник, fieldName: utm_source, type: string }
`)
  f.put('demo/api/lead.ts', `const result = await captureCustomerEvent(ctx, {
  event: 'lead_created',
  contacts: [{ type: 'email', value: row.email }],
  metricEventData: { action_param1: row.id, action_param2: row.email },
})
`)
  const checks = f.run()
  assert.equal(named(checks, 'events.registry').ok, true)
  assert.equal(named(checks, 'events.data').ok, true)
  assert.match(named(checks, 'events.data').warnings.join('\n'), /дублирование контакта/)
})

test('metricEventData cannot override CRM-generated customer_contacts', t => {
  const f = fixture(t)
  f.put('demo/specs/events.yaml', 'events: []\n')
  f.put('demo/api/lead.ts', `await captureCustomerEvent(ctx, {
  event: 'lead_created',
  contacts: [{ type: 'email', value: row.email }],
  metricEventData: { customer_contacts: [{ type: 'email', value: row.email }] },
})
`)
  const data = named(f.run(), 'events.data')
  assert.equal(data.ok, false)
  assert.match(data.errors.join('\n'), /CRM формирует его из contacts/)
})
