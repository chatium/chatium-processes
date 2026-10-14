import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { acceptanceErrors, creativeTaskChain, parseTaskPlan, taskReadiness } from '../lib/tasks.mjs'
import { prepareOwnerDecision, recordOwnerDecision } from '../lib/owner-decisions.mjs'
import { SKILL_DIR } from '../lib/project.mjs'

const cli = fileURLToPath(new URL('../tasks.mjs', import.meta.url))

test('CRLF and deeper indentation preserve plan tasks and criteria', () => {
  const plan = '# План\r\n\r\n## Задачи\r\n- [ ] T1 Форма\r\n    - T1.A1 [build] Данные сохранены\r\n'
  assert.deepEqual(parseTaskPlan(plan).map(task => [task.id, task.criteria.map(item => item.id)]), [['T1', ['T1.A1']]])
})

test('live plan criterion cannot be assigned to a build card', t => {
  const f = fixture(t)
  f.put('demo/PLAN.md', '# Demo\n\n## Задачи\n- [ ] T1 Форма\n  - T1.A1 [build] Форма собрана.\n  - T1.A2 [test] Заявка сохранена на сервере.\n')
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.acceptanceCriteria[0].planCriteria = ['T1.A2']
  f.put('demo/tasks/W001.json', task)
  assert.ok(taskReadiness({ root: f.root, slug: 'demo', stage: 'build' }).errors
    .some(error => /T1\.A2: живой критерий этапа test нужен в отдельной карточке test/.test(error)))
  task.stage = 'test'
  f.put('demo/tasks/W001.json', task)
  assert.ok(!taskReadiness({ root: f.root, slug: 'demo', stage: 'test' }).errors
    .some(error => /T1\.A2: живой критерий этапа test нужен/.test(error)))
})

test('task CLI uses code 2 for invalid invocation and code 1 for unmet readiness', t => {
  const f = fixture(t)
  const unknown = f.run('startt', 'W001')
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /Неизвестная команда startt/)
  const missingId = f.run('start')
  assert.equal(missingId.status, 2)
  assert.match(missingId.stderr, /Нужен ID/)
  const extraId = f.run('status', 'W001')
  assert.equal(extraId.status, 2)
  assert.match(extraId.stderr, /не принимает ID/)
  for (const command of ['create', 'record']) {
    const missingFile = f.run(command, 'W001')
    assert.equal(missingFile.status, 2)
    assert.match(missingFile.stderr, /нужен --file/)
  }
  f.put('broken.json', '{broken')
  const brokenFile = f.run('create', 'W001', '--file', join(f.root, 'broken.json'))
  assert.equal(brokenFile.status, 2)
  assert.match(brokenFile.stderr, /корректный JSON/)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  const unready = f.run('status')
  assert.equal(unready.status, 1)
  assert.ok(JSON.parse(unready.stdout).errors.some(error => /задача не завершена/.test(error)))
})

test('task status writes complete JSON when a large stdout pipe is read late', async t => {
  const f = fixture(t)
  const template = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  for (let i = 1; i <= 80; i += 1) {
    const id = `W${String(i).padStart(3, '0')}`
    f.put(`demo/tasks/${id}.json`, { ...template, id })
  }
  const child = spawn(process.execPath, [cli, 'status', 'demo', '--root', f.root],
    { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const closed = new Promise(resolve => child.once('close', resolve))
  child.stdout.pause()
  await new Promise(resolve => setTimeout(resolve, 100))
  child.stdout.resume()
  const code = await closed
  assert.equal(code, 1, stderr)
  assert.equal(JSON.parse(stdout).tasks.length, 80)
})

test('batch creation validates every card before changing task files or plan', t => {
  const f = fixture(t)
  const first = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  const second = structuredClone(first)
  second.id = 'W002'
  second.expectedOutputs = [{ path: 'demo/confirmation.vue', purpose: 'Подтверждение' }]
  const before = readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8')
  f.put('batch.json', [first, { ...second, planTask: 'T999' }])
  const bad = f.run('create-batch', '--file', join(f.root, 'batch.json'))
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /нет T-задачи/)
  assert.equal(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'), before)
  assert.equal(f.run('context', 'W001').status, 1)
  f.put('batch.json', [first, second])
  const good = f.run('create-batch', '--file', join(f.root, 'batch.json'))
  assert.equal(good.status, 0, good.stderr)
  assert.deepEqual(good.json.created.map(item => item.id), ['W001', 'W002'])
  const plan = readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8')
  assert.match(plan, /\[W001\]\(tasks\/W001\.json\), \[W002\]\(tasks\/W002\.json\)/)
  assert.equal(f.run('create-batch', 'W003', '--file', join(f.root, 'batch.json')).status, 2)
  assert.equal(f.run('create-batch', '--file', join(f.root, 'batch.json')).status, 1)
})

test('batch creation rejects an implementation whose creative spec has no producing task', t => {
  const f = fixture(t)
  const implementation = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  const specPath = 'demo/creative/form/spec.yaml'
  implementation.inputs.push({ kind: 'spec', path: specPath, purpose: 'Задание страницы' })
  const before = readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8')
  f.put('batch.json', [implementation])
  const missing = f.run('create-batch', '--file', join(f.root, 'batch.json'))
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /нужна одна карточка main\/produce/)
  assert.equal(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'), before)
  assert.equal(f.run('context', 'W001').status, 1)

  const producer = structuredClone(implementation)
  producer.id = 'W002'
  producer.title = 'Подготовить задание страницы'
  producer.mode = 'produce'
  producer.inputs = [{ kind: 'knowledge', path: '.knowledge-base/processes/demo/form.md', purpose: 'Поля' }]
  producer.expectedOutputs = [{ path: specPath, purpose: 'Задание страницы' }]
  f.put('batch.json', [implementation, producer])
  const unlinked = f.run('create-batch', '--file', join(f.root, 'batch.json'))
  assert.equal(unlinked.status, 1)
  assert.match(unlinked.stderr, /добавьте зависимость от W002/)
  assert.equal(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'), before)
  implementation.dependsOn = ['W002']
  f.put('batch.json', [implementation, producer])
  assert.equal(f.run('create-batch', '--file', join(f.root, 'batch.json')).status, 0)
  assert.ok(readFileSync(join(f.root, 'demo/tasks/W002.json'), 'utf8').includes(specPath))
})

test('oversized task is rejected before either single or batch creation changes the plan', t => {
  const f = fixture(t)
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.objective = 'Описание '.repeat(10_000)
  f.put('large.json', task)
  const before = readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8')
  const single = f.run('create', 'W001', '--file', join(f.root, 'large.json'))
  assert.equal(single.status, 1)
  assert.match(single.stderr, /64 КБ/)
  task.id = 'W002'
  f.put('batch.json', [JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8')), task])
  const batch = f.run('create-batch', '--file', join(f.root, 'batch.json'))
  assert.equal(batch.status, 1)
  assert.match(batch.stderr, /64 КБ/)
  assert.equal(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'), before)
  assert.equal(f.run('context', 'W001').status, 1)
  assert.equal(f.run('context', 'W002').status, 1)
})

test('single and batch creation honor the same plan lock', t => {
  const f = fixture(t)
  const before = readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8')
  f.put('batch.json', [JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))])
  f.put('demo/tasks/.create.lock', 'other-agent\n')
  for (const [command, args] of [
    ['create', ['W001', '--file', join(f.root, 'task.json')]],
    ['create-batch', ['--file', join(f.root, 'batch.json')]],
  ]) {
    const result = f.run(command, ...args)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /создание задач уже идёт/i)
  }
  assert.equal(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'), before)
  rmSync(join(f.root, 'demo/tasks/.create.lock'))
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
})

test('implementation cannot start without a current owner plan answer', t => {
  const f = fixture(t)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  rmSync(join(f.root, 'demo/decisions/plan.json'))
  const missing = f.run('start', 'W001')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /Нет ответа владельца/)
  f.approve()
  assert.equal(f.run('start', 'W001').status, 0)
})

test('v2 implementation cannot start before independent design conclusions', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', { type: 'process', processEngine: 'processes-v2' })
  f.put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\nlinks: []\n')
  f.approve()
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  const result = f.run('start', 'W001')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /ревью.*design|архитектур/i)
})

test('v2 specialist proposal cannot start before design and owner approval', t => {
  const f = fixture(t)
  f.put('demo/.workspace.json', { type: 'process', processEngine: 'processes-v2' })
  f.put('demo/process.yaml', 'title: Demo\nknowledge: .knowledge-base/processes/demo\nnodes: []\nlinks: []\n')
  f.approve()
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.executor = { kind: 'specialist', role: 'landing' }
  task.mode = 'produce'
  task.expectedOutputs = [{ path: 'demo/creative/form/proposals/landing.md', purpose: 'Предложение' }]
  task.acceptanceCriteria[0].verification = { kind: 'inspection', instruction: 'Сверить предложение со знаниями' }
  f.put('proposal.json', task)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'proposal.json')).status, 0)
  const blocked = f.run('start', 'W001')
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /ревью design не принято/)
})

