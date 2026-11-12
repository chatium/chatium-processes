import test from 'node:test'
import assert from 'node:assert/strict'
import { crmUsageChecks } from '../lib/crm-contract.mjs'

const check = (content, path = 'demo/api/order.ts') => crmUsageChecks([{ path, content }])

test('direct Pay initiation is rejected including aliases and namespace calls', () => {
  for (const content of [
    "import { runAttemptPayment as pay } from '@pay/sdk'; pay(ctx, input)",
    "export { attemptAutoCharge as charge } from '@pay/sdk'",
    "import * as payment from '@pay/sdk'; payment.runPaymentOption(ctx, input)",
    "import { successAttemptPayment } from '@pay/sdk'",
  ]) assert.ok(check(content).errors.length, content)
})

test('CRM and diagnostic/refund Pay SDK imports are accepted, comments and strings ignored', () => {
  for (const content of [
    "import { createDeal, chargeDealWithSavedCard } from '@crm/sdk'",
    "import { getAllPaymentProviders, ensureSandboxProvider, findPayments, markPaymentRefunded } from '@pay/sdk'",
    "// import { runAttemptPayment } from '@pay/sdk'\nexport const x = 1",
    'const example = "import { runAttemptPayment } from \'@pay/sdk\'"',
    "import type { runAttemptPayment } from '@pay/sdk'",
  ]) assert.deepEqual(check(content).errors, [], content)
  assert.equal(check("const pay = await import('@pay/sdk')").warnings.length, 1)
})

test('table names flag ownership for review without rejecting a legitimate domain record', () => {
  assert.equal(check("Heap.Table('orders', {})", 'demo/tables/orders.table.ts').warnings.length, 1)
  assert.deepEqual(check("Heap.Table('enrollments', {})", 'demo/tables/enrollments.table.ts'), { errors: [], warnings: [] })
})
