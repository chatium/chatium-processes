import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const sha256 = data => createHash('sha256').update(data).digest('hex')
const commit = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
function gitFile(root, revision, path) {
  const result = spawnSync('git', ['show', '--no-ext-diff', `${revision}:${path}`],
    { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } })
  return result.status === 0 ? result.stdout : null
}

export function messageDeliverySmokeStatus({ root, slug, expectations,
  readAtCommit = (revision, path) => gitFile(root, revision, path), ancestor = (tested, current) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', tested, current],
      { cwd: root, timeout: 5000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return result.status === 0
  } }) {
  if (!expectations.length) return { status: 'ready', errors: [] }
  const file = join(root, slug, 'tests/message-delivery.json')
  if (!existsSync(file)) return { status: 'missing', errors: ['Нет результатов тестовой доставки каждого сообщения и канала.'] }
  if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 128 * 1024)
    return { status: 'invalid', errors: ['Результаты доставки должны быть обычным JSON-файлом до 128 KB.'] }
  let data
  try { data = JSON.parse(readFileSync(file, 'utf8')) }
  catch { return { status: 'invalid', errors: ['Результаты доставки не разбираются как JSON.'] } }
  if (data?.version !== 1 || !Array.isArray(data.runs) || data.runs.length > 200)
    return { status: 'invalid', errors: ['Нужны version: 1 и runs (не более 200).'] }
  const errors = [], byPath = new Map()
  if (!Array.isArray(data.channelCatalog) || data.channelCatalog.length > 100 ||
      new Set(data.channelCatalog.map(channel => channel?.id)).size !== data.channelCatalog.length)
    errors.push('channelCatalog: нужен список каналов Sender с уникальными ID (до 100).')
  const catalog = new Map(Array.isArray(data.channelCatalog) ? data.channelCatalog.map(channel => [channel?.id, channel]) : [])
  for (const run of data.runs) {
    if (typeof run?.path !== 'string' || byPath.has(run.path)) errors.push('Для каждой версии сообщения нужна одна запись с уникальным path.')
    else byPath.set(run.path, run)
  }
  for (const expected of expectations) {
    const run = byPath.get(expected.path)
    if (!run) { errors.push(`${expected.path}: нет тестовой доставки.`); continue }
    const source = readFileSync(join(root, expected.path))
    if (run.messageSha256 !== sha256(source))
      errors.push(`${expected.path}: шаблон изменился после тестовой доставки.`)
    const validCommit = run.branch === 'main' && commit(run.testedCommit) && ancestor(run.testedCommit, 'HEAD')
    if (!validCommit) errors.push(`${expected.path}: тест не привязан к предшествующему опубликованному коммиту main.`)
    else {
      const testedMessage = readAtCommit(run.testedCommit, expected.path)
      if (!testedMessage || sha256(testedMessage) !== run.messageSha256)
        errors.push(`${expected.path}: исполненный шаблон не совпадает с проверяемым.`)
      const testedWorkspace = readAtCommit(run.testedCommit, `${slug}/.workspace.json`)
      let workspace
      try { workspace = JSON.parse(testedWorkspace?.toString('utf8') || '') }
      catch { /* Missing settings cannot prove safe delivery. */ }
      if (workspace?.config?.mailings?.testOnly !== true)
        errors.push(`${expected.path}: в исполненной версии не подтверждён testOnly: true.`)
      if (expected.channelIds.some(id => !workspace?.config?.senderChannels?.includes(id)))
        errors.push(`${expected.path}: заявленные каналы отсутствовали в исполненной версии.`)
    }
    if (run.testOnly !== true || !Number.isFinite(Date.parse(run.testedAt)) ||
        typeof run.executionId !== 'string' || !run.executionId.trim() ||
        run.variantUsed?.filePath !== expected.path ||
        !Array.isArray(run.testContacts) || !run.testContacts.length ||
        run.testContacts.some(contact => !contact || typeof contact.type !== 'string' || !contact.type.trim() ||
          typeof contact.value !== 'string' || !contact.value.trim()))
      errors.push(`${expected.path}: не указаны безопасные контакты, время, исполнение и выбранный вариант.`)
    for (const id of expected.channelIds) {
      const channel = catalog.get(id)
      const type = channel?.type
      const format = type === 'email' ? 'email' : type === 'sms' ? 'sms' :
        typeof type === 'string' && type && type !== 'unknown' ? 'messenger' : null
      if (channel?.active !== true || format !== expected.formatById?.[id])
        errors.push(`${expected.path}: канал ${id} не подтверждён как активный ${expected.formatById?.[id]} в Sender.`)
      const results = Array.isArray(run.channelResults) ? run.channelResults.filter(result => result?.channelId === id) : []
      if (!results.length || results.some(result => result.success !== true))
        errors.push(`${expected.path}: нет успешной тестовой доставки по каналу ${id}.`)
      for (const key of expected.mediaByChannel?.[id] || [])
        if (!Array.isArray(run.openedMediaByChannel?.[id]) || !run.openedMediaByChannel[id].includes(key))
          errors.push(`${expected.path}: не подтверждено открытие медиа ${key} в канале ${id}.`)
    }
  }
  for (const path of byPath.keys()) if (!expectations.some(expected => expected.path === path))
    errors.push(`${path}: тест не относится к текущим сообщениям процесса.`)
  return { status: errors.length ? 'invalid' : 'ready', errors, path: file }
}
