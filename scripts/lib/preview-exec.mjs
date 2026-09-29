// Temporary Source Git preview transport for CLI 3.x (exec has no header flag).
// Uses the installed CLI's existing session; never reads or logs its token store.
// Remove this adapter when chatium exec supports scoped plugin previews itself.
import { existsSync, realpathSync } from 'node:fs'
import { dirname, delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function previewExec({ branch, commit, code, startBranch }) {
  if (!/^[a-zA-Z0-9._/-]{1,200}$/.test(startBranch)) throw Error('Invalid Start preview branch')
  const cli = (process.env.PATH || '').split(delimiter).map(p => join(p, 'chatium')).find(existsSync)
  if (!cli) throw Error('chatium CLI is not installed')
  const dir = dirname(realpathSync(cli))
  const sessionModule = join(dir, 'session.js'), accountModule = join(dir, 'account.js')
  if (!existsSync(sessionModule) || !existsSync(accountModule)) throw Error('This CLI does not support the preview adapter; use --no-snapshot until the Start SDK is released')
  const { accountOrigin } = await import(pathToFileURL(accountModule).href)
  const { accessSession } = await import(pathToFileURL(sessionModule).href)
  const origin = await accountOrigin()
  const signal = AbortSignal.timeout(30_000)
  const session = await accessSession(origin, signal, 'code:execute')
  const response = await fetch(new URL('/s/ugc/exec', origin), {
    method: 'POST', redirect: 'error', signal,
    headers: { authorization: `Basic ${Buffer.from(`git:${session.accessToken}`).toString('base64')}`, 'content-type': 'application/json', cookie: `__chtmPreviewMode__=app_start:${startBranch}` },
    body: JSON.stringify({ refName: `refs/heads/${branch}`, basePath: '', code }),
  })
  const result = await response.json()
  if (!response.ok) throw Error(`Preview exec failed: ${result.errorCode || response.status}: ${result.reason || ''}`)
  if (result.commitSha !== commit) throw Error('Preview exec used a different commit; refresh and inspect the snapshot before retrying')
  return result.result
}
