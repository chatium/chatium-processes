import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, symlinkSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringifyYaml } from '../lib/yaml.mjs'
import { validateProcessAgents } from '../lib/agents.mjs'
import { makeAgentReviewPacket, agentReviewStatus } from '../lib/agent-review.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'process-agents-'))
  const dir = join(root, 'demo/agents')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(root, '.knowledge-base/processes/demo'), { recursive: true })
  writeFileSync(join(root, '.knowledge-base/processes/demo/offer.md'), 'Offer')
  writeFileSync(join(dir, 'helper.agent.json'), JSON.stringify({ title: 'Helper', model: 'model', instructions: ['Serve the client'], enabledTools: [] }))
  const map = { nodes: [{ id: 'helper', kind: 'agent', source: 'demo/agents/helper.agent.json' }] }
  const spec = { version: 1, opportunities: [{ id: 'help', decision: 'accepted', need: 'Client question', reason: 'Owner approved' }], agents: [{ key: 'helper', config: 'demo/agents/helper.agent.json', node: 'helper', opportunity: 'help', role: 'Consultant', outcome: 'Qualified request', boundary: 'Escalate uncertainty', inputs: [{ kind: 'sender', source: 'test channel' }], knowledge: ['.knowledge-base/processes/demo/offer.md'], tools: [], cases: ['first-contact'] }], routes: [{ channel: 'test channel', firstAgent: 'helper', existingConversation: 'Current chain' }], handoffs: [] }
  const cases = { version: 1, cases: [{ id: 'first-contact', agent: 'helper', situation: 'New lead', expected: 'Qualify', evidence: 'CRM test record' }] }
  const run = () => {
    writeFileSync(join(dir, 'spec.yaml'), stringifyYaml(spec))
    writeFileSync(join(dir, 'cases.yaml'), stringifyYaml(cases))
    return validateProcessAgents({ root, slug: 'demo', map })
  }
  return { root, map, spec, cases, run, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('accepted standalone agent, map and scenarios form a valid local contract', () => {
  const f = fixture()
  try { assert.deepEqual(f.run().errors, []); assert.deepEqual(f.run().warnings, []) }
  finally { f.cleanup() }
})

test('unapproved role and map drift block readiness', () => {
  const f = fixture()
  try {
    f.spec.opportunities[0].decision = 'deferred'
    f.map.nodes[0].source = 'demo/agents/other.agent.json'
    const result = f.run()
    assert.match(result.errors.join('\n'), /принятое применение/)
    assert.match(result.errors.join('\n'), /не совпадает/)
  } finally { f.cleanup() }
})

test('route conflict and incomplete handoff are explicit failures', () => {
  const f = fixture()
  try {
    f.spec.routes.push({ ...f.spec.routes[0] })
    f.spec.handoffs.push({ from: 'helper', to: 'missing', when: 'Escalate' })
    const result = f.run()
    assert.match(result.errors.join('\n'), /повторный маршрут/)
    assert.match(result.errors.join('\n'), /разные существующие/)
    assert.match(result.errors.join('\n'), /нет summary/)
  } finally { f.cleanup() }
})

test('routing dry-run contacts must be usable CRM contact pairs', () => {
  const f = fixture()
  try {
    f.spec.routes[0].testNewContacts = [{ type: 'email', value: '' }]
    f.spec.routes[0].testExistingContacts = []
    f.spec.routes[0].expectedExistingAgent = 'missing'
    const result = f.run()
    assert.match(result.errors.join('\n'), /testNewContacts/)
    assert.match(result.errors.join('\n'), /testExistingContacts/)
    assert.match(result.errors.join('\n'), /expectedExistingAgent/)
  } finally { f.cleanup() }
})

test('process without AI stays valid without agent files', () => {
  const root = mkdtempSync(join(tmpdir(), 'process-no-agents-'))
  try { mkdirSync(join(root, 'demo')); assert.deepEqual(validateProcessAgents({ root, slug: 'demo', map: { nodes: [] } }), { errors: [], warnings: [], enabled: false }) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('agent source symlink is rejected instead of traversing outside the process', () => {
  const f = fixture()
  try {
    symlinkSync(f.root, join(f.root, 'demo/agents/outside'))
    symlinkSync(join(f.root, '.knowledge-base/processes/demo/offer.md'), join(f.root, 'demo/agents/linked.agent.json'))
    const result = f.run()
    assert.match(result.errors.join('\n'), /символической ссылкой/)
  } finally { f.cleanup() }
})

test('independent review packet binds role instructions and reference snapshot', () => {
  const f = fixture()
  try {
    f.run()
    const first = makeAgentReviewPacket({ root: f.root, slug: 'demo' })
    assert.ok(first.questions.some(question => question.id === 'role.helper'))
    assert.ok(first.referenceLibrary.required.includes('skills/chatium-development/references/ai/routing-and-handoff.md'))
    assert.equal(agentReviewStatus({ root: f.root, slug: 'demo' }).status, 'missing')
    writeFileSync(join(f.root, 'demo/agents/helper.agent.json'), JSON.stringify({ title: 'Helper', model: 'model', instructions: ['New instructions'], enabledTools: [] }))
    const changed = makeAgentReviewPacket({ root: f.root, slug: 'demo' })
    assert.notEqual(changed.inputDigest, first.inputDigest)
  } finally { f.cleanup() }
})

test('published-state check remains partial without an existing-chain test and rejects a wrong preview branch', () => {
  const f = fixture()
  try {
    f.spec.routes[0].testNewContacts = [{ type: 'email', value: 'new-test@example.com' }]
    f.run()
    writeFileSync(join(f.root, 'demo/.workspace.json'), JSON.stringify({ type: 'process', processEngine: 'processes-v2' }))
    writeFileSync(join(f.root, 'demo/process.yaml'), stringifyYaml({ title: 'Demo', knowledge: '.knowledge-base/processes/demo/', stages: ['Lead'], nodes: [{ ...f.map.nodes[0], agentId: 'a-1', stage: 'Lead', title: 'Helper', purpose: 'Qualify' }], links: [] }))
    execFileSync('git', ['init', '-q', '-b', 'process/demo'], { cwd: f.root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '.'], { cwd: f.root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: f.root })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim()
    const bin = join(f.root, 'bin'), responseFile = join(f.root, 'runtime.json'), stdinFile = join(f.root, 'runtime-input.txt')
    mkdirSync(bin)
    const chatium = join(bin, 'chatium')
    writeFileSync(chatium, '#!/bin/sh\ncat > "$FAKE_RUNTIME_STDIN"\necho "Executed commit: $FAKE_RUNTIME_COMMIT" >&2\ncat "$FAKE_RUNTIME_RESPONSE"\n')
    chmodSync(chatium, 0o755)
    const sha256 = createHash('sha256').update(readFileSync(join(f.root, 'demo/agents/helper.agent.json'))).digest('hex')
    const response = { accountId: 1, agents: [{ key: 'helper', value: { branch: 'process/demo', sourceSha256: sha256, agentId: 'a-1', model: 'model', enabledTools: [] }, toolChecks: [] }], routes: [{ index: 0, value: { config: { enabled: true, defaultAgentId: 'a-1', rulesCount: 0 }, linkedAgentIds: ['a-1'] }, dryRun: { mode: 'selected', agentId: 'a-1', reason: 'default-agent' } }] }
    const cli = fileURLToPath(new URL('../agents-runtime.mjs', import.meta.url))
    const run = () => {
      writeFileSync(responseFile, JSON.stringify(response))
      const result = spawnSync(process.execPath, [cli, 'demo', '--root', f.root, '--json'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RUNTIME_RESPONSE: responseFile, FAKE_RUNTIME_STDIN: stdinFile, FAKE_RUNTIME_COMMIT: commit } })
      return { exit: result.status, report: JSON.parse(result.stdout) }
    }
    const partial = run()
    assert.equal(partial.exit, 1)
    assert.equal(partial.report.status, 'partial')
    assert.equal(partial.report.executedCommit, commit)
    assert.match(readFileSync(stdinFile, 'utf8'), /"contacts":\[\{"type":"email","value":"new-test@example.com"\}\]/)
    assert.doesNotMatch(readFileSync(stdinFile, 'utf8'), /chainKey:/)
    const processYaml = join(f.root, 'demo/process.yaml')
    const savedMap = readFileSync(processYaml, 'utf8')
    writeFileSync(processYaml, savedMap.replace(/^[ \t]+agentId: a-1\n/m, ''))
    const missingMapId = run()
    assert.equal(missingMapId.report.status, 'unverified', JSON.stringify(missingMapId.report))
    assert.match(missingMapId.report.errors.join('\n'), /запиши опубликованный agentId/)
    writeFileSync(processYaml, savedMap)
    writeFileSync(chatium, '#!/bin/sh\ncat >/dev/null\necho "Executed commit: 0000000000000000000000000000000000000000" >&2\ncat "$FAKE_RUNTIME_RESPONSE"\n')
    const stale = run()
    assert.equal(stale.report.status, 'unverified')
    assert.match(stale.report.errors.join('\n'), /опубликован коммит/)
    writeFileSync(chatium, '#!/bin/sh\ncat > "$FAKE_RUNTIME_STDIN"\necho "Executed commit: $FAKE_RUNTIME_COMMIT" >&2\ncat "$FAKE_RUNTIME_RESPONSE"\n')
    response.routes[0].dryRun = { mode: 'unresolved', reason: 'crm-customer-not-found' }
    const unresolved = run()
    assert.equal(unresolved.report.status, 'unverified')
    assert.match(unresolved.report.errors.join('\n'), /сухая проверка выбрала unresolved/)
    response.routes[0].dryRun = { mode: 'selected', agentId: 'a-1', reason: 'active-chain-last-touch' }
    const notNew = run()
    assert.equal(notNew.report.status, 'unverified')
    assert.match(notNew.report.errors.join('\n'), /а не как адресата по умолчанию/)
    response.routes[0].dryRun = { mode: 'selected', agentId: 'a-1', reason: 'default-agent' }
    response.agents[0].value.branch = 'main'
    const wrong = run()
    assert.equal(wrong.exit, 1)
    assert.equal(wrong.report.status, 'unverified')
    assert.match(wrong.report.errors.join('\n'), /нужна ветка process\/demo/)
  } finally { f.cleanup() }
})