test('specialist proposal cannot request unsupported independent review of Markdown', t => {
  const f = fixture(t)
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.executor = { kind: 'specialist', role: 'landing' }
  task.mode = 'produce'
  task.expectedOutputs = [{ path: 'demo/creative/form/proposals/landing.md', purpose: 'Предложение' }]
  task.acceptanceCriteria[0].verification = { kind: 'review', instruction: 'Сверить предложение со знаниями' }
  f.put('proposal.json', task)
  const blocked = f.run('create', 'W001', '--file', join(f.root, 'proposal.json'))
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /verification.kind: inspection/)
})

test('implementation waits for a deferred business answer at its dependent stage', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { title: 'Demo', nodes: [], needsInput: [{ title: 'Нужна ли ручная проверка заявки?',
    kind: 'question', blocks: ['build'] }] })
  f.approve()
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  const blocked = f.run('start', 'W001')
  assert.equal(blocked.status, 1)
  assert.match(blocked.stderr, /нужно решение владельца: Нужна ли ручная проверка заявки/)
  f.put('demo/process.yaml', { title: 'Demo', nodes: [] })
  f.approve()
  assert.equal(f.run('start', 'W001').status, 0)
})
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'process-tasks-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const put = (path, content) => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n')
  }
  const sha = path => createHash('sha256').update(readFileSync(join(root, path))).digest('hex')
  put('demo/PLAN.md', '# Demo\n\n## Задачи\n- [ ] T1 Форма\n  - T1.A1 [build] Корректная заявка записана.\n\n## Согласования\n- План: согласован\n')
  put('demo/tasks/index.json', { version: 1 })
  put('.knowledge-base/processes/demo/form.md', 'Email обязателен.\n')
  const task = {
    version: 1, id: 'W001', planTask: 'T1', title: 'Собрать форму', targetNode: 'form',
    executor: { kind: 'main', role: 'developer' }, mode: 'implement', stage: 'build',
    objective: 'Сохранить заявку', scope: { includes: ['Форма'], excludes: ['Письмо'] },
    status: 'queued', revision: 0, createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z',
    dependsOn: [], session: null,
    inputs: [{ kind: 'knowledge', path: '.knowledge-base/processes/demo/form.md', purpose: 'Поля' }],
    expectedOutputs: [{ path: 'demo/form.vue', purpose: 'Форма' }],
    steps: [{ id: 'P1', action: 'Собрать', status: 'todo', reason: null }],
    acceptanceCriteria: [{ id: 'C1', planCriteria: ['T1.A1'], condition: 'Корректная заявка записана',
      verification: { kind: 'test', instruction: 'Запустить проверку записи' } }],
    questions: [], drafts: [], latestAttempt: null, attempts: [], result: null, acceptance: null, cancellation: null,
  }
  put('task.json', task)
  for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'],
    ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-qm', 'Initial']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  const approve = () => {
    const packet = prepareOwnerDecision({ root, slug: 'demo', kind: 'plan', boardRevision: null })
    recordOwnerDecision({ root, slug: 'demo', kind: 'plan', packet,
      response: { decision: 'approve', message: 'Тестовое согласование плана.',
        messageReference: 'unit-test/message-1', owner: 'fixture-owner', answeredAt: new Date().toISOString() } })
  }
  approve()
  const run = (command, ...args) => {
    const response = spawnSync(process.execPath, [cli, command, 'demo', ...args, '--root', root], { encoding: 'utf8' })
    return { ...response, json: response.status === 0 ? JSON.parse(response.stdout) : null }
  }
  return { root, put, run, sha, approve, task: () => JSON.parse(readFileSync(join(root, 'demo/tasks/W001.json'), 'utf8')) }
}

