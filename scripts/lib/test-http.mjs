import { readFileSync } from 'node:fs'
const request = JSON.parse(readFileSync(0, 'utf8'))
try {
  if (request.authUrl) {
    const target = new URL(request.url), auth = new URL(request.authUrl)
    if (auth.origin !== target.origin || auth.pathname !== '/s/auth/another/migrate-token') throw Error('Неподдерживаемый адрес авторизации.')
    const response = await fetch(auth, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
    const location = response.headers.get('location')
    if (response.status !== 302 || !location || new URL(location, auth).href !== target.href) throw Error('Авторизация не подтверждена платформой.')
    const cookies = new Map(response.headers.getSetCookie().map(value => value.split(';')[0]).map(value => [value.slice(0, value.indexOf('=')), value]))
    if (![...cookies].some(([name, value]) => /^at-\d+$/.test(name) && value.length > name.length + 1)) throw Error('Сессия разработчика отсутствует.')
    process.stdout.write(JSON.stringify({ cookie: [...cookies.values()].join('; ') }) + '\n')
    process.exit(0)
  }
  const response = await fetch(request.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { 'content-type': 'application/json', cookie: request.cookie }, body: JSON.stringify({ method: request.method, args: request.args }) })
  if (!response.ok) throw Error(`Тестовый SDK недоступен: HTTP ${response.status}.`)
  const data = await response.json()
  if (data.protocol !== 'process-testing-v1') throw Error('Ответ не подтверждает тестовый SDK Start.')
  const selected = key => { const v = data.preview?.[key]; return v && typeof v === 'object' ? v.sourceGitVersionSpec : 'main' }
  if (selected('account') !== request.branch || Object.entries(request.plugins).some(([slug, branch]) => selected(`app_${slug}`) !== branch)) throw Error('Платформа не подтвердила выбранные ветки. Исход операции требует проверки.')
  if (typeof data.error === 'string') throw Error(`Start: ${data.error}`)
  process.stdout.write(JSON.stringify(data.result) + '\n')
} catch (error) {
  // Never print cookies, request bodies, tokens or a raw error response.
  console.error(error instanceof Error ? error.message : 'Тестовый HTTP-запрос не завершён.'); process.exitCode = 1
}
