#!/usr/bin/env node
import { findRoot, parseArgs } from './lib/project.mjs'
import { gitState } from './lib/git-state.mjs'
import { syncBuildProgress } from './lib/build-progress.mjs'
import { startExec } from './lib/snapshot.mjs'

try {
  const { positional, options } = parseArgs(process.argv.slice(2), ['help'], ['root', 'help'])
  const [command, slug] = positional
  if (options.help) {
    console.log('construction.mjs <sync|status> <process> [--root DIR]. Статусы вычисляются из задач и проверок; ручного set-status нет.')
  } else {
    if (positional.length !== 2 || !/^[a-z][a-z0-9-]*$/.test(slug || '') || !['sync', 'status'].includes(command)) throw Error('Укажите sync|status и процесс.')
    const root = findRoot(options.root)
    if (command === 'sync') {
      const result = await syncBuildProgress(root, slug)
      console.log(JSON.stringify(result, null, 2))
      if (result.status === 'pending') process.exitCode = 1
    } else {
      const state = gitState(root)
      const board = await startExec(root, `import {readProcessBoardForAgent} from '@start/sdk'\nreturn await readProcessBoardForAgent(ctx, ${JSON.stringify(slug)}, ${JSON.stringify(state.branch)})`, state.commit)
      if (!board?.snapshot) throw Error('Нет опубликованной карты выбранной ветки.')
      console.log(JSON.stringify({ process: slug, branch: state.branch, commit: board.snapshot.snapshot.commit,
        nodes: board.snapshot.snapshot.nodes.map(({ id, title, status, reason, build, progress }) => ({ id, title, status, reason, build, progress })),
        build: board.snapshot.snapshot.build }, null, 2))
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 2 }
