import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { collectKnowledge, KNOWLEDGE_LIMITS } from '../lib/knowledge.mjs'

const subtree = '.knowledge-base/processes/demo'
const article = (body, title = 'Процесс') => `---\ntitle: ${title}\n---\n\n${body}\n`
const messages = (report, field = 'errors') => report.checks.flatMap(check => check[field]).join('\n')

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'process-knowledge-'))
  const root = join(base, 'account')
  mkdirSync(root)
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source) }
  put('.knowledge-base/.knowledge.yml', 'order: [business, processes]\n')
  put('.knowledge-base/processes/.knowledge.yml', 'title: Процессы\norder: [demo, absent-other-process]\n')
  put(`${subtree}/.knowledge.yml`, 'title: Демо\norder: [overview.md]\n')
  put(`${subtree}/overview.md`, article('Человек оставляет заявку; менеджер звонит в течение дня.'))
  put('.knowledge-base/business/.knowledge.yml', 'title: Бизнес\norder: [company.md, unrelated-missing.md]\n')
  put('.knowledge-base/business/company.md', article('Компания продаёт услуги записи.', 'Компания'))
  put('.knowledge-base/business/unrelated.md', 'invalid YAML and TODO: must not be collected')
  put('demo/process.yaml', `title: Демо\nknowledge: ${subtree}/\nnodes: []\n`)
  put('demo/PLAN.md', '# План\n\nСтраница записи и подтверждение заявки.\n')
  return { root, base, put, collect: () => collectKnowledge({ root, slug: 'demo' }) }
}

test('clean corpus is sorted and scoped; shared metadata does not validate unrelated children', t => {
  const f = fixture(t)
  f.put(`${subtree}/overview.md`, article('[Компания](/app/knowledge/~/business/company.md). Человек оставляет заявку.'))
  const result = f.collect()
  assert.equal(result.passed, result.total, messages(result))
  assert.equal(result.processPath, 'demo')
  const paths = result.files.map(file => file.path)
  assert.deepEqual(paths, [...paths].sort())
  assert.equal(new Set(paths).size, paths.length)
  assert.ok(paths.includes('.knowledge-base/business/company.md'))
  assert.ok(!paths.includes('.knowledge-base/business/unrelated.md'))
  assert.equal(messages(result, 'warnings'), '')
})

test('author-selected article names and prose or custom headings need no template sections', t => {
  const f = fixture(t)
  rmSync(join(f.root, subtree, 'overview.md'))
  f.put(`${subtree}/.knowledge.yml`, 'title: Запись на занятие\norder: [booking.md, reschedule.md]\n')
  f.put(`${subtree}/booking.md`, article('Человек оставляет заявку. Администратор уточняет время и подтверждает запись.', 'Как записаться'))
  f.put(`${subtree}/reschedule.md`, article('## Если время не подходит\n\nАдминистратор предлагает свободное время.\n\n## Когда запись подтверждена\n\nКлиент получил дату и адрес.', 'Перенос занятия'))
  const report = f.collect()
  assert.equal(report.passed, report.total, messages(report))
  assert.ok(report.files.some(file => file.path === `${subtree}/booking.md`))
  assert.ok(report.files.some(file => file.path === `${subtree}/reschedule.md`))
  assert.ok(!report.files.some(file => file.path === `${subtree}/overview.md`))
})

test('nested sections, transitive business links, encoded paths and query fragments are included', t => {
  const f = fixture(t)
  f.put(`${subtree}/deep/.knowledge.yml`, 'title: Детали\norder: [step.md]\n')
  f.put(`${subtree}/deep/step.md`, article('[Компания](../../../business/company.md?version=1#offer)'))
  f.put('.knowledge-base/business/company.md', article('[Ещё](./offer%20name.md#detail)'))
  f.put('.knowledge-base/business/offer name.md', article('[Назад](company.md). Услуга стоит 5000 рублей.'))
  const result = f.collect()
  assert.equal(result.passed, result.total, messages(result))
  assert.ok(result.files.some(file => file.path.endsWith('/deep/step.md')))
  assert.ok(result.files.some(file => file.path.endsWith('/offer name.md')))
  assert.ok(messages(result, 'warnings').includes('reader требует'))
})

