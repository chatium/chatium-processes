// Administrative progress must not invalidate a semantic review. Normalize
// only fields whose runtime contract is checked separately by check/decisions.
export function reviewPlan(content) {
  let approvals = false, task = false
  return content.split('\n').flatMap(line => {
    const heading = /^##\s+(.+?)\s*\r?$/u.exec(line)
    if (heading) { approvals = heading[1] === 'Согласования'; task = false }
    if (/^- \[[xX ]\] T\d+\s/u.test(line)) task = true
    if (approvals && /^- (?:План|Запуск|Строим):\s*(?:не\s+)?согласован(?:о|а)?(?:\s+(?:\d{2}\.\d{2}(?:\.\d{4})?|\d{4}-\d{2}-\d{2}))?\s*$/iu.test(line)) return []
    if (task && /^[ \t]+- Рабочие задачи:/u.test(line)) return []
    return [line.replace(/^- \[[xX ]\] (T\d+)/u, '- [ ] $1')]
  }).join('\n')
}

// Task criteria can contain the only recorded business condition for a page or
// message. Keep them in the review input; reviewPlan removes bookkeeping only.
export function reviewCreativePlan(content) {
  return reviewPlan(content)
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
