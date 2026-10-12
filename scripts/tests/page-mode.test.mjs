import assert from 'node:assert/strict'
import test from 'node:test'
import { internalPageErrors, needsCreativeReview } from '../lib/page-mode.mjs'

test('staff price control is mapped without a landing brief, while a public page still needs one', () => {
  const internal = { id: 'price', kind: 'page', pageMode: 'internal', source: 'demo/admin/price/' }
  assert.equal(needsCreativeReview(internal), false)
  assert.deepEqual(internalPageErrors(internal, "requireAccountRole(ctx, 'Admin')"), [])
  assert.equal(needsCreativeReview({ id: 'buy', kind: 'page', source: 'demo/pages/buy/' }), true)
  assert.equal(needsCreativeReview({ id: 'letters', kind: 'series' }), true)
})

test('a public or unprotected screen cannot skip creative review as internal', () => {
  assert.match(internalPageErrors({ id: 'buy', kind: 'page', pageMode: 'internal', source: 'demo/pages/buy/' },
    "requireAccountRole(ctx, 'Admin')").join(' '), /служебная страница/)
  assert.match(internalPageErrors({ id: 'price', kind: 'page', pageMode: 'internal', source: 'demo/admin/price/' },
    'export const route = app.get()').join(' '), /проверки роли/)
  assert.match(internalPageErrors({ id: 'table', kind: 'table', pageMode: 'internal', source: 'demo/tables/price.table.ts' },
    '').join(' '), /pageMode/)
})