test('PLAN links add relevant business articles but neither reports nor arbitrary files are read', t => {
  const f = fixture(t)
  f.put('demo/PLAN.md', '# План\n[Компания](../.knowledge-base/business/company.md)\n[Отчёт](reviews/knowledge-build.json)\n')
  f.put('demo/reviews/knowledge-build.json', '{"verdict":"ready"}')
  const result = f.collect()
  assert.equal(result.passed, result.total, messages(result))
  assert.ok(result.files.some(file => file.path.endsWith('/business/company.md')))
  assert.ok(!result.files.some(file => file.path.includes('/reviews/')))
})

test('missing map and plan warn before planning; missing knowledge still fails', t => {
  const f = fixture(t)
  rmSync(join(f.root, 'demo'), { recursive: true })
  const initial = f.collect()
  assert.equal(initial.passed, initial.total, messages(initial))
  assert.match(messages(initial, 'warnings'), /process\.yaml.*до планирования/)
  assert.match(messages(initial, 'warnings'), /PLAN\.md.*до планирования/)
  rmSync(join(f.root, subtree), { recursive: true })
  const empty = f.collect()
  assert.ok(empty.passed < empty.total)
  assert.match(messages(empty), /нет статей/)
})

test('YAML parse errors, missing frontmatter, empty title and invalid metadata types are errors', t => {
  const f = fixture(t)
  f.put(`${subtree}/.knowledge.yml`, 'title: Демо\nisNew: "true"\nagentAccessMode: everything\n')
  f.put(`${subtree}/overview.md`, article('Данные процесса.', '""'))
  f.put(`${subtree}/invalid.md`, '---\ntitle: Что: Как\n---\nТекст статьи.')
  f.put(`${subtree}/no-title.md`, 'Текст без frontmatter.')
  const errors = messages(f.collect())
  assert.match(errors, /title должен/)
  assert.match(errors, /невалидный YAML/)
  assert.match(errors, /нет YAML frontmatter/)
  assert.match(errors, /isNew должен быть boolean/)
  assert.match(errors, /неверный agentAccessMode/)
})

test('process order rejects duplicate, missing and non-child entries without requiring every article', t => {
  const f = fixture(t)
  f.put(`${subtree}/.knowledge.yml`, 'order: [overview.md, overview.md, vanished.md, ../escape.md]\n')
  f.put(`${subtree}/extra.md`, article('Статья вне order допустима.'))
  const result = f.collect(), errors = messages(result)
  assert.match(errors, /повтор в order/)
  assert.match(errors, /vanished\.md: файл или каталог не найден/)
  assert.match(errors, /некорректное имя непосредственного ребёнка/)
  assert.ok(!errors.includes('extra.md'))
})

test('nested metadata is required; optional metadata title stays optional', t => {
  const f = fixture(t)
  f.put(`${subtree}/.knowledge.yml`, 'order: [overview.md, nested]\n')
  f.put(`${subtree}/nested/detail.md`, article('Описание шага.'))
  const result = f.collect()
  assert.match(messages(result), /nested\/\.knowledge\.yml: нет метаданных раздела/)
  assert.doesNotMatch(messages(result), /title должен/)
})

test('empty and heading-only articles and explicit placeholders fail; questions do not', t => {
  const f = fixture(t)
  f.put(`${subtree}/overview.md`, article('## Вопросы\n\n- Нужны ли SMS?\n- Допущение: сначала звоним вручную.\n\nTODO: указать срок.\n[TODO]\n…'))
  f.put(`${subtree}/empty.md`, article(''))
  f.put(`${subtree}/headings.md`, article('# Заголовок\n\n## Второй заголовок'))
  const errors = messages(f.collect())
  assert.match(errors, /явная незаполненная заглушка/)
  assert.match(errors, /empty\.md: нет содержательного тела/)
  assert.match(errors, /headings\.md: нет содержательного тела/)
  assert.doesNotMatch(errors, /SMS|Допущение/)
})