test('main agent can resume after a KB answer and close a task only with evidence', t => {
  const f = fixture(t)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  assert.match(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'), /\[W001\]\(tasks\/W001\.json\)/)
  assert.ok(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(e => e.includes('задача не завершена')))
  const firstStart = f.run('start', 'W001')
  assert.equal(firstStart.status, 0, firstStart.stderr)
  assert.equal(firstStart.json.attemptId, 'R001')
  f.put('question.json', { questions: [{ id: 'Q1', question: 'Нужно имя?', why: 'Поле формы', blocking: true }] })
  assert.equal(f.run('ask', 'W001', '--file', join(f.root, 'question.json')).json.status, 'needs-input')
  f.put('.knowledge-base/processes/demo/form.md', 'Email обязателен. Имя не требуется.\n')
  f.put('answer.json', { summary: 'Имя не требуется', sourceRefs: ['.knowledge-base/processes/demo/form.md'] })
  assert.equal(f.run('resolve', 'W001', '--question', 'Q1', '--file', join(f.root, 'answer.json')).json.status, 'ready-to-resume')
  f.approve()
  assert.equal(f.run('start', 'W001').json.attemptId, 'R002')
  assert.equal(f.run('step', 'W001', '--step', 'P1', '--status', 'done').status, 0)
  f.put('demo/form.vue', '<template>Форма</template>\n')
  f.put('demo/reviews/tasks/W001/tests.json', { version: 1, method: 'Изолированный тест заявки',
    inputDigest: f.task().attempts.at(-1).inputDigest,
    testedFiles: [{ path: 'demo/form.vue', sha256: f.sha('demo/form.vue') }],
    checks: [{ id: 'valid-email', status: 'pass' }] })
  const resultGuide = readFileSync(join(SKILL_DIR, 'formats/work-task.md'), 'utf8')
  const resultExample = /```json\n([\s\S]*?)\n```/.exec(resultGuide.split('## Результат для `tasks.mjs record`\n')[1])?.[1]
  assert.ok(resultExample, 'справка должна содержать JSON результата задачи')
  const documentedResult = JSON.parse(resultExample)
  documentedResult.attemptId = 'R002'
  documentedResult.outputs[0].path = 'demo/form.vue'
  documentedResult.criteriaResults[0].evidence[0].path = 'demo/reviews/tasks/W001/tests.json'
  documentedResult.criteriaResults[0].evidence[0].locator = 'valid-email'
  f.put('result.json', documentedResult)
  assert.equal(f.run('record', 'W001', '--file', join(f.root, 'result.json')).json.status, 'result-ready')
  f.put('demo/process.yaml', { nodes: [{ id: 'form', kind: 'page', source: 'demo/form.vue' }] })
  const oldTask = f.run('accept', 'W001')
  assert.equal(oldTask.status, 1)
  assert.match(oldTask.stderr, /нет задачи специалиста landing/)
  rmSync(join(f.root, 'demo/process.yaml'))
  assert.equal(f.run('accept', 'W001').json.status, 'done')
  assert.ok(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(e => e.includes('PLAN.md остаётся открытой')))
  f.put('demo/PLAN.md', readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8').replace('- [ ] T1', '- [x] T1'))
  assert.deepEqual(taskReadiness({ root: f.root, slug: 'demo' }).errors, [])
  f.put('.knowledge-base/processes/demo/form.md', 'Email и телефон обязательны.\n')
  assert.ok(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(e => e.includes('изменились входные материалы')))
})

test('accept rejects missing or failed evidence and changed criteria', t => {
  const f = fixture(t)
  f.run('create', 'W001', '--file', join(f.root, 'task.json'))
  f.run('start', 'W001')
  f.run('step', 'W001', '--step', 'P1', '--status', 'done')
  f.put('demo/form.vue', 'Форма\n')
  f.put('demo/reviews/tasks/W001/tests.json', { version: 1, method: 'Изолированный тест заявки',
    inputDigest: f.task().attempts.at(-1).inputDigest,
    testedFiles: [{ path: 'demo/form.vue', sha256: f.sha('demo/form.vue') }],
    checks: [{ id: 'valid-email', status: 'fail' }] })
  f.put('result.json', { attemptId: 'R001', summary: 'Черновик', outputs: [{ path: 'demo/form.vue' }],
    criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{ path: 'demo/reviews/tasks/W001/tests.json', locator: 'valid-email', observation: 'Заявка' }] }],
  })
  f.run('record', 'W001', '--file', join(f.root, 'result.json'))
  const rejected = f.run('accept', 'W001')
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /не содержит пройденную проверку/)
  assert.equal(f.task().status, 'result-ready')
})

test('test evidence for old output cannot accept changed implementation', t => {
  const f = fixture(t)
  f.run('create', 'W001', '--file', join(f.root, 'task.json'))
  f.run('start', 'W001')
  f.run('step', 'W001', '--step', 'P1', '--status', 'done')
  f.put('demo/form.vue', '<template>Первая версия</template>\n')
  f.put('demo/reviews/tasks/W001/tests.json', { version: 1, method: 'Изолированный тест заявки',
    inputDigest: f.task().attempts.at(-1).inputDigest,
    testedFiles: [{ path: 'demo/form.vue', sha256: f.sha('demo/form.vue') }],
    checks: [{ id: 'valid-email', status: 'pass' }] })
  f.put('demo/form.vue', '<template>Другая версия</template>\n')
  f.put('result.json', { attemptId: 'R001', summary: 'Форма готова', outputs: [{ path: 'demo/form.vue' }],
    criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{
      path: 'demo/reviews/tasks/W001/tests.json', locator: 'valid-email', observation: 'Заявка записана',
    }] }],
  })
  assert.equal(f.run('record', 'W001', '--file', join(f.root, 'result.json')).status, 0)
  const rejected = f.run('accept', 'W001')
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /не проверял текущие результаты/)
})

