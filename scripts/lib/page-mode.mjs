/** Staff/Admin utility screens need access review, not landing-page creative review. */
export const isInternalPage = node => node?.kind === 'page' && node.pageMode === 'internal'
export const needsCreativeReview = node => node?.kind === 'series' ||
  (node?.kind === 'page' && !isInternalPage(node))

export function internalPageErrors(node, source) {
  if (node?.pageMode === undefined) return []
  if (!isInternalPage(node)) return [`${node?.id || 'узел'}: pageMode допускает только значение internal для страницы.`]
  if (typeof node.source !== 'string' || !/(^|\/)(admin|staff)\//.test(node.source))
    return [`${node.id}: служебная страница должна находиться в admin/ или staff/.`]
  if (!/(requireAccountRole\s*\(|provideUser\s*\(\s*\{[^}]*minRole\s*:)/s.test(source))
    return [`${node.id}: служебная страница не содержит проверки роли Staff/Admin.`]
  return []
}
