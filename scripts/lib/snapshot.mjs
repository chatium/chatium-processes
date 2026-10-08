// Snapshot producer. All paths are account-relative; publication is a separate step.
import { templatePath } from './letters.mjs'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isDir, isFile, walk, rel } from './project.mjs'
import { parseYaml } from './yaml.mjs'
import { git, gitState, assertPublishedState, SnapshotDrift } from './git-state.mjs'
import { STAGE_CHECKS } from './snapshot-stage.mjs'

function safePath(root, value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.replace(/\/$/, '').split('/').some(p => !p || p === '.' || p === '..')) throw Error('Unsafe snapshot source path')
  const file = resolve(root, value)
  if (!file.startsWith(resolve(root) + sep)) throw Error('Snapshot source escapes account')
  if (existsSync(file) && !realpathSync(file).startsWith(realpathSync(root) + sep)) throw Error('Snapshot source symlink escapes account')
  return file
}
function delayText(delay) {
  if (delay?.type === 'delay') return `${delay.amount} ${{ seconds: 'сек.', minutes: 'мин.', hours: 'ч.', days: 'дн.' }[delay.units] || delay.units}`
  if (delay?.type === 'exactTime') return `До ${delay.exactTime}`
  if (delay?.type === 'waitForTime') {
    const days = { monday: 'пн', tuesday: 'вт', wednesday: 'ср', thursday: 'чт', friday: 'пт', saturday: 'сб', sunday: 'вс' }
    return `${(delay.weekdays || []).map(d => days[d] || d).join(', ')} в ${delay.weekdayTime}`
  }
  return 'До даты, заданной условием процесса'
}
// A shared automation may send several series. Keep the timing/conditions
// leading to this destination, but do not attribute other series to the link.
function stepsForSeries(steps, source) {
  if (!source) return steps
  const prefix = source.replace(/\/$/, '') + '/'
  const belongs = step => templatePath(step)?.startsWith(prefix)
  const contains = step => belongs(step) || (step?.thenBranch?.steps || []).some(contains) || (step?.elseBranch?.steps || []).some(contains)
  const last = steps.findLastIndex(contains)
  if (last < 0) return []
  return steps.slice(0, last + 1).flatMap(step => {
    if (step.type === 'action' && templatePath(step) && !belongs(step)) return []
    if (step.type === 'condition' || step.type === 'draft') return [{ ...step, thenBranch: { steps: stepsForSeries(step.thenBranch?.steps || [], source) }, elseBranch: { steps: stepsForSeries(step.elseBranch?.steps || [], source) } }]
    return [step]
  })
}
function walkSteps(steps, prefix = '', out = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (out.length >= 100) throw Error('Too many automation steps for snapshot')
    if (step.type === 'delay') out.push({ kind: 'delay', title: prefix + 'Ожидание', detail: step.description || delayText(step.delay) })
    else if (step.type === 'condition' || step.type === 'continueCondition') {
      out.push({ kind: 'condition', title: prefix + (step.conditionName || step.title || 'Условие'), detail: step.description || (step.type === 'continueCondition' ? 'Продолжить, только если условие выполнено' : 'Два пути: условие выполнено или нет') })
      walkSteps(step.thenBranch?.steps, prefix + 'Если да · ', out)
      walkSteps(step.elseBranch?.steps, prefix + 'Если нет · ', out)
    } else if (step.type === 'action') out.push({ kind: 'action', title: prefix + (step.actionName || step.title || 'Действие'), detail: step.description || '' })
    else if (step.type === 'draft') {
      out.push({ kind: 'condition', title: prefix + 'Не настроено', detail: step.description || '' })
      walkSteps(step.thenBranch?.steps, prefix + 'Если да · ', out)
      walkSteps(step.elseBranch?.steps, prefix + 'Если нет · ', out)
    }
  }
  return out
}
function boundedMessages(messages) {
  const values = Array.isArray(messages) ? messages : []
  return values.slice(0, 99).map(value => String(value || 'Пустое сообщение').slice(0, 2000))
    .concat(values.length > 99 ? [`И ещё ${values.length - 99} замечаний; полный вывод — в check.`] : [])
}
export function buildSnapshot({ root, slug, map, checks, branch, commit, checkedAt = new Date().toISOString() }) {
  if (!map || !Array.isArray(map.stages) || !Array.isArray(map.nodes) || checks.some(c => c.id === 'map' && !c.ok)) throw Error('Cannot publish an invalid process map')
  if (checks.length > 100) throw Error('Снимок поддерживает не более 100 проверок. Сгруппируйте проверки до публикации.')
  const rawNeeds = map.needsInput ?? []
  if (!Array.isArray(rawNeeds) || rawNeeds.length > 100) throw Error('Invalid needsInput')
  const needsInput = rawNeeds.map(item => typeof item === 'string' ? { title: item } : { title: item.title, ...(item.nodeId ? { nodeId: item.nodeId } : {}) })
  const stableChecks = checks.filter(check => !STAGE_CHECKS.has(check.id))
  const allErrors = stableChecks.flatMap(c => c.errors)
  const nodes = map.nodes.map(node => {
    const source = safePath(root, node.source), present = isFile(source) || isDir(source)
    const agentPath = node.source.endsWith('.agent.json') ? node.source : undefined
    if (node.agentId !== undefined && (!agentPath || typeof node.agentId !== 'string' || !node.agentId.trim() || node.agentId.length > 200 || /[\u0000-\u001f]/.test(node.agentId))) throw Error('Invalid agentId')
    const localErrors = allErrors.filter(e => e.includes(node.source.replace(/\/$/, '')) || e.includes(`«${node.id}»`))
    const needed = needsInput.filter(i => i.nodeId === node.id)
    const status = !present ? 'missing' : localErrors.length ? 'error' : needed.length ? 'needs-input' : 'ready'
    const letters = node.kind === 'series' && isDir(source) ? walk(source).filter(p => p.endsWith('.message.yaml')).sort().map(file => {
      safePath(root, rel(root, file))
      try { const l = parseYaml(readFileSync(file, 'utf8')); return { title: l.title || 'Письмо', subject: l.subject || '', source: rel(root, file) } }
      catch { return { title: 'Письмо не разбирается', subject: '', source: rel(root, file) } }
    }) : undefined
    return { id: node.id, stage: node.stage, kind: node.kind, title: node.title, purpose: node.purpose || '', source: node.source, status,
      reason: !present ? 'Исходники ещё не созданы' : localErrors[0] || needed[0]?.title || (stableChecks.every(c => c.ok) ? 'Исходники проверены' : 'Есть общие замечания проверки'),
      ...(agentPath ? { agent: { path: agentPath, ...(node.agentId ? { id: node.agentId } : {}) } } : {}), ...(letters ? { letters } : {}) }
  })
  const links = (map.links || []).map((link, i) => {
    const steps = []
    const automationFiles = []
    if (link.via) {
      const dir = safePath(root, link.via)
      for (const file of walk(dir).filter(f => f.endsWith('.automationConfig.json')).sort()) {
        const path = rel(root, file)
        safePath(root, path)
        automationFiles.push(path)
        try { const target = map.nodes.find(n => n.id === link.to); const all = JSON.parse(readFileSync(file, 'utf8')).steps || []; walkSteps(stepsForSeries(all, target?.kind === 'series' ? target.source : null), '', steps) } catch (e) { steps.push({ kind: 'action', title: 'Ошибка конфигурации', detail: e.message }) }
      }
    }
    return { id: link.id || `link-${i + 1}`, from: link.from, to: link.to, when: link.when || '', ...(link.signal ? { signal: link.signal } : {}), ...(link.via ? { via: link.via, automationFiles } : {}), steps }
  })
  return { version: 1, processPath: slug, ...(map.knowledge ? { knowledge: map.knowledge } : {}),
    title: map.title, branch, commit, checkedAt, stages: map.stages, nodes, links, needsInput,
    checks: checks.map(item => ({ ...item, errors: boundedMessages(item.errors), warnings: boundedMessages(item.warnings) })) }
}
export function prepareSnapshot({ root, slug, map, checks, state = gitState(root) }) {
  return buildSnapshot({ root, slug, map, checks, ...state })
}
export async function startExec(root, sdkCode, expectedCommit) {
  // Use the public CLI entrypoint, including the image's supported wrapper.
  const r = spawnSync('chatium', ['exec'], { cwd: root, input: sdkCode, encoding: 'utf8', timeout: 45_000, maxBuffer: 4 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw Error(`Start exec failed: ${r.error?.message || r.stderr.trim()}`)
  if (expectedCommit) {
    const executed = r.stderr.match(/^Executed commit: ([0-9a-f]{40})$/m)?.[1]
    if (!executed) throw Error('CLI не сообщил SHA исполненного коммита; актуальность результата не подтверждена.')
    if (executed !== expectedCommit) {
      // Source Git can reuse a successful build for a different commit with
      // exactly the same file tree (for example, after reverting test edits).
      let sameTree = false
      try { sameTree = git(root, ['rev-parse', `${executed}^{tree}`]) === git(root, ['rev-parse', `${expectedCommit}^{tree}`]) }
      catch { /* An unknown executed commit cannot prove equivalence. */ }
      if (!sameTree) throw new SnapshotDrift(`CLI исполнил коммит ${executed}, ожидался ${expectedCommit}. Повторите проверку на нужной ветке.`)
    }
  }
  return JSON.parse(r.stdout)
}
export async function publishSnapshot(root, snapshot) {
  const payload = JSON.stringify(snapshot)
  if (payload.length > 250_000) throw Error('Снимок превышает предел сервера: 250 000 символов JSON. Сократите карту или диагностику.')
  assertPublishedState(root, snapshot)
  const saved = await startExec(root,
    `import { writeProcessSnapshot } from '@start/sdk'\nreturn await writeProcessSnapshot(ctx, ${payload})`, snapshot.commit)
  if (!saved?.saved) throw Error(`Snapshot not saved: ${saved?.reason || 'unexpected response'}`)
  if (!Number.isInteger(saved.revision) || saved.revision < 1) throw Error('Snapshot write returned an invalid revision')
  return { saved: true, revision: saved.revision }
}
