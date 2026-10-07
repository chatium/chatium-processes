import { spawnSync } from 'node:child_process'

export class SnapshotDrift extends Error {}

export function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } })
  if (r.error || r.status !== 0) throw Error(`Не удалось выполнить git ${args[0]}; актуальность снимка не подтверждена.`)
  return r.stdout.trim()
}

export function gitState(root) {
  const branch = git(root, ['branch', '--show-current'])
  if (!branch) throw new SnapshotDrift('Нужна рабочая ветка: HEAD отсоединён.')
  return { branch, commit: git(root, ['rev-parse', 'HEAD']) }
}

export function assertLocalState(root, expected) {
  const current = gitState(root)
  if (current.branch !== expected.branch || current.commit !== expected.commit)
    throw new SnapshotDrift('Ветка или HEAD изменились во время проверки. Запустите check заново.')
  if (git(root, ['status', '--porcelain', '--untracked-files=normal']))
    throw new SnapshotDrift('Есть незакоммиченные изменения. Завершите правки, commit и push, затем повторите check.')
}

export function assertPublishedState(root, expected) {
  assertLocalState(root, expected)
  // Ask the server: origin/<branch> may be stale without a fetch.
  const ref = `refs/heads/${expected.branch}`
  const row = git(root, ['ls-remote', '--heads', 'origin', ref]).split('\n')
    .map(line => line.split(/\s+/)).find(([, name]) => name === ref)
  if (row?.[0] !== expected.commit)
    throw new SnapshotDrift(`Ветка origin/${expected.branch}: ${row?.[0] || 'отсутствует'}; HEAD: ${expected.commit}. Сначала синхронизируйте ветку и повторите check.`)
  assertLocalState(root, expected)
  return row[0]
}
