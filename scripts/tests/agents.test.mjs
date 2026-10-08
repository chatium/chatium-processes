import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, readFileSync, symlinkSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseYaml, stringifyYaml } from '../lib/yaml.mjs'
import { validateProcessAgents } from '../lib/agents.mjs'
import { makeAgentReviewPacket, agentReviewStatus } from '../lib/agent-review.mjs'
import { agentRuntimeEvidenceStatus, writeAgentRuntimeEvidence } from '../lib/agent-runtime-evidence.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'process-agents-'))
  const dir = join(root, 'demo/agents')
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(root, '.knowledge-base/processes/demo'), { recursive: true })
  writeFileSync(join(root, '.knowledge-base/processes/demo/offer.md'), 'Offer')
  writeFileSync(join(dir, 'helper.agent.json'), JSON.stringify({ title: 'Helper', model: 'model', instructions: ['Serve the client'], enabledTools: [] }))
  const map = { accountId: 1, nodes: [{ id: 'helper', kind: 'agent', source: 'demo/agents/helper.agent.json' }] }
  const spec = { version: 1, opportunities: [{ id: 'help', decision: 'accepted', need: 'Client question', reason: 'Owner approved' }], agents: [{ key: 'helper', config: 'demo/agents/helper.agent.json', node: 'helper', opportunity: 'help', role: 'Consultant', outcome: 'Qualified request', boundary: 'Escalate uncertainty', inputs: [{ kind: 'sender', source: 'test channel' }], knowledge: ['.knowledge-base/processes/demo/offer.md'], tools: [], cases: ['first-contact'] }], routes: [{ channel: 'test channel', firstAgent: 'helper', existingConversation: 'Current chain', testNewContacts: [{ type: 'email', value: 'test@example.com' }] }], handoffs: [] }
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