test('specialist receives an isolated bounded packet with role instructions', t => {
  const f = fixture(t)
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.executor = { kind: 'specialist', role: 'consultant', profiles: ['copywriting'] }
  task.mode = 'produce'
  task.expectedOutputs = [{ path: 'demo/creative/form/proposals/copy.md', purpose: 'Предложение текста' }]
  f.put('task.json', task)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  assert.equal(f.run('start', 'W001').status, 0)
  const packetDir = mkdtempSync(join(tmpdir(), 'specialist-packet-'))
  t.after(() => rmSync(packetDir, { recursive: true, force: true }))
  const prepared = f.run('prepare', 'W001', '--out', packetDir)
  assert.equal(prepared.status, 0, prepared.stderr)
  const packet = JSON.parse(readFileSync(prepared.json.packet, 'utf8'))
  assert.equal(packet.task.executor.kind, 'specialist')
  assert.equal(packet.materials[0].path, '.knowledge-base/processes/demo/form.md')
  assert.deepEqual(packet.competencies.profiles.map(profile => profile.id), ['copywriting'])
  assert.ok(readFileSync(prepared.json.prompt, 'utf8').includes(readFileSync(join(SKILL_DIR, 'specialists/profiles/copywriting.md'), 'utf8').trim()))
  assert.match(readFileSync(prepared.json.prompt, 'utf8'), /run|JSON|специалист/)
  f.put('question.json', { questions: [{ id: 'Q1', question: 'Какой тон?', why: 'Нужен текст', blocking: true }] })
  assert.equal(f.run('ask', 'W001', '--file', join(f.root, 'question.json')).status, 0)
  f.put('.knowledge-base/processes/demo/voice.md', 'Тон спокойный и конкретный.\n')
  f.put('answer.json', { summary: 'Спокойный тон', sourceRefs: ['.knowledge-base/processes/demo/voice.md'] })
  assert.equal(f.run('resolve', 'W001', '--question', 'Q1', '--file', join(f.root, 'answer.json')).status, 0)
  f.approve()
  assert.equal(f.run('start', 'W001').status, 0)
  const resumedDir = mkdtempSync(join(tmpdir(), 'specialist-resumed-'))
  t.after(() => rmSync(resumedDir, { recursive: true, force: true }))
  const resumed = f.run('prepare', 'W001', '--out', resumedDir)
  assert.equal(resumed.status, 0, resumed.stderr)
  const resumedPacket = JSON.parse(readFileSync(resumed.json.packet, 'utf8'))
  assert.ok(resumedPacket.materials.some(material => material.path === '.knowledge-base/processes/demo/voice.md'))
  assert.equal(resumedPacket.task.resolvedQuestions[0].answer.summary, 'Спокойный тон')
})

test('task registry rejects untracked card names, mismatched IDs and symlinks', t => {
  const f = fixture(t)
  f.put('demo/tasks/other.json', { version: 1 })
  assert.throws(() => taskReadiness({ root: f.root, slug: 'demo' }), /Неизвестные JSON-карточки/)
  rmSync(join(f.root, 'demo/tasks/other.json'))
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.id = 'W002'
  f.put('demo/tasks/W001.json', task)
  assert.throws(() => taskReadiness({ root: f.root, slug: 'demo' }), /не совпадает/)
  rmSync(join(f.root, 'demo/tasks/W001.json'))
  symlinkSync(join(f.root, 'task.json'), join(f.root, 'demo/tasks/W001.json'))
  assert.throws(() => taskReadiness({ root: f.root, slug: 'demo' }), /не может быть ссылкой/)
})

test('specialist role cannot traverse outside role instructions', t => {
  const f = fixture(t)
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.executor = { kind: 'specialist', role: '../../private' }
  f.put('task.json', task)
  const result = f.run('create', 'W001', '--file', join(f.root, 'task.json'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /безопасный исполнитель/)
})

test('specialist cannot be assigned implementation of a landing', t => {
  const f = fixture(t)
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.executor = { kind: 'specialist', role: 'landing' }
  task.title = 'Собрать лендинг'
  task.targetNode = 'landing-page'
  f.put('task.json', task)
  const rejected = f.run('create', 'W001', '--file', join(f.root, 'task.json'))
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /специалист не реализует код/)
  task.mode = 'produce'
  f.put('task.json', task)
  const disguised = f.run('create', 'W001', '--file', join(f.root, 'task.json'))
  assert.equal(disguised.status, 1)
  assert.match(disguised.stderr, /результат специалиста — предложение или отчёт/)
  task.expectedOutputs = [{ path: 'demo/creative/landing-page/proposals/landing.md', purpose: 'Предложение по странице' }]
  f.put('task.json', task)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
})

test('page readiness requires specialist proposal, main spec and main implementation tasks', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { nodes: [{ id: 'landing-page', kind: 'page', creativeRef: 'demo/creative/landing-page/spec.yaml' }] })
  const before = taskReadiness({ root: f.root, slug: 'demo', stage: 'build' }).errors.join('\n')
  assert.match(before, /нет задачи специалиста landing/)
  assert.match(before, /нет задачи main на итоговый/)
  assert.match(before, /нет задачи main на реализацию/)
  const base = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  const expert = { ...base, id: 'W010', title: 'Проект страницы', targetNode: 'landing-page',
    executor: { kind: 'specialist', role: 'landing' }, mode: 'produce',
    expectedOutputs: [{ path: 'demo/creative/landing-page/proposals/landing.md', purpose: 'Предложение специалиста' }] }
  const spec = { ...base, id: 'W011', title: 'Свести конфигуратор', targetNode: 'landing-page',
    mode: 'produce', dependsOn: ['W010'],
    expectedOutputs: [{ path: 'demo/creative/landing-page/spec.yaml', purpose: 'Конфигуратор' }] }
  const implementation = { ...base, id: 'W012', title: 'Реализовать страницу', targetNode: 'landing-page',
    dependsOn: ['W011'], inputs: [{ kind: 'build', path: 'demo/creative/landing-page/build.md', purpose: 'Задание' }],
    expectedOutputs: [{ path: 'demo/pages/landing.vue', purpose: 'Страница' }] }
  for (const task of [expert, spec, implementation]) f.put(`demo/tasks/${task.id}.json`, task)
  const withoutProposalInput = taskReadiness({ root: f.root, slug: 'demo', stage: 'build' }).errors.join('\n')
  assert.match(withoutProposalInput, /не читает предложение специалиста landing/)
  spec.inputs = [{ kind: 'report', path: expert.expectedOutputs[0].path, purpose: 'Предложение специалиста' }]
  f.put('demo/tasks/W011.json', spec)
  const after = taskReadiness({ root: f.root, slug: 'demo', stage: 'build' }).errors.join('\n')
  assert.doesNotMatch(after, /нет задачи специалиста landing|нет задачи main на итоговый|нет задачи main на реализацию|не зависит от/)
  assert.doesNotMatch(after, /не читает предложение специалиста landing/)
})

