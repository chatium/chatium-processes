import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { messageDeliverySmokeStatus } from '../lib/message-delivery-smoke.mjs'

test('launch evidence covers every channel, variant and promised media on the tested template', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-delivery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = '.mailings/storage/processes/demo/followup/01.message.yaml'
  const variant = '.mailings/storage/processes/demo/followup/01.v2.message.yaml'
  const put = (name, value) => {
    mkdirSync(dirname(join(root, name)), { recursive: true })
    writeFileSync(join(root, name), typeof value === 'string' ? value : JSON.stringify(value))
  }
  const source = 'title: Followup\nplain: Hello\nprocessDeliveryChannelIds: [email-1, telegram-1]\n'
  put(path, source)
  put(variant, source)
  const workspace = JSON.stringify({ config: { senderChannels: ['email-1', 'telegram-1'], mailings: { testOnly: true } } })
  const sha256 = data => createHash('sha256').update(data).digest('hex')
  const run = messagePath => ({ path: messagePath, messageSha256: sha256(source), branch: 'main',
    testedCommit: 'a'.repeat(40), testedAt: '2026-10-07T10:00:00.000Z', testOnly: true,
    testContacts: [{ type: 'email', value: 'test@example.com' }, { type: 'telegram', value: 'test-chat' }],
    executionId: 'execution-1', variantUsed: { filePath: messagePath },
    openedMediaByChannel: { 'telegram-1': ['guide'] },
    channelResults: [{ channelId: 'email-1', success: true }, { channelId: 'telegram-1', success: true }] })
  const data = { version: 1, channelCatalog: [
    { id: 'email-1', type: 'email', active: true },
    { id: 'telegram-1', type: 'telegram', active: true },
  ], runs: [run(path)] }
  const expectations = [path, variant].map(messagePath => ({ path: messagePath,
    channelIds: ['email-1', 'telegram-1'], formatById: { 'email-1': 'email', 'telegram-1': 'messenger' },
    mediaByChannel: { 'telegram-1': ['guide'] } }))
  const check = () => messageDeliverySmokeStatus({ root, slug: 'demo', expectations,
    ancestor: () => true, readAtCommit: (_revision, name) => name === 'demo/.workspace.json'
      ? Buffer.from(workspace) : readFileSync(join(root, name)) })
  put('demo/tests/message-delivery.json', data)
  assert.match(check().errors.join('\n'), /01\.v2\.message\.yaml: нет тестовой доставки/)
  data.runs.push(run(variant))
  data.runs[0].channelResults[1].success = false
  put('demo/tests/message-delivery.json', data)
  assert.match(check().errors.join('\n'), /telegram-1/)
  data.runs[0].channelResults[1].success = true
  data.runs[1].openedMediaByChannel['telegram-1'] = []
  put('demo/tests/message-delivery.json', data)
  assert.match(check().errors.join('\n'), /медиа guide/)
  data.runs[1].openedMediaByChannel['telegram-1'] = ['guide']
  put('demo/tests/message-delivery.json', data)
  assert.deepEqual(check().errors, [])
  data.channelCatalog[1].type = 'email'
  put('demo/tests/message-delivery.json', data)
  assert.match(check().errors.join('\n'), /telegram-1 не подтверждён как активный messenger/)
  data.channelCatalog[1].type = 'telegram'
  put(path, source + '# changed\n')
  assert.match(check().errors.join('\n'), /шаблон изменился/)
})
