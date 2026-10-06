import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectImplementation, IMPLEMENTATION_LIMITS, importSpecifiers } from '../lib/implementation.mjs'
import { codeReviewPath, codeReviewStatus, makeCodeReviewPacket, recordCodeReview } from '../lib/code-review.mjs'
import { validateReview } from '../lib/knowledge-review.mjs'

import { writeReferenceSnapshot } from '../lib/review-library.mjs'

const cli = fileURLToPath(new URL('../code-review.mjs', import.meta.url))
const kbPath = '.knowledge-base/processes/demo/overview.md'
const codePath = 'demo/index.ts'
const quote = 'export const answer = 42'

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'process-code-review-')), root = join(base, 'account')
  mkdirSync(root)
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const put = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  put('.knowledge-base/.knowledge.yml', 'order: [processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'order: [demo]\n')
  put('.knowledge-base/processes/demo/.knowledge.yml', 'title: Запись\norder: [overview.md]\n')
  put(kbPath, '---\ntitle: Запись\n---\nКлиент оставляет заявку. Менеджер отвечает в рабочий день.\n')
  put('demo/PLAN.md', '# План\n\n- [x] T1 Собрать форму заявки\n- [ ] T2 Проверить повторную заявку\n')
  put('demo/process.yaml', 'title: Запись\naccountId: 123\nknowledge: .knowledge-base/processes/demo\nnodes: []\n')
  put(codePath, `${quote}\n`)
  mkdirSync(join(root, '.mailings/storage/processes/demo'), { recursive: true })
  const packet = () => makeCodeReviewPacket({ root, slug: 'demo' })
  const collect = () => collectImplementation({ root, slug: 'demo' })
  const run = (command, flags = []) => spawnSync(process.execPath,
    [cli, command, 'demo', '--root', root, '--json', ...flags],
    { encoding: 'utf8', env: process.env, cwd: root })
  return { root, base, put, packet, collect, run }
}
const errors = corpus => corpus.checks.flatMap(check => check.errors)
const paths = corpus => corpus.files.map(file => file.path)

// Unit-only fabricated answers test schema and invalidation, NOT an actual
// independent code review. One repeated quote does not establish code safety.
function syntheticReport(packet) {
  return { version: 1, process: packet.process, stage: packet.stage, inputDigest: packet.inputDigest,
    inspectedFiles: packet.files.map(file => file.path),
    inspectedReferences: [...packet.referenceLibrary.required],
    answers: packet.questions.map((question, index) => ({ id: question.id, status: 'covered',
      reason: 'Unit-only synthetic answer to exercise the structural validator.',
      evidence: [{ path: codePath, quote: quote.slice(index % 3) }] })) }
}
function save(f, packet, report = syntheticReport(packet)) {
  return recordCodeReview({ root: f.root, slug: 'demo', packet, report,
    agentReference: 'unit-test-only:synthetic-code-review' })
}

test('source packet includes subtree, linked KB, central letters and mapped external local files', t => {
  const f = fixture(t)
  f.put(kbPath, '---\ntitle: Запись\n---\n[Бизнес](/app/knowledge/~/business/company.md).\n')
  f.put('.knowledge-base/business/.knowledge.yml', 'order: [company.md]\n')
  f.put('.knowledge-base/business/company.md', '---\ntitle: Компания\n---\nМенеджер проводит консультации.\n')
  f.put('.mailings/storage/processes/demo/welcome/1.message.yaml', 'subject: Заявка получена\n')
  f.put('demo/nested/component.vue', '<template><p>Готово</p></template>\n')
  f.put('shared/form.ts', 'export const form = true\n')
  f.put('shared/flow/action.ts', 'export const action = true\n')
  f.put('demo/process.yaml', 'title: Запись\naccountId: 123\nknowledge: .knowledge-base/processes/demo\nnodes:\n  - source: shared/form.ts\nlinks:\n  - via: shared/flow\n')
  const corpus = f.collect()
  assert.deepEqual(errors(corpus), [])
  for (const path of [kbPath, 'demo/PLAN.md', 'demo/process.yaml', codePath, 'demo/nested/component.vue',
    '.knowledge-base/business/company.md', '.mailings/storage/processes/demo/welcome/1.message.yaml', 'shared/form.ts', 'shared/flow/action.ts'])
    assert.ok(paths(corpus).includes(path), path)
  assert.deepEqual(corpus.tasks, [{ id: 'T1', title: 'Собрать форму заявки', markedDone: true },
    { id: 'T2', title: 'Проверить повторную заявку', markedDone: false }])
})