test('series needs one exact task per message and start cannot bypass the brief', t => {
  const f = fixture(t)
  f.put('demo/process.yaml', { nodes: [{ id: 'warmup', kind: 'series',
    source: '.mailings/storage/processes/demo/warmup/', creativeRef: 'demo/creative/warmup/spec.yaml' }] })
  const paths = ['01-first', '02-second'].map(name => `.mailings/storage/processes/demo/warmup/${name}.message.yaml`)
  f.put('demo/creative/warmup/spec.yaml', { messages: paths.map((path, i) => ({ id: `m${i + 1}`, path })) })
  const base = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  base.targetNode = 'warmup'
  base.expectedOutputs = [{ path: '.mailings/storage/processes/demo/warmup/', purpose: 'Папка писем' }]
  f.put('task.json', base)
  const directory = f.run('create', 'W001', '--file', join(f.root, 'task.json'))
  assert.equal(directory.status, 1)
  assert.match(directory.stderr, /точные пути файлов результата/)
  base.expectedOutputs = [{ path: paths[0], purpose: 'Первое письмо' }, { path: paths[1], purpose: 'Второе письмо' }]
  f.put('task.json', base)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  f.approve()
  const bypass = f.run('start', 'W001')
  assert.equal(bypass.status, 1)
  assert.match(bypass.stderr, /перед реализацией нужен вход|нет задачи специалиста email/)
  const wrongNode = f.task()
  wrongNode.targetNode = 'other'
  f.put('demo/tasks/W001.json', wrongNode)
  const wrong = f.run('start', 'W001')
  assert.equal(wrong.status, 1)
  assert.match(wrong.stderr, /указан в карточке с targetNode other/)
  f.put('demo/tasks/W001.json', { ...wrongNode, targetNode: 'warmup' })
  const obsolete = f.task()
  obsolete.status = 'cancelled'
  obsolete.cancellation = { reason: 'Заменена отдельными карточками писем', decisionRef: 'demo/PLAN.md' }
  f.put('demo/tasks/W001.json', obsolete)
  const expert = { ...base, id: 'W010', executor: { kind: 'specialist', role: 'email' }, mode: 'produce',
    expectedOutputs: [{ path: 'demo/creative/warmup/proposals/email.md', purpose: 'Проект серии' }] }
  const spec = { ...base, id: 'W011', mode: 'produce', dependsOn: ['W010'],
    inputs: [{ kind: 'report', path: expert.expectedOutputs[0].path, purpose: 'Проект серии' }],
    expectedOutputs: [{ path: 'demo/creative/warmup/spec.yaml', purpose: 'Конфигуратор' }] }
  const implementation = (id, path) => ({ ...base, id, dependsOn: ['W011'],
    inputs: [{ kind: 'build', path: 'demo/creative/warmup/build.md', purpose: 'Задание' }],
    expectedOutputs: [{ path, purpose: 'Готовое сообщение' }] })
  for (const task of [expert, spec, implementation('W012', paths[0])]) f.put(`demo/tasks/${task.id}.json`, task)
  const incomplete = taskReadiness({ root: f.root, slug: 'demo', stage: 'build' }).errors.join('\n')
  assert.match(incomplete, /warmup\/m2: нужен один точный результат/)
  f.put('demo/tasks/W013.json', implementation('W013', paths[1]))
  const complete = taskReadiness({ root: f.root, slug: 'demo', stage: 'build' }).errors.join('\n')
  assert.doesNotMatch(complete, /warmup\/m[12]: нужен один точный результат|каждое сообщение требует отдельную/)
  f.put('demo/tasks/W013.json', implementation('W013', paths[0]))
  const duplicate = taskReadiness({ root: f.root, slug: 'demo', stage: 'build' }).errors.join('\n')
  assert.match(duplicate, /warmup\/m1: нужен один точный результат/)
})

test('existing output must match its start version before applying changes', t => {
  const f = fixture(t)
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.inputs.push({ kind: 'code', path: 'demo/form.vue', purpose: 'Существующая форма' })
  f.put('demo/form.vue', 'Первая версия\n')
  f.put('task.json', task)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  assert.equal(f.run('start', 'W001').status, 0)
  f.put('demo/form.vue', 'Чужая правка\n')
  const rejected = f.run('verify-base', 'W001')
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /исходный файл изменился/)
  f.put('demo/form.vue', 'Первая версия\n')
  assert.equal(f.run('verify-base', 'W001').status, 0)
})

