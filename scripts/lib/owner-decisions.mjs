import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { collectKnowledge } from './knowledge.mjs'
import { canonicalTarget } from './knowledge-review.mjs'
import { isProcessSlug, rel } from './project.mjs'
import { readProcessBoard } from './board.mjs'
import { reviewPlan } from './review-normalization.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' && value.trim().length > 0
const KINDS = ['plan', 'launch']

function delegatedTestIsSafe(root, slug) {
  try {
    const workspace = JSON.parse(readFileSync(join(root, slug, '.workspace.json'), 'utf8'))
    const mailings = workspace?.config?.mailings
    return mailings?.testOnly === true && Array.isArray(mailings.testContacts) &&
      mailings.testContacts.some(contact => text(contact?.type) && text(contact?.value))
  } catch { return false }
}

function approvalFiles(root, directory, { skipRootRecords = false } = {}) {
  if (!existsSync(directory)) return []
  const account = realpathSync(root), files = []
  const scopeRoot = realpathSync(directory)
  let entries = 0, bytes = 0
  function visit(path) {
    if (++entries > 2000) throw Error('Слишком много файлов в согласуемом объёме.')
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw Error(`Ссылка в согласуемом объёме: ${rel(root, path)}`)
    const real = realpathSync(path)
    if (!real.startsWith(account + sep)) throw Error('Согласуемый файл выходит за пределы аккаунта.')
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (['.git', 'node_modules'].includes(name) ||
            (skipRootRecords && real === scopeRoot && ['tasks', 'reviews', 'decisions'].includes(name))) continue
        visit(join(path, name))
      }
    } else if (stat.isFile()) {
      if (stat.size > 1024 * 1024 || (bytes += stat.size) > 8 * 1024 * 1024)
        throw Error('Слишком большой согласуемый объём.')
      files.push(path)
    }
  }
  visit(directory)
  return files
}

function commit(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 })
  return result.status === 0 ? result.stdout.trim() : null
}

// A snapshot publication may advance the board revision without changing the
// owner's notes or attachments. Bind decisions to that visible content as well
// as the revision, so a bookkeeping snapshot alone does not demand a new answer.
export function boardDecisionDigest(board) {
  if (!Array.isArray(board?.elements?.blocks) || !Array.isArray(board?.elements?.connections))
    throw Error('Нельзя определить содержание показанной доски.')
  const byId = (a, b) => String(a?.id).localeCompare(String(b?.id))
  const notes = (board.tasksSupported === false ? [] : board.notes || [])
    .map(({ taskAuthority, ...note }) => note)
  return hash(JSON.stringify({
    blocks: [...board.elements.blocks].sort(byId),
    connections: [...board.elements.connections].sort(byId),
    notes: notes.sort(byId),
  }))
}

function normalized(path, content, historical = false) {
  if (path.endsWith('/.workspace.json')) {
    try {
      const config = JSON.parse(content)
      if (typeof config?.config?.mailings?.testOnly === 'boolean') {
        config.config.mailings.testOnly = 'launch-toggle'
        return JSON.stringify(config)
      }
    } catch { /* The ordinary validator reports an invalid workspace. */ }
  }
  if (!path.endsWith('/PLAN.md')) return content
  const previous = content.replace(/^- \[[xX]\]/gm, '- [ ]')
    .replace(/^- (?:Строим|Запуск):.*$/gm, '')
    .replace(/^  - Рабочие задачи:.*\n?/gm, '')
  // Older decisions included the administrative "План: согласован" line in
  // their digest. Keep that digest readable while new decisions share the
  // reviewer's distinction between status and business content.
  return historical ? previous : reviewPlan(previous)
}

export function ownerDecisionPath(root, slug, kind) {
  if (!isProcessSlug(slug) || !KINDS.includes(kind)) throw Error('Нужны процесс и решение plan или launch.')
  const path = resolve(root, slug, 'decisions', `${kind}.json`)
  const base = realpathSync(root), target = canonicalTarget(path)
  if (!target.startsWith(base + sep)) throw Error('Путь решения выходит за пределы аккаунта.')
  return path
}