test('no letters is valid without a letters directory; explicit missing letters is an error', t => {
  const f = fixture(t)
  rmSync(join(f.root, '.mailings/storage/processes/demo'), { recursive: true })
  assert.deepEqual(errors(f.collect()), [])
  f.put('demo/process.yaml', 'title: Запись\nknowledge: .knowledge-base/processes/demo\nletters: missing-letters\nnodes: []\n')
  assert.ok(errors(f.collect()).some(error => error.includes('missing-letters')))
})

test('import scanner finds import, re-export, require and literal import while ignoring comments and quoted code', () => {
  const source = `// import './commented'
    /* export * from './commented-again' */
    const example = "import './string-only'";
    import './side-effect';
    import type { Type } from './types';
    export { entry } from './re-export';
    export * from './wildcard';
    const data = require('./required');
    const module = import('./lazy');
    const dynamic = import(prefix + '/computed');
    const template = import(\`./items/\${id}\`);
    const owner = import.meta.url;
  `
  assert.deepEqual(importSpecifiers(source), [
    { specifier: './side-effect' }, { specifier: './types' }, { specifier: './re-export' },
    { specifier: './wildcard' }, { specifier: './required' }, { specifier: './lazy' },
    { dynamic: true }, { dynamic: true },
  ])
})

test('relative shared imports and re-exports are followed transitively with no dependency code execution', t => {
  const f = fixture(t)
  f.put(codePath, `${quote}\nimport { value } from '../shared/index'\nimport '../shared/effects'\n`)
  f.put('shared/index.ts', "export { value } from './nested/value'\n")
  f.put('shared/nested/value.ts', "export const value = import('./lazy')\n")
  f.put('shared/nested/lazy.ts', 'export const lazy = true\n')
  f.put('shared/effects.ts', `throw Error('This source must never execute during prepare')\n`)
  const corpus = f.collect()
  assert.deepEqual(errors(corpus), [])
  for (const path of ['shared/index.ts', 'shared/nested/value.ts', 'shared/nested/lazy.ts', 'shared/effects.ts'])
    assert.ok(paths(corpus).includes(path), path)
})

test('tsconfig aliases honor baseUrl, wildcard suffixes and fallback targets; root and home imports are local', t => {
  const f = fixture(t)
  f.put('tsconfig.json', `{
    // JSONC comments and trailing commas are accepted.
    "compilerOptions": { "baseUrl": "src", "paths": {
      "@shared/*": ["missing/*", "shared/*"],
      "@parts/*/public": ["parts/*"],
      "@exact": ["exact"],
    } },
  }`)
  f.put(codePath, `${quote}\nimport '@shared/first'\nimport '@parts/two/public'\nimport '@exact'\nimport '~/root-helper'\nimport '/root-other'\nimport '@app/heap'\n`)
  for (const path of ['src/shared/first.ts', 'src/parts/two.ts', 'src/exact.ts', 'root-helper.ts', 'root-other.ts'])
    f.put(path, 'export const helper = true\n')
  const corpus = f.collect()
  assert.deepEqual(errors(corpus), [])
  for (const path of ['src/shared/first.ts', 'src/parts/two.ts', 'src/exact.ts', 'root-helper.ts', 'root-other.ts'])
    assert.ok(paths(corpus).includes(path), path)
  assert.ok(corpus.dependencies.some(dep => dep.kind === 'external' && dep.specifier === '@app/heap'))
})

