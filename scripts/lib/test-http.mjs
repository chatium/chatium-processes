import { readFileSync } from 'node:fs'
const request = JSON.parse(readFileSync(0, 'utf8'))
try {
  const response = await fetch(request.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', cookie: request.cookie }, body: JSON.stringify({ method: request.method, args: request.args }) })
  if (!response.ok) throw Error(`Тестовый SDK недоступен: HTTP ${response.status}.`)
  const data = await response.json()
  if (data.protocol !== 'process-testing-v1') throw Error('Ответ не подтверждает тестовый SDK Start.')
  const selected = key => { const v = data.preview?.[key]; return v && typeof v === 'object' ? v.sourceGitVersionSpec : 'main' }
  if (selected('account') !== request.branch || Object.entries(request.plugins).some(([slug, branch]) => selected(`app_${slug}`) !== branch)) throw Error('Платформа не подтвердила выбранные ветки. Исход операции требует проверки.')
  process.stdout.write(JSON.stringify(data.result) + '\n')
} catch (error) {
  // Never print cookies, request bodies, tokens or a raw error response.
  console.error(error instanceof Error ? error.message : 'Тестовый HTTP-запрос не завершён.'); process.exitCode = 1
}
