import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SKILL_DIR } from '../lib/project.mjs'
import { specialistContract, specialistManifest, specialistPrompt, specialistResponseErrors } from '../lib/specialists.mjs'

const contract = (role, profiles) => specialistContract({ role, ...(profiles ? { profiles } : {}) })
const ids = value => value.profiles.map(profile => profile.id)

test('entity recipes include mandatory competencies; additions cannot remove them', () => {
  assert.deepEqual(ids(contract('landing')), ['copywriting', 'design', 'marketing'])
  assert.deepEqual(ids(contract('landing', ['design'])), ids(contract('landing')))
  assert.deepEqual(ids(contract('email', ['design'])), ['communications', 'copywriting', 'design', 'marketing'])
  assert.deepEqual(ids(contract('confirmation')), ['copywriting', 'design'])
  assert.deepEqual(ids(contract('agent', ['marketing'])), ['copywriting', 'dialogue', 'marketing', 'product'])
  assert.deepEqual(ids(contract('consultant', ['marketing', 'product'])), ['marketing', 'product'])
  assert.deepEqual(ids(contract('copywriter')), ['copywriting'])
  assert.equal(contract('site').role.family, 'page')
})

test('unknown, duplicate or unsafe profile choices fail without fallback', () => {
  for (const profiles of [['design', 'design'], ['../../secrets'], ['invented'], '__proto__', [null]])
    assert.throws(() => specialistContract({ role: 'landing', profiles }), /profiles/)
  assert.throws(() => contract('consultant'), /хотя бы один/)
  for (const role of ['../../private', 'unknown', '__proto__']) assert.throws(() => contract(role), /Неизвестная роль/)
})

test('the actual start prompt contains all selected instructions and required guides', () => {
  for (const role of ['landing', 'email', 'agent', 'consultant']) {
    const selected = contract(role, role === 'consultant' ? ['design', 'copywriting'] : undefined)
    const prompt = specialistPrompt(selected, '/external/task/packet.json')
    for (const file of [selected.common, selected.role, ...selected.profiles, ...selected.references])
      assert.ok(prompt.includes(file.content.trim()), `${role}: missing ${file.path}`)
    assert.ok(prompt.includes(selected.digest))
    assert.ok(prompt.includes('/external/task/packet.json'))
    assert.ok(!JSON.stringify(specialistManifest(selected)).includes('"content"'))
  }
})

function library(t) {
  const skillDir = mkdtempSync(join(tmpdir(), 'process-profile-library-'))
  t.after(() => rmSync(skillDir, { recursive: true, force: true }))
  cpSync(join(SKILL_DIR, 'specialists'), join(skillDir, 'specialists'), { recursive: true })
  cpSync(join(SKILL_DIR, 'creative'), join(skillDir, 'creative'), { recursive: true })
  const load = () => specialistContract({ role: 'landing' }, { skillDir })
  const change = path => writeFileSync(join(skillDir, path), readFileSync(join(skillDir, path), 'utf8') + '\nУточнение методики.\n')
  return { skillDir, load, change }
}

test('only selected profiles, role and mandatory references invalidate the contract', t => {
  const f = library(t), before = f.load()
  assert.equal(before.digest, contract('landing').digest, 'another directory/VM has the same content identity')
  f.change('specialists/profiles/dialogue.md')
  assert.equal(f.load().digest, before.digest)
  for (const path of ['specialists/profiles/marketing.md', 'specialists/roles/landing.md',
    'specialists/common.md', 'creative/catalog/landing-quality.md']) {
    const previous = f.load().digest
    f.change(path)
    assert.notEqual(f.load().digest, previous, path)
  }
})

test('an unrelated recipe change is informational; a selected profile version changes identity', t => {
  const f = library(t), file = join(f.skillDir, 'specialists/catalog.json')
  const catalog = JSON.parse(readFileSync(file, 'utf8')), before = f.load().digest
  catalog.roles.email.profiles.push('design')
  writeFileSync(file, JSON.stringify(catalog))
  assert.equal(f.load().digest, before)
  catalog.profiles.marketing.version++
  writeFileSync(file, JSON.stringify(catalog))
  assert.notEqual(f.load().digest, before)
})

test('profile files cannot escape the library via symlinks or registry paths', t => {
  const f = library(t), path = join(f.skillDir, 'specialists/profiles/marketing.md')
  const external = mkdtempSync(join(tmpdir(), 'external-profile-'))
  t.after(() => rmSync(external, { recursive: true, force: true }))
  writeFileSync(join(external, 'secret.md'), 'Do not load this')
  rmSync(path); symlinkSync(join(external, 'secret.md'), path)
  assert.throws(f.load, /безопасная методика/)
  const registry = join(f.skillDir, 'specialists/catalog.json'), catalog = JSON.parse(readFileSync(registry, 'utf8'))
  catalog.profiles.marketing.path = '../secret.md'
  writeFileSync(registry, JSON.stringify(catalog))
  assert.throws(f.load, /Некорректный путь/)
})

function response(selected) {
  const fragments = {
    copywriting: 'Кнопка «Запросить место» точно называет результат отправки формы.',
    design: 'На телефоне существенные условия расположены рядом с формой.',
    marketing: 'Пример первой работы снимает опасение взрослого новичка о нехватке опыта.',
  }
  return { contractDigest: selected.digest, brief: 'Взрослый новичок выбирает пробное занятие; статус заявки подтверждается отдельно.',
    proposal: Object.values(fragments).join('\n'),
    profileApplications: selected.profiles.map(p => ({ id: p.id, decision: `Решение ${p.id}`, proposalQuote: fragments[p.id] })) }
}

test('result must apply exactly the selected competencies to its actual proposal', () => {
  const selected = contract('landing'), good = response(selected)
  assert.deepEqual(specialistResponseErrors(good, selected), [])
  const missing = structuredClone(good); missing.profileApplications.pop()
  assert.match(specialistResponseErrors(missing, selected).join(), /каждого/)
  const foreign = { ...good, contractDigest: 'another-task-contract' }
  assert.match(specialistResponseErrors(foreign, selected).join(), /другому контракту/)
  const fake = structuredClone(good); fake.profileApplications[0].proposalQuote = 'Цитата, которой нет в фактическом предложении.'
  assert.match(specialistResponseErrors(fake, selected).join(), /точная/)
  const repeated = structuredClone(good)
  for (const item of repeated.profileApplications) item.proposalQuote = good.profileApplications[0].proposalQuote
  assert.match(specialistResponseErrors(repeated, selected).join(), /одна и та же цитата/)
  assert.ok(specialistResponseErrors({ ...good, proposal: 'Основной агент сохранил другое предложение' }, selected).length)
  assert.ok(specialistResponseErrors({ ...good, proposal: {} }, selected).length)
})
