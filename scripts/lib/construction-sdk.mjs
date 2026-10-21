import { gitState } from './git-state.mjs'
import { startExec } from './snapshot.mjs'
import { scopedSdk } from './test-exec.mjs'

/** Reuse the authenticated process gateway when a healthy host runs another account branch. */
export function constructionSdk(root, method, args, { executionRoot = root, execute = startExec, http = scopedSdk } = {}) {
  const state = gitState(root), host = gitState(executionRoot)
  if (state.branch !== host.branch)
    return http(root, host.commit, method, args, { executionRoot, plugins: {} })
  return execute(executionRoot, `import { ${method} } from '@start/sdk'\nreturn await ${method}(ctx, ${args.map(value => JSON.stringify(value)).join(', ')})`, host.commit)
}