test('dot-prefixed account aliases are not relative imports and exact aliases outrank generic patterns', t => {
  const f = fixture(t)
  f.put('tsconfig.json', JSON.stringify({ compilerOptions: { paths: {
    '.mailings/*': ['./.mailings/*'], '@shared/*': ['wrong/*'], '@shared/critical': ['correct/critical'],
  } } }))
  f.put(codePath, `${quote}\nimport '.mailings/storage/read-letter'\nimport '@shared/critical'\n`)
  f.put('.mailings/storage/read-letter.ts', 'export const readLetter = () => true\n')
  f.put('wrong/critical.ts', 'export const wrong = true\n')
  f.put('correct/critical.ts', 'export const correct = true\n')
  const corpus = f.collect()
  assert.deepEqual(errors(corpus), [])
  assert.ok(paths(corpus).includes('.mailings/storage/read-letter.ts'))
  assert.ok(paths(corpus).includes('correct/critical.ts'))
  assert.ok(!paths(corpus).includes('wrong/critical.ts'))
})

test('unresolved relative import and inherited aliases block a complete packet', t => {
  const f = fixture(t)
  f.put(codePath, `${quote}\nimport '../missing'\n`)
  f.put('tsconfig.json', '{"extends":"./base-tsconfig.json"}')
  const failures = errors(f.collect()).join('\n')
  assert.match(failures, /не разрешена зависимость .*missing/)
  assert.match(failures, /tsconfig.extends/)
})

test('computed imports require declared final sources and explicit includes add their transitive imports', t => {
  const f = fixture(t)
  f.put(codePath, `${quote}\nconst load = (name: string) => import('../actions/' + name)\n`)
  assert.match(errors(f.collect()).join('\n'), /вычисляемая зависимость/)
  f.put('actions/a.ts', "export { value } from '../shared/value'\n")
  f.put('shared/value.ts', 'export const value = true\n')
  f.put('middleware.ts', 'export const middleware = true\n')
  f.put('demo/review-scope.json', JSON.stringify({ version: 1, include: ['middleware.ts'],
    dynamic: [{ source: codePath, reason: 'Имя ограничено единственным действием a.', paths: ['actions/a.ts'] }] }))
  const corpus = f.collect()
  assert.deepEqual(errors(corpus), [])
  for (const path of ['actions/a.ts', 'shared/value.ts', 'middleware.ts']) assert.ok(paths(corpus).includes(path))
  assert.ok(corpus.dependencies.some(dep => dep.kind === 'dynamic' && dep.declared))
  f.put('demo/review-scope.json', JSON.stringify({ version: 1, include: ['../outside.ts'], dynamic: [] }))
  assert.match(errors(f.collect()).join('\n'), /Некорректный локальный путь/)
})

test('configured local routeJson modules are followed and external accounts stay external despite naming collisions', t => {
  const f = fixture(t)
  f.put('demo/flow.automationConfig.json', JSON.stringify({ steps: [
    { routeJson: [123, 'shared/actions/local', '/run'] },
    { routeJson: [456, 'shared/actions/collision', '/run'] },
    { routeJson: [456, 'external/only', '/run'] },
  ] }))
  f.put('shared/actions/local.ts', "export { run } from '../impl'\n")
  f.put('shared/impl.ts', 'export const run = () => true\n')
  f.put('shared/actions/collision.ts', 'export const unrelatedLocal = true\n')
  const corpus = f.collect()
  assert.deepEqual(errors(corpus), [])
  assert.ok(paths(corpus).includes('shared/actions/local.ts'))
  assert.ok(paths(corpus).includes('shared/impl.ts'))
  assert.ok(!paths(corpus).includes('shared/actions/collision.ts'))
  assert.equal(corpus.dependencies.filter(dep => dep.kind === 'configured-external').length, 2)
  assert.ok(corpus.dependencies.some(dep => dep.kind === 'configured-external' && dep.module === 'shared/actions/collision'))
})

test('automation configurations discovered by imports also contribute routeJson source modules', t => {
  const f = fixture(t)
  f.put(codePath, `${quote}\nimport '../shared/flow.automationConfig.json'\n`)
  f.put('shared/flow.automationConfig.json', JSON.stringify({ action: { routeJson: [123, 'shared/actions/imported', '/run'] } }))
  f.put('shared/actions/imported.ts', 'export const run = () => true\n')
  const corpus = f.collect()
  assert.deepEqual(errors(corpus), [])
  assert.ok(paths(corpus).includes('shared/actions/imported.ts'))
})