test('numeric token limit is rejected before Source Git agent synchronization', () => {
  const f = fixture()
  try {
    const file = join(f.root, 'demo/agents/helper.agent.json')
    const config = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(file, JSON.stringify({ ...config, tokensLimitPerChain: 6000 }))
    assert.match(f.run().errors.join('\n'), /tokensLimitPerChain должен быть объектом/)
    writeFileSync(file, JSON.stringify({ ...config, tokensLimitPerChain: { kind: 'const', value: 6000 } }))
    assert.deepEqual(f.run().errors, [])
  } finally { f.cleanup() }
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

test('malformed routing test contacts fail local validation', () => {
  const f = fixture()
  try {
    f.spec.routes[0].testNewContacts = [{ type: 'email', value: '' }]
    assert.match(f.run().errors.join('\n'), /testNewContacts/)
    f.spec.routes[0].testNewContacts = [{ type: 'email', value: 'test@example.com' }]
    f.spec.routes[0].testExistingContacts = [{ type: 'email', value: 'existing@example.com' }]
    assert.match(f.run().errors.join('\n'), /expectedExistingAgent/)
  } finally { f.cleanup() }
})

test('process without AI stays valid without agent files', () => {
  const root = mkdtempSync(join(tmpdir(), 'process-no-agents-'))
  try { mkdirSync(join(root, 'demo')); assert.deepEqual(validateProcessAgents({ root, slug: 'demo', map: { nodes: [] } }), { errors: [], warnings: [], enabled: false }) }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('a broken agent turns the process check red even when another agent is valid', () => {
  const f = fixture()
  try {
    f.spec.agents.push({ ...f.spec.agents[0], key: 'backup', node: 'backup',
      config: 'demo/agents/backup.agent.json', opportunity: 'help' })
    f.map.nodes.push({ id: 'backup', kind: 'agent', source: 'demo/agents/backup.agent.json' })
    writeFileSync(join(f.root, 'demo/agents/backup.agent.json'), JSON.stringify({ title: 'Backup', model: 'model', instructions: ['Help'], enabledTools: [] }))
    f.run()
    writeFileSync(join(f.root, 'demo/.workspace.json'), JSON.stringify({ type: 'process', processEngine: 'processes-v2' }))
    writeFileSync(join(f.root, 'demo/process.yaml'), stringifyYaml({ title: 'Demo', accountId: 1, knowledge: '.knowledge-base/processes/demo/',
      stages: ['Lead'], nodes: f.map.nodes.map(node => ({ ...node, stage: 'Lead', title: node.id, purpose: 'Help' })), links: [] }))
    const cli = fileURLToPath(new URL('../check.mjs', import.meta.url))
    const check = () => {
      const result = spawnSync(process.execPath, [cli, 'demo', '--root', f.root, '--no-snapshot', '--json'], { encoding: 'utf8' })
      assert.ok([0, 1].includes(result.status), result.stderr)
      return JSON.parse(result.stdout)
    }
    const valid = check()
    assert.equal(valid.checks.find(item => item.id === 'agents').ok, true)
    writeFileSync(join(f.root, 'demo/agents/backup.agent.json'), '{broken')
    const broken = check()
    assert.equal(broken.checks.find(item => item.id === 'agents').ok, false)
    assert.ok(broken.passed < broken.total)
    assert.match(broken.checks.find(item => item.id === 'agents').errors.join('\n'), /backup/)
  } finally { f.cleanup() }
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
    assert.ok(first.referenceLibrary.required.some(path => [
      'skills/chatium-development/ai-routing-and-handoff.md',
      'skills/chatium-development/references/ai/routing-and-handoff.md',
    ].includes(path)))
    assert.equal(agentReviewStatus({ root: f.root, slug: 'demo' }).status, 'missing')
    writeFileSync(join(f.root, 'demo/agents/helper.agent.json'), JSON.stringify({ title: 'Helper', model: 'model', instructions: ['New instructions'], enabledTools: [] }))
    const changed = makeAgentReviewPacket({ root: f.root, slug: 'demo' })
    assert.notEqual(changed.inputDigest, first.inputDigest)
  } finally { f.cleanup() }
})

test('test stage requires a published runtime result for every AI process', () => {
  const f = fixture()
  try {
    f.run()
    writeFileSync(join(f.root, 'demo/.workspace.json'), JSON.stringify({ type: 'process', processEngine: 'processes-v2' }))
    writeFileSync(join(f.root, 'demo/process.yaml'), stringifyYaml({ title: 'Demo', accountId: 1, knowledge: '.knowledge-base/processes/demo/',
      stages: ['Lead'], nodes: [{ ...f.map.nodes[0], stage: 'Lead', title: 'Helper', purpose: 'Help' }], links: [] }))
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../check.mjs', import.meta.url)),
      'demo', '--root', f.root, '--no-snapshot', '--task-stage', 'test', '--json'], { encoding: 'utf8' })
    const report = JSON.parse(result.stdout)
    assert.equal(report.checks.find(item => item.id === 'agents.runtime').ok, false)
    assert.match(report.checks.find(item => item.id === 'agents.runtime').errors.join('\n'), /Нет проверки опубликованных помощников/)
  } finally { f.cleanup() }
})

test('runtime evidence is bound to the tested commit, branch, agent sources and map IDs', () => {
  const f = fixture()
  try {
    f.map.nodes[0].agentId = 'a-1'
    f.run()
    writeFileSync(join(f.root, 'demo/process.yaml'), stringifyYaml(f.map))
    execFileSync('git', ['init', '-q', '-b', 'process/demo'], { cwd: f.root })
    execFileSync('git', ['add', '.'], { cwd: f.root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'published agent'], { cwd: f.root })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim()
    const args = { root: f.root, slug: 'demo', map: f.map }
    assert.equal(agentRuntimeEvidenceStatus(args).status, 'missing')
    writeAgentRuntimeEvidence({ ...args, spec: f.spec, branch: 'process/demo', commit, accountId: 1,
      checkedAt: '2026-10-07T12:00:00Z' })
    assert.equal(agentRuntimeEvidenceStatus(args).status, 'ready')
    assert.match(agentRuntimeEvidenceStatus({ ...args, maxAgeMs: 1 }).errors.join('\n'), /устарела по времени/)
    const wrongBranch = agentRuntimeEvidenceStatus({ ...args, currentBranch: () => 'main' })
    assert.match(wrongBranch.errors.join('\n'), /текущая ветка/)
    const unmerged = agentRuntimeEvidenceStatus({ ...args, ancestor: () => false })
    assert.match(unmerged.errors.join('\n'), /не предшествует/)
    const wrongPublished = agentRuntimeEvidenceStatus({ ...args, readAtCommit: (revision, path) =>
      path.endsWith('helper.agent.json') ? Buffer.from('different') : execFileSync('git', ['show', `${revision}:${path}`], { cwd: f.root }) })
    assert.match(wrongPublished.errors.join('\n'), /опубликованного файла/)
    f.map.accountId = 999
    assert.match(agentRuntimeEvidenceStatus(args).errors.join('\n'), /изменились после проверки/)
    f.map.accountId = 1
    writeFileSync(join(f.root, 'demo/agents/helper.agent.json'), JSON.stringify({ title: 'Helper', model: 'model', instructions: ['Changed'], enabledTools: [] }))
    assert.match(agentRuntimeEvidenceStatus(args).errors.join('\n'), /изменились после проверки/)
    f.map.nodes[0].agentId = 'a-2'
    assert.match(agentRuntimeEvidenceStatus(args).errors.join('\n'), /изменились после проверки/)
  } finally { f.cleanup() }
})

test('runtime evidence refuses a linked tests directory and a linked result file', () => {
  const f = fixture()
  try {
    f.map.nodes[0].agentId = 'a-1'
    f.run()
    mkdirSync(join(f.root, 'outside'))
    symlinkSync('../outside', join(f.root, 'demo/tests'))
    const args = { root: f.root, slug: 'demo', map: f.map, spec: f.spec,
      branch: 'process/demo', commit: 'a'.repeat(40), accountId: 1, checkedAt: new Date().toISOString() }
    assert.throws(() => writeAgentRuntimeEvidence(args), /ссылку/)
    assert.equal(agentRuntimeEvidenceStatus(args).status, 'invalid')
    assert.equal(readFileSync(join(f.root, 'demo/agents/spec.yaml'), 'utf8').length > 0, true)
    rmSync(join(f.root, 'demo/tests'))
    mkdirSync(join(f.root, 'demo/tests'))
    writeFileSync(join(f.root, 'outside/agents-runtime.json'), '{}')
    symlinkSync(join(f.root, 'outside/agents-runtime.json'), join(f.root, 'demo/tests/agents-runtime.json'))
    assert.throws(() => writeAgentRuntimeEvidence(args), /ссылку/)
    assert.equal(agentRuntimeEvidenceStatus(args).status, 'invalid')
  } finally { f.cleanup() }
})

test('standalone agent without a shared Sender channel can record published runtime evidence', () => {
  const f = fixture()
  try {
    f.spec.routes = []
    f.run()
    writeFileSync(join(f.root, 'demo/.workspace.json'), JSON.stringify({ type: 'process', processEngine: 'processes-v2' }))
    const processYaml = join(f.root, 'demo/process.yaml')
    writeFileSync(processYaml, stringifyYaml({ title: 'Demo', accountId: 1, knowledge: '.knowledge-base/processes/demo/',
      stages: ['Lead'], nodes: [{ ...f.map.nodes[0], agentId: 'a-1', stage: 'Lead', title: 'Helper', purpose: 'Qualify' }], links: [] }))
    execFileSync('git', ['init', '-q', '-b', 'process/demo'], { cwd: f.root })
    execFileSync('git', ['add', '.'], { cwd: f.root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: f.root })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim()
    const bin = join(f.root, 'bin'), responseFile = join(f.root, 'runtime.json')
    mkdirSync(bin)
    const chatium = join(bin, 'chatium')
    writeFileSync(chatium, '#!/bin/sh\ncat >/dev/null\necho "Executed commit: $FAKE_RUNTIME_COMMIT" >&2\ncat "$FAKE_RUNTIME_RESPONSE"\n')
    chmodSync(chatium, 0o755)
    const sha256 = createHash('sha256').update(readFileSync(join(f.root, 'demo/agents/helper.agent.json'))).digest('hex')
    writeFileSync(responseFile, JSON.stringify({ accountId: 1, agents: [{ key: 'helper', value: {
      branch: 'process/demo', sourceSha256: sha256, agentId: 'a-1', model: 'model', enabledTools: [] }, toolChecks: [] }], routes: [] }))
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../agents-runtime.mjs', import.meta.url)),
      'demo', '--root', f.root, '--json', '--record'], { encoding: 'utf8', env: { ...process.env,
        PATH: `${bin}:${process.env.PATH}`, FAKE_RUNTIME_RESPONSE: responseFile, FAKE_RUNTIME_COMMIT: commit } })
    const report = JSON.parse(result.stdout)
    assert.equal(result.status, 0, JSON.stringify(report))
    assert.equal(report.status, 'verified')
    assert.ok(report.informational.some(message => /Нет routes/.test(message)))
    assert.equal(agentRuntimeEvidenceStatus({ root: f.root, slug: 'demo', map: parseYaml(readFileSync(processYaml, 'utf8')) }).status, 'ready')
  } finally { f.cleanup() }
})

