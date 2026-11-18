import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isProcessSlug, rel } from './project.mjs'
import { processSourceFiles } from './process-sources.mjs'
import { ownerDecisionStatus } from './owner-decisions.mjs'

export function emptyDesignSource(file) {
  if (statSync(file).size > 256) return false
  const text = readFileSync(file, 'utf8').trim()
  return ['', '// TODO', '# TODO', '<!-- TODO -->'].includes(text)
}

const planningFiles = new Set(['.workspace.json', '.dir.json', 'process.yaml', 'PLAN.md', 'review-scope.json',
  'retirements.json', 'tables/schema-decisions.json', 'agents/spec.yaml', 'agents/cases.yaml', 'tests/plan.yaml'])

export function isImplementationOutput(slug, file) {
  if (file.startsWith(`.mailings/storage/processes/${slug}/`)) return true
  if (!file.startsWith(slug + '/')) return false
  const local = file.slice(slug.length + 1)
  if (planningFiles.has(local) || /^specs\/[^/]+\.ya?ml$/.test(local)) return false
  if (/^(?:reviews|decisions|tasks)\//.test(local) || /^proposals\/[^/]+\.md$/.test(local)) return false
  return !local.startsWith('materials/') || /\.(?:[cm]?[jt]sx?|vue|agent\.json|automationConfig\.json|message\.yaml)$/.test(local)
}

// A published process keeps its existing implementation while a change is being designed.
function inheritedFiles(root, slug, paths) {
  const git = args => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 })
  const ref = git(['merge-base', 'HEAD', 'origin/main']).stdout?.trim()
  if (!ref) return new Set()
  // An initial draft can already be on main. Branching from it does not approve it.
  const record = git(['show', `${ref}:${slug}/decisions/plan.json`])
  if (record.status !== 0) return new Set()
  const decision = JSON.parse(record.stdout)
  if (decision?.decision !== 'approve' || decision.process !== slug || decision.kind !== 'plan') return new Set()
  const tree = git(['ls-tree', '-rz', '--name-only', ref, '--', ...paths])
  const changed = git(['diff', '--no-renames', '--name-only', '-z', ref, '--', ...paths])
  if (tree.status !== 0 || changed.status !== 0) throw Error('Не удалось сверить исходники с исходной версией процесса.')
  const files = new Set(tree.stdout.split('\0'))
  for (const file of changed.stdout.split('\0')) files.delete(file)
  return files
}

export function prematureContent(root, slug) {
  if (!isProcessSlug(slug)) throw Error('Некорректный слаг процесса.')
  if (ownerDecisionStatus({ root, slug, kind: 'plan' }).status === 'ready') return []
  const mail = `.mailings/storage/processes/${slug}`
  const paths = [slug, mail]
  const inherited = inheritedFiles(root, slug, paths)
  const errors = []
  for (const path of paths.flatMap(path => processSourceFiles(root, join(root, path)))) {
    const file = rel(root, path)
    if (!inherited.has(file) && isImplementationOutput(slug, file) && !emptyDesignSource(path)) errors.push(file)
  }
  return errors
}

export function designContentIssue(root, slug) {
  const files = prematureContent(root, slug)
  if (files.length) return 'До «строим так?» разрешена только структура. Обнаружены материалы реализации: ' +
    files.join(', ') + '. Сохраните уже сделанную работу отдельно; для согласования покажите карту с назначением и переходами блоков.'
}