test('missing configured local modules are errors and configured module paths cannot escape account', t => {
  const f = fixture(t)
  f.put('demo/flow.automationConfig.json', JSON.stringify({ steps: [
    { routeJson: [123, 'shared/missing', '/run'] }, { routeJson: [123, '../outside', '/run'] },
  ] }))
  const failures = errors(f.collect()).join('\n')
  assert.match(failures, /нет исходника routeJson shared\/missing/)
  assert.match(failures, /Некорректный локальный путь/)
})

test('symlink escapes and dangling sources block collection without including outside contents', t => {
  const f = fixture(t), outside = join(f.base, 'secret.ts')
  writeFileSync(outside, 'OUTSIDE_SECRET_MUST_NOT_BE_INCLUDED')
  symlinkSync(outside, join(f.root, 'demo/escape.ts'))
  symlinkSync(join(f.base, 'absent.ts'), join(f.root, 'demo/dangling.ts'))
  const corpus = f.collect()
  assert.match(errors(corpus).join('\n'), /Ссылка вне аккаунта/)
  assert.match(errors(corpus).join('\n'), /dangling.*ENOENT/)
  assert.ok(!JSON.stringify(corpus.files).includes('OUTSIDE_SECRET'))
})

test('generated trees and reports are excluded while explicit local typings and bounded binary assets are fingerprinted', t => {
  const f = fixture(t)
  f.put('demo/reviews/implementation.json', 'invalid ignored report')
  f.put('demo/node_modules/ignored.ts', 'throw Error("Do not include this")')
  f.put('.typings/contracts.d.ts', 'export interface Contract { id: string }\n')
  f.put('demo/review-scope.json', JSON.stringify({ version: 1, include: ['.typings/contracts.d.ts'] }))
  f.put('demo/photo.bin', Buffer.from([0, 1, 2, 3]))
  const corpus = f.collect()
  assert.deepEqual(errors(corpus), [])
  assert.ok(paths(corpus).includes('.typings/contracts.d.ts'))
  assert.ok(!paths(corpus).some(path => path.includes('/reviews/') || path.includes('/node_modules/')))
  assert.equal(corpus.assets.length, 1)
  assert.equal(corpus.assets[0].path, 'demo/photo.bin')
  assert.equal(corpus.assets[0].bytes, 4)
  assert.match(corpus.assets[0].sha256, /^[a-f0-9]{64}$/)
})

test('secret configs and size/count bounds produce structural errors instead of silent success', t => {
  const f = fixture(t)
  f.put('demo/.env', 'TOKEN=SHOULD_NOT_LEAK')
  f.put('demo/oversized.txt', Buffer.alloc(IMPLEMENTATION_LIMITS.fileBytes + 1, 65))
  let corpus = f.collect()
  assert.match(errors(corpus).join('\n'), /Секретный конфиг/)
  assert.match(errors(corpus).join('\n'), /лимит размера\/числа/)
  assert.ok(!JSON.stringify(corpus.files).includes('SHOULD_NOT_LEAK'))
  rmSync(join(f.root, 'demo/oversized.txt'))
  rmSync(join(f.root, 'demo/.env'))
  for (let i = 0; i < IMPLEMENTATION_LIMITS.files; i++) f.put(`demo/many/${i}.txt`, 'bounded\n')
  corpus = f.collect()
  assert.ok(corpus.files.length + corpus.assets.length <= IMPLEMENTATION_LIMITS.files)
  assert.match(errors(corpus).join('\n'), /лимит размера\/числа/)
})

test('total source byte budget stops collection with a visible error', t => {
  const f = fixture(t)
  const chunk = Buffer.alloc(IMPLEMENTATION_LIMITS.fileBytes, 65)
  for (let i = 0; i < 9; i++) f.put(`demo/size-${i}.txt`, chunk)
  const corpus = f.collect()
  assert.match(errors(corpus).join('\n'), /лимит размера\/числа/)
  assert.ok(corpus.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) <= IMPLEMENTATION_LIMITS.bytes)
})

