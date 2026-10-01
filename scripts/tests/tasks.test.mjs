import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { taskReadiness } from '../lib/tasks.mjs'

const cli = fileURLToPath(new URL('../tasks.mjs', import.meta.url))
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
  const run = (command, ...args) => {
    const response = spawnSync(process.execPath, [cli, command, 'demo', ...args, '--root', root], { encoding: 'utf8' })
    return { ...response, json: response.status === 0 ? JSON.parse(response.stdout) : null }
  }
  return { root, put, run, sha, task: () => JSON.parse(readFileSync(join(root, 'demo/tasks/W001.json'), 'utf8')) }
}

test('main agent can resume after a KB answer and close a task only with evidence', t => {
  const f = fixture(t)
  assert.equal(f.run('create', 'W001', '--file', join(f.root, 'task.json')).status, 0)
  assert.match(readFileSync(join(f.root, 'demo/PLAN.md'), 'utf8'), /\[W001\]\(tasks\/W001\.json\)/)
  assert.ok(taskReadiness({ root: f.root, slug: 'demo' }).errors.some(e => e.includes('задача не завершена')))
  assert.equal(f.run('start', 'W001').json.attemptId, 'R001')
  f.put('question.json', { questions: [{ id: 'Q1', question: 'Нужно имя?', why: 'Поле формы', blocking: true }] })
  assert.equal(f.run('ask', 'W001', '--file', join(f.root, 'question.json')).json.status, 'needs-input')
  f.put('.knowledge-base/processes/demo/form.md', 'Email обязателен. Имя не требуется.\n')
  f.put('answer.json', { summary: 'Имя не требуется', sourceRefs: ['.knowledge-base/processes/demo/form.md'] })
  assert.equal(f.run('resolve', 'W001', '--question', 'Q1', '--file', join(f.root, 'answer.json')).json.status, 'ready-to-resume')
  assert.equal(f.run('start', 'W001').json.attemptId, 'R002')
  assert.equal(f.run('step', 'W001', '--step', 'P1', '--status', 'done').status, 0)
  f.put('demo/form.vue', '<template>Форма</template>\n')
  f.put('demo/reviews/tasks/W001/tests.json', { version: 1, method: 'Изолированный тест заявки',
    inputDigest: f.task().attempts.at(-1).inputDigest,
    testedFiles: [{ path: 'demo/form.vue', sha256: f.sha('demo/form.vue') }],
    checks: [{ id: 'valid-email', status: 'pass' }] })
  f.put('result.json', { attemptId: 'R002', summary: 'Форма и проверка готовы',
    outputs: [{ path: 'demo/form.vue' }],
    criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{ path: 'demo/reviews/tasks/W001/tests.json', locator: 'valid-email', observation: 'Заявка записана' }] }],
  })
  assert.equal(f.run('record', 'W001', '--file', join(f.root, 'result.json')).json.status, 'result-ready')
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
  task.executor = { kind: 'specialist', role: 'copywriter' }
  task.mode = 'produce'
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
  assert.match(packet.roleInstructions, /Копирайтер/)
  assert.match(readFileSync(prepared.json.prompt, 'utf8'), /run|JSON|специалист/)
  f.put('question.json', { questions: [{ id: 'Q1', question: 'Какой тон?', why: 'Нужен текст', blocking: true }] })
  assert.equal(f.run('ask', 'W001', '--file', join(f.root, 'question.json')).status, 0)
  f.put('.knowledge-base/processes/demo/voice.md', 'Тон спокойный и конкретный.\n')
  f.put('answer.json', { summary: 'Спокойный тон', sourceRefs: ['.knowledge-base/processes/demo/voice.md'] })
  assert.equal(f.run('resolve', 'W001', '--question', 'Q1', '--file', join(f.root, 'answer.json')).status, 0)
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
  task.executor = { kind: 'specialist', role: 'copywriter' }
  task.mode = 'produce'
  f.put('task.json', task)
  f.run('create', 'W001', '--file', join(f.root, 'task.json'))
  f.run('start', 'W001')
  f.run('step', 'W001', '--step', 'P1', '--status', 'done')
  f.put('demo/form.vue', '<template>Форма</template>\n')
  f.put('demo/reviews/tasks/W001/tests.json', { version: 1, method: 'Проверка формы',
    inputDigest: f.task().attempts.at(-1).inputDigest,
    testedFiles: [{ path: 'demo/form.vue', sha256: f.sha('demo/form.vue') }],
    checks: [{ id: 'valid-email', status: 'pass' }] })
  const responseRef = join(mkdtempSync(join(tmpdir(), 'specialist-response-')), 'response.json')
  t.after(() => rmSync(dirname(responseRef), { recursive: true, force: true }))
  writeFileSync(responseRef, '{"status":"result"}')
  f.put('result.json', { attemptId: 'R001', responseRef, summary: 'Результат специалиста',
    outputs: [{ path: 'demo/form.vue' }],
    criteriaResults: [{ criterionId: 'C1', outcome: 'pass', evidence: [{
      path: 'demo/reviews/tasks/W001/tests.json', locator: 'valid-email', observation: 'Проверено',
    }] }],
  })
  const withoutRun = f.run('record', 'W001', '--file', join(f.root, 'result.json'))
  assert.equal(withoutRun.status, 1)
  assert.match(withoutRun.stderr, /сначала нужен bind/)
  assert.equal(f.run('bind', 'W001', '--agent-id', 'subagent-42').status, 0)
  assert.equal(f.run('record', 'W001', '--file', join(f.root, 'result.json')).status, 0)
  assert.equal(f.task().attempts.at(-1).responseRef, responseRef)
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
