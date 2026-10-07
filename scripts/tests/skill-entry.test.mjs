import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const entry = readFileSync(fileURLToPath(new URL('../../SKILL.md', import.meta.url)), 'utf8')

test('installed skill entry remains short and discoverable for business requests', () => {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(entry)?.[1]
  assert.ok(frontmatter, 'SKILL.md needs frontmatter')
  const description = /^description:\s*(.+)$/m.exec(frontmatter)?.[1] || ''
  for (const term of ['бизнес-процесс', 'воронка', 'автоворонка', 'рассылка', 'лендинг'])
    assert.ok(description.toLowerCase().includes(term), `description must mention ${term}`)
  const body = entry.slice(frontmatter.length + 9)
  assert.ok(body.trim().split(/\s+/).length <= 800, 'SKILL.md must remain a short task router')
  assert.match(body, /открывай нужный раздел по текущему этапу/)
  assert.doesNotMatch(entry, /\/Users\/|\.local-context\/|start\.chatium\.ru/i)
})
