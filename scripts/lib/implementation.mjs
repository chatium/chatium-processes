// Bounded, read-only source collection. Import scanning is a discovery aid, not
// proof of a complete call graph; the reviewer must check scope and dynamic use.
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { collectKnowledge } from './knowledge.mjs'
import { parseYaml } from './yaml.mjs'
import { isProcessSlug, rel } from './project.mjs'

export const IMPLEMENTATION_LIMITS = Object.freeze({ files: 800, bytes: 8 * 1024 * 1024, fileBytes: 1024 * 1024, entries: 10000 })
const hash = value => createHash('sha256').update(value).digest('hex')
const inside = (root, path) => path === root || path.startsWith(root + sep)
const TEXT = /\.(?:[cm]?[jt]sx?|vue|json|ya?ml|md|html?|css|scss|sass|less|sql|svg|txt|tpl|lock)$/i
const CODE = /\.(?:[cm]?[jt]sx?|vue)$/i
const OMIT = new Set(['node_modules', '.git', '.typings', 'coverage', '.cache'])
const secretName = name => /^\.env(?:\.|$)|^(?:credentials|secrets?)\.(?:json|ya?ml)$/i.test(name)

export function collectImplementation({ root, slug }) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  root = realpathSync(resolve(root))
  const knowledge = collectKnowledge({ root, slug })
  const files = new Map(), assets = new Map(), visited = new Set(), queue = [], dependencies = []
  const errors = knowledge.checks.flatMap(c => c.errors), warnings = knowledge.checks.flatMap(c => c.warnings)
  let bytes = 0, entries = 0, exhausted = false
  const addError = value => { if (!errors.includes(value)) errors.push(value) }
  const excluded = path => {
    const parts = relative(root, path).split(sep)
    return parts.some(p => OMIT.has(p)) || (parts[0] === slug && ['reviews', 'decisions'].includes(parts[1]))
  }
  function safe(path, explicit = false) {
    if (!inside(root, path)) { addError(`Путь вне аккаунта: ${rel(root, path)}`); return null }
    try {
      lstatSync(path)
      const real = realpathSync(path)
      if (!inside(root, real)) { addError(`Ссылка вне аккаунта: ${rel(root, path)}`); return null }
      // Explicit declarations are allowed; never traverse installed/generated code.
      const declaration = explicit && real.endsWith('.d.ts') && statSync(real).isFile() &&
        (real.includes(`${sep}.typings${sep}`) || real.includes(`${sep}node_modules${sep}`))
      if (excluded(real) && !declaration) {
        if (explicit) addError(`Нельзя включить служебный каталог/отчёт: ${rel(root, path)}`)
        return null
      }
      return real
    } catch (e) { addError(`Не прочитан ${rel(root, path)}: ${e.code || e.message}`); return null }
  }
  function add(path, explicit = false) {
    const real = safe(resolve(path), explicit)
    if (!real || files.has(rel(root, real)) || assets.has(rel(root, real)) || exhausted) return
    const stat = statSync(real)
    if (stat.isDirectory()) {
      if (visited.has(real)) return
      visited.add(real)
      for (const name of readdirSync(real).sort()) {
        if (++entries > IMPLEMENTATION_LIMITS.entries) { exhausted = true; addError('Превышен лимит обхода исходников; пакет неполон.'); break }
        if (OMIT.has(name) || (real === join(root, slug) && ['reviews', 'decisions'].includes(name))) continue
        add(join(real, name))
      }
      return
    }
    if (!stat.isFile()) { addError(`Необычный тип файла: ${rel(root, real)}`); return }
    if (secretName(real.split(sep).at(-1))) { addError(`Секретный конфиг не включён: ${rel(root, real)}. Уберите секреты из исходников и опишите безопасный контракт.`); return }
    if (files.size + assets.size >= IMPLEMENTATION_LIMITS.files || bytes + stat.size > IMPLEMENTATION_LIMITS.bytes || stat.size > IMPLEMENTATION_LIMITS.fileBytes) {
      exhausted = true; addError('Превышен лимит размера/числа исходников; пакет неполон. Разделите согласованный объём ревью.'); return
    }
    const data = readFileSync(real), pathRel = rel(root, real)
    if (bytes + data.length > IMPLEMENTATION_LIMITS.bytes || data.length > IMPLEMENTATION_LIMITS.fileBytes) {
      exhausted = true; addError('Файл изменился/превысил лимит при чтении; пакет неполон.'); return
    }
    bytes += data.length
    if (!TEXT.test(real) || data.includes(0)) assets.set(pathRel, { path: pathRel, bytes: data.length, sha256: hash(data) })
    else {
      const file = { path: pathRel, content: data.toString('utf8') }
      files.set(pathRel, file)
      if (CODE.test(real) || real.endsWith('.automationConfig.json')) queue.push(file)
    }
  }
  for (const file of knowledge.files) add(join(root, file.path), true)
  add(join(root, slug), true)
  const mapFile = files.get(`${slug}/process.yaml`)
  // Root account/configuration and manifests influence aliases and runtime behavior.
  for (const name of ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'tsconfig.json', '.workspace.json', '.dir.json'])
    if (existsSync(join(root, name))) add(join(root, name), true)
  // Central letters and mapped local nodes/automations are not necessarily below slug/.
  let map
  try { map = mapFile ? parseYaml(mapFile.content) : null }
  catch (e) { addError(`process.yaml: ${e.message}`) }
  if (!map || !Array.isArray(map.nodes)) addError('Для ревью реализации нужна карта с nodes.')
  function localPath(value, label) {
    if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value) || !inside(root, resolve(root, value))) {
      addError(`Некорректный локальный путь ${label}`); return null
    }
    return resolve(root, value)
  }
  function mapped(value) {
    if (typeof value !== 'string' || /^(?:[a-z]+:)?\/\//i.test(value)) return
    const path = localPath(value, value)
    if (path) add(path, true)
  }
  const letters = map?.letters || `.mailings/storage/processes/${slug}`
  if (map?.letters || (map?.nodes || []).some(node => node.kind === 'series') || existsSync(join(root, letters))) mapped(letters)
  for (const node of map?.nodes || []) mapped(node?.source)
  for (const link of map?.links || []) if (link?.via) mapped(link.via)

  let scope = { version: 1, include: [], dynamic: [] }
  const scopeFile = files.get(`${slug}/review-scope.json`)
  try {
    if (scopeFile) scope = JSON.parse(scopeFile.content)
    if (scope.version !== 1 || !Array.isArray(scope.include || []) || !Array.isArray(scope.dynamic || [])) throw Error('нужны version: 1, include?: [], dynamic?: []')
    for (const entry of scope.include || []) { const path = localPath(entry, 'review-scope.include'); if (path) add(path, true) }
    for (const entry of scope.dynamic || []) {
      if (!entry || typeof entry.source !== 'string' || typeof entry.reason !== 'string' || !entry.reason.trim() || !Array.isArray(entry.paths) || !entry.paths.length)
        throw Error('dynamic: нужны source, reason и непустой paths')
      if (!localPath(entry.source, 'dynamic.source')) continue
      for (const path of entry.paths) { const abs = localPath(path, 'dynamic.paths'); if (abs) add(abs, true) }
    }
  } catch (e) { addError(`review-scope.json: ${e.message}`); scope = { version: 1, include: [], dynamic: [] } }

  const aliases = []
  let baseUrl
  try {
    const tsconfig = files.get('tsconfig.json')
    if (tsconfig) {
      const config = JSON.parse(stripComments(tsconfig.content).replace(/,\s*([}\]])/g, '$1'))
      baseUrl = config.compilerOptions?.baseUrl
      if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !inside(root, resolve(root, baseUrl)))) throw Error('baseUrl выходит за аккаунт')
      if (config.extends) addError('tsconfig.extends требует явного разрешения aliases в локальном tsconfig для полного пакета ревью.')
      for (const [pattern, targets] of Object.entries(config.compilerOptions?.paths || {})) {
        if (pattern.split('*').length > 2) throw Error('в paths поддерживается один wildcard')
        if (!Array.isArray(targets) || !targets.every(v => typeof v === 'string')) throw Error('неверный paths')
        aliases.push({ pattern, targets, base: config.compilerOptions?.baseUrl || '.' })
      }
    }
  } catch (e) { addError(`Не разобраны aliases tsconfig: ${e.message}`) }
  aliases.sort((a,b) => {
    const ai = a.pattern.indexOf('*'), bi = b.pattern.indexOf('*')
    return (bi < 0 ? Infinity : bi) - (ai < 0 ? Infinity : ai) || 0
  })
  const resolutions = base => {
    // Chatium commonly omits .ts in foo.table and route imports.
    const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json', '.d.ts'].map(ext => base + ext),
      ...['index.ts', 'index.tsx', 'index.js', 'index.vue'].map(name => join(base, name))]
    return candidates.find(path => inside(root, path) && existsSync(path) && statSync(path).isFile())
  }
  function resolveImport(source, specifier) {
    if (specifier === '.' || specifier === '..' || specifier.startsWith('./') || specifier.startsWith('../')) return { local: true, candidates: [resolve(root, dirname(source), specifier)] }
    if (specifier.startsWith('/')) return { local: true, candidates: [resolve(root, '.' + specifier)] }
    if (specifier.startsWith('~/')) return { local: true, candidates: [resolve(root, specifier.slice(2))] }
    for (const { pattern, targets, base } of aliases) {
      const at = pattern.indexOf('*')
      const match = at < 0 ? specifier === pattern : specifier.startsWith(pattern.slice(0, at)) && specifier.endsWith(pattern.slice(at + 1))
      if (!match) continue
      const part = at < 0 ? '' : specifier.slice(at, specifier.length - (pattern.length - at - 1))
      return { local: true, candidates: targets.map(target => resolve(root, base, target.replace('*', part))) }
    }
    if (baseUrl !== undefined) {
      const candidate = resolve(root, baseUrl, specifier)
      if (resolutions(candidate)) return { local: true, candidates: [candidate] }
    }
    return { local: false, candidates: [] }
  }
  for (let i = 0; i < queue.length; i++) {
    const file = queue[i]
    // Configuration reached through an import must be traversed too.
    if (file.path.endsWith('.automationConfig.json')) {
      try {
        const visit = value => {
          if (!value || typeof value !== 'object') return
          if (Array.isArray(value.routeJson) && typeof value.routeJson[1] === 'string') {
            const [account, module] = value.routeJson
            if (!Number.isInteger(account) || account <= 0) {
              addError(`${file.path}: routeJson требует положительный числовой accountId для ${module}; null не означает общий маршрут`)
            } else if (!Number.isInteger(map?.accountId) || map.accountId <= 0) {
              addError(`${file.path}: нужен accountId карты для определения области routeJson ${module}`)
            } else if (account === map.accountId) {
              const base = localPath(module, `${file.path}: routeJson`)
              const target = base && resolutions(base)
              if (!target) addError(`${file.path}: нет исходника routeJson ${module}`)
              else { add(target, true); dependencies.push({ source: file.path, kind: 'configured-local', target: rel(root, target) }) }
            } else dependencies.push({ source: file.path, kind: 'configured-external', account, module })
          }
          for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child)
        }
        visit(JSON.parse(file.content))
      } catch (e) { addError(`${file.path}: ${e.message}`) }
      continue
    }
    for (const found of importSpecifiers(file.content)) {
      if (found.dynamic) {
        const declared = (scope.dynamic || []).find(entry => entry.source === file.path)
        dependencies.push({ source: file.path, kind: 'dynamic', declared: Boolean(declared) })
        if (!declared) addError(`${file.path}: вычисляемая зависимость. Укажите её конечные исходники в review-scope.json (dynamic) и обоснование.`)
        continue
      }
      const selected = resolveImport(file.path, found.specifier)
      if (!selected.local) { dependencies.push({ source: file.path, specifier: found.specifier, kind: 'external' }); continue }
      const target = selected.candidates.map(resolutions).find(Boolean)
      if (!target) { addError(`${file.path}: не разрешена зависимость ${found.specifier}`); continue }
      dependencies.push({ source: file.path, specifier: found.specifier, kind: 'local', target: rel(root, target) })
      add(target, true)
    }
  }
  const plan = files.get(`${slug}/PLAN.md`)
  const tasks = [...(plan?.content || '').matchAll(/^- \[( |x|X)\] (T\d+)(?:[ \t]+(.*))?$/gm)]
    .map(m => ({ id: m[2], title: (m[3] || '').trim(), markedDone: m[1] !== ' ' }))
  if (!tasks.length || tasks.some(t => !t.title || t.title === '…')) addError('В PLAN.md нет конкретных задач T1… для сопоставления с реализацией.')
  if (new Set(tasks.map(t => t.id)).size !== tasks.length) addError('В PLAN.md повторяются ID задач.')
  return { files: [...files.values()].sort((a,b) => a.path.localeCompare(b.path, 'en')), assets: [...assets.values()].sort((a,b) => a.path.localeCompare(b.path, 'en')),
    dependencies, tasks, scope, checks: [{ id: 'implementation-scope', title: 'Полнота пакета исходников', ok: !errors.length, errors, warnings }] }
}

