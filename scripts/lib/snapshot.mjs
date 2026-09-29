// Snapshot producer. All paths are account-relative; publication is a separate step.
import { previewExec } from './preview-exec.mjs'
import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { isDir, isFile, walk, rel } from './project.mjs'
import { parseYaml } from './yaml.mjs'

function safePath(root, value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value.replace(/\/$/, '').split('/').some(p => !p || p === '.' || p === '..')) throw Error('Unsafe snapshot source path')
  const file = resolve(root, value)
  if (!file.startsWith(resolve(root) + sep)) throw Error('Snapshot source escapes account')
  if (existsSync(file) && !realpathSync(file).startsWith(realpathSync(root) + sep)) throw Error('Snapshot source symlink escapes account')
  return file
}
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15_000 })
  if (r.status !== 0) throw Error(`git ${args[0]} failed`)
  return r.stdout.trim()
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
export function buildSnapshot({ root, slug, map, checks, branch, commit, checkedAt = new Date().toISOString() }) {
  if (!map || !Array.isArray(map.stages) || !Array.isArray(map.nodes) || checks.some(c => c.id === 'map' && !c.ok)) throw Error('Cannot publish an invalid process map')
  const rawNeeds = map.needsInput ?? []
  if (!Array.isArray(rawNeeds) || rawNeeds.length > 100) throw Error('Invalid needsInput')
  const needsInput = rawNeeds.map(item => typeof item === 'string' ? { title: item } : { title: item.title, ...(item.nodeId ? { nodeId: item.nodeId } : {}) })
  const allErrors = checks.flatMap(c => c.errors)
  const nodes = map.nodes.map(node => {
    const source = safePath(root, node.source), present = isFile(source) || isDir(source)
    const localErrors = allErrors.filter(e => e.includes(node.source.replace(/\/$/, '')) || e.includes(`«${node.id}»`))
    const needed = needsInput.filter(i => i.nodeId === node.id)
    const status = !present ? 'missing' : localErrors.length ? 'error' : needed.length ? 'needs-input' : 'ready'
    const letters = node.kind === 'series' && isDir(source) ? walk(source).filter(p => p.endsWith('.message.yaml')).sort().map(file => {
      safePath(root, rel(root, file))
      try { const l = parseYaml(readFileSync(file, 'utf8')); return { title: l.title || 'Письмо', subject: l.subject || '', source: rel(root, file) } }
      catch { return { title: 'Письмо не разбирается', subject: '', source: rel(root, file) } }
    }) : undefined
    return { id: node.id, stage: node.stage, kind: node.kind, title: node.title, purpose: node.purpose || '', source: node.source, status,
      reason: !present ? 'Исходники ещё не созданы' : localErrors[0] || needed[0]?.title || (checks.every(c => c.ok) ? 'Исходники проверены' : 'Есть общие замечания проверки'), ...(letters ? { letters } : {}) }
  })
  const links = (map.links || []).map((link, i) => {
    const steps = []
    if (link.via) {
      const dir = safePath(root, link.via)
      for (const file of walk(dir).filter(f => f.endsWith('.automationConfig.json')).sort()) {
        safePath(root, rel(root, file))
        try { walkSteps(JSON.parse(readFileSync(file, 'utf8')).steps, '', steps) } catch (e) { steps.push({ kind: 'action', title: 'Ошибка конфигурации', detail: e.message }) }
      }
    }
    return { id: link.id || `link-${i + 1}`, from: link.from, to: link.to, when: link.when || '', ...(link.signal ? { signal: link.signal } : {}), ...(link.via ? { via: link.via } : {}), steps }
  })
  return { version: 1, processPath: slug, title: map.title, branch, commit, checkedAt, stages: map.stages, nodes, links, needsInput, checks }
}
export function prepareSnapshot({ root, slug, map, checks }) {
  const branch = git(root, ['branch', '--show-current']), commit = git(root, ['rev-parse', 'HEAD'])
  if (!branch) throw Error('Snapshot requires a branch checkout')
  return buildSnapshot({ root, slug, map, checks, branch, commit })
}
export async function publishSnapshot(root, snapshot, startBranch) {
  // Do not label uncommitted files or another deployed revision with this SHA.
  if (git(root, ['status', '--porcelain', '--untracked-files=normal'])) throw Error('Snapshot not saved: commit and push the working tree first')
  const remote = git(root, ['ls-remote', 'origin', `refs/heads/${snapshot.branch}`]).split(/\s/)[0]
  if (remote !== snapshot.commit) throw Error('Snapshot not saved: push this exact commit to the process branch first')
  const payload = JSON.stringify(snapshot)
  if (payload.length > 250_000) throw Error('Snapshot exceeds 250 KB')
  if (startBranch) {
    // The scoped preview must be on the execution HTTP request, not a cloned ctx.
    // @start/sdk imports are resolved from the published SDK until the release.
    const code = `import { runAppFunction } from '@app/app'\nreturn await runAppFunction(ctx, 'start', 'process-map/api/snapshots~write', { snapshot: ${payload} })`
    const saved = await previewExec({ branch: snapshot.branch, commit: snapshot.commit, code, startBranch })
    if (!saved?.saved) throw Error(`Snapshot not saved: ${saved?.reason || 'unexpected response'}`)
    return { saved: true, revision: saved.revision }
  }
  const snippet = `import { writeProcessSnapshot } from '@start/sdk'\nreturn await writeProcessSnapshot(ctx, ${payload})`
  const r = spawnSync('chatium', ['exec'], { cwd: root, input: snippet, encoding: 'utf8', timeout: 45_000, maxBuffer: 1024 * 1024 })
  if (r.error || r.status !== 0) throw Error(`Snapshot not saved: ${r.error?.message || r.stderr.trim()}`)
  const saved = JSON.parse(r.stdout)
  if (!saved?.saved) throw Error(`Snapshot not saved: ${saved?.reason || 'unexpected response'}`)
  return { saved: true, revision: saved.revision }
}
