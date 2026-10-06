import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { parseYaml } from '../lib/yaml.mjs'
import { collectKnowledge } from '../lib/knowledge.mjs'

const cli = fileURLToPath(new URL('../scaffold.mjs', import.meta.url))
const contextCli = fileURLToPath(new URL('../context.mjs', import.meta.url))
const knowledge = '.knowledge-base/processes/demo'
const allTopics = ['audience', 'offer', 'journey', 'pages', 'series', 'operations']

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-scaffold-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const run = (...args) => spawnSync(process.execPath, [cli, 'demo', '--root', root, '--title', 'Пробное: занятие', ...args], { encoding: 'utf8' })
  const read = path => readFileSync(join(root, path), 'utf8')
  const yaml = path => parseYaml(read(path))
  const snapshot = () => {
    const files = {}
    function visit(dir) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) visit(path)
        else files[relative(root, path)] = readFileSync(path, 'utf8')
      }
    }
    visit(root)
    return files
  }
  return { root, put, run, read, yaml, snapshot }
}

test('default scaffold creates only overview and no shared business articles', t => {
  const f = fixture(t)
  const run = f.run()
  assert.equal(run.status, 0, run.stderr || run.stdout)
  assert.deepEqual(readdirSync(join(f.root, knowledge)).sort(), ['.knowledge.yml', 'overview.md'])
  assert.deepEqual(readdirSync(join(f.root, '.knowledge-base/business')), ['.knowledge.yml'])
  assert.deepEqual(f.yaml(`${knowledge}/.knowledge.yml`), { title: 'Пробное: занятие', order: ['overview.md'] })
  assert.match(f.read(`${knowledge}/overview.md`), /Пробное: занятие/)
  assert.doesNotMatch(f.read(`${knowledge}/overview.md`), /__PROCESS__|__TITLE__/)
})

test('a newly scaffolded TODO article keeps context at the interview stage', t => {
  const f = fixture(t)
  assert.equal(f.run().status, 0)
  const context = spawnSync(process.execPath, [contextCli, 'demo', '--root', f.root, '--offline', '--no-cards'], { encoding: 'utf8' })
  assert.equal(context.status, 0, context.stderr)
  assert.match(context.stdout, /1\. Знания/)
  assert.doesNotMatch(context.stdout, /Этап: 2\. План/)
})

test('selected topics are created in requested order with no duplicate entries', t => {
  const f = fixture(t)
  const run = f.run('--topics', 'journey,audience, journey,offer,operations')
  assert.equal(run.status, 0, run.stderr || run.stdout)
  assert.deepEqual(f.yaml(`${knowledge}/.knowledge.yml`).order, ['overview.md', 'journey.md', 'audience.md', 'offer.md', 'operations.md'])
  for (const name of ['overview', 'journey', 'audience', 'offer', 'operations']) {
    const source = f.read(`${knowledge}/${name}.md`)
    assert.match(source, /^---\ntitle: .+\n/)
    assert.doesNotMatch(source, /__PROCESS__|__TITLE__/)
  }
  assert.equal(existsSync(join(f.root, knowledge, 'pages.md')), false)
  assert.equal(existsSync(join(f.root, knowledge, 'series.md')), false)
})

test('repeat and extension preserve articles, metadata fields and prior order', t => {
  const f = fixture(t)
  f.put('.knowledge-base/.knowledge.yml', 'order: [custom, processes]\ncustomField: keep\n')
  f.put('.knowledge-base/processes/.knowledge.yml', 'title: Существующие процессы\norder: [previous]\nicon: 🌿\n')
  f.put(`${knowledge}/.knowledge.yml`, 'title: Авторское имя\ndescription: Сохранить описание\norder: [custom.md, audience.md]\nisNew: true\n')
  const existing = '---\ntitle: Наша аудитория\n---\nПроверенный авторский материал.\n'
  f.put(`${knowledge}/audience.md`, existing)
  f.put(`${knowledge}/custom.md`, '---\ntitle: Особый раздел\n---\nСпецифика процесса.\n')
  const first = f.run('--topics', 'audience,journey')
  assert.equal(first.status, 0, first.stderr || first.stdout)
  assert.equal(f.read(`${knowledge}/audience.md`), existing)
  assert.deepEqual(f.yaml('.knowledge-base/.knowledge.yml'), { order: ['custom', 'processes', 'business'], customField: 'keep' })
  assert.deepEqual(f.yaml('.knowledge-base/processes/.knowledge.yml'), { title: 'Существующие процессы', order: ['previous', 'demo'], icon: '🌿' })
  assert.deepEqual(f.yaml(`${knowledge}/.knowledge.yml`), {
    title: 'Авторское имя', description: 'Сохранить описание', order: ['custom.md', 'audience.md', 'journey.md'], isNew: true,
  })
  const before = f.snapshot()
  assert.equal(f.run('--topics', 'audience,journey').status, 0)
  assert.deepEqual(f.snapshot(), before)
  assert.equal(f.run('--topics', 'operations').status, 0)
  assert.equal(f.read(`${knowledge}/audience.md`), existing)
  assert.deepEqual(f.yaml(`${knowledge}/.knowledge.yml`).order, ['custom.md', 'audience.md', 'journey.md', 'operations.md'])
  assert.equal(f.run().status, 0)
  assert.equal(existsSync(join(f.root, knowledge, 'operations.md')), true)
})

