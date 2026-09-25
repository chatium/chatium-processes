// Временный хелпер процесса: письмо из .mailings/storage по пути.
// Его заменит общее действие Sender. Не переписывай его под конкретное письмо.
import { findUgcFile } from '@app/ugc'
import { sendMessageToContacts } from '@sender/sdk'
import { getWorkspaceConfig, jsYaml } from '@start/sdk'
import { TEST_CONTACTS, TEST_ONLY } from '../tests/records'

const PROCESS_PATH = '__PROCESS__'
const LETTERS_ROOT = '.mailings/storage/'

type Contact = { type: string; value: string }

type Letter = {
  subject?: string
  preheader?: string
  plain?: string
  html?: string
  short?: string
  buttons?: { text: string; url: string; type: 'primary' | 'secondary' | 'link' }[]
  inlineButtons?: boolean
  variables?: { name: string; required?: boolean }[]
}

export type SendLetterResult =
  | { success: true; result: { store: string; sentTo: number } }
  | { success: false; result: string }

// Опубликованные файлы лежат в cgs, в превью ветки — в db (как у рантайма
// автоматизаций); source-build — запасной вариант для Source Git.
function letterStores(ctx: app.Ctx) {
  return ctx.env.usePreviewMode
    ? (['db', 'cgs', 'source-build'] as const)
    : (['cgs', 'db', 'source-build'] as const)
}

async function readLetter(ctx: app.Ctx, letterPath: string) {
  for (const store of letterStores(ctx)) {
    try {
      const file = await findUgcFile(ctx, store, letterPath)
      if (file?.source) {
        return { store, letter: jsYaml.load(file.source) as Letter }
      }
    } catch (err) {
      ctx.account.log('sendLetter: хранилище недоступно', {
        level: 'warn',
        json: { store, letterPath, error: String(err) },
      })
    }
  }
  return null
}

function isSameContact(a: Contact, b: Contact) {
  return a.type === b.type && a.value.trim().toLowerCase() === b.value.trim().toLowerCase()
}

export async function sendLetter(
  ctx: app.Ctx,
  params: Record<string, unknown>,
  contextContacts: Contact[] = [],
): Promise<SendLetterResult> {
  const letterPath = typeof params.letterPath === 'string' ? params.letterPath : ''
  if (!letterPath.startsWith(LETTERS_ROOT)) {
    return { success: false, result: `letterPath должен начинаться с ${LETTERS_ROOT}` }
  }

  const found = await readLetter(ctx, letterPath)
  if (!found) {
    return { success: false, result: `Письмо не найдено: ${letterPath}` }
  }
  const { store, letter } = found

  const variables: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    if (key.startsWith('var_') && value !== null && value !== undefined) {
      variables[key.slice(4)] = String(value)
    }
  }
  // Sender молча заменяет пустые {{...}} на пустую строку, поэтому не шлём
  // письмо без обязательной переменной. Нерезолвленный $template приходит
  // строкой с {{ ... }} — тоже считаем пустым.
  const missing = (letter.variables ?? [])
    .filter(v => v.required && (!variables[v.name] || /\{\{.*\}\}/.test(variables[v.name] ?? '')))
    .map(v => v.name)
  if (missing.length > 0) {
    return { success: false, result: `Нет значений переменных: ${missing.join(', ')}` }
  }

  const email = typeof params.email === 'string' ? params.email.trim() : ''
  const contacts: Contact[] = email ? [{ type: 'email', value: email }] : contextContacts
  const allowed = TEST_ONLY
    ? contacts.filter(c => TEST_CONTACTS.some(t => isSameContact(t, c)))
    : contacts
  if (allowed.length === 0) {
    return {
      success: false,
      result: TEST_ONLY
        ? 'TEST_ONLY: получателя нет в TEST_CONTACTS, письмо не отправлено'
        : 'Нет контактов получателя',
    }
  }

  const config = await getWorkspaceConfig(ctx, PROCESS_PATH)
  const channels = Array.isArray(config.senderChannels) && config.senderChannels.length > 0
    ? (config.senderChannels as string[])
    : undefined

  const res = await sendMessageToContacts(ctx, {
    message: {
      subject: letter.subject,
      preheader: letter.preheader,
      plain: letter.plain,
      html: letter.html,
      short: letter.short,
      buttons: letter.buttons,
      inlineButtons: letter.inlineButtons,
    },
    variables,
    contacts: allowed,
    channels,
    originType: 'funnel',
    originId: `${PROCESS_PATH}:${letterPath.slice(LETTERS_ROOT.length)}`,
  })

  ctx.account.log('sendLetter', { json: { letterPath, store, contacts: allowed.length, res } })
  if (!res.success) {
    return { success: false, result: res.error }
  }
  return { success: true, result: { store, sentTo: allowed.length } }
}

export const sendLetterAction = app
  .function('/send-letter')
  .meta({
    name: 'sendLetter',
    description: 'Отправляет письмо из хранилища писем по пути; переменные — параметры var_<имя>',
    hrTitle: 'Письмо по пути',
    icon: '✉️',
    category: 'communications',
  })
  .body(s => ({
    context: s.unknown().optional(),
    // Параметры произвольные: letterPath, email и var_<имя> для каждой переменной письма
    params: s.record(s.string(), s.unknown()),
  }))
  .result(s => ({
    success: s.boolean(),
    result: s.smartUnion([
      s.object({
        store: s.string().meta({ title: 'Хранилище, из которого прочитано письмо' }),
        sentTo: s.number().meta({ title: 'Сколько получателей' }),
      }),
      s.string().meta({ title: 'Сообщение об ошибке' }),
    ]).optional(),
  }))
  .handle(async (ctx, body) => {
    try {
      const context = body.context as { customerContacts?: Contact[] } | undefined
      return await sendLetter(ctx, body.params, context?.customerContacts ?? [])
    } catch (err) {
      ctx.account.log('sendLetter упал', { level: 'error', json: { error: String(err) } })
      return { success: false, result: String(err) }
    }
  })