test('published-state check stays partial with extra channel rules and rejects a wrong preview branch', () => {
  const f = fixture()
  try {
    f.run()
    writeFileSync(join(f.root, 'demo/.workspace.json'), JSON.stringify({ type: 'process', processEngine: 'processes-v2' }))
    writeFileSync(join(f.root, 'demo/process.yaml'), stringifyYaml({ title: 'Demo', accountId: 1, knowledge: '.knowledge-base/processes/demo/', stages: ['Lead'], nodes: [{ ...f.map.nodes[0], agentId: 'a-1', stage: 'Lead', title: 'Helper', purpose: 'Qualify' }], links: [] }))
    execFileSync('git', ['init', '-q', '-b', 'process/demo'], { cwd: f.root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'add', '.'], { cwd: f.root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: f.root })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim()
    const bin = join(f.root, 'bin'), responseFile = join(f.root, 'runtime.json')
    mkdirSync(bin)
    const chatium = join(bin, 'chatium')
    writeFileSync(chatium, '#!/bin/sh\ncat >/dev/null\necho "Executed commit: $FAKE_RUNTIME_COMMIT" >&2\ncat "$FAKE_RUNTIME_RESPONSE"\n')
    chmodSync(chatium, 0o755)
    const sha256 = createHash('sha256').update(readFileSync(join(f.root, 'demo/agents/helper.agent.json'))).digest('hex')
    const response = { accountId: 1, agents: [{ key: 'helper', value: { branch: 'process/demo', sourceSha256: sha256, agentId: 'a-1', model: 'model', enabledTools: [] }, toolChecks: [] }], routes: [{ index: 0, value: { config: { enabled: true, defaultAgentId: 'a-1', rulesCount: 1 }, linkedAgentIds: ['a-1'] }, dryRun: { mode: 'selected', agentId: 'a-1', reason: 'default-agent' } }] }
    const cli = fileURLToPath(new URL('../agents-runtime.mjs', import.meta.url))
    const run = (record = false) => {
      writeFileSync(responseFile, JSON.stringify(response))
      const result = spawnSync(process.execPath, [cli, 'demo', '--root', f.root, '--json', ...(record ? ['--record'] : [])], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_RUNTIME_RESPONSE: responseFile, FAKE_RUNTIME_COMMIT: commit } })
      return { exit: result.status, report: JSON.parse(result.stdout) }
    }
    const partial = run()
    assert.equal(partial.exit, 1)
    assert.equal(partial.report.status, 'partial')
    assert.equal(partial.report.executedCommit, commit)
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
    writeFileSync(chatium, '#!/bin/sh\ncat >/dev/null\necho "Executed commit: $FAKE_RUNTIME_COMMIT" >&2\ncat "$FAKE_RUNTIME_RESPONSE"\n')
    response.routes[0].dryRun = { mode: 'unresolved', reason: 'crm-customer-not-found' }
    const unresolved = run()
    assert.equal(unresolved.report.status, 'unverified')
    assert.match(unresolved.report.errors.join('\n'), /новое обращение выбрало unresolved/)
    response.routes[0].dryRun = { mode: 'selected', agentId: 'a-1', reason: 'active-chain-last-touch' }
    const notNew = run()
    assert.equal(notNew.report.status, 'unverified')
    assert.match(notNew.report.errors.join('\n'), /default-agent/)
    response.routes[0].dryRun = { mode: 'selected', agentId: 'a-1', reason: 'default-agent' }
    response.agents[0].value.branch = 'main'
    const wrong = run()
    assert.equal(wrong.exit, 1)
    assert.equal(wrong.report.status, 'unverified')
    assert.match(wrong.report.errors.join('\n'), /нужна ветка process\/demo/)
  } finally { f.cleanup() }
})