test('specialist result requires bound run and saved response', t => {
  const f = fixture(t)
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.executor = { kind: 'specialist', role: 'consultant', profiles: ['copywriting'] }
  task.mode = 'produce'
  task.expectedOutputs = [{ path: 'demo/creative/form/proposals/copy.md', purpose: 'Предложение текста' }]
  f.put('task.json', task)
  f.run('create', 'W001', '--file', join(f.root, 'task.json'))
  f.run('start', 'W001')
  f.run('step', 'W001', '--step', 'P1', '--status', 'done')
  f.put('demo/creative/form/proposals/copy.md', 'Текст формы и подтверждения.\n')
  f.put('demo/reviews/tasks/W001/tests.json', { version: 1, method: 'Проверка формы',
    inputDigest: f.task().attempts.at(-1).inputDigest,
    testedFiles: [{ path: 'demo/creative/form/proposals/copy.md', sha256: f.sha('demo/creative/form/proposals/copy.md') }],
    checks: [{ id: 'valid-email', status: 'pass' }] })
  const responseRef = join(mkdtempSync(join(tmpdir(), 'specialist-response-')), 'response.json')
  t.after(() => rmSync(dirname(responseRef), { recursive: true, force: true }))
  writeFileSync(responseRef, '{"status":"result"}')
  f.put('result.json', { attemptId: 'R001', responseRef, summary: 'Результат специалиста',
    outputs: [{ path: 'demo/creative/form/proposals/copy.md' }],
    criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{
      path: 'demo/reviews/tasks/W001/tests.json', locator: 'valid-email', observation: 'Проверено',
    }] }],
  })
  const withoutRun = f.run('record', 'W001', '--file', join(f.root, 'result.json'))
  assert.equal(withoutRun.status, 1)
  assert.match(withoutRun.stderr, /сначала нужен bind/)
  assert.equal(f.run('bind', 'W001', '--agent-id', 'subagent-42').status, 0)
  const missingProfiles = f.run('record', 'W001', '--file', join(f.root, 'result.json'))
  assert.equal(missingProfiles.status, 1)
  assert.match(missingProfiles.stderr, /контракту компетенций|brief/)
  writeFileSync(responseRef, JSON.stringify({ status: 'result',
    contractDigest: f.task().attempts.at(-1).specialistContract.digest,
    brief: 'Заявка требует email; источник: .knowledge-base/processes/demo/form.md.',
    proposal: 'Текст формы и подтверждения.',
    profileApplications: [{ id: 'copywriting', decision: 'Точный текст состояния после отправки', proposalQuote: 'Текст формы и подтверждения.' }] }))
  const started = f.task(), incomplete = structuredClone(started)
  delete incomplete.attempts.at(-1).specialistContract
  f.put('demo/tasks/W001.json', incomplete)
  const missingContract = f.run('record', 'W001', '--file', join(f.root, 'result.json'))
  assert.equal(missingContract.status, 1)
  assert.match(missingContract.stderr, /Нет актуального контракта компетенций/)
  f.put('demo/tasks/W001.json', started)
  assert.equal(f.run('record', 'W001', '--file', join(f.root, 'result.json')).status, 0)
  assert.equal(f.task().attempts.at(-1).responseRef, responseRef)
  assert.equal(f.task().result.specialistEvidence.profileApplications[0].id, 'copywriting')
  assert.equal(f.run('accept', 'W001').status, 0)
  const saved = f.task()
  const acceptedWithoutContract = structuredClone(saved)
  delete acceptedWithoutContract.attempts.at(-1).specialistContract
  f.put('demo/tasks/W001.json', acceptedWithoutContract)
  assert.match(f.run('status').stdout, /нет актуального контракта компетенций/)
  saved.result.specialistEvidence.profileApplications = []
  f.put('demo/tasks/W001.json', saved)
  assert.match(f.run('status').stdout, /каждого выбранного профиля/)
})

test('consultation CLI composes explicit profiles and rejects unknown profiles before creating a card', t => {
  const f = fixture(t), task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.executor = { kind: 'specialist', role: 'consultant', profiles: ['marketing', 'missing'] }
  task.mode = 'consult'
  task.expectedOutputs = [{ path: 'demo/proposals/offer.md', purpose: 'Выбор предложения' }]
  f.put('task.json', task)
  const before = readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8')
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 1)
  assert.equal(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'), before)
  task.executor.profiles = ['marketing', 'product']
  f.put('task.json', task)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  assert.equal(f.run('start', 'W001').status, 0)
  const directory = mkdtempSync(join(tmpdir(), 'composed-consultation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const prepared = f.run('prepare', 'W001', '--out', directory)
  assert.equal(prepared.status, 0, prepared.stderr)
  const packet = JSON.parse(readFileSync(prepared.json.packet, 'utf8'))
  assert.deepEqual(packet.competencies.profiles.map(p => p.id), ['marketing', 'product'])
  assert.equal(packet.competencies.digest, f.task().attempts.at(-1).specialistContract.digest)
  assert.ok(readFileSync(prepared.json.prompt, 'utf8').includes(readFileSync(join(SKILL_DIR, 'specialists/profiles/product.md'), 'utf8').trim()))
})

test('confirmation recipe only replaces landing for a thank-you page; consultation cannot bypass the creative chain', t => {
  const f = fixture(t), node = { id: 'form', kind: 'page', source: 'demo/form.vue' }
  const expert = { id: 'W001', targetNode: 'form', executor: { kind: 'specialist', role: 'confirmation' }, mode: 'produce',
    expectedOutputs: [{ path: 'demo/proposals/thanks.md' }] }
  const spec = { id: 'W002', targetNode: 'form', executor: { kind: 'main' }, mode: 'produce', dependsOn: ['W001'],
    inputs: [{ path: 'demo/proposals/thanks.md' }], expectedOutputs: [{ path: 'demo/creative/form/spec.yaml' }] }
  const build = { id: 'W003', targetNode: 'form', executor: { kind: 'main' }, mode: 'implement', dependsOn: ['W002'],
    inputs: [{ kind: 'build', path: 'demo/creative/form/build.md' }], expectedOutputs: [{ path: 'demo/form.vue' }] }
  const run = () => creativeTaskChain({ root: f.root, slug: 'demo', node, tasks: [expert, spec, build] }).errors
  f.put('demo/creative/form/spec.yaml', { landingType: 'thankyou' })
  assert.deepEqual(run(), [])
  f.put('demo/creative/form/spec.yaml', { landingType: 'sales' })
  assert.match(run().join(), /confirmation подходит только/)
  expert.executor.role = 'consultant'
  assert.match(run().join(), /нет задачи специалиста landing/)
})

test('duplicate plan task and criterion IDs are rejected', t => {
  const f = fixture(t)
  f.put('demo/PLAN.md', '# Demo\n\n## Задачи\n- [ ] T1 Первая\n  - T1.A1 [build] Первый результат.\n- [ ] T1 Вторая\n')
  assert.throws(() => taskReadiness({ root: f.root, slug: 'demo' }), /Повторная задача плана/)
  f.put('demo/PLAN.md', '# Demo\n\n## Задачи\n- [ ] T1 Первая\n  - T1.A1 [build] Первый результат.\n  - T1.A1 [build] Другой результат.\n')
  assert.throws(() => taskReadiness({ root: f.root, slug: 'demo' }), /Повторный критерий плана/)
})

test('unknown review file cannot close a criterion with a forged ready flag', t => {
  const f = fixture(t)
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.acceptanceCriteria[0].verification = { kind: 'review', instruction: 'Независимое ревью' }
  f.put('task.json', task)
  f.run('create', 'W001', '--file', join(f.root, 'task.json'))
  f.run('start', 'W001')
  f.run('step', 'W001', '--step', 'P1', '--status', 'done')
  f.put('demo/form.vue', '<template>Форма</template>\n')
  f.put('demo/reviews/tasks/W001/forged.json', { status: 'ready', reviewer: { kind: 'subagent', reference: 'fake' } })
  f.put('result.json', { attemptId: 'R001', summary: 'Форма готова', outputs: [{ path: 'demo/form.vue' }],
    criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{
      path: 'demo/reviews/tasks/W001/forged.json', locator: 'task', observation: 'Принято',
    }] }],
  })
  assert.equal(f.run('record', 'W001', '--file', join(f.root, 'result.json')).status, 0)
  const rejected = f.run('accept', 'W001')
  assert.equal(rejected.status, 1)
  assert.match(rejected.stderr, /Неподдерживаемый отчёт/)
})

