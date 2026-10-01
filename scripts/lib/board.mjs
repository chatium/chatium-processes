import { gitState } from './git-state.mjs'
import { isProcessSlug } from './project.mjs'
import { readBoard } from './freshness.mjs'
import { startExec } from './snapshot.mjs'
import { noteContext } from './board-notes.mjs'

/** Preserve the entire SDK projection, including objects not understood by this skill yet. */
export function boardContext(board, slug, branch) {
  const context = noteContext(board, slug, branch)
  const snapshot = board.snapshot?.snapshot ?? null
  const nodes = new Map((snapshot?.nodes || []).map(n => [`node-${n.id}`, n]))
  const blocks = new Map(context.elements.blocks.map(b => [b.id, b]))
  const connections = new Map()
  for (const connection of context.elements.connections) {
    for (const id of new Set([connection.from.block, connection.to.block])) {
      if (!connections.has(id)) connections.set(id, [])
      connections.get(id).push(connection)
    }
  }
  const relations = id => {
    const edges = connections.get(id) || []
    const related = [...new Set(edges.flatMap(c => [c.from.block, c.to.block]))].filter(other => other !== id)
    return {
      connectionIds: edges.map(c => c.id),
      relatedIds: related.filter(other => blocks.has(other)),
      targets: related.filter(other => nodes.has(other) || other.startsWith('node-')).map(other => {
        const node = nodes.get(other)
        return node ? { nodeId: node.id, title: node.title, source: node.source, missing: false } :
          { nodeId: other.slice(5), title: '', source: '', missing: true }
      }),
    }
  }
  // Older SDK still provides the whole shared graph: absence of task metadata must not hide it.
  if (!context.tasksSupported) context.notes = context.notes.map(n => ({ ...n, ...relations(n.id) }))
  return { ...context, snapshot,
    materials: context.elements.blocks.filter(b => b.type === 'image').map(b => ({
      id: b.id, type: b.type, title: b.title || '', image: b.image ?? null, ...relations(b.id),
    })),
    unsupportedTypes: [...new Set(context.elements.blocks.map(b => b.type).filter(type => !['sticky', 'image'].includes(type)))],
  }
}

export async function readProcessBoard(root, slug, { reader = readBoard } = {}) {
  if (!isProcessSlug(slug)) throw Error('Нужен корректный слаг процесса.')
  const { branch } = gitState(root)
  return boardContext(await reader(root, { processPath: slug, branch }), slug, branch)
}

/** Resolve a single visible material afresh; never sign an arbitrary hash supplied by the caller. */
export async function readMaterial(root, context, { slug, elementId }, { execute = startExec } = {}) {
  const { branch } = gitState(root)
  if (!isProcessSlug(slug) || !context || context.version !== 1 || context.process !== slug || context.branch !== branch)
    throw Error('Контекст относится к другому процессу или ветке. Прочитайте доску заново.')
  const element = context.elements?.blocks?.find(b => b.id === elementId)
  if (element?.type !== 'image' || typeof element.image?.hash !== 'string' || !element.image.hash)
    throw Error('Нужно изображение из прочитанного общего слоя доски.')
  if (!Number.isSafeInteger(context.boardRevision) || context.boardRevision < 0)
    throw Error('Некорректная ревизия доски.')
  const request = { process: slug, branch, id: elementId, hash: element.image.hash,
    boardRevision: context.boardRevision, snapshotRevision: context.snapshotRevision }
  const result = await execute(root, `import { readProcessBoardForAgent } from '@start/sdk'
import { getOriginalUrl } from '@app/storage'
const request = ${JSON.stringify(request)}
const board = await readProcessBoardForAgent(ctx, request.process, request.branch)
if (board.revision !== request.boardRevision || (board.snapshot?.revision ?? null) !== request.snapshotRevision)
  throw new Error('Доска изменилась. Прочитайте её заново.')
const element = board.elements.blocks.find(b => b.id === request.id)
if (element?.type !== 'image' || !element.image?.hash || element.image.hash !== request.hash)
  throw new Error('Изображение изменено, удалено или недоступно агенту.')
return { id: element.id, type: element.type, image: element.image,
  boardRevision: board.revision, snapshotRevision: board.snapshot?.revision ?? null,
  url: getOriginalUrl(ctx, element.image.hash) }`)
  if (result?.id !== elementId || result.type !== 'image' || result.image?.hash !== element.image.hash ||
      result.boardRevision !== context.boardRevision || result.snapshotRevision !== context.snapshotRevision ||
      typeof result.url !== 'string' || !/^https?:\/\//.test(result.url))
    throw Error('Некорректный ответ чтения изображения. Перечитайте доску.')
  return result
}