export function approvalScope({ root, slug, kind, historical = false }) {
  ownerDecisionPath(root, slug, kind)
  const knowledge = collectKnowledge({ root, slug })
  const files = new Map(knowledge.files.map(file => [file.path, normalized(file.path, file.content, historical)]))
  if (kind === 'launch') {
    const rootPath = join(root, slug)
    for (const path of approvalFiles(root, rootPath, { skipRootRecords: true })) {
      const relative = rel(root, path)
      if (['tasks', 'reviews', 'decisions'].some(name => relative.startsWith(`${slug}/${name}/`)) ||
          relative === `${slug}/PLAN.md`) continue
      // A launch decision covers executable behavior too: prices, recipients and
      // delivery rules often live in route handlers rather than config files.
      if (!/\.(?:json|ya?ml|md|tpl|[cm]?js|jsx|[cm]?ts|tsx|vue)$/.test(relative)) continue
      files.set(relative, normalized(relative, readFileSync(path, 'utf8'), historical))
    }
    for (const path of approvalFiles(root, join(root, '.mailings/storage/processes', slug))) {
      if (path.endsWith('.message.yaml')) files.set(rel(root, path), readFileSync(path, 'utf8'))
    }
  }
  const manifest = [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, sha256: hash(content) }))
  return { kind, process: slug, manifest, digest: hash(JSON.stringify(manifest)) }
}

export function prepareOwnerDecision({ root, slug, kind, boardRevision, boardContentDigest = null }) {
  if (boardRevision !== null && (!Number.isInteger(boardRevision) || boardRevision < 0))
    throw Error('Укажите ревизию доски или явное отсутствие доски.')
  if (boardContentDigest !== null && (boardRevision === null || !/^[0-9a-f]{64}$/.test(boardContentDigest)))
    throw Error('Некорректный отпечаток содержания доски.')
  const scope = approvalScope({ root, slug, kind })
  const shownCommit = commit(root)
  if (!shownCommit) throw Error('Нельзя определить коммит, показанный владельцу.')
  return { version: 1, ...scope, shownCommit, boardRevision, boardContentDigest,
    preparedAt: new Date().toISOString() }
}

export function recordOwnerDecision({ root, slug, kind, packet, response }) {
  const current = approvalScope({ root, slug, kind })
  if (packet?.version !== 1 || packet.kind !== kind || packet.process !== slug ||
      packet.digest !== current.digest || !/^[0-9a-f]{40}$/.test(packet.shownCommit) ||
      !Number.isFinite(Date.parse(packet.preparedAt)) ||
      !(packet.boardRevision === null || Number.isInteger(packet.boardRevision)) ||
      !(packet.boardContentDigest == null || /^[0-9a-f]{64}$/.test(packet.boardContentDigest)))
    throw Error('Показанный владельцу объём устарел или пакет некорректен.')
  const authority = response?.authority || 'owner'
  if (!response || !['owner', 'delegated-test'].includes(authority) ||
      !['approve', 'decline'].includes(response.decision) || !text(response.message) ||
      !text(response.messageReference) ||
      !(authority === 'owner' ? text(response.owner) : text(response.actor) && text(response.delegationReference)) ||
      !Number.isFinite(Date.parse(response.answeredAt)))
    throw Error('Нужны решение, текст ответа, ссылка, время и владелец либо исполнитель с основанием тестового делегирования.')
  if (Date.parse(response.answeredAt) < Date.parse(packet.preparedAt))
    throw Error('Решение датировано раньше подготовки согласуемого объёма.')
  if (authority === 'delegated-test' && !delegatedTestIsSafe(root, slug))
    throw Error('Делегированное тестовое решение требует mailings.testOnly=true и разрешённый тестовый контакт.')
  const path = ownerDecisionPath(root, slug, kind)
  const saved = { version: 1, kind, process: slug, decision: response.decision, authority,
    message: response.message, messageReference: response.messageReference,
    ...(authority === 'owner' ? { owner: response.owner } : {
      actor: response.actor, delegationReference: response.delegationReference,
    }), answeredAt: response.answeredAt,
    recordedAt: new Date().toISOString(), shownCommit: packet.shownCommit,
    boardRevision: packet.boardRevision, boardContentDigest: packet.boardContentDigest ?? null,
    scopeDigest: packet.digest, scopeManifest: packet.manifest }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(saved, null, 2) + '\n')
  return { status: response.decision === 'approve' ? 'ready' : 'declined', path,
    scopeDigest: packet.digest, shownCommit: packet.shownCommit, boardRevision: packet.boardRevision }
}

