const text = value => typeof value === 'string' && value.trim().length > 0
const unique = values => new Set(values).size === values.length

/** The data specification is an explicit inventory, not a second physical schema. */
export function validateDataContracts({ map, data, stage = 'build' }) {
  const errors = [], warnings = []
  const nodes = Array.isArray(map?.nodes) ? map.nodes.filter(node => node?.kind === 'table') : []
  if (data === undefined) {
    if (nodes.length) (stage === 'launch' ? errors : warnings)
      .push('Для таблиц процесса нужен specs/data.yaml с владельцем, читателями и сроком хранения до запуска.')
    return { errors, warnings }
  }
  if (data?.version !== 1 || !Array.isArray(data.tables) || data.tables.length > 100) {
    errors.push('data.yaml: нужны version: 1 и tables[] (не более 100).')
    return { errors, warnings }
  }
  if (!unique(data.tables.map(table => table?.id))) errors.push('data.yaml: id таблицы повторяется.')
  for (const [index, table] of data.tables.entries()) {
    const where = `data.tables[${index}]`
    if (!text(table?.id) || !text(table?.source) || !text(table?.purpose))
      errors.push(`${where}: нужны id, source и purpose.`)
    const node = nodes.find(item => item.id === table?.id)
    if (!node || node.source !== table.source)
      errors.push(`${where}: таблица ${table?.id || '?'} должна иметь узел карты с тем же source; иначе источник и ревью можно потерять.`)
    if (!text(table?.owner) || !Array.isArray(table.readers) || !table.readers.length ||
        !table.readers.every(text) || !unique(table.readers))
      errors.push(`${where}: нужны ответственный owner и уникальные readers (роли, которым можно читать данные).`)
    if (!text(table?.identity?.key) || !text(table?.identity?.rule))
      errors.push(`${where}: нужна идентичность записи и правило повтора.`)
    if (!Array.isArray(table?.fields) || !table.fields.length ||
        table.fields.some(field => !text(field?.name) || !text(field?.type) || !text(field?.purpose)) ||
        !unique(table.fields.map(field => field?.name)))
      errors.push(`${where}: нужны уникальные поля с name, type и purpose.`)
  }
  for (const node of nodes) if (!data.tables.some(table => table?.id === node.id && table.source === node.source))
    errors.push(`data.yaml: таблица карты ${node.id} не описана.`)
  if (!data.retention || typeof data.retention.decided !== 'boolean' || !text(data.retention.current))
    errors.push('data.yaml: нужны retention.decided и текущее правило retention.current.')
  else if (!data.retention.decided) {
    const issue = 'Срок хранения и удаления данных ещё не решён владельцем: data.yaml retention.decided=false.'
    ;(stage === 'launch' ? errors : warnings).push(issue)
  }
  return { errors, warnings }
}
