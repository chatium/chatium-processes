// Administrative progress must not invalidate a semantic review. Normalize
// only fields whose runtime contract is checked separately by check/decisions.
export function reviewPlan(content) {
  return content.replace(/^- \[[xX ]\] (T\d+)/gm, '- [ ] $1')
    .replace(/^- (?:План|Запуск|Строим):[^\n]*(?=\n|$)/gm, '')
    .replace(/^\s*- Рабочие задачи:[^\n]*(?=\n|$)/gm, '')
}

export function reviewWorkspace(content) {
  let value
  try { value = JSON.parse(content) } catch { return content }
  if (typeof value?.config?.mailings?.testOnly === 'boolean') {
    value.config.mailings.testOnly = '<launch toggle checked separately>'
    return JSON.stringify(value)
  }
  return content
}