test('packet requires all PLAN task answers and refuses duplicate/placeholder task definitions', t => {
  const f = fixture(t), packet = f.packet()
  assert.equal(packet.stage, 'implementation')
  assert.ok(packet.questions.some(question => question.id === 'plan.T1'))
  assert.ok(packet.questions.some(question => question.id === 'plan.T2'))
  assert.ok(packet.referenceLibrary.required.includes('skills/processes/build/review-safety.md'))
  assert.equal(packet.methodology, undefined)
  const report = syntheticReport(packet)
  report.answers = report.answers.filter(answer => answer.id !== 'plan.T2')
  assert.throws(() => validateReview(report, packet), /каждый вопрос/)
  f.put('demo/PLAN.md', '- [x] T1 Первая задача\n- [ ] T1 Вторая задача\n')
  assert.throws(() => f.packet(), /Повторяются вопросы|ID задач/)
  f.put('demo/PLAN.md', '- [ ] T1 …\n')
  assert.match(errors(f.collect()).join('\n'), /нет конкретных задач/)
})

test('a task with no title cannot consume the following task line or silently disappear', t => {
  const f = fixture(t)
  f.put('demo/PLAN.md', '# План\n\n- [x] T1\n- [ ] T2 Собрать форму\n')
  const corpus = f.collect()
  assert.ok(corpus.tasks.some(task => task.id === 'T2' && task.title === 'Собрать форму'))
  assert.ok(errors(corpus).length > 0, 'a malformed task must make scope incomplete')
})

test('implementation digest changes for own code, shared code, new files, assets, KB and PLAN, but not reports/unrelated code', t => {
  const f = fixture(t)
  f.put(codePath, `${quote}\nimport '../shared/helper'\n`)
  f.put('shared/helper.ts', 'export const helper = true\n')
  f.put('demo/icon.bin', Buffer.from([0, 1]))
  const before = f.packet().inputDigest
  f.put('demo/reviews/implementation.json', '{}\n')
  f.put('demo/reviews/knowledge-build.json', '{}\n')
  f.put('unrelated/index.ts', 'export const other = true\n')
  assert.equal(f.packet().inputDigest, before)
  for (const path of [codePath, 'shared/helper.ts', kbPath, 'demo/PLAN.md']) {
    const original = readFileSync(join(f.root, path), 'utf8')
    f.put(path, original + '\n// additional information\n')
    assert.notEqual(f.packet().inputDigest, before, path)
    f.put(path, original)
    assert.equal(f.packet().inputDigest, before, path)
  }
  f.put('demo/new-route.ts', 'export const route = true\n')
  assert.notEqual(f.packet().inputDigest, before)
  rmSync(join(f.root, 'demo/new-route.ts'))
  f.put('demo/icon.bin', Buffer.from([0, 2]))
  assert.notEqual(f.packet().inputDigest, before)
})

test('record tracks provenance and missing/ready/stale without hashing its own report', t => {
  const f = fixture(t), packet = f.packet()
  assert.equal(codeReviewStatus({ root: f.root, slug: 'demo' }).status, 'missing')
  const result = save(f, packet), saved = JSON.parse(readFileSync(result.path, 'utf8'))
  assert.equal(saved.reviewer.kind, 'subagent')
  assert.equal(saved.reviewer.reference, 'unit-test-only:synthetic-code-review')
  assert.ok(Number.isFinite(Date.parse(saved.reviewedAt)))
  assert.equal(f.packet().inputDigest, packet.inputDigest)
  assert.equal(codeReviewStatus({ root: f.root, slug: 'demo' }).status, 'ready')
  f.put(codePath, `${quote}\nexport const changed = true\n`)
  assert.equal(codeReviewStatus({ root: f.root, slug: 'demo' }).status, 'stale')
  assert.throws(() => save(f, packet), /изменились/)
})

