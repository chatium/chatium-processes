#!/usr/bin/env node
// Структурная проверка знаний. Содержание и готовность оценивает отдельный агент.
import { collectKnowledge } from './lib/knowledge.mjs'
import { findRoot, parseArgs } from './lib/project.mjs'

const { positional, options } = parseArgs(process.argv.slice(2), ['json', 'help'])
const usage = 'Использование: kb-check.mjs <process> [--root DIR] [--json]'
if (options.help) { console.log(usage); process.exit(0) }
try {
  if (positional.length !== 1 || Object.keys(options).some(key => !['root', 'json', 'help'].includes(key)) || ('root' in options && (!options.root || options.root.startsWith('--')))) throw new Error(usage)
  const report = collectKnowledge({ root: findRoot(options.root), slug: positional[0] })
  const { files, ...summary } = report
  const output = { ...summary, files: files.map(file => file.path) }
  if (options.json) console.log(JSON.stringify(output, null, 2))
  else {
    console.log(`Знания ${report.processPath}: ${report.passed}/${report.total}, файлов ${files.length}`)
    for (const check of report.checks) {
      console.log(`${check.ok ? '✓' : '✗'} ${check.title}`)
      for (const error of check.errors) console.log(`  ОШИБКА: ${error}`)
      for (const warning of check.warnings) console.log(`  ПРЕДУПРЕЖДЕНИЕ: ${warning}`)
    }
    console.log('Это структурная проверка. Достаточность знаний для сборки требует содержательного ревью.')
  }
  process.exitCode = report.passed === report.total ? 0 : 1
} catch (error) {
  if (options.json) console.log(JSON.stringify({ error: error.message }, null, 2))
  else console.error(error.message)
  process.exitCode = 2
}
