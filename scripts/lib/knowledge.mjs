// Read-only corpus and structural checks shared by kb-check and agent review.
// Scope: this process's KB subtree, plus explicitly linked KB articles and metadata.
import { lstatSync, realpathSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isProcessSlug, rel } from './project.mjs'
import { reviewPlan } from './review-normalization.mjs'
import { parseYaml, requireYaml } from './yaml.mjs'

export const KNOWLEDGE_LIMITS = Object.freeze({ files: 300, bytes: 5 * 1024 * 1024, fileBytes: 1024 * 1024, entries: 10000 })
export const MATERIAL_LIMITS = Object.freeze({ files: 30, bytes: 40 * 1024 * 1024, fileBytes: 20 * 1024 * 1024 })
const inside = (parent, path) => { const r = relative(parent, path); return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r)) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const markdown = path => /\.md$/i.test(path)
const blank = value => value.replace(/[^\n]/g, ' ')
const missing = error => error.code === 'ENOENT' || error.code === 'ENOTDIR'

// Preserve line numbers while excluding fenced/indented code and inline code.
function prose(source) {
  let fence
  return source.split('\n').map(line => {
    const mark = /^\s{0,3}(?:>\s*)?(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim()) fence = null
      return blank(line)
    }
    if (mark) { fence = mark[1]; return blank(line) }
    if (/^(?: {4}|\t)/.test(line)) return blank(line)
    return line
  }).join('\n').replace(/(`+)([\s\S]*?)\1(?!`)/g, blank)
}

function label(value) { return value.replace(/\\([\[\]\\])/g, '$1').trim().replace(/\s+/g, ' ').toLowerCase() }
function bracketEnds(source) {
  const stack = [], ends = new Map()
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue }
    if (source[i] === '[') stack.push(i)
    else if (source[i] === ']' && stack.length) ends.set(stack.pop(), i + 1)
  }
  return ends
}
function bracket(source, start, ends) {
  const end = ends.get(start)
  return end === undefined ? null : { value: source.slice(start + 1, end - 1), end }
}

// Parse a Markdown destination, including balanced parentheses and optional title.
function destination(source, start, inline) {
  let i = start
  while (/\s/.test(source[i] || '') && i < source.length) i++
  const begin = i
  let value
  if (source[i] === '<') {
    i++
    const from = i
    while (i < source.length && source[i] !== '>' && source[i] !== '\n') {
      if (source[i] === '\\') i++
      i++
    }
    if (source[i] !== '>') return null
    value = source.slice(from, i++)
  } else {
    let depth = 0
    while (i < source.length) {
      if (source[i] === '\\') { i += 2; continue }
      if (/\s/.test(source[i])) break
      if (source[i] === '(') depth++
      if (source[i] === ')') { if (depth === 0) break; depth-- }
      i++
    }
    if (depth !== 0) return null
    value = source.slice(begin, i)
  }
  if (!inline) return { value, end: i }
  while (/\s/.test(source[i] || '') && i < source.length) i++
  if (['"', "'", '('].includes(source[i])) {
    const close = source[i] === '(' ? ')' : source[i]
    i++
    while (i < source.length && source[i] !== close) { if (source[i] === '\\') i++; i++ }
    if (source[i++] !== close) return null
    while (/\s/.test(source[i] || '') && i < source.length) i++
  }
  return source[i] === ')' ? { value, end: i + 1 } : null
}

function linksIn(source) {
  let text = prose(source).replace(/<!--[\s\S]*?-->/g, blank)
  const definitions = new Map(), links = [], undefinedReferences = []
  text = text.replace(/^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\n[ \t]*)?.*$/gm, (line, id, offset) => {
    const colon = line.indexOf(']:') + 2
    const dest = destination(line, colon, false)
    if (dest) {
      const key = label(id)
      if (!definitions.has(key)) definitions.set(key, dest.value)
      links.push({ target: dest.value, offset })
      return blank(line)
    }
    return line
  })
  const ends = bracketEnds(text)
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] !== '[') continue
    const first = bracket(text, i, ends)
    if (!first) continue
    let next = first.end
    if (text[next] === '(') {
      const dest = destination(text, next + 1, true)
      if (dest) { links.push({ target: dest.value, offset: i }); i = dest.end - 1; continue }
    }
    while (/[ \t\n]/.test(text[next] || '') && next < text.length) next++
    let second = bracket(text, next, ends)
    // A known shortcut on one line must not swallow the next independent link.
    if (second && !definitions.has(label(second.value || first.value)) && definitions.has(label(first.value))) second = null
    const id = label(second?.value || first.value)
    if (definitions.has(id)) links.push({ target: definitions.get(id), offset: i })
    else if (second) undefinedReferences.push({ id, offset: i })
    i = (second?.end || first.end) - 1
  }
  return { links, undefinedReferences }
}