test('current packet validation rejects forged evidence, omitted files/tasks and malformed reports', t => {
  const f = fixture(t), packet = f.packet(), altered = structuredClone(packet)
  altered.files.find(file => file.path === codePath).content += '\nFAKE_AUTHORIZATION\n'
  const report = syntheticReport(altered)
  report.answers[0].evidence[0].quote = 'FAKE_AUTHORIZATION'
  assert.throws(() => save(f, altered, report), /Цитата.*не найдена/)
  const omitted = syntheticReport(packet); omitted.inspectedFiles.pop()
  assert.throws(() => save(f, packet, omitted), /inspectedFiles/)
  const wrongStage = syntheticReport(packet); wrongStage.stage = 'build'
  assert.throws(() => save(f, packet, wrongStage), /не соответствует/)
  const fakeId = syntheticReport(packet); fakeId.answers[0].id = 'forged.question'
  assert.throws(() => save(f, packet, fakeId), /Неизвестный/)
  const unsubstantiated = syntheticReport(packet); unsubstantiated.answers[0].status = 'not-applicable'; unsubstantiated.answers[0].evidence = []
  assert.throws(() => save(f, packet, unsubstantiated), /Нужна цитата/)
  assert.ok(!existsSync(codeReviewPath(f.root, 'demo')))
})

test('blocking or structural findings prevent readiness; status rejects absent reviewer provenance', t => {
  const f = fixture(t), packet = f.packet(), report = syntheticReport(packet)
  Object.assign(report.answers[0], { status: 'gap', priority: 'blocking', reason: 'Нет нужного handler.',
    evidence: [], nextAction: 'Добавить исходник handler в пакет.' })
  assert.equal(save(f, packet, report).status, 'needs-work')
  assert.equal(codeReviewStatus({ root: f.root, slug: 'demo' }).status, 'needs-work')
  const saved = JSON.parse(readFileSync(codeReviewPath(f.root, 'demo'), 'utf8'))
  delete saved.reviewer
  f.put('demo/reviews/implementation.json', JSON.stringify(saved))
  assert.throws(() => codeReviewStatus({ root: f.root, slug: 'demo' }), /независимом reviewer/)
  f.put(codePath, `${quote}\nimport '../missing-dependency'\n`)
  const incomplete = f.packet()
  assert.equal(save(f, incomplete).status, 'needs-work')
})

test('report path rejects outside and dangling symlinks before writing', t => {
  const f = fixture(t), packet = f.packet(), outside = join(f.base, 'report.json')
  writeFileSync(outside, 'UNTOUCHED')
  mkdirSync(join(f.root, 'demo/reviews'))
  symlinkSync(outside, join(f.root, 'demo/reviews/implementation.json'))
  assert.throws(() => save(f, packet), /за пределы/)
  assert.equal(readFileSync(outside, 'utf8'), 'UNTOUCHED')
  rmSync(join(f.root, 'demo/reviews/implementation.json'))
  const absent = join(f.base, 'absent.json')
  symlinkSync(absent, join(f.root, 'demo/reviews/implementation.json'))
  assert.throws(() => save(f, packet), /ENOENT|ссылк|за пределы/)
  assert.ok(!existsSync(absent))
})

test('CLI prepare writes packet/prompt outside account, never executes source or overwrites existing output', t => {
  const f = fixture(t), out = join(f.base, 'prepared')
  f.put('demo/side-effect.mjs', `throw Error('prepare must not evaluate process code')\n`)
  const prepared = f.run('prepare', ['--out', out])
  assert.equal(prepared.status, 0, prepared.stderr || prepared.stdout)
  const result = JSON.parse(prepared.stdout), original = readFileSync(result.packet, 'utf8')
  assert.equal(JSON.parse(original).inputDigest, f.packet().inputDigest)
  const prompt = readFileSync(result.prompt, 'utf8')
  assert.ok(prompt.includes(result.packet))
  assert.match(prompt, /не запускай/)
  assert.equal(f.run('prepare', ['--out', out]).status, 2)
  assert.equal(readFileSync(result.packet, 'utf8'), original)
  assert.equal(readFileSync(result.prompt, 'utf8'), prompt)
  assert.equal(f.run('prepare', ['--out', join(f.root, 'review-input')]).status, 2)
  const alias = join(f.base, 'out-alias'); symlinkSync(join(f.root, 'demo'), alias)
  assert.equal(f.run('prepare', ['--out', alias]).status, 2)
  assert.ok(!existsSync(join(f.root, 'demo/packet.json')))
})