test('code examples are not scanned for placeholders or links; warning matches whole words', t => {
  const f = fixture(t)
  f.put(`${subtree}/overview.md`, article('Возможности системы описаны. Предположительно запуск завтра.\n\n```md\nTODO: пример\n…\n[нет](missing.md)\n```\n\n~~~js\n// TODO: пример\n~~~\n\n    TODO: пример кода\n\n`[TODO]` и `[нет](missing.md)` — литералы.'))
  const result = f.collect()
  assert.equal(result.passed, result.total, messages(result))
  const warnings = result.checks.find(check => check.id === 'kb-content').warnings
  assert.equal(warnings.length, 1)
  f.put(`${subtree}/overview.md`, article('Возможности системы описаны.'))
  assert.equal(f.collect().checks.find(check => check.id === 'kb-content').warnings.length, 0)
})

test('reference-style links support full, collapsed, shortcut and next-line definitions', t => {
  const f = fixture(t)
  f.put(`${subtree}/overview.md`, article('[Компания][company]\n[company][]\n[company]\n[Второй][next]\n\n[company]: /app/knowledge/~/business/company.md "Компания"\n[next]:\n  </app/knowledge/~/business/extra.md>\n'))
  f.put('.knowledge-base/business/extra.md', article('Дополнительный оффер.'))
  const result = f.collect()
  assert.equal(result.passed, result.total, messages(result))
  assert.ok(result.files.some(file => file.path.endsWith('/business/company.md')))
  assert.ok(result.files.some(file => file.path.endsWith('/business/extra.md')))
})

test('missing local destinations and undefined explicit references fail; external and self links are untouched', t => {
  const f = fixture(t)
  f.put(`${subtree}/overview.md`, article('[Нет](missing.md?x=1#s)\n[Нет][undefined]\n[Снаружи](https://example.invalid/missing.md)\n[Почта](mailto:person@example.invalid)\n[Якорь](#here)\n[Параметр](?x=1)'))
  const errors = messages(f.collect())
  assert.match(errors, /missing\.md: файл или каталог не найден/)
  assert.match(errors, /нет определения Markdown-ссылки \[undefined\]/)
  assert.doesNotMatch(errors, /example\.invalid|#here|\?x=1\)/)
})

test('destinations with parentheses, escaped parentheses, angle brackets and images are checked', t => {
  const f = fixture(t)
  f.put(`${subtree}/overview.md`, article('[Оффер](../../business/offer(v2).md "Версия")\n[Оффер](../../business/offer\\(v2\\).md)\n[Пробел](<../../business/offer name.md> "Пробел")\n![Диаграмма](flow.svg)'))
  f.put('.knowledge-base/business/offer(v2).md', article('Версия оффера 2.'))
  f.put('.knowledge-base/business/offer name.md', article('Название оффера.'))
  f.put(`${subtree}/flow.svg`, '<svg></svg>')
  const result = f.collect()
  assert.equal(result.passed, result.total, messages(result))
  assert.ok(!result.files.some(file => file.path.endsWith('.svg')))
})

test('map paths cannot escape KB; encoded reader traversal cannot escape KB or account', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', 'knowledge: ../outside\n')
  assert.match(messages(f.collect()), /knowledge должен указывать на раздел внутри/)
  f.put('demo/process.yaml', `knowledge: ${subtree}\n`)
  f.put('secret.md', 'A private file that must not enter the corpus')
  f.put(`${subtree}/overview.md`, article('[Секрет](/app/knowledge/~/%2e%2e/secret.md)\n[Выход](../../../../../../outside.md)\n[Файл](file:///etc/passwd)'))
  const result = f.collect(), errors = messages(result)
  assert.match(errors, /путь выходит за разрешённый каталог/)
  assert.match(errors, /запрещён локальный file:/)
  assert.ok(!result.files.some(file => file.path === 'secret.md'))
})