function frontmatter(source) {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { body: normalized, error: 'нет YAML frontmatter с title' }
  const close = /^---[ \t]*$/m.exec(normalized.slice(4))
  if (!close) return { body: '', error: 'не закрыт YAML frontmatter' }
  const end = 4 + close.index + close[0].length
  try { return { data: parseYaml(normalized.slice(4, 4 + close.index)), body: normalized.slice(end), offset: normalized.slice(0, end).split('\n').length - 1 } }
  catch (error) { return { body: normalized.slice(end), error: `невалидный YAML frontmatter: ${error.message}` } }
}

/**
 * Returns { files: [{path, content}], checks, passed, total, processPath }.
 * Paths are unique, sorted, account-relative POSIX; no writes, network or LLM.
 * Validation findings are returned. Invalid invocation/missing YAML throws.
 */
export function collectKnowledge({ root, slug }) {
  requireYaml()
  if (!isProcessSlug(slug)) throw new Error('Некорректный slug процесса: ожидается kebab-case латиницей.')
  if (!root) throw new Error('Не указан корень аккаунта.')
  root = realpathSync(resolve(root))
  if (!statSync(root).isDirectory()) throw new Error('Корень аккаунта должен быть каталогом.')
  const checks = [
    { id: 'kb-scope', title: 'Материалы процесса и безопасные пути', errors: [], warnings: [] },
    { id: 'kb-metadata', title: 'YAML, заголовки статей и порядок разделов', errors: [], warnings: [] },
    { id: 'kb-content', title: 'Непустые статьи без явных заглушек', errors: [], warnings: [] },
    { id: 'kb-links', title: 'Локальные ссылки и связанные статьи', errors: [], warnings: [] },
  ]
  const [scope, metadata, content, links] = checks
  const files = new Map(), articleQueue = [], inspectedArticles = new Set(), directories = new Set(), metadataDirs = new Set()
  const linkedMaterials = new Set(), sourceMaterials = []
  const materialDirs = new Set()
  const materialsPath = join(root, slug, 'materials')
  let bytes = 0, entries = 0, materialBytes = 0, exhausted = false, kbPath
  const name = path => rel(root, path)
  const report = (check, field, message) => { if (!check[field].includes(message)) check[field].push(message) }
  const fail = (check, message) => report(check, 'errors', message)
  const warn = (check, message) => report(check, 'warnings', message)
  function limit(message) { exhausted = true; fail(scope, `Превышен лимит: ${message}. Полнота материалов не подтверждена.`) }

  function safe(path, check = scope, optional = false, kbOnly = false) {
    if (!inside(root, path) || (kbOnly && !inside(join(root, '.knowledge-base'), path))) {
      fail(check, `${name(path)}: путь выходит за разрешённый каталог`); return null
    }
    try {
      // lstat distinguishes a dangling symlink from an optional absent file.
      lstatSync(path)
      const real = realpathSync(path)
      if (!inside(root, real) || (kbOnly && !inside(join(root, '.knowledge-base'), real))) {
        fail(check, `${name(path)}: символическая ссылка выходит за разрешённый каталог`); return null
      }
      return { path: real, stat: statSync(real) }
    } catch (error) {
      if (!optional || !missing(error)) fail(check, `${name(path)}: ${missing(error) ? 'файл или каталог не найден' : error.code || error.message}`)
      else {
        // A dangling symlink is not an absent optional source.
        try { if (lstatSync(path).isSymbolicLink()) fail(check, `${name(path)}: повреждённая символическая ссылка`) } catch {}
      }
      return null
    }
  }

  function read(path, { check = scope, optional = false, kbOnly = false } = {}) {
    const selected = safe(path, check, optional, kbOnly)
    if (!selected) return null
    if (!selected.stat.isFile()) { fail(check, `${name(path)}: ожидается обычный файл`); return null }
    if (files.has(selected.path)) return files.get(selected.path)
    if (exhausted) return null
    if (files.size >= KNOWLEDGE_LIMITS.files) { limit(`${KNOWLEDGE_LIMITS.files} файлов`); return null }
    if (selected.stat.size > KNOWLEDGE_LIMITS.fileBytes) { fail(scope, `${name(path)}: файл больше ${KNOWLEDGE_LIMITS.fileBytes} байт`); return null }
    if (bytes + selected.stat.size > KNOWLEDGE_LIMITS.bytes) { limit(`${KNOWLEDGE_LIMITS.bytes} байт`); return null }
    try {
      const source = readFileSync(selected.path, 'utf8')
      const size = Buffer.byteLength(source)
      if (size > KNOWLEDGE_LIMITS.fileBytes || bytes + size > KNOWLEDGE_LIMITS.bytes) { limit('размер изменившегося при чтении файла'); return null }
      const file = { path: name(selected.path), content: source }
      files.set(selected.path, file); bytes += size
      return file
    } catch (error) { fail(check, `${name(path)}: чтение не удалось (${error.code || error.message})`); return null }
  }

  function yaml(file, check) {
    try {
      const data = parseYaml(file.content)
      if (!object(data)) { fail(check, `${file.path}: ожидается YAML-объект`); return null }
      return data
    } catch (error) { fail(check, `${file.path}: невалидный YAML: ${error.message}`); return null }
  }

  function validateMetadata(data, path, article = false) {
    if (!object(data)) { fail(metadata, `${path}: ожидается YAML-объект`); return }
    if (article ? !nonempty(data.title) : data.title !== undefined && !nonempty(data.title)) fail(metadata, `${path}: title должен быть непустой строкой`)
    for (const field of ['description', 'icon', 'cover']) if (data[field] != null && typeof data[field] !== 'string') fail(metadata, `${path}: ${field} должен быть строкой`)
    for (const field of ['publicAccessMode', 'agentAccessMode']) if (data[field] !== undefined && !['inherit', 'enabled', 'disabled'].includes(data[field])) fail(metadata, `${path}: неверный ${field}`)
    if (data.isNew !== undefined && typeof data.isNew !== 'boolean') fail(metadata, `${path}: isNew должен быть boolean`)
    if (data.archivedBy != null && !nonempty(data.archivedBy)) fail(metadata, `${path}: archivedBy должен быть непустой строкой или null`)
    if (data.archivedAt != null && (typeof data.archivedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(data.archivedAt) || !Number.isFinite(Date.parse(data.archivedAt)))) fail(metadata, `${path}: archivedAt должен быть ISO-датой со временем или null`)
    if (data.order !== undefined) {
      if (!Array.isArray(data.order)) fail(metadata, `${path}: order должен быть массивом`)
      else {
        const seen = new Set()
        for (const item of data.order) {
          if (!nonempty(item) || item !== item.trim() || /[/\\\0]/.test(item) || ['.', '..'].includes(item)) { fail(metadata, `${path}: order содержит некорректное имя непосредственного ребёнка`); continue }
          if (seen.has(item)) fail(metadata, `${path}: повтор в order: ${item}`)
          seen.add(item)
          // Ancestors/shared business metadata must not pull unrelated articles into scope.
          if (kbPath && inside(kbPath, dirname(join(root, path)))) {
            const child = safe(join(dirname(join(root, path)), item), metadata, false, true)
            if (child && !child.stat.isDirectory() && !(child.stat.isFile() && markdown(child.path))) fail(metadata, `${path}: order ${item} должен указывать на статью .md или раздел`)
          }
        }
      }
    }
  }

  function directoryMetadata(dir) {
    while (inside(join(root, '.knowledge-base'), dir)) {
      if (!metadataDirs.has(dir)) {
        metadataDirs.add(dir)
        const file = read(join(dir, '.knowledge.yml'), { check: metadata, optional: true, kbOnly: true })
        if (file) { const data = yaml(file, metadata); if (data) validateMetadata(data, file.path) }
        else if (kbPath && inside(kbPath, dir)) fail(metadata, `${name(dir)}/.knowledge.yml: нет метаданных раздела`)
        else warn(metadata, `${name(dir)}/.knowledge.yml: нет метаданных общего раздела`)
      }
      if (dir === join(root, '.knowledge-base')) break
      dir = dirname(dir)
    }
  }

  function addArticle(path) {
    const file = read(path, { kbOnly: true })
    if (!file) return
    directoryMetadata(dirname(join(root, file.path)))
    if (!inspectedArticles.has(file.path)) { inspectedArticles.add(file.path); articleQueue.push(file) }
  }

  function walk(dir) {
    if (exhausted) return
    const selected = safe(dir, scope, false, true)
    if (!selected) return
    if (!selected.stat.isDirectory()) { fail(scope, `${name(dir)}: ожидается каталог знаний`); return }
    if (kbPath && !inside(kbPath, selected.path)) { fail(scope, `${name(dir)}: каталог выходит за раздел процесса; свяжите нужную статью Markdown-ссылкой`); return }
    if (directories.has(selected.path)) return
    directories.add(selected.path)
    directoryMetadata(selected.path)
    let names
    try { names = readdirSync(selected.path).sort() }
    catch (error) { fail(scope, `${name(dir)}: обход не удался (${error.code || error.message})`); return }
    for (const entry of names) {
      if (++entries > KNOWLEDGE_LIMITS.entries) { limit(`${KNOWLEDGE_LIMITS.entries} записей каталогов`); return }
      if (['.git', 'node_modules'].includes(entry)) continue
      const path = join(selected.path, entry), item = safe(path, scope, false, true)
      if (!item) continue
      if (item.stat.isDirectory()) walk(item.path)
      else if (markdown(entry)) addArticle(item.path)
      if (exhausted) return
    }
  }

  function followLinks(file, source) {
    const found = linksIn(source)
    for (const entry of found.undefinedReferences) fail(links, `${file.path}: нет определения Markdown-ссылки [${entry.id}]`)
    for (const { target } of found.links) {
      let url = target.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g, '$1').replace(/&amp;/g, '&')
      if (!url || url.startsWith('#') || url.startsWith('?')) continue
      if (/^file:/i.test(url)) { fail(links, `${file.path}: запрещён локальный file: URL`); continue }
      if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//')) continue
      const raw = url.split(/[?#]/, 1)[0]
      try { url = decodeURIComponent(raw) }
      catch { fail(links, `${file.path}: некорректная кодировка URL ${target}`); continue }
      if (/[\0\\]/.test(url)) { fail(links, `${file.path}: небезопасный путь ссылки ${target}`); continue }
      let path
      if (url.startsWith('/app/knowledge/~/')) path = resolve(root, '.knowledge-base', url.slice('/app/knowledge/~/'.length))
      else if (url.startsWith('/app/knowledge/')) { warn(links, `${file.path}: ссылка на reader по ID не проверяется статически: ${target}`); continue }
      else if (/^\/?\.knowledge-base\//.test(url)) path = resolve(root, url.replace(/^\//, ''))
      else path = url.startsWith('/') ? resolve(root, `.${url}`) : resolve(dirname(join(root, file.path)), url)
      const item = safe(path, links, false, url.startsWith('/app/knowledge/~/'))
      if (!item) { fail(links, `${file.path}: не разрешается ссылка ${target}`); continue }
      if (inside(join(root, '.knowledge-base'), path) && !inside(join(root, '.knowledge-base'), item.path)) { fail(links, `${file.path}: ссылка ${target} выходит из базы знаний через symlink`); continue }
      if (inside(join(root, '.knowledge-base'), item.path) && markdown(item.path) && item.stat.isFile()) {
        if (file.path.startsWith('.knowledge-base/') && !url.startsWith('/app/knowledge/~/')) warn(links, `${file.path}: ссылка ${target} существует, но reader требует /app/knowledge/~/…`)
        addArticle(item.path)
      }
      if (inside(materialsPath, item.path) && item.stat.isFile()) linkedMaterials.add(item.path)
    }
  }

  const mapFile = read(join(root, slug, 'process.yaml'), { optional: true })
  if (!mapFile) warn(scope, `${slug}/process.yaml: карты пока нет; это допустимо до планирования`)
  const map = mapFile ? yaml(mapFile, scope) : null
  let selectedKnowledge = map?.knowledge ?? `.knowledge-base/processes/${slug}`
  if (!nonempty(selectedKnowledge) || isAbsolute(selectedKnowledge) || selectedKnowledge.includes('\\') || selectedKnowledge.includes('\0')) {
    fail(scope, `${slug}/process.yaml: knowledge должен быть относительным путём внутри .knowledge-base/`)
    selectedKnowledge = null
  }
  if (selectedKnowledge) {
    const candidate = resolve(root, selectedKnowledge)
    if (candidate === join(root, '.knowledge-base') || !inside(join(root, '.knowledge-base'), candidate)) fail(scope, `${slug}/process.yaml: knowledge должен указывать на раздел внутри .knowledge-base/`)
    else {
      const selected = safe(candidate, scope, false, true)
      if (selected) { kbPath = selected.path; walk(kbPath) }
    }
  }
  const plan = read(join(root, slug, 'PLAN.md'), { optional: true })
  if (plan) followLinks(plan, reviewPlan(plan.content))
  else warn(scope, `${slug}/PLAN.md: плана пока нет; это допустимо до планирования`)
  if (!articleQueue.some(file => kbPath && inside(kbPath, join(root, file.path)))) fail(scope, 'В разделе знаний процесса нет статей .md')
  // The queue may grow when a business article links to another relevant article.
  for (let i = 0; i < articleQueue.length; i++) {
    const file = articleQueue[i], parsed = frontmatter(file.content)
    if (parsed.error) fail(metadata, `${file.path}: ${parsed.error}`)
    else validateMetadata(parsed.data, file.path, true)
    const body = parsed.body.replace(/<!--[\s\S]*?-->/g, '')
    const withoutHeadings = body.replace(/^\s{0,3}#{1,6}\s.*$/gm, '')
    if (!/[\p{L}\p{N}]/u.test(withoutHeadings)) fail(content, `${file.path}: нет содержательного тела статьи`)
    for (const [lineIndex, line] of prose(body).split('\n').entries()) {
      const at = `${file.path}:${lineIndex + 1 + (parsed.offset || 0)}`
      if (/^\s*(?:>\s*)?(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s*)?(?:…|\.{3}|TODO|TBD)\s*$/i.test(line) || /(?<![\p{L}\p{N}_])(?:TODO|TBD|FIXME)\s*:|\[(?:TODO|TBD|FIXME)\]/iu.test(line)) fail(content, `${at}: явная незаполненная заглушка`)
      if (/(?<![\p{L}\p{N}_])(?:возможно|предположительно|ориентировочно|вероятно)(?![\p{L}\p{N}_])/iu.test(line)) warn(content, `${at}: неопределённая формулировка; проверьте, обозначены ли допущение и способ его проверки`)
    }
    followLinks(file, parsed.body)
  }
  function scanMaterials(dir) {
    const selected = safe(dir, scope, false)
    if (!selected) return
    if (!selected.stat.isDirectory() || !inside(materialsPath, selected.path)) {
      fail(scope, `${name(dir)}: каталог оригиналов недоступен или выходит за пределы процесса`); return
    }
    if (materialDirs.has(selected.path)) return
    materialDirs.add(selected.path)
    let names
    try { names = readdirSync(selected.path).sort() }
    catch (error) { fail(scope, `${name(dir)}: обход оригиналов не удался (${error.code || error.message})`); return }
    for (const entry of names) {
      if (++entries > KNOWLEDGE_LIMITS.entries) { limit(`${KNOWLEDGE_LIMITS.entries} записей каталогов`); return }
      const path = join(selected.path, entry), item = safe(path)
      if (!item) continue
      if (!inside(materialsPath, item.path)) { fail(scope, `${name(path)}: оригинал выходит за каталог процесса`); continue }
      if (item.stat.isDirectory()) { scanMaterials(item.path); continue }
      if (!item.stat.isFile()) { fail(scope, `${name(path)}: ожидается обычный файл`); continue }
      if (sourceMaterials.length >= MATERIAL_LIMITS.files || item.stat.size > MATERIAL_LIMITS.fileBytes ||
          materialBytes + item.stat.size > MATERIAL_LIMITS.bytes) {
        fail(scope, `${name(path)}: превышен лимит оригиналов; полнота материалов не подтверждена`); continue
      }
      let content
      try { content = readFileSync(item.path) }
      catch (error) { fail(scope, `${name(path)}: чтение оригинала не удалось (${error.code || error.message})`); continue }
      if (content.length > MATERIAL_LIMITS.fileBytes || materialBytes + content.length > MATERIAL_LIMITS.bytes) {
        fail(scope, `${name(path)}: размер оригинала изменился при чтении и превысил лимит`); continue
      }
      sourceMaterials.push({ path: name(item.path), sha256: createHash('sha256').update(content).digest('hex'), bytes: content.length })
      materialBytes += content.length
      if (!linkedMaterials.has(item.path)) warn(links, `${name(path)}: оригинал не указан ссылкой в знаниях или плане; reviewer всё равно получит его путь`)
    }
  }
  const materialDir = safe(materialsPath, scope, true)
  if (materialDir) scanMaterials(materialsPath)
  for (const check of checks) check.ok = check.errors.length === 0
  return { files: [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    sourceMaterials, checks, passed: checks.filter(check => check.ok).length, total: checks.length, processPath: slug }
}
