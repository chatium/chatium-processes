import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { assessAutomationState } from '../lib/automation-state.mjs'

const path = 'demo/automations/welcome.automationConfig.json'
const value = { automationId: 'stable-id', branchName: 'main', filePath: path,
  status: 'ready', error: null, enabled: false }

test('ready config and actual subscription are distinct checks', () => {
  assert.deepEqual(assessAutomationState([path], [{ path, value }], 'disabled'), [])
  assert.match(assessAutomationState([path], [{ path, value }], 'enabled')[0], /подписка выключена/)
  assert.deepEqual(assessAutomationState([path], [{ path, value: { ...value, enabled: true } }], 'enabled'), [])
})

test('old SDK, preview, invalid config and missing response cannot pass', () => {
  assert.match(assessAutomationState([path], [{ path, value: { ...value, enabled: undefined } }], 'disabled')[0], /SDK/)
  assert.match(assessAutomationState([path], [{ path, value: { ...value, branchName: 'process/demo' } }], 'disabled')[0], /ветку/)
  assert.match(assessAutomationState([path], [{ path, value: { ...value, status: 'invalid' } }], 'disabled')[0], /не готов/)
  assert.match(assessAutomationState([path], [{ path, value: { ...value, automationId: '' } }], 'disabled')[0], /постоянный ID/)
  assert.match(assessAutomationState([path], [], 'disabled')[0], /нет ответа/)
  assert.match(assessAutomationState([path], [{ path, error: 'plugin unavailable' }], 'disabled')[0], /unavailable/)
})

test('extra and duplicate SDK results do not hide the expected file', () => {
  const rows = [{ path, value }, { path, value }, { path: 'other', value }]
  const errors = assessAutomationState([path], rows, 'disabled')
  assert.equal(errors.length, 2)
  assert.ok(errors.some(error => error.includes('повторный')))
  assert.ok(errors.some(error => error.includes('посторонний')))
})
