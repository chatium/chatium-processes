import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// These files belong to Start's former process planner. events.yaml and version: 2
// are deliberately absent: neither distinguishes the two generations.
const LEGACY_PATHS = ['specs/index.yaml', 'specs/passport-sections', 'specs/passport-section-parts',
  'specs/workspaces', 'specs/workspaces.yaml', 'spec/current.yml', 'specs/current.md']
export const PROCESS_ENGINE = 'processes-v2'
const record = value => value && typeof value === 'object' && !Array.isArray(value)

/** Read-only, conservative classification. Missing or conflicting evidence never authorizes migration. */
export function inspectProcessFormat(root, requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath || isAbsolute(requestedPath) ||
      requestedPath.split(/[\\/]/).some(p => !p || p === '.' || p === '..') || /[\\\u0000-\u001f]/.test(requestedPath))
    throw Error('Нужен относительный путь внутри аккаунта без .. и обратных слешей.')
  root = realpathSync(root)
  const target = resolve(root, requestedPath)
  const evidence = [], errors = []
  const inside = path => {
    if (!existsSync(path)) return false
    const rel = relative(root, realpathSync(path))
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error('Путь выходит за пределы аккаунта.')
    return true
  }
  const readMetadata = path => {
    if (!inside(path)) return null
    evidence.push(relative(root, path).split(sep).join('/'))
    try {
      if (statSync(path).size > 256 * 1024) throw Error('слишком большой файл метаданных')
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (!record(value)) throw Error('ожидается JSON-объект')
      return value
    } catch (error) {
      errors.push(`${relative(root, path)}: ${error.message}`)
      return null
    }
  }
  let dir = target, workspacePath = null, workspaceType = null, appearance = null, owner = null
  if (inside(dir) && !statSync(dir).isDirectory()) dir = dirname(dir)
  const targetDir = dir
  // Only ancestors and known marker paths; no recursive scan of the account or runtime data.
  for (let depth = 0; dir !== root && depth < 64; depth++, dir = dirname(dir)) {
    inside(dir)
    const wsFile = join(dir, '.workspace.json'), metaFile = join(dir, '.dir.json')
    const ws = readMetadata(wsFile), meta = readMetadata(metaFile)
    const here = relative(root, dir).split(sep).join('/')
    if (workspacePath === null && existsSync(wsFile)) {
      workspacePath = here; workspaceType = ws?.type ?? null
      appearance = meta?.params?.startWorkspaceAppearance ?? null
    }
    const legacy = LEGACY_PATHS.filter(p => inside(join(dir, p)))
    const plan = inside(join(dir, 'PLAN.md')), map = inside(join(dir, 'process.yaml'))
    if (plan) evidence.push(`${here}/PLAN.md`)
    if (map) evidence.push(`${here}/process.yaml`)
    evidence.push(...legacy.map(p => `${here}/${p}`))
    const hasEngine = ws && Object.hasOwn(ws, 'processEngine')
    if (hasEngine && (ws.processEngine !== PROCESS_ENGINE || ws.type !== 'process'))
      errors.push(`${here}/.workspace.json: неподдерживаемый processEngine или несовместимый type; ожидается type: process, processEngine: ${PROCESS_ENGINE}`)
    const modern = ws?.type === 'process' && ws.processEngine === PROCESS_ENGINE
    const process = ws?.type === 'process' || meta?.params?.startWorkspaceAppearance === 'process'
    const child = meta?.params?.startWorkspaceAppearance === 'process-workspace'
    // A child workspace in a process is incompatible with the new single-workspace layout.
    let nestedWorkspace = false
    if (process && inside(dir)) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === '.git') continue
        if (inside(join(dir, entry.name, '.workspace.json'))) {
          evidence.push(`${here}/${entry.name}/.workspace.json`)
          nestedWorkspace = true
          break
        }
      }
    }
    const old = legacy.length > 0 || child || nestedWorkspace
    const format = old ? (modern || plan || map ? 'mixed' : 'legacy') : modern ? 'skill' : 'unknown'
    if (!owner && (process || hasEngine || old || plan || map)) {
      owner = { processPath: here, format, component: dir !== targetDir || child }
    } else if (owner && (process || legacy.some(p => p.startsWith('specs/')))) {
      // A nested workspace cannot escape its parent's generation by adding a new map.
      owner = { processPath: here, component: true,
        format: [owner.format, format].some(f => f === 'mixed' || f === 'skill') ? 'mixed' :
          [owner.format, format].includes('legacy') ? 'legacy' : 'unknown' }
      break
    }
  }
  if (errors.length) owner = { ...owner, format: 'unknown' }
  let kind = owner ? `${owner.format}-process` : workspacePath ? 'workspace' : inside(target) ? 'directory' : 'missing'
  if (owner?.component) kind = `${owner.format}-component`
  return { path: requestedPath, kind, format: owner?.format ?? null,
    processPath: owner?.processPath ?? null, workspacePath, workspaceType, appearance,
    evidence: [...new Set(evidence)], errors,
    canUseSkillWorkflow: kind === 'skill-process' && requestedPath === owner?.processPath,
    canCreateProcess: kind === 'missing' || kind === 'directory' && lstatSync(target).isDirectory() && readdirSync(target).length === 0,
  }
}

export function assertSkillProcess(root, path, { creating = false } = {}) {
  const result = inspectProcessFormat(root, path)
  if (result.canUseSkillWorkflow || creating && result.canCreateProcess) return result
  throw Error(`Формат ${path}: ${result.kind}. Новая процедура не применяется автоматически. ` +
    `См. build/legacy-processes.md. Признаки: ${result.evidence.join(', ') || 'недостаточно данных'}. ` +
    (result.errors.join('; ') || `Для новой процедуры нужен явный processEngine: ${PROCESS_ENGINE}; не добавляй его старому процессу ради обхода проверки.`))
}
