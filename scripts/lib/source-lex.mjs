// Keep offsets stable while excluding comments and string contents from static code searches.
export function scanJsSource(source) {
  const clean = source.split(''), code = source.split('')
  let state = 'code', escape = false
  const blank = (array, index) => { if (array[index] !== '\n' && array[index] !== '\r') array[index] = ' ' }
  for (let i = 0; i < source.length; i++) {
    const ch = source[i], next = source[i + 1]
    if (state === 'line') {
      if (ch === '\n') state = 'code'
      else { blank(clean, i); blank(code, i) }
      continue
    }
    if (state === 'block') {
      blank(clean, i); blank(code, i)
      if (ch === '*' && next === '/') { i++; blank(clean, i); blank(code, i); state = 'code' }
      continue
    }
    if (state !== 'code') {
      blank(code, i)
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === state) state = 'code'
      continue
    }
    if (ch === '/' && next === '/') { blank(clean, i); blank(code, i); i++; blank(clean, i); blank(code, i); state = 'line'; continue }
    if (ch === '/' && next === '*') { blank(clean, i); blank(code, i); i++; blank(clean, i); blank(code, i); state = 'block'; continue }
    if (ch === "'" || ch === '"' || ch === '`') { blank(code, i); state = ch }
  }
  return { clean: clean.join(''), code: code.join('') }
}

export function hasExportedGetRoute(source) {
  const { clean, code } = scanJsSource(source)
  const exportedGet = /\bexport\s+(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*|default\s+)app\.get\s*\(/g
  return [...code.matchAll(exportedGet)].some(match => /^\s*(['"`])\/\1/.test(clean.slice(match.index + match[0].length)))
}

export function routeDefinitionCount(source) {
  const { code } = scanJsSource(source)
  return [...code.matchAll(/(?<![\w$.])app\.(?:get|post|put|patch|delete)\s*\(/g)].length
}

export function balancedObjectEnd(code, opening) {
  if (code[opening] !== '{') return -1
  let depth = 0
  for (let i = opening; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}' && --depth === 0) return i
  }
  return -1
}
