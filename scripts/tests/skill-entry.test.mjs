import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = readFileSync(fileURLToPath(new URL('../../SKILL.md', import.meta.url)), 'utf8')
const workflow = readFileSync(fileURLToPath(new URL('../../WORKFLOW.md', import.meta.url)), 'utf8')
const environment = readFileSync(fileURLToPath(new URL('../../build/environment.md', import.meta.url)), 'utf8')
const packageInfo = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'))

test('installed skill entry routes complex processes without claiming standalone work', () => {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(entry)?.[1]
  assert.ok(frontmatter, 'SKILL.md needs frontmatter')
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1] || ''
  for (const term of ['бизнес-процесс', ' воронк', 'автоворонк', 'многоэтапн'])
    assert.ok(description.toLowerCase().includes(term), `description must mention ${term}`)
  for (const term of ['рассылка', 'лендинг', 'автоматизация'])
    assert.ok(!description.toLowerCase().includes(term), `description must not route standalone ${term}`)
  const body = entry.slice(frontmatter.length + 9)
  assert.ok(body.trim().split(/\s+/).length <= 800, 'SKILL.md must remain a short task router')
  assert.match(body, /открывай нужный раздел по текущему этапу/)
  assert.match(body, /Если масштаб неясен, задай один короткий вопрос до создания процесса/)
  assert.match(workflow, /Не достраивай воронку без поручения/)
  assert.doesNotMatch(entry, /\/Users\/|\.local-context\/|start\.chatium\.ru/i)
})

test('documented and tested Node versions match the Chatium CLI minimum', () => {
  const required = Number(/^>=(\d+)(?:\.\d+)*$/.exec(packageInfo.engines.node)?.[1])
  const documented = Number(/Нужны Node\.js (\d+) или новее/.exec(environment)?.[1])
  const running = Number(process.versions.node.split('.')[0])
  assert.ok(Number.isInteger(required) && required >= 22, 'Chatium CLI requires Node 22 or newer')
  assert.equal(documented, required, 'installation guide must not allow an older runtime')
  assert.ok(running >= required, `tests must run on Node ${required} or newer`)
})