test('symlink escape and dangling symlinks fail without reading outside files', t => {
  const f = fixture(t)
  const outside = join(f.base, 'outside.md')
  writeFileSync(outside, article('EXTERNAL_MARKER_DO_NOT_READ'))
  symlinkSync(outside, join(f.root, subtree, 'outside.md'))
  symlinkSync(join(f.base, 'absent.md'), join(f.root, subtree, 'dangling.md'))
  const result = f.collect()
  assert.match(messages(result), /символическая ссылка выходит/)
  assert.match(messages(result), /dangling\.md: файл или каталог не найден/)
  assert.ok(!result.files.some(file => file.content.includes('EXTERNAL_MARKER')))
})

test('symlink cycles and article link cycles terminate with a unique corpus', t => {
  const f = fixture(t)
  f.put(`${subtree}/child/.knowledge.yml`, 'title: Дочерний\n')
  f.put(`${subtree}/child/detail.md`, article('[Назад](../overview.md)'))
  f.put(`${subtree}/overview.md`, article('[Вперёд](child/detail.md)'))
  symlinkSync(join(f.root, subtree), join(f.root, subtree, 'child/back'))
  symlinkSync(join(f.root, subtree, 'overview.md'), join(f.root, subtree, 'alias.md'))
  const result = f.collect()
  assert.equal(result.passed, result.total, messages(result))
  assert.equal(result.files.filter(file => file.path.endsWith('/overview.md')).length, 1)
  assert.ok(!result.files.some(file => file.path.includes('/back/')))
})

test('process directory symlink cannot bulk-read another business directory', t => {
  const f = fixture(t)
  symlinkSync(join(f.root, '.knowledge-base/business'), join(f.root, subtree, 'business'))
  const result = f.collect()
  assert.match(messages(result), /каталог выходит за раздел процесса/)
  assert.ok(!result.files.some(file => file.path.endsWith('/business/unrelated.md')))
})

test('file size and corpus count limits fail rather than reporting truncated material as ready', t => {
  const f = fixture(t)
  f.put(`${subtree}/huge.md`, article('X'.repeat(KNOWLEDGE_LIMITS.fileBytes)))
  assert.match(messages(f.collect()), /файл больше/)
  rmSync(join(f.root, subtree, 'huge.md'))
  for (let i = 0; i < KNOWLEDGE_LIMITS.files + 1; i++) f.put(`${subtree}/item-${i}.md`, article('Описание шага.'))
  const result = f.collect()
  assert.match(messages(result), /Превышен лимит.*файлов/)
  assert.ok(result.files.length <= KNOWLEDGE_LIMITS.files)
})

test('CLI has 0/1/2 exit codes, JSON summary, and never changes sources', t => {
  const f = fixture(t)
  const cli = fileURLToPath(new URL('../kb-check.mjs', import.meta.url))
  const run = extra => spawnSync(process.execPath, [cli, 'demo', '--root', f.root, '--json', ...extra], { encoding: 'utf8' })
  const before = readFileSync(join(f.root, subtree, 'overview.md'), 'utf8')
  const ok = run([])
  assert.equal(ok.status, 0, ok.stderr || ok.stdout)
  assert.equal(JSON.parse(ok.stdout).passed, 4)
  assert.equal(readFileSync(join(f.root, subtree, 'overview.md'), 'utf8'), before)
  f.put(`${subtree}/overview.md`, article('TODO: заполнить'))
  assert.equal(run([]).status, 1)
  assert.equal(run(['--unknown']).status, 2)
  assert.equal(spawnSync(process.execPath, [cli, '../demo', '--root', f.root], { encoding: 'utf8' }).status, 2)
  assert.throws(() => collectKnowledge({ root: f.root, slug: '../escape' }), /Некорректный slug/)
  assert.throws(() => collectKnowledge({ root: resolve(f.root, 'missing'), slug: 'demo' }))
})
