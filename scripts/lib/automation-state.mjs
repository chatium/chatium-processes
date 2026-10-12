/** Compare published Automations state with the expected phase of a process. */
export function assessAutomationState(paths, rows, expected) {
  const errors = []
  if (!Array.isArray(rows)) return ['SDK не вернул список автоматизаций.']
  const found = new Map()
  for (const row of rows) {
    if (!row || typeof row.path !== 'string' || found.has(row.path)) {
      errors.push('SDK вернул повторный или некорректный путь автоматизации.')
      continue
    }
    found.set(row.path, row)
  }
  for (const path of paths) {
    const row = found.get(path)
    if (!row) { errors.push(`${path}: нет ответа SDK.`); continue }
    if (row.error) { errors.push(`${path}: ${row.error}`); continue }
    const value = row.value
    if (!value) { errors.push(`${path}: конфиг не найден в опубликованном main.`); continue }
    if (typeof value.automationId !== 'string' || !value.automationId.trim())
      errors.push(`${path}: SDK не вернул постоянный ID автоматизации.`)
    if (value.filePath !== path || value.branchName !== 'main')
      errors.push(`${path}: SDK вернул другой файл или ветку.`)
    if (value.status !== 'ready') errors.push(`${path}: конфиг не готов (${value.status ?? 'нет статуса'}${value.error ? `: ${value.error}` : ''}).`)
    if (typeof value.enabled !== 'boolean') errors.push(`${path}: версия Automations SDK не сообщает состояние подписки.`)
    else if (value.enabled !== (expected === 'enabled'))
      errors.push(`${path}: подписка ${value.enabled ? 'включена' : 'выключена'}, ожидалось ${expected === 'enabled' ? 'включена' : 'выключена'}.`)
  }
  for (const path of found.keys()) if (!paths.includes(path)) errors.push(`${path}: посторонний ответ SDK.`)
  return errors
}
