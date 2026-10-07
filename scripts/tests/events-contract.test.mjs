import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const run = (...flags) => {
    const result = spawnSync(process.execPath, [checkScript, 'demo', '--root', root, '--no-snapshot', '--json', ...flags],
      { encoding: 'utf8', timeout: 15_000 })
    assert.ok(result.stdout, result.stderr)
    return JSON.parse(result.stdout).checks
  }
  return { put, run }
}

const named = (checks, id) => checks.find(check => check.id === id)

test('event registry blocks reserved contact slot, numeric IDs, misplaced UTM and contact mapping', t => {
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
  assert.match(registry.errors.join('\n'), /контакт не хранят в payloadMapping/)
  assert.match(registry.errors.join('\n'), /ID должен быть строкой/)
  assert.match(registry.errors.join('\n'), /customer_contacts формируется/)
  assert.match(registry.errors.join('\n'), /utm_source/)
})

test('contact copied to a metric is rejected while contacts-only event passes', t => {
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
  assert.equal(named(checks, 'events.data').ok, false)
  assert.match(named(checks, 'events.data').errors.join('\n'), /контакт не хранят в action_param2/)
  f.put('demo/api/lead.ts', `const result = await captureCustomerEvent(ctx, {
  event: 'lead_created',
  contacts: [{ type: 'email', value: row.email }],
  metricEventData: { action_param1: row.id },
})
`)
  assert.equal(named(f.run(), 'events.data').ok, true)
})

test('declared event without a writer fails; real writer satisfies the contract', t => {
  const f = fixture(t)
  f.put('demo/specs/events.yaml', `events:
  - key: lead_created
    type: customerEvent
    name: Заявка
    description: Клиент оставил заявку
    payloadMapping: {}
`)
  const design = named(f.run('--task-stage', 'design'), 'events.used')
  assert.equal(design.ok, true)
  assert.match(design.warnings.join('\n'), /никто не пишет.*этапе сборки/)
  assert.match(named(f.run(), 'events.used').errors.join('\n'), /никто не пишет/)
  f.put('demo/api/lead.ts', `await captureCustomerEvent(ctx, {
  event: 'lead_created', contacts: [{ type: 'email', value: input.email }],
})
`)
  assert.equal(named(f.run(), 'events.used').ok, true)
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

test('hard-coded undefined UTM placeholders fail while actual submitted attribution passes', t => {
  const f = fixture(t)
  f.put('demo/api/lead.ts', `await captureCustomerEvent(ctx, {
  event: 'lead_created', contacts: [{ type: 'email', value: input.email }],
  customer: { utm: { source: input.utmSource, medium: undefined, campaign: undefined } },
})\n`)
  const bad = named(f.run(), 'events.data')
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join('\n'), /undefined-заглушками/)
  f.put('demo/api/lead.ts', `await captureCustomerEvent(ctx, {
  event: 'lead_created', contacts: [{ type: 'email', value: input.email }],
  customer: { ...(input.utmSource ? { utm: { source: input.utmSource } } : {}) },
})\n`)
  assert.equal(named(f.run(), 'events.data').ok, true)
})

test('event guide example never reintroduces undefined UTM placeholders', () => {
  const guide = readFileSync(fileURLToPath(new URL('../../formats/events-yaml.md', import.meta.url)), 'utf8')
  assert.doesNotMatch(guide, /utm\s*:\s*\{[^}]*\bundefined\b/)
  assert.match(guide, /input\.utmSource/)
  assert.match(guide, /Object\.keys\(utm\)\.length/)
})

test('commented event writers do not satisfy the declared-event contract', t => {
  const f = fixture(t)
  f.put('demo/specs/events.yaml', `events:
  - key: lead_created
    type: customerEvent
    name: Заявка
    description: Заявка
    payloadMapping: {}
`)
  f.put('demo/api/lead.ts', `// await captureCustomerEvent(ctx, { event: 'lead_created' })
const example = "captureCustomerEvent(ctx, { event: 'lead_created' })"
`)
  assert.match(named(f.run(), 'events.used').errors.join('\n'), /никто не пишет/)
})

test('nested metric values and compound contact identifiers cannot hide a contact', t => {
  const f = fixture(t)
  f.put('demo/specs/events.yaml', `events:
  - key: lead_created
    type: customerEvent
    name: Заявка
    description: Заявка
    payloadMapping:
      customerEmail: { title: Почта, fieldName: action_param1, type: string }
`)
  f.put('demo/api/lead.ts', `await captureCustomerEvent(ctx, {
  event: 'lead_created',
  contacts: [{ type: 'email', value: row.customerEmail }],
  metricEventData: { action_param1_mapstrstr: { category: 'x' }, action_param2: row.customerEmail },
})`)
  const checks = f.run()
  assert.match(named(checks, 'events.registry').errors.join('\n'), /контакт не хранят в payloadMapping/)
  assert.match(named(checks, 'events.data').errors.join('\n'), /контакт не хранят в action_param2/)
})

test('commented unsafe metric example does not block a valid event', t => {
  const f = fixture(t)
  f.put('demo/api/lead.ts', `// Не делай так: metricEventData: { action_param1: row.email }
const payload = { metricEventData: { action_param1: row.id } }
`)
  assert.equal(named(f.run(), 'events.data').ok, true)
})

test('analytics funnel rejects unrelated event identities and imaginary events', t => {
  const f = fixture(t)
  f.put('demo/specs/events.yaml', `events:
  - key: page_viewed
    type: workspaceEvent
    name: Просмотр
    description: Посещение страницы
    payloadMapping: {}
  - key: order_paid
    type: customerEvent
    name: Оплата
    description: Оплата заказа
    category: revenue
    payloadMapping:
      orderId: { title: Заказ, fieldName: action_param1, type: string }
`)
  f.put('demo/specs/analytics.yaml', `funnels:
  - id: purchase
    question: Сколько посетителей оплатили?
    identity: customer
    windowDays: 30
    steps: [page_viewed, order_paid]
    deduplicateBy: orderId
`)
  const bad = named(f.run(), 'analytics.spec')
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join('\n'), /page_viewed.*workspaceEvent/)
  f.put('demo/specs/analytics.yaml', `funnels:
  - id: purchase
    question: Сколько заявок оплатили?
    identity: customer
    windowDays: 30
    steps: [lead_created, order_paid]
    deduplicateBy: orderId
`)
  assert.match(named(f.run(), 'analytics.spec').errors.join('\n'), /lead_created.*не объявлено/)
})

