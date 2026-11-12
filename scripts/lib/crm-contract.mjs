import { scanJsSource } from './source-lex.mjs'

export const CRM_DEAL_EVENTS = new Set(['created', 'stage-changed', 'won', 'lost',
  'archived', 'restored', 'payment-changed', 'paid', 'contact-linked', 'contact-unlinked']
  .map(name => `event://crm/deal/${name}`))

// Fields of the CRM account-events contract, used only for static analytics checks.
// Live registry, contact identity and process scope remain review requirements.
export function crmAnalyticsEvent(url) {
  if (!CRM_DEAL_EVENTS.has(url)) return undefined
  const strings = ['dealId', 'status', 'stageId', 'title', 'currency', 'paymentStatus',
    'stageName', 'pipelineId', 'previousStatus', 'previousStageName']
  const numbers = ['amount', 'paid', 'paidMoney', 'paidInternal', 'previousPaid']
  return { type: 'customerEvent', payment: /\/(?:paid|payment-changed)$/.test(url),
    payloadMapping: Object.fromEntries([...strings.map(key => [key, { type: 'string' }]),
      ...numbers.map(key => [key, { type: 'number' }])]) }
}

// CRM owns these events; they must not require a duplicate local writer or registration.
export const isModuleEventUrl = value => typeof value === 'string' &&
  /^event:\/\/(?!account\/|crm\/customer\/event\/)[a-z0-9-]+(?:\/[a-zA-Z0-9_-]+)+$/.test(value)

const directPayments = new Set(['runAttemptPayment', 'attemptPayment', 'attemptPaymentModern',
  'createAttempt', 'attemptAutoCharge', 'runPaymentOption', 'chargeInternalBalancePayment',
  'successAttemptPayment', 'failedAttemptPayment', 'recordAttemptPartialPayment'])

/** Static guidance, not a complete resolver: indirect SDK calls still need implementation review. */
export function crmUsageChecks(files) {
  const errors = [], warnings = []
  for (const { path, content } of files) {
    if (!/\.(?:[cm]?[jt]sx?|vue)$/.test(path) || path.endsWith('.d.ts')) continue
    const { clean, code } = scanJsSource(content)
    const imports = /\b(?:import|export)\s+(\{[^}]*\}|\*\s+as\s+[\w$]+)\s+from\s+(['"])@pay\/sdk\2/g
    for (const match of clean.matchAll(imports)) {
      if (!/\S/.test(code[match.index])) continue
      const clause = match[1]
      if (clause.startsWith('{')) {
        for (const name of clause.slice(1, -1).split(',').map(part => part.trim().split(/\s+/)[0]))
          if (directPayments.has(name)) errors.push(`${path}: ${name} из @pay/sdk обходит заказ CRM; используйте createDeal, страницу CRM и chargeDealWithSavedCard. Не подтверждайте оплату вручную.`)
      } else {
        const namespace = clause.split(/\s+/).at(-1).replace(/\$/g, '\\$')
        for (const method of directPayments)
          if (new RegExp(`\\b${namespace}\\s*\\.\\s*${method}\\s*\\(`).test(code))
            errors.push(`${path}: прямой Pay ${method} обходит заказ CRM; используйте штатный путь CRM.`)
      }
    }
    if (/\bimport\s*\(\s*['"]@pay\/sdk['"]\s*\)/.test(clean))
      warnings.push(`${path}: динамический Pay SDK требует ревью: создание и подтверждение оплаты должны оставаться в CRM; чтение, sandbox и штатные возвраты Pay допустимы.`)
    if (/\bHeap\s*\.\s*Table\s*\(/.test(code) && /(?:^|\/)(?:orders?|deals?|payments?)\.table\.[jt]s$/.test(path))
      warnings.push(`${path}: проверьте владельца данных — заказы и оплату хранит CRM. Собственная предметная запись допустима, дублирующая таблица заказов — нет.`)
  }
  return { errors, warnings }
}