// Tiny lexical scanner for discovering module specifiers without interpreting
// comments or quoted code snippets as imports. It does not execute source code.
function tokens(source) {
  const out = []
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (/\s/.test(c)) { i++; continue }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i + 2); i = end < 0 ? source.length : end; continue }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue }
    if (['"', "'", '`'].includes(c)) {
      const start = i++, quote = c
      let value = '', dynamic = false
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') { value += source.slice(i, i + 2); i += 2; continue }
        if (quote === '`' && source.startsWith('${', i)) dynamic = true
        value += source[i++]
      }
      i++
      out.push({ kind: 'string', value, dynamic, start, end: i }); continue
    }
    const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i))
    if (word) { out.push({ kind: 'word', value: word[0], start: i, end: i + word[0].length }); i += word[0].length; continue }
    out.push({ kind: 'punctuation', value: c, start: i, end: i + 1 }); i++
  }
  return out
}
function stripComments(source) {
  // Keep strings intact while removing comments, including JSONC tsconfig.
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, value => value.startsWith('/') ? ' ' : value)
}
export function importSpecifiers(source) {
  const result = [], list = tokens(source)
  for (let i = 0; i < list.length; i++) {
    const token = list[i], next = list[i + 1]
    if (token.kind !== 'word' || !['import', 'export', 'require'].includes(token.value)) continue
    if (token.value === 'import' && next?.value === '.') continue // import.meta
    if (next?.value === '(' && token.value !== 'export') {
      const arg = list[i + 2], close = list[i + 3]
      result.push(arg?.kind === 'string' && !arg.dynamic && [')', ','].includes(close?.value)
        ? { specifier: arg.value } : { dynamic: true })
    } else if (token.value === 'import' && next?.kind === 'string') result.push({ specifier: next.value })
    else if (token.value === 'import' || (token.value === 'export' && ['*', '{', 'type'].includes(next?.value))) {
      for (let j = i + 1; j < Math.min(i + 120, list.length); j++) {
        if ([';', 'import', 'export'].includes(list[j].value)) break
        if (list[j].value === 'from' && list[j + 1]?.kind === 'string') { result.push({ specifier: list[j + 1].value }); break }
      }
    }
  }
  return result
}
