import { existsSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hasOpenBuildWork, implementationStep, messageFooter } from '../lib/implementation-step.mjs'

const reviewed = {
  hasKnowledge: true, hasPlan: true, designReady: true, planDecision: { status: 'ready' },
  openTasks: false, buildReady: true, currentNodes: [{ status: 'built' }],
  constructionStatus: 'current', testingStatus: 'passed', checkPassed: true,
  taskStage: 'test', launchDecision: { status: 'missing' },
}

test('pending client test or launch does not send an accepted block back to construction', () => {
  const plan = [{ id: 'T1', done: false, criteria: [{ id: 'A', stage: 'build' }, { id: 'B', stage: 'test' }] },
    { id: 'T2', done: false, criteria: [{ id: 'C', stage: 'launch' }] }]
  const card = { planTask: 'T1', status: 'done', acceptanceCriteria: [{ planCriteria: ['A'] }] }
  assert.equal(hasOpenBuildWork(plan, [card]), false)
  assert.equal(hasOpenBuildWork(plan, []), true)
  assert.equal(hasOpenBuildWork(plan, [{ ...card, status: 'queued' }]), true)
})

test('the owner sees the earliest unfinished step and one action, including both sides of the launch decision', () => {
  for (const [facts, label, next] of [
    [{ hasKnowledge: false }, '1 из 7 — Вводные о бизнесе', /уточню/],
    [{ hasPlan: false }, '2 из 7 — План и согласование', /опишу/],
    [{ planDecision: { status: 'missing' } }, '2 из 7 — План и согласование', /От вас/],
    [{ openTasks: true }, '3 из 7 — Сборка', /соберу/],
    [{ buildReady: false }, '4 из 7 — Приёмка сборки', /независимую проверку/],
    [{ testingStatus: 'incomplete' }, '5 из 7 — Проверка пути клиента', /проверю/],
    [{}, '6 из 7 — Согласование запуска', /решение/],
    [{ launchDecision: { status: 'ready', authority: 'owner' }, taskStage: 'launch' }, '7 из 7 — Запуск', /проверю.*включены/],
  ]) {
    const result = implementationStep({ ...reviewed, ...facts })
    assert.equal(result.label, label)
    assert.match(result.next, next)
    assert.ok(result.instruction)
    assert.ok(result.references.length)
    for (const ref of result.references) assert.ok(existsSync(new URL('../../' + ref, import.meta.url)), ref)
  }
})

test('drafts, stale results, a manual stage override and a rehearsal cannot advance the owner to a real launch', () => {
  const accepted = { status: 'ready', authority: 'owner' }
  const label = facts => implementationStep({ ...reviewed, ...facts }).label
  for (const facts of [
    { currentNodes: Array.from({ length: 13 }, () => ({ status: 'in-progress' })) },
    { currentNodes: null }, { currentNodes: [] }, { constructionStatus: 'stale' },
  ]) assert.equal(label({ ...facts, taskStage: 'launch', launchDecision: accepted }), '4 из 7 — Приёмка сборки')
  assert.equal(label({ testingStatus: 'incomplete', launchDecision: accepted }), '5 из 7 — Проверка пути клиента')
  assert.equal(label({ checkPassed: false }), '5 из 7 — Проверка пути клиента')
  assert.equal(label({ taskStage: 'launch' }), '5 из 7 — Проверка пути клиента')
  assert.equal(label({ launchDecision: { status: 'ready', authority: 'delegated-test' } }), '6 из 7 — Согласование запуска')
  assert.match(implementationStep({ ...reviewed, launchDecision: { status: 'declined' } }).next, /отложен/)
})

test('message footer has a separator, a branch-specific board link and both progress lines', () => {
  const progress = implementationStep(reviewed)
  const path = '/app/start/process-map?process=demo&branch=process%2Fdemo'
  const lines = [`Текущий шаг: ${progress.label}`, `Следующий шаг: ${progress.next}`]
  assert.equal(messageFooter(progress, 'https://user:token@account.example/s/git/account.git', path),
    ['---', `[Доска процесса](https://account.example${path})`, ...lines].join('\n\n'))
  for (const origin of ['', '/tmp/local-origin', 'https://github.com/example/account'])
    assert.equal(messageFooter(progress, origin, path), lines.join('\n'))
})