test('task review evidence checks current architecture, analytics and agent conclusions', t => {
  const f = fixture(t)
  const plan = parseTaskPlan(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'))
  const task = JSON.parse(readFileSync(join(f.root, 'task.json'), 'utf8'))
  task.acceptanceCriteria[0].verification.kind = 'review'
  task.attempts = [{ id: 'R001' }]
  f.put('demo/form.vue', '<template>Форма</template>\n')
  for (const name of ['architecture', 'analytics', 'agents']) {
    const path = `demo/reviews/${name}.json`
    f.put(path, { version: 1, process: 'demo', stage: name, status: 'ready',
      reviewedAt: new Date().toISOString(), inputDigest: 'outdated-material',
      reviewer: { kind: 'subagent', reference: 'forged-report' } })
    task.result = { summary: 'Проверено', attemptId: 'R001',
      outputs: [{ path: 'demo/form.vue', sha256: f.sha('demo/form.vue') }],
      criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{ path,
        sha256: f.sha(path), locator: 'coverage', observation: 'Проверено' }] }] }
    const errors = acceptanceErrors(f.root, 'demo', task, plan, [task]).join('\n')
    assert.match(errors, /ревью устарело|нет помощников|изменились/i)
    assert.doesNotMatch(errors, /Неподдерживаемый отчёт/)
  }
})

test('failed attempt retries and accepted card can be reopened with history', t => {
  const f = fixture(t)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  assert.equal(f.run('start', 'W001').status, 0)
  f.put('failure.json', { reason: 'Тестовая отправка не дошла' })
  assert.equal(f.run('fail', 'W001', '--file', join(f.root, 'failure.json')).json.status, 'failed')
  assert.equal(f.run('start', 'W001').json.attemptId, 'R002')
  const accepted = f.task()
  accepted.status = 'done'
  accepted.acceptance = { decision: 'accepted', at: '2026-10-06T10:00:00Z' }
  accepted.result = { attemptId: 'R002', summary: 'Старый результат' }
  f.put('demo/tasks/W001.json', accepted)
  f.put('reopen.json', { reason: 'После ревью уточнили путь клиента' })
  const reopened = f.run('reopen', 'W001', '--file', join(f.root, 'reopen.json'))
  assert.equal(reopened.status, 0, reopened.stderr)
  assert.equal(f.task().status, 'queued')
  assert.equal(f.task().reopens.length, 1)
  assert.equal(f.task().acceptance, null)
  assert.equal(f.task().result, null)
  assert.equal(f.run('start', 'W001').json.attemptId, 'R003')
})

test('one independent batch reassesses unchanged results without rerunning their old tests', t => {
  const f = fixture(t)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  const started = f.run('start', 'W001')
  assert.equal(started.status, 0, started.stderr)
  assert.equal(f.run('step', 'W001', '--step', 'P1', '--status', 'done').status, 0)
  f.put('demo/form.vue', '<template>Форма</template>\n')
  f.put('demo/reviews/tasks/W001/tests.json', { version: 1, method: 'Локальная проверка формы',
    inputDigest: started.json.inputDigest,
    testedFiles: [{ path: 'demo/form.vue', sha256: f.sha('demo/form.vue') }],
    checks: [{ id: 'C1', status: 'pass' }] })
  f.put('result.json', { attemptId: started.json.attemptId, summary: 'Форма проверена',
    outputs: [{ path: 'demo/form.vue' }],
    criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{
      path: 'demo/reviews/tasks/W001/tests.json', locator: 'C1', observation: 'Локальная проверка прошла',
    }] }] })
  assert.equal(f.run('record', 'W001', '--file', join(f.root, 'result.json')).status, 0)
  assert.equal(f.run('accept', 'W001').status, 0)
  f.put('demo/PLAN.md', readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8').replace('- [ ] T1', '- [x] T1'))
  const commit = message => {
    for (const args of [['add', '.'], ['commit', '-qm', message]]) {
      const result = spawnSync('git', args, { cwd: f.root, encoding: 'utf8' })
      assert.equal(result.status, 0, result.stderr)
    }
    return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).stdout.trim()
  }
  const baseline = commit('Accepted form')
  f.put('.knowledge-base/processes/demo/form.md', 'Email обязателен. Уточнили пример, который не меняет форму.\n')
  commit('Clarify knowledge')
  assert.ok(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(error => /изменились входные материалы/.test(error)))
  const prepared = f.run('reassess-prepare', '--base', baseline)
  assert.equal(prepared.status, 0, prepared.stderr)
  const packet = JSON.parse(readFileSync(prepared.json.packet, 'utf8'))
  assert.deepEqual(packet.eligible.map(item => item.taskId), ['W001'])
  assert.deepEqual(packet.eligible[0].changedInputs, ['.knowledge-base/processes/demo/form.md'])
  const candidate = packet.eligible[0]
  const report = { version: 1, kind: 'task-reassessment', process: 'demo',
    baselineCommit: packet.baselineCommit, headCommit: packet.headCommit,
    packetDigest: packet.packetDigest, reviewedAt: new Date().toISOString(),
    reviewer: { kind: 'subagent', reference: '/root/independent_reviewer' },
    findings: [{ taskId: 'W001', decision: 'unaffected',
      fromInputDigest: candidate.fromInputDigest, toInputDigest: candidate.toInputDigest,
      rationale: 'Добавлен только пример; поля и проверенное поведение формы остались прежними.',
      changedInputs: [{ path: candidate.changedInputs[0],
        reason: 'Уточнение иллюстрации не меняет обязательность email или структуру формы.' }],
      criteria: [{ id: 'C1', reason: 'Проверка сохранения заявки не зависит от нового примера в статье.' }],
    }] }
  const reportDir = mkdtempSync(join(tmpdir(), 'task-reassessment-report-'))
  t.after(() => rmSync(reportDir, { recursive: true, force: true }))
  const reportFile = join(reportDir, 'report.json')
  writeFileSync(reportFile, JSON.stringify({ ...report, reviewer: { kind: 'main', reference: 'main' } }))
  assert.equal(f.run('reassess-record', '--file', reportFile).status, 1)
  assert.ok(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(error => /изменились входные материалы/.test(error)))
  writeFileSync(reportFile, JSON.stringify(report))
  const recorded = f.run('reassess-record', '--file', reportFile)
  assert.equal(recorded.status, 0, recorded.stderr)
  assert.deepEqual(recorded.json.accepted, ['W001'])
  assert.deepEqual(taskReadiness({ root: f.root, slug: 'demo' }).errors, [])
  f.put('.knowledge-base/processes/demo/form.md', 'Теперь обязателен и телефон.\n')
  assert.ok(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(error => /изменились входные материалы/.test(error)))
  f.put('.knowledge-base/processes/demo/form.md', 'Email обязателен. Уточнили пример, который не меняет форму.\n')
  f.put(recorded.json.reportPath, { version: 1, tampered: true })
  assert.ok(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(error => /отчёт переоценки изменён/.test(error)))
})