test('analytics funnel requires order deduplication and accepts linked customer events', t => {
  const f = fixture(t)
  f.put('demo/specs/events.yaml', `events:
  - key: lead_created
    type: customerEvent
    name: Заявка
    description: Клиент оставил заявку
    payloadMapping:
      leadId: { title: Заявка, fieldName: action_param1, type: string }
  - key: order_paid
    type: customerEvent
    name: Оплата
    description: Оплата заказа
    category: revenue
    payloadMapping:
      orderId: { title: Заказ, fieldName: action_param1, type: string }
`)
  const analytics = dedup => `funnels:
  - id: purchase
    question: Какая доля заявок завершилась оплатой?
    identity: customer
    windowDays: 30
    steps: [lead_created, order_paid]
${dedup ? '    deduplicateBy: orderId\n' : ''}`
  f.put('demo/specs/analytics.yaml', analytics(false))
  assert.match(named(f.run(), 'analytics.spec').errors.join('\n'), /deduplicateBy/)
  f.put('demo/specs/analytics.yaml', analytics(true))
  assert.equal(named(f.run(), 'analytics.spec').ok, true)
})

test('custom analytics query needs a documented funnel contract', t => {
  const f = fixture(t)
  f.put('demo/specs/events.yaml', 'events: []\n')
  f.put('demo/api/report.ts', 'export async function report(ctx) { return queryAi(ctx, "select count() from events") }\n')
  assert.match(named(f.run(), 'analytics.spec').errors.join('\n'), /нужен specs\/analytics.yaml/)
  f.put('demo/specs/events.yaml', `events:
  - key: lead_created
    type: customerEvent
    name: Заявка
    description: Клиент оставил заявку
    payloadMapping: {}
`)
  f.put('demo/specs/analytics.yaml', `metrics:
  - id: lead_count
    question: Сколько было заявок?
    sourceEvents: [lead_created]
`)
  assert.equal(named(f.run(), 'analytics.spec').ok, true)
})