test('agents-runtime uses the SDK contact contract and records only a fully verified published result', () => {
  const f = fixture()
  try {
    f.spec.routes[0].testExistingContacts = [{ type: 'email', value: 'existing@example.com' }]
    f.spec.routes[0].expectedExistingAgent = 'helper'
    f.run()
    const processYaml = join(f.root, 'demo/process.yaml')
    writeFileSync(join(f.root, 'demo/.workspace.json'), JSON.stringify({ type: 'process', processEngine: 'processes-v2' }))
    writeFileSync(processYaml, stringifyYaml({ title: 'Demo', accountId: 1, knowledge: '.knowledge-base/processes/demo/',
      stages: ['Lead'], nodes: [{ ...f.map.nodes[0], agentId: 'a-1', stage: 'Lead', title: 'Helper', purpose: 'Qualify' }], links: [] }))
    execFileSync('git', ['init', '-q', '-b', 'process/demo'], { cwd: f.root })
    execFileSync('git', ['add', '.'], { cwd: f.root })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: f.root })
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim()
    const bin = join(f.root, 'bin'), responseFile = join(f.root, 'runtime.json'), inputFile = join(f.root, 'input.txt')
    mkdirSync(bin)
    const chatium = join(bin, 'chatium')
    writeFileSync(chatium, '#!/bin/sh\ncat >"$FAKE_RUNTIME_INPUT"\necho "Executed commit: $FAKE_RUNTIME_COMMIT" >&2\ncat "$FAKE_RUNTIME_RESPONSE"\n')
    chmodSync(chatium, 0o755)
    const config = readFileSync(join(f.root, 'demo/agents/helper.agent.json'))
    const response = { accountId: 1, agents: [{ key: 'helper', value: { branch: 'process/demo', sourceSha256: createHash('sha256').update(config).digest('hex'), agentId: 'a-1', model: 'model', enabledTools: [] }, toolChecks: [] }],
      routes: [{ index: 0, value: { config: { enabled: true, defaultAgentId: 'a-1', rulesCount: 0 }, linkedAgentIds: ['a-1'] },
        dryRun: { mode: 'selected', agentId: 'a-1', reason: 'active-chain-last-touch' }, existingDryRun: null }] }
    const run = () => {
      writeFileSync(responseFile, JSON.stringify(response))
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('../agents-runtime.mjs', import.meta.url)),
        'demo', '--root', f.root, '--json', '--record'], { encoding: 'utf8', env: { ...process.env,
          PATH: `${bin}:${process.env.PATH}`, FAKE_RUNTIME_RESPONSE: responseFile, FAKE_RUNTIME_COMMIT: commit, FAKE_RUNTIME_INPUT: inputFile } })
      return { exit: result.status, report: JSON.parse(result.stdout) }
    }
    const failed = run()
    assert.equal(failed.report.status, 'unverified')
    const code = readFileSync(inputFile, 'utf8')
    assert.match(code, /getPublishedAgentBySourcePath\(ctx, item\.config, input\.branch\)/)
    assert.match(code, /"branch":"process\/demo"/)
    assert.match(code, /contacts: item.contacts/)
    assert.match(code, /"contacts":\[\{"type":"email","value":"test@example.com"\}\]/)
    assert.match(code, /"existingContacts":\[\{"type":"email","value":"existing@example.com"\}\]/)
    assert.doesNotMatch(code, /chainKey/)
    assert.equal(agentRuntimeEvidenceStatus({ root: f.root, slug: 'demo', map: parseYaml(readFileSync(processYaml, 'utf8')) }).status, 'missing')
    response.routes[0].dryRun = { mode: 'selected', agentId: 'a-1', reason: 'default-agent' }
    const withoutExisting = run()
    assert.equal(withoutExisting.report.status, 'unverified')
    assert.match(withoutExisting.report.errors.join('\n'), /CRM-цепочка/)
    response.routes[0].existingDryRun = { mode: 'selected', agentId: 'a-1', reason: 'active-chain-last-touch' }
    const passed = run()
    assert.equal(passed.exit, 0, JSON.stringify(passed.report))
    assert.equal(passed.report.status, 'verified')
    assert.ok(passed.report.recordedPath)
    assert.equal(agentRuntimeEvidenceStatus({ root: f.root, slug: 'demo', map: parseYaml(readFileSync(processYaml, 'utf8')) }).status, 'ready')
  } finally { f.cleanup() }
})
