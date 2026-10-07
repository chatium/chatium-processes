const stages = ['design', 'build', 'test', 'launch']
const text = value => typeof value === 'string' && value.trim().length > 0

/** Open business questions stay visible and block dependent stages until resolved. */
export function inputBlockers(map, stage = 'build') {
  if (!stages.includes(stage)) throw Error('Неизвестный этап проверки открытых вопросов.')
  const errors = [], pending = []
  if (map?.needsInput === undefined) return { errors, pending }
  if (!Array.isArray(map.needsInput) || map.needsInput.length > 100)
    return { errors: ['needsInput должен быть списком не более 100 пунктов.'], pending }
  for (const [index, item] of map.needsInput.entries()) {
    const where = `needsInput[${index}]`
    if (!text(item?.title)) { errors.push(`${where}: нужно описание для владельца.`); continue }
    if (item.kind !== undefined && !['question', 'dependency'].includes(item.kind))
      errors.push(`${where}: kind должен быть question или dependency.`)
    const blocks = item.blocks
    if (item.kind === 'question' && (!Array.isArray(blocks) || !blocks.length)) {
      errors.push(`${where}: у открытого бизнес-вопроса нужен blocks со стадиями design|build|test|launch.`)
      continue
    }
    if (blocks !== undefined && (!Array.isArray(blocks) ||
      blocks.some(value => !stages.includes(value)) || new Set(blocks).size !== blocks.length)) {
      errors.push(`${where}: blocks должен содержать уникальные этапы design|build|test|launch.`)
      continue
    }
    if (blocks?.some(value => stages.indexOf(value) <= stages.indexOf(stage)))
      pending.push({ index, title: item.title, kind: item.kind || 'dependency', blocks })
  }
  return { errors, pending }
}
