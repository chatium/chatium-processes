/** Optional navigation only: a URL does not prove integration or readiness. */
export function externalUrlForNode(node) {
  if (node?.externalUrl === undefined) return undefined
  const value = node.externalUrl
  const invalid = () => new Error('externalUrl допустим только для external: нужен абсолютный HTTP(S) URL до 2048 символов без пробелов и логина/пароля')
  if (node.kind !== 'external' || typeof value !== 'string' || value.length > 2048 || !/^https?:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\]/.test(value)) throw invalid()
  let url
  try { url = new URL(value) } catch { throw invalid() }
  if (url.username || url.password) throw invalid()
  return value
}
