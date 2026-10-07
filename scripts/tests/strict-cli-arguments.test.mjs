import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = name => fileURLToPath(new URL(`../${name}.mjs`, import.meta.url))

test('documented commands reserve 0 for help and 2 for invalid invocation', () => {
  for (const name of ['scaffold', 'kb-check', 'kb-review', 'code-review', 'reviews',
    'owner-decisions', 'agent-review', 'agents-runtime', 'board', 'board-notes',
    'tasks', 'creative', 'creative-review', 'context', 'check', 'catalog', 'review-packets']) {
    const help = spawnSync(process.execPath, [script(name), '--help'], { encoding: 'utf8' })
    assert.equal(help.status, 0, `${name} --help: ${help.stderr}`)
    const invalid = spawnSync(process.execPath, [script(name), 'definitely-unknown', 'demo'],
      { encoding: 'utf8' })
    assert.equal(invalid.status, 2, `${name}: ${invalid.stderr || invalid.stdout}`)
  }
})

test('process commands reject unknown, valued boolean, missing and duplicate options before doing work', t => {
  const root = mkdtempSync(join(tmpdir(), 'process-strict-args-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const cases = [
    ['scaffold', ['demo', '--root', root, '--no-snapshoto'], /--no-snapshoto/],
    ['scaffold', ['demo', '--root', root, '--dry-run=false'], /--dry-run/],
    ['scaffold', ['demo', '--root', root, '--title'], /--title/],
    ['scaffold', ['demo', '--root', root, '--root', root], /--root/],
    ['scaffold', ['demo', 'extra', '--root', root], /аргумент/],
    ['tasks', ['create', 'demo', 'W001', '--root', root, '--file', 'task.json', '--unknown'], /--unknown/],
    ['creative', ['compile', 'demo', 'page', '--root', root, '--unknown'], /--unknown/],
    ['creative-review', ['record', 'demo', 'page', '--root', root, '--packte', 'packet.json'], /--packte/],
    ['board', ['respond-note', 'demo', '--root', root, '--stauts', 'done'], /--stauts/],
    ['board-notes', ['respond', 'demo', '--root', root, '--stauts', 'done'], /--stauts/],
    ['review-packets', ['cleanup', '--root', root, '--apply=false'], /--apply/],
    ['check', ['demo', '--root', root, '--publish-snapshot', '--publish-snapshot'], /--publish-snapshot/],
    ['owner-decisions', ['record', 'demo', '--root', root, '--kind', 'plan', '--response', 'one.json', '--response', 'two.json'], /--response/],
    ['reviews', ['record', 'demo', '--root', root, '--role', 'methodology', '--role', 'implementation'], /--role/],
    ['kb-review', ['record', 'demo', '--root', root, '--json=false'], /--json/],
    ['code-review', ['record', 'demo', '--root', root, '--report', 'one.json', '--report', 'two.json'], /--report/],
    ['agent-review', ['record', 'demo', '--root', root, '--agent', 'one', '--agent', 'two'], /--agent/],
    ['context', ['demo', '--root', root, '--offline=false'], /--offline/],
    ['kb-check', ['demo', '--root', root, '--json=false'], /--json/],
    ['agents-runtime', ['demo', '--root', root, '--json=false'], /--json/],
    ['agents-runtime', ['demo', '--root', root, '--record=false'], /--record/],
  ]
  for (const [name, args, message] of cases) {
    const result = spawnSync(process.execPath, [script(name), ...args], { encoding: 'utf8' })
    assert.equal(result.status, 2, `${name} ${args.join(' ')}: ${result.stderr || result.stdout}`)
    assert.match(result.stderr, message)
    assert.deepEqual(readdirSync(root), [])
  }
})
