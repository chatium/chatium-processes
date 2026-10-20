#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, findRoot } from './lib/project.mjs'
import { git, gitState } from './lib/git-state.mjs'
import { parseYaml } from './lib/yaml.mjs'
import { assertTestSourcesCommitted, hash, createRun, readTestPlan, readTestRun, saveRun, testPath, testStatus } from './lib/process-testing.mjs'
import { readSession, saveSession, saveTestPluginBranches, testSdk, redact, redactData, platformTestLogs } from './lib/test-exec.mjs'
import { fetchRun, publishRun, recoverSequence, closeRun } from './lib/test-remote.mjs'

const help = `node scripts/test.mjs <process> <status|run|show|record|logs|cleanup|reconcile|acknowledge|finding> [--root DIR]
  run --case ID --scope FILE [--previous RUN]   выполнить опубликованный сценарий
  show --run RUN                              прочитать попытку и квитанции из Start
  record --case ID --evidence FILE             записать браузерную проверку
  logs --run RUN                              прочитать текущее состояние модулей и логи
  cleanup --run RUN                           закрыть и убрать ресурсы попытки
  reconcile --run RUN --request ID --operation MOD.OP  выяснить исход без повтора действия
  acknowledge --run RUN --evidence FILE        признать неизвестный исход для очистки; {requestIds,note}
  finding --evidence FILE                     записать {revision,finding} в Start
  status                                     актуальное покрытие из Start
Scope JSON: {contacts:[{type,value}],channels:[id],variants?:{messageKey:path},plugins?:{slug:branch}}.
Получатели остаются вне Git. История и артефакты сохраняются в Start без push.`
try {
  const { positional, options } = parseArgs(process.argv.slice(2), ['help'], ['root', 'case', 'scope', 'previous', 'run', 'evidence', 'request', 'operation', 'help'])
  if (options.help) { console.log(help); process.exit(0) }
  const [slug, command] = positional
  if (!slug || !command || positional.length !== 2) throw Error(help)
  const root = findRoot(options.root), state = gitState(root)
  const map = parseYaml(readFileSync(testPath(root, `${slug}/process.yaml`), 'utf8'))
  if (command === 'reconcile') {
    if (!options.request || !options.operation) throw Error('Укажите --request и --operation исходной операции.')
    const run = fetchRun(root, slug, options.run).report
    const session = readSession(root, options.run)
    const original = run.operations.find(o => o.requestId === options.request && o.operation === options.operation)
    if (!original) throw Error('Исходные параметры отсутствуют в отчёте. Получите их из журнала вызывавшего кода и используйте SDK reconcile с исходным input; не подставляйте пустой объект.')
    const result = testSdk(root, state.commit, 'executeProcessTestOperation', { context: session.context, requestId: options.request, operation: options.operation, input: original.input, reconcile: true })
    console.log(JSON.stringify(result, null, 2)); if (result.status !== 'completed') process.exitCode = 1
  } else if (command === 'acknowledge') {
    fetchRun(root, slug, options.run)
    const session = readSession(root, options.run)
    const { requestIds, note } = JSON.parse(readFileSync(options.evidence, 'utf8'))
    console.log(JSON.stringify(testSdk(root, state.commit, 'acknowledgeProcessTestUncertainty', { context: session.context, requestIds, note }), null, 2))
  } else if (command === 'status') console.log(JSON.stringify(testStatus({ root, slug, map, remote: true }), null, 2))
  else if (command === 'show') console.log(JSON.stringify(fetchRun(root, slug, options.run), null, 2))
  else if (command === 'finding') {
    const value = JSON.parse(readFileSync(options.evidence, 'utf8'))
    console.log(JSON.stringify(testSdk(root, state.commit, 'writeProcessTestFinding', { ...value, process: slug, branch: state.branch }), null, 2))
  } else if (command === 'run' || command === 'record') {
    const scenario = readTestPlan(root, slug, map).cases.find(c => c.id === options.case)
    if (!scenario || scenario.kind !== (command === 'record' ? 'browser' : 'runtime')) throw Error('Выберите сценарий соответствующего вида из plan.yaml.')
    if (options.previous) fetchRun(root, slug, options.previous)
    let run = createRun({ root, slug, scenario, previousRunId: options.previous })
    assertTestSourcesCommitted(root, run.inputs)
    const remote = git(root, ['ls-remote', '--heads', 'origin', `refs/heads/${run.branch}`]).split(/\s+/)[0]
    if (remote !== run.testedCommit) throw Error('Сначала опубликуйте проверяемый коммит в текущую ветку.')
    let scope = { contacts: [], channels: [] }
    if (command === 'run') {
      if (!options.scope || realpathSync(options.scope).startsWith(realpathSync(root) + '/')) throw Error('Файл получателей должен находиться вне Git-аккаунта.')
      scope = JSON.parse(readFileSync(options.scope, 'utf8'))
      if (!Array.isArray(scope.contacts) || !Array.isArray(scope.channels)) throw Error('Scope должен содержать contacts и channels.')
    }
    if (scope.plugins) saveTestPluginBranches(root, scope.plugins)
    if (testSdk(root, run.testedCommit, 'getProcessTestCapabilities').version !== 3) throw Error('Нужен совместимый протокол тестирования Start версии 3.')
    const session = testSdk(root, run.testedCommit, 'createProcessTestContext', { runId: run.runId, caseId: run.caseId, processPath: slug, branch: run.branch, testedCommit: run.testedCommit, sources: run.inputs.files, contacts: scope.contacts, channels: scope.channels, variants: scope.variants })
    run.executedVersions = [{ module: 'account', commit: run.testedCommit, evidence: 'chatium-exec' }, ...Object.entries(session.scope.codeFingerprints || {}).map(([module, fingerprint]) => ({ module, fingerprint, evidence: 'sdk-source-fingerprint' }))]
    saveSession(root, run.runId, { context: session.context, contacts: scope.contacts, channels: scope.channels, sequence: 0 })
    saveRun(root, run, { create: true })
    let cleanup
    try {
      publishRun(root, run)
      if (command === 'record') {
        const evidence = JSON.parse(readFileSync(options.evidence, 'utf8'))
        const artifacts = (evidence.artifacts || []).map(item => {
          if (item.storageHash) return item
          const source = resolve(dirname(resolve(options.evidence)), item.file), name = basename(source)
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}\.(txt|json|md)$/.test(name)) throw Error('Неподдерживаемое имя текстового артефакта.')
          const content = redact(readFileSync(source, 'utf8'))
          if (Buffer.byteLength(content) > 256 * 1024) throw Error('Артефакт более 256 КиБ: используйте штатное хранилище.')
          return { title: item.title || name, name, content, sha256: hash(content) }
        })
        Object.assign(run, { assertions: evidence.assertions, observations: evidence.observations, artifacts, limitations: evidence.limitations || [],
          status: evidence.assertions?.length && scenario.expected.every(c => evidence.assertions.some(a => a.criterion === c && a.ok)) && evidence.assertions.every(a => a.ok) ? 'passed' : 'failed', finishedAt: new Date().toISOString() })
        saveRun(root, run); publishRun(root, run)
      } else {
        const available = testSdk(root, run.testedCommit, 'getProcessTestCapabilities')
        const missing = (scenario.capabilities || []).filter(id => !available.operations?.some(o => o.id === id && o.available !== false))
        if (missing.length) {
          run.status = 'blocked'; run.finishedAt = new Date().toISOString(); run.limitations.push(`Нет безопасного SDK: ${missing.join(', ')}`)
          run.limitations.push(...new Set(available.operations.filter(o => missing.includes(o.id) && o.unavailableReason).map(o => o.unavailableReason)))
          saveRun(root, run); publishRun(root, run)
        } else {
          const child = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'lib/test-worker.mjs')], {
            cwd: root, input: JSON.stringify({ root, slug, scenario, runId: run.runId }), encoding: 'utf8', timeout: scenario.timeoutMs || 300000, maxBuffer: 1024 * 1024,
          })
          run = recoverSequence(root, slug, run.runId)
          if (run.status === 'running') {
            run.status = 'incomplete'; run.finishedAt = new Date().toISOString()
            run.limitations.push('Сценарий прерван. Исход уточняется по состоянию модулей; повтор эффекта с новым requestId запрещён.')
            saveRun(root, run); publishRun(root, run)
          }
        }
      }
    } catch (error) {
      // The worker or a lost HTTP response may have already sealed a newer report.
      // Prefer authoritative state; keep the private local attempt if recovery is unavailable.
      try { run = recoverSequence(root, slug, run.runId) }
      catch { try { run = readTestRun(root, slug, run.runId) } catch {} }
      if (run.status === 'running') {
        run.status = 'incomplete'; run.finishedAt = new Date().toISOString()
        run.limitations.push(redact(`Сценарий прерван: ${error.message}`, [session.context.token], scope.contacts.map(c => c.value)))
        saveRun(root, run)
        try { publishRun(root, run) }
        catch { console.error('Итог сохранён в приватном кэше; Start недоступен для публикации.') }
      }
      throw error
    } finally { cleanup = closeRun(root, run.runId, run) }
    const saved = fetchRun(root, slug, run.runId)
    console.log(JSON.stringify({ ...saved, cleanup }, null, 2))
    if (saved.effectiveStatus !== 'passed' || cleanup.some(c => c.status !== 'completed')) process.exitCode = 1
  } else if (command === 'logs' || command === 'cleanup') {
    const run = fetchRun(root, slug, options.run).report, session = readSession(root, run.runId)
    if (command === 'cleanup') {
      const result = closeRun(root, run.runId, run); console.log(JSON.stringify(result, null, 2))
      if (result.some(r => r.status !== 'completed')) process.exitCode = 1
    } else {
      const scope = testSdk(root, state.commit, 'getProcessTestScope', session.context, true), results = []
      try { results.push({ operation: 'platform.logs', status: 'completed', result: platformTestLogs(root, state.commit, run), limitation: 'Выборка ограничена временем и 100 строками; логи Start недоступны.' }) }
      catch { results.push({ operation: 'platform.logs', status: 'blocked', error: 'Платформенные логи недоступны.' }) }
      for (const module of [...new Set(scope.resources.map(r => r.module))]) {
        const operation = `${module}.diagnostics`
        results.push({ operation, ...testSdk(root, state.commit, 'executeProcessTestOperation', { context: session.context, operation, requestId: `logs:${module}`, input: {} }) })
      }
      console.log(JSON.stringify(redactData(results, [session.context.token], session.contacts.map(c => c.value)), null, 2))
      if (results.some(r => r.status !== 'completed')) process.exitCode = 1
    }
  } else throw Error(help)
} catch (error) { console.error(error.message); process.exitCode = 2 }
