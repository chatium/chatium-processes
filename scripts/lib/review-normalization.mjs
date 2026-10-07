// Administrative progress must not invalidate a semantic review. Normalize
// only fields whose runtime contract is checked separately by check/decisions.
export function reviewPlan(content) {
  return content.replace(/^- \[[xX ]\] (T\d+)/gm, '- [ ] $1')
    .replace(/^- (?:План|Запуск|Строим):[^\n]*(?=\n|$)/gm, '')
    .replace(/^\s*- Рабочие задачи:[^\n]*(?=\n|$)/gm, '')
}

// Creative review needs the business promise and conditions, not the work-card
// register, whose routine edits must not expire a page or message judgement.
export function reviewCreativePlan(content) {
  let inTasks = false
  return reviewPlan(content).split('\n').filter(line => {
    if (/^## Задачи(?:\s|$)/u.test(line)) { inTasks = true; return false }
    if (inTasks && /^##\s+/u.test(line)) inTasks = false
    return !inTasks
  }).join('\n')
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
