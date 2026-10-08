import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { isFile, walk } from './project.mjs'

// Source Build can succeed while a Vue import fails in the browser: Chatium
// only serves shared client modules when their first line is // @shared.
export function validateClientModules({ root, slug }) {
  const processDir = join(root, slug)
  const errors = []
  const seen = new Set()
  for (const vueFile of walk(processDir).filter(file => file.endsWith('.vue'))) {
    const source = readFileSync(vueFile, 'utf8')
    for (const match of source.matchAll(/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(vueFile), match[1])
      const moduleFile = [target, `${target}.ts`, `${target}.tsx`].find(isFile)
      if (!moduleFile || seen.has(moduleFile)) continue
      const rel = relative(processDir, moduleFile).replaceAll('\\', '/')
      if (rel.startsWith('../') || !rel.split('/').includes('shared')) continue
      seen.add(moduleFile)
      if (!/^\/\/\s*@shared\b/.test(readFileSync(moduleFile, 'utf8')))
        errors.push(`${rel}: Vue imports this shared module, but its first line must be // @shared; otherwise the page can be blank after a successful Source Build`)
    }
  }
  return { errors }
}