test('CLI uses distinct missing, ready, needs-work and invalid invocation exit codes', t => {
  const f = fixture(t), packet = f.packet()
  assert.equal(f.run('status').status, 1)
  for (const [command, flags] of [['prepare', ['--out']], ['prepare', ['--unknown', 'x']],
    ['prepare', ['extra']], ['record', []], ['other', []]])
    assert.equal(f.run(command, flags).status, 2, `${command} ${flags.join(' ')}`)
  const packetFile = join(f.base, 'packet.json'), reportFile = join(f.base, 'answer.json')
  writeReferenceSnapshot(f.base, packet)
  writeFileSync(packetFile, JSON.stringify(packet))
  writeFileSync(reportFile, JSON.stringify(syntheticReport(packet)))
  const flags = ['--packet', packetFile, '--report', reportFile, '--agent', 'unit-test-only:cli']
  assert.equal(f.run('record', flags).status, 0)
  assert.equal(f.run('status').status, 0)
  const report = syntheticReport(packet)
  Object.assign(report.answers[0], { status: 'gap', priority: 'blocking', reason: 'Не ограничен цикл.',
    nextAction: 'Добавить условие окончания и бюджет.', evidence: [] })
  writeFileSync(reportFile, JSON.stringify(report))
  assert.equal(f.run('record', flags).status, 1)
  assert.equal(f.run('status').status, 1)
  writeFileSync(reportFile, 'not json')
  assert.equal(f.run('record', flags).status, 2)
})

test('check gates implementation even with design knowledge stage; offline context shows current status', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  const call = (name, flags) => spawnSync(process.execPath,
    [fileURLToPath(new URL(`../${name}.mjs`, import.meta.url)), 'demo', '--root', f.root, ...flags],
    { encoding: 'utf8', timeout: 10_000 })
  const check = () => JSON.parse(call('check', ['--no-snapshot', '--json', '--knowledge-stage', 'design']).stdout)
  const gate = () => check().checks.find(c => c.id === 'implementation.review')
  const context = () => call('context', ['--offline', '--no-cards']).stdout
  assert.equal(gate().ok, false)
  assert.match(gate().errors.join(' '), /Нет независимого ревью реализации/)
  assert.match(context(), /ревью реализации: missing/)
  save(f, f.packet())
  assert.equal(gate().ok, true)
  assert.match(context(), /ревью реализации: ready/)
  f.put('demo/new-code.ts', 'export const newPath = true\n')
  assert.equal(gate().ok, false)
  assert.match(gate().errors.join(' '), /изменились/)
  assert.match(context(), /ревью реализации: stale/)
})

test('new process check exposes uncovered work and missing page brief and review', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', '{"type":"process","processEngine":"processes-v2"}')
  f.put('demo/tasks/index.json', '{"version":1}')
  f.put('demo/PLAN.md', '# План\n\n## Задачи\n- [ ] T1 Страница заявки\n  - T1.A1 [build] Посетитель понимает предложение.\n\n## Согласования\n')
  f.put('demo/process.yaml', 'title: Заявка\naccountId: 123\nknowledge: .knowledge-base/processes/demo\nnodes:\n  - id: signup\n    kind: page\n    title: Заявка\n    source: demo/index.ts\n')
  const result = spawnSync(process.execPath,
    [fileURLToPath(new URL('../check.mjs', import.meta.url)), 'demo', '--root', f.root,
      '--no-snapshot', '--json', '--task-stage', 'build'], { encoding: 'utf8', timeout: 10_000 })
  const checks = JSON.parse(result.stdout).checks
  assert.match(checks.find(c => c.id === 'tasks').errors.join(' '), /не назначена рабочая задача/)
  assert.match(checks.find(c => c.id === 'creative').errors.join(' '), /нет creativeRef/)
  assert.match(checks.find(c => c.id === 'creative.review').errors.join(' '), /нет creativeRef/)
})