test('batch reassessment rejects changed outputs and changed criteria', t => {
  const f = fixture(t)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  const started = f.run('start', 'W001')
  assert.equal(started.status, 0)
  assert.equal(f.run('step', 'W001', '--step', 'P1', '--status', 'done').status, 0)
  f.put('demo/form.vue', '<template>Форма</template>\n')
  f.put('demo/helper.ts', 'export const label = "email"\n')
  f.put('demo/reviews/tasks/W001/tests.json', { version: 1, method: 'Локальная проверка формы',
    inputDigest: started.json.inputDigest,
    testedFiles: [{ path: 'demo/form.vue', sha256: f.sha('demo/form.vue') },
      { path: 'demo/helper.ts', sha256: f.sha('demo/helper.ts') }],
    checks: [{ id: 'C1', status: 'pass' }] })
  f.put('result.json', { attemptId: started.json.attemptId, summary: 'Форма проверена',
    outputs: [{ path: 'demo/form.vue' }], criteriaResults: [{ criterionId: 'C1', outcome: 'pass',
      evidence: [{ path: 'demo/reviews/tasks/W001/tests.json', locator: 'C1', observation: 'Тест прошёл' }] }] })
  assert.equal(f.run('record', 'W001', '--file', join(f.root, 'result.json')).status, 0)
  assert.equal(f.run('accept', 'W001').status, 0)
  const git = (...args) => spawnSync('git', args, { cwd: f.root, encoding: 'utf8' })
  assert.equal(git('add', '.').status, 0)
  assert.equal(git('commit', '-qm', 'Accepted').status, 0)
  const baseline = git('rev-parse', 'HEAD').stdout.trim()
  f.put('.knowledge-base/processes/demo/form.md', 'Email и телефон обязательны.\n')
  f.put('demo/helper.ts', 'export const label = "phone"\n')
  assert.equal(git('add', '.').status, 0)
  assert.equal(git('commit', '-qm', 'Changed input and tested helper').status, 0)
  const changedHelper = f.run('reassess-prepare', '--base', baseline)
  assert.equal(changedHelper.status, 0, changedHelper.stderr)
  const helperPacket = JSON.parse(readFileSync(changedHelper.json.packet, 'utf8'))
  assert.deepEqual(helperPacket.eligible, [])
  assert.ok(helperPacket.ineligible[0].reasons.some(reason => /после теста изменился проверенный файл/.test(reason)))
  f.put('demo/form.vue', '<template>Другая форма</template>\n')
  assert.equal(git('add', '.').status, 0)
  assert.equal(git('commit', '-qm', 'Changed output').status, 0)
  const prepared = f.run('reassess-prepare', '--base', baseline)
  assert.equal(prepared.status, 0, prepared.stderr)
  const packet = JSON.parse(readFileSync(prepared.json.packet, 'utf8'))
  assert.deepEqual(packet.eligible, [])
  assert.ok(packet.ineligible[0].reasons.some(reason => /неверный хеш результата/.test(reason)))
  const changedTask = f.task()
  changedTask.acceptanceCriteria[0].condition = 'Другое условие'
  f.put('demo/tasks/W001.json', changedTask)
  assert.ok(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(error => /изменилось задание\/критерии/.test(error)))
})

test('three identical failed attempts require a changed input or work plan', t => {
  const f = fixture(t)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  f.put('failure.json', { reason: 'Та же ошибка формы без исправления' })
  for (let i = 0; i < 3; i++) {
    assert.equal(f.run('start', 'W001').status, 0)
    assert.equal(f.run('fail', 'W001', '--file', join(f.root, 'failure.json')).status, 0)
  }
  const repeated = f.run('start', 'W001')
  assert.equal(repeated.status, 1)
  assert.match(repeated.stderr, /три одинаковые неудачные попытки/)
  f.put('.knowledge-base/processes/demo/form.md', 'Email и телефон обязательны. Новое правило.\n')
  f.approve()
  assert.equal(f.run('start', 'W001').json.attemptId, 'R004')
})
