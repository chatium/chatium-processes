import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { hasOpenBuildWork, implementationStep, messageFooter } from '../lib/implementation-step.mjs'

const reviewed = {
  hasKnowledge: true, hasPlan: true, designReady: true, planDecision: { status: 'ready' },
  openTasks: false, buildReady: true, currentNodes: [{ status: 'built' }],
  constructionStatus: 'current', processAcceptance: 'passed', testingStatus: 'passed', checkPassed: true,
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
    [{ hasPlan: false }, '2 из 7 — План и первая карта', /опишу/],
    [{ designReady: false }, '3 из 7 — Ревью плана и «Строим так?»', /методологу и архитектору/],
    [{ prematureContent: true }, '3 из 7 — Ревью плана и «Строим так?»', /черновики/],
    [{ planDecision: { status: 'declined' } }, '3 из 7 — Ревью плана и «Строим так?»', /учту ваши замечания/],
    [{ planDecision: { status: 'missing' }, checkPassed: false }, '3 из 7 — Ревью плана и «Строим так?»', /проверки проекта/],
    [{ planDecision: { status: 'missing' }, currentNodes: null }, '3 из 7 — Ревью плана и «Строим так?»', /актуальную карту/],
    [{ planDecision: { status: 'stale' } }, '3 из 7 — Ревью плана и «Строим так?»', /От вас/],
    [{ planDecision: { status: 'missing' } }, '3 из 7 — Ревью плана и «Строим так?»', /От вас/],
    [{ openTasks: true }, '4 из 7 — Сборка', /соберу/],
    [{ buildReady: false }, '5 из 7 — Приёмка', /независимую проверку/],
    [{ testingStatus: 'incomplete' }, '6 из 7 — Тестирование', /проверю/],
    [{}, '7 из 7 — Согласование и запуск', /решение/],
    [{ launchDecision: { status: 'ready', authority: 'owner' }, taskStage: 'launch' }, '7 из 7 — Согласование и запуск', /проверю.*включены/],
  ]) {
    const result = implementationStep({ ...reviewed, ...facts })
    assert.equal(result.label, label)
    assert.match(result.next, next)
    assert.ok(result.deliverable)
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
    { processAcceptance: 'failed' }, { processAcceptance: undefined },
    { currentNodes: null }, { currentNodes: [] }, { constructionStatus: 'stale' },
  ]) assert.equal(label({ ...facts, taskStage: 'launch', launchDecision: accepted }), '5 из 7 — Приёмка')
  assert.equal(label({ testingStatus: 'incomplete', launchDecision: accepted }), '6 из 7 — Тестирование')
  assert.equal(label({ checkPassed: false }), '6 из 7 — Тестирование')
  assert.equal(label({ taskStage: 'launch' }), '6 из 7 — Тестирование')
  const rehearsal = implementationStep({ ...reviewed, launchDecision: { status: 'ready', authority: 'delegated-test' } })
  assert.equal(rehearsal.label, '7 из 7 — Согласование и запуск')
  assert.match(rehearsal.next, /только учебный запуск/)
  assert.match(implementationStep({ ...reviewed, launchDecision: { status: 'stale' } }).next, /От вас нужно решение/)
  assert.match(implementationStep({ ...reviewed, launchDecision: { status: 'declined' } }).next, /отложен/)
})

test('the two working guides number the same seven steps as the message footer', () => {
  const facts = [{ hasKnowledge: false }, { hasPlan: false }, { designReady: false }, { openTasks: true },
    { buildReady: false }, { testingStatus: 'incomplete' }, {}]
  const headings = facts.map(state => implementationStep({ ...reviewed, ...state }).label.replace(' из 7 — ', '. '))
  for (const [file, numberedHeading] of [['WORKFLOW.md', /^### (\d+\. .+)$/gm], ['build/procedure.md', /^## (\d+\. .+)$/gm]]) {
    const guide = readFileSync(new URL('../../' + file, import.meta.url), 'utf8')
    assert.deepEqual([...guide.matchAll(numberedHeading)].map(match => match[1]), headings, file)
  }
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
