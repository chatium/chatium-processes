#!/usr/bin/env node
// Короткая навигация по творческим каталогам без загрузки всего файла в контекст агента.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs, SKILL_DIR } from './lib/project.mjs'
import { searchCatalog } from './lib/catalog-search.mjs'

const catalogs = {
  styles: ['styles.json', 'styles'],
  pages: ['landing-types.json', 'types'],
  mechanics: ['mechanics.json', 'mechanics'],
  copywriting: ['copywriting.json', 'styles'],
}

try {
  const { positional, options } = parseArgs(process.argv.slice(2), ['help'], ['help', 'search'])
  if (options.help) {
    console.log('Использование: catalog.mjs <styles|pages|mechanics|copywriting> [id] [--search текст]')
    process.exit(0)
  }
  const [name, id] = positional
  if (positional.length < 1 || positional.length > 2 || !catalogs[name] || (id && options.search))
    throw Error('Нужны каталог и необязательный ID либо --search. См. --help.')
  if (options.search?.length > 100) throw Error('Поисковый запрос слишком длинный (максимум 100 символов).')
  const [file, key] = catalogs[name]
  const entries = JSON.parse(readFileSync(join(SKILL_DIR, 'creative/catalog', file), 'utf8'))[key]
  if (id) {
    if (!Object.hasOwn(entries, id)) throw Error(`Нет элемента ${id} в каталоге ${name}.`)
    console.log(JSON.stringify({ id, ...entries[id] }, null, 2))
  } else {
    const result = searchCatalog(entries, options.search)
    console.log(JSON.stringify({ catalog: name, count: result.length, items: result }, null, 2))
  }
} catch (error) {
  console.error(error.message)
  process.exit(2)
}