export function ownerDecisionStatus({ root, slug, kind, currentBoardRevision, currentBoardDigest }) {
  const path = ownerDecisionPath(root, slug, kind)
  if (!existsSync(path)) return { status: 'missing', path, error: `Нет ответа владельца на ${kind === 'plan' ? '«строим так?»' : '«запускаем?»'}.` }
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  const authority = saved.authority || 'owner'
  if (saved.version !== 1 || saved.kind !== kind || saved.process !== slug ||
      !['owner', 'delegated-test'].includes(authority) ||
      !text(saved.message) || !text(saved.messageReference) ||
      !(authority === 'owner' ? text(saved.owner) : text(saved.actor) && text(saved.delegationReference)) ||
      !Number.isFinite(Date.parse(saved.answeredAt)) || !/^[0-9a-f]{40}$/.test(saved.shownCommit))
    return { status: 'invalid', path, error: 'Решение неполно или принадлежит другому процессу.' }
  if (saved.decision !== 'approve') return { status: 'declined', path, error: 'Этот шаг не согласован.' }
  if (authority === 'delegated-test' && !delegatedTestIsSafe(root, slug))
    return { status: 'stale', path,
      error: 'Учебное решение исполнителя не действует без mailings.testOnly=true и разрешённого тестового контакта; для обычного запуска нужен ответ владельца.' }
  const current = approvalScope({ root, slug, kind })
  const historical = saved.scopeDigest === current.digest ? null : approvalScope({ root, slug, kind, historical: true })
  if (saved.scopeDigest !== current.digest && saved.scopeDigest !== historical?.digest) {
    const previous = new Map(saved.scopeManifest?.map(file => [file.path, file.sha256]) || [])
    const changedFiles = current.manifest.filter(file => previous.get(file.path) !== file.sha256).map(file => file.path)
    for (const path of previous.keys()) if (!current.manifest.some(file => file.path === path)) changedFiles.push(path)
    return { status: 'stale', path, changedFiles,
      error: `После согласования изменилось содержание: ${changedFiles.join(', ') || 'неизвестное отличие'}. Покажите его владельцу.` }
  }
  if (saved.boardContentDigest && currentBoardDigest !== undefined && currentBoardDigest !== saved.boardContentDigest)
    return { status: 'stale', path, error: 'После согласования изменились заметки или материалы на доске.' }
  if (currentBoardRevision !== undefined && currentBoardRevision !== saved.boardRevision &&
      (!saved.boardContentDigest || currentBoardDigest === undefined))
    return { status: 'stale', path, error: `Доска изменилась: показана ревизия ${saved.boardRevision ?? 'отсутствует'}, сейчас ${currentBoardRevision ?? 'отсутствует'}.` }
  return { status: 'ready', authority, path, shownCommit: saved.shownCommit, currentCommit: commit(root),
    boardRevision: saved.boardRevision, boardContentDigest: saved.boardContentDigest ?? null,
    answeredAt: saved.answeredAt,
    messageReference: saved.messageReference,
    ...(authority === 'delegated-test' ? { actor: saved.actor, delegationReference: saved.delegationReference } : {}) }
}

export async function ownerDecisionForCurrentBoard({ root, slug, kind, readBoard = readProcessBoard }) {
  const decision = ownerDecisionStatus({ root, slug, kind })
  if (decision.status !== 'ready' || decision.boardRevision === null) return decision
  try {
    const board = await readBoard(root, slug)
    return ownerDecisionStatus({ root, slug, kind, currentBoardRevision: board.boardRevision,
      currentBoardDigest: decision.boardContentDigest ? boardDecisionDigest(board) : undefined })
  } catch (error) {
    return { status: 'unavailable', path: decision.path,
      error: `Не удалось сверить доску с согласованием владельца: ${error.message}` }
  }
}