test('existing author-written knowledge is reused without an extra overview, including nested articles', t => {
  const f = fixture(t)
  const source = '---\ntitle: Запись на занятие\n---\nОставьте заявку; администратор подтвердит время.\n'
  f.put(`${knowledge}/visits/.knowledge.yml`, 'title: Занятия\norder: ["booking (adults).md"]\n')
  f.put(`${knowledge}/visits/booking (adults).md`, source)
  const result = f.run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(join(f.root, knowledge, 'overview.md')), false)
  assert.equal(f.read(`${knowledge}/visits/booking (adults).md`), source)
  assert.deepEqual(f.yaml(`${knowledge}/.knowledge.yml`).order, ['visits'])
  assert.match(f.read('demo/PLAN.md'), /processes\/demo\/visits\/booking%20%28adults%29\.md/)
  const report = collectKnowledge({ root: f.root, slug: 'demo' })
  assert.deepEqual(report.checks.find(check => check.id === 'kb-links').errors, [])
  assert.deepEqual(report.checks.find(check => check.id === 'kb-metadata').errors, [])
  const before = f.snapshot()
  assert.equal(f.run().status, 0)
  assert.deepEqual(f.snapshot(), before)
})

test('invalid topic lists fail before creating files', t => {
  const f = fixture(t)
  for (const args of [
    ['--topics', 'unknown'], ['--topics='], ['--topics'], ['--topics', 'audience,'],
    ['--topics', ',journey'], ['--topics', 'audience,,journey'], ['--topics', '../offer'],
    ['--topics', 'Audience'], ['--topics', 'overview'],
  ]) {
    const run = f.run(...args)
    assert.equal(run.status, 2, `${args.join(' ')}: ${run.stderr || run.stdout}`)
    assert.match(run.stderr, /--topics/)
    assert.deepEqual(readdirSync(f.root), [])
  }
})

test('dry-run reports optional articles without writing, including on an existing process', t => {
  const f = fixture(t)
  const initial = f.run('--topics', 'pages,series', '--dry-run')
  assert.equal(initial.status, 0, initial.stderr || initial.stdout)
  assert.match(initial.stdout, /pages\.md/)
  assert.match(initial.stdout, /series\.md/)
  assert.deepEqual(readdirSync(f.root), [])
  assert.equal(f.run().status, 0)
  const before = f.snapshot()
  const continued = f.run('--topics', 'pages', '--dry-run')
  assert.equal(continued.status, 0)
  assert.match(continued.stdout, /\.knowledge\.yml \(\+ pages\.md\)/)
  assert.deepEqual(f.snapshot(), before)
})

test('all generated knowledge templates expose placeholders to kb-check without fake links', t => {
  const f = fixture(t)
  const run = f.run('--topics', allTopics.join(','))
  assert.equal(run.status, 0, run.stderr || run.stdout)
  const report = collectKnowledge({ root: f.root, slug: 'demo' })
  const contentErrors = report.checks.find(check => check.id === 'kb-content').errors
  for (const topic of ['overview', ...allTopics]) {
    assert.ok(contentErrors.some(error => error.includes(`${topic}.md`) && error.includes('заглушка')), `${topic}: ${contentErrors.join('\n')}`)
  }
  assert.deepEqual(report.checks.find(check => check.id === 'kb-links').errors, [])
  assert.deepEqual(report.checks.find(check => check.id === 'kb-metadata').errors, [])
  assert.equal(existsSync(join(f.root, '.knowledge-base/business/company.md')), false)
})
