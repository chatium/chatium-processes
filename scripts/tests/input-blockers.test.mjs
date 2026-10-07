import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { inputBlockers } from '../lib/input-blockers.mjs'

test('deferred business question blocks only its stage and later stages', () => {
  const map = { needsInput: [{ title: 'Нужна ли ручная проверка заявки?', kind: 'question', blocks: ['test'] }] }
  assert.equal(inputBlockers(map, 'build').pending.length, 0)
  assert.equal(inputBlockers(map, 'test').pending.length, 1)
  assert.equal(inputBlockers(map, 'launch').pending.length, 1)
  map.needsInput[0].blocks = []
  assert.match(inputBlockers(map, 'build').errors.join(' '), /нужен blocks/)
  map.needsInput = [{ title: 'Подключить тестовый канал', kind: 'dependency', blocks: ['test'] }]
  assert.equal(inputBlockers(map, 'build').pending.length, 0)
  assert.equal(inputBlockers(map, 'test').pending.length, 1)
})

test('central check names the open question and stage', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-input-blockers-'))
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
  - id: form
    kind: page
    stage: Заявка
    title: Форма
    purpose: Получить заявку
    source: demo/pages/form/
needsInput:
  - title: Нужна ли ручная проверка заявки?
    kind: question
    blocks: [build]
`)
  const cli = fileURLToPath(new URL('../check.mjs', import.meta.url))
  const run = stage => spawnSync(process.execPath,
    [cli, 'demo', '--root', root, '--no-snapshot', '--task-stage', stage, '--json'], { encoding: 'utf8' })
  const design = JSON.parse(run('design').stdout).checks.find(check => check.id === 'owner.questions')
  assert.equal(design.ok, true)
  const build = JSON.parse(run('build').stdout).checks.find(check => check.id === 'owner.questions')
  assert.equal(build.ok, false)
  assert.match(build.errors.join(' '), /Нужна ли ручная проверка заявки/)
})
