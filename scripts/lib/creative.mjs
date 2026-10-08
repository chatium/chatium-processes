import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseYaml } from './yaml.mjs'
import { safeTaskPath } from './tasks.mjs'
import { SKILL_DIR } from './project.mjs'
import { validateMediaRequirements } from './message-media.mjs'
import { validateChannelPlan } from './message-delivery.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' && value.trim().length > 0
const unique = values => new Set(values).size === values.length
const catalog = name => JSON.parse(readFileSync(join(SKILL_DIR, 'creative/catalog', name), 'utf8'))
const json = value => JSON.stringify(value, null, 2)

function selectedText(content, section) {
  if (!section) return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '')
  const expected = String(section).replace(/^#+\s*/, '').trim()
  if (!expected) throw Error('нужно имя раздела после #')
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex(line => {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    return heading && heading[2].trim() === expected
  })
  if (start < 0) throw Error(`раздел «${section}» не найден`)
  const level = /^(#+)/.exec(lines[start])[1].length
  const end = lines.findIndex((line, index) => index > start &&
    new RegExp(`^#{1,${level}}\\s+`).test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

function requireContent(content, section) {
  const selected = selectedText(content, section)
  const visible = selected.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s{0,3}#{1,6}\s.*$/gm, '').trim()
  if (!/[\p{L}\p{N}]/u.test(visible)) throw Error(section ? `раздел «${section}» пуст` : 'источник пуст')
  if (/(?:^|\n)\s*(?:[-*+]\s+)?(?:…|\.{3}|TODO|TBD)\s*$/im.test(visible) ||
      /(?<![\p{L}\p{N}_])(?:TODO|TBD|FIXME)\s*:|\[(?:TODO|TBD|FIXME)\]/iu.test(visible))
    throw Error(section ? `раздел «${section}» содержит незаполненную заглушку` : 'источник содержит незаполненную заглушку')
}

function sourceFiles(root, spec, errors) {
  const files = [], seen = new Set()
  for (const source of spec.sources || []) {
    if (!text(source?.id) || !text(source?.path) || seen.has(source.id)) { errors.push('Нужны уникальные sources[].id и path.'); continue }
    seen.add(source.id)
    try {
      const file = safeTaskPath(root, source.path)
      if (statSync(file).size > 80000) throw Error('слишком большой источник')
      const content = readFileSync(file, 'utf8')
      requireContent(content, source.section)
      files.push({ id: source.id, path: source.path, section: source.section || null, content })
    } catch (error) { errors.push(`Источник ${source.id}: ${error.message}`) }
  }
  if (!files.length) errors.push('Нужен хотя бы один подтверждённый источник.')
  return files
}

function originalPage(root, redesign, errors) {
  if (text(redesign?.originalUrl)) {
    try {
      const url = new URL(redesign.originalUrl)
      if (url.protocol !== 'https:' || url.username || url.password) throw Error('нужен HTTPS URL без учётных данных')
      return { url: url.toString(), revision: redesign.originalRevision || null }
    } catch { errors.push('redesign.originalUrl: нужен корректный HTTPS URL исходной страницы без учётных данных.') }
  }
  if (text(redesign?.originalCapture)) {
    try {
      const file = safeTaskPath(root, redesign.originalCapture)
      if (!redesign.originalCapture.toLowerCase().endsWith('.png') || statSync(file).size > 5 * 1024 * 1024)
        throw Error('нужен PNG до 5 МиБ')
      const bytes = readFileSync(file)
      if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
          bytes.toString('ascii', 12, 16) !== 'IHDR' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20))
        throw Error('нужен действительный PNG')
      return { path: redesign.originalCapture, sha256: hash(bytes),
        width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    } catch (error) { errors.push(`redesign.originalCapture: ${error.message}`) }
  }
  if (!text(redesign?.originalUrl) && !text(redesign?.originalCapture))
    errors.push('redesign: нужен originalUrl исходной страницы или originalCapture с PNG-снимком; текстовый пересказ недостаточен.')
  return null
}

function validateLanding(spec, errors, references) {
  const types = catalog('landing-types.json'), mechanics = catalog('mechanics.json'), styles = catalog('styles.json')
  const copywriting = catalog('copywriting.json')
  references.push('creative/catalog/landing-quality.md')
  const type = types.types[spec.landingType]
  if (!type) { errors.push(`Неизвестный landingType ${spec.landingType}`); return null }
  if (!Array.isArray(spec.sections) || !spec.sections.length) errors.push('Нужны содержательные sections[].')
  const sections = Array.isArray(spec.sections) ? spec.sections : []
  if (!unique(sections.map(s => s.id))) errors.push('ID секций должны быть уникальны.')
  const sourceIds = new Set((spec.sources || []).map(s => s.id))
  for (const s of sections) {
    if (!text(s.id) || !text(s.type) || !text(s.purpose) || !Array.isArray(s.covers) || !s.covers.length ||
        !Array.isArray(s.points) || !s.points.length || !text(s.presentation?.desktop) || !text(s.presentation?.mobile) ||
        !Array.isArray(s.acceptance) || !s.acceptance.length)
      errors.push(`Секция ${s.id || '?'}: нужны цель, покрытие, тезисы, композиция desktop/mobile и приёмка.`)
    for (const point of s.points || []) if (!text(point.text) || !sourceIds.has(point.sourceRef))
      errors.push(`Секция ${s.id || '?'}: у тезиса нет текста или подтверждённого sourceRef.`)
  }
  const rawMechanics = Array.isArray(spec.mechanics) ? spec.mechanics : []
  const selected = rawMechanics.filter(m => m && typeof m === 'object' && !Array.isArray(m))
  if (selected.length !== rawMechanics.length) errors.push('Механика должна быть объектом с полями настройки.')
  if (!unique(selected.map(m => m.id))) errors.push('ID механик должны быть уникальны.')
  for (const m of selected) {
    for (const [field, value] of Object.entries(m)) if (value === null)
      errors.push(`Механика ${m.id || '?'}: поле ${field} пусто; проверьте разделители и кавычки в YAML.`)
    const rule = mechanics.mechanics[m.type]
    if (!rule) { errors.push(`Неизвестная механика ${m.type}`); continue }
    if (!text(m.id) || !text(m.purpose) || !text(m.placement)) errors.push(`Механика ${m.id || '?'}: нужны цель и место.`)
    if (!text(m.expectedOutcome)) errors.push(`Механика ${m.id || '?'}: нужен ожидаемый результат.`)
    if (text(m.placement) && !sections.some(s => s.id === m.placement))
      errors.push(`Механика ${m.id || '?'}: нет секции ${m.placement}.`)
    else if (text(m.id) && !sections.some(s => s.id === m.placement && s.mechanicRefs?.includes(m.id)))
      errors.push(`Механика ${m.id}: не привязана к секции ${m.placement}.`)
    for (const field of rule.requires) if (!(Array.isArray(m[field]) ? m[field].length : text(m[field])))
      errors.push(`Механика ${m.id || '?'}: требуется ${field}.`)
    if (rule.requires.includes('sourceRef') && !sourceIds.has(m.sourceRef))
      errors.push(`Механика ${m.id || '?'}: sourceRef должен ссылаться на проверенный источник из sources.`)
    if (['timer', 'scarcity_counter'].includes(m.type) && !sourceIds.has(m.deadlineSource || m.quantitySource))
      errors.push(`Механика ${m.id || '?'}: нужен источник срока/количества.`)
  }
  const mechanicIds = new Set(selected.map(m => m.id))
  for (const s of sections) for (const id of s.mechanicRefs || []) {
    if (!mechanicIds.has(id)) errors.push(`Секция ${s.id}: нет механики ${id}.`)
    else if (selected.find(m => m.id === id)?.placement !== s.id)
      errors.push(`Секция ${s.id}: механика ${id} назначена в другом месте.`)
  }
  if (spec.landingType === 'sales' && !selected.some(m => ['form', 'payment_button', 'cta_button'].includes(m.type)))
    errors.push('Продающей странице нужен настроенный путь покупки или заявки.')
  if (['webinar', 'autowebinar'].includes(spec.landingType)) {
    const event = spec.event
    const fields = spec.landingType === 'webinar'
      ? ['date', 'timezone', 'format', 'program', 'presenter', 'registrationOutcome']
      : ['schedule', 'timezone', 'format', 'program', 'presenter', 'registrationOutcome']
    if (fields.some(field => !text(event?.[field])))
      errors.push(`${spec.landingType}: нужны дата/часовой пояс, формат, программа, ведущий и результат регистрации (для записи — расписание вместо даты).`)
    if (!selected.some(m => m.type === 'form' || m.type === 'cta_button'))
      errors.push(`${spec.landingType}: нужен настроенный путь регистрации.`)
  }
  if (spec.landingType === 'quiz') {
    if (!selected.some(m => m.type === 'quiz')) errors.push('quiz: нужна настроенная механика quiz с обработкой результата.')
    if (!text(spec.quiz?.resultRule) || !text(spec.quiz?.outcomes) || !text(spec.quiz?.nextStep))
      errors.push('quiz: нужны правило результата, возможные исходы и следующий шаг.')
  }
  if (spec.landingType === 'redesign') {
    const original = spec.redesign
    if (!(spec.sources || []).some(source => source.id === original?.sourceRef && source.role === 'original') ||
        !Array.isArray(original?.preserve) ||
        !original.preserve.length || !original.preserve.every(text) ||
        !Array.isArray(original?.changes) || !original.changes.length || !original.changes.every(text) ||
        !Array.isArray(original?.verification) || !original.verification.length || !original.verification.every(text))
      errors.push('redesign: нужны исходный материал в sources, сохраняемые условия/действия, согласованные изменения и способ сравнения результата.')
  }
  const design = spec.design
  if (!design || !text(design.styleId)) errors.push('Нужна дизайн-система.')
  else if (design.styleId !== 'custom' && !styles.styles[design.styleId]) errors.push(`Неизвестный стиль ${design.styleId}.`)
  else if (design.styleId === 'custom') {
    for (const key of ['colors', 'typography', 'grid', 'spacing', 'components', 'mobile', 'forbidden'])
      if (!design[key] || Array.isArray(design[key]) && !design[key].length) errors.push(`Свой стиль: не заполнено ${key}.`)
  }
  if (design && !text(design.adaptation)) errors.push('Нужно объяснить адаптацию дизайн-системы под задачу.')
  const writing = spec.copywriting
  if (writing !== undefined) {
    if (!text(writing?.styleId) || !copywriting.styles[writing.styleId])
      errors.push(`Неизвестная подача текста ${writing?.styleId || '?'}.`)
    if (!text(writing?.adaptation)) errors.push('Подача текста: объясни адаптацию под аудиторию и бренд.')
  }
  for (const image of spec.images || []) {
    if (!text(image.id) || !text(image.sectionId) || !text(image.purpose) || !text(image.alt) ||
        !(text(image.asset) || text(image.generationBrief)) || !text(image.aspect) || !text(image.mobileCrop))
      errors.push(`Изображение ${image.id || '?'}: нужны роль, секция, файл/бриф, пропорции, mobile crop и alt.`)
    if (!sections.some(s => s.id === image.sectionId)) errors.push(`Изображение ${image.id}: нет секции ${image.sectionId}.`)
    if (!text(image.asset)) errors.push(`Изображение ${image.id}: перед реализацией нужен готовый asset.`)
    if (!['owner', 'generated', 'licensed'].includes(image.provenance?.kind) ||
        !text(image.provenance?.reference) || !text(image.provenance?.usageRights))
      errors.push(`Изображение ${image.id}: укажи происхождение (owner/generated/licensed), источник и основание использования.`)
  }
  const ab = spec.abTesting
  if (!ab || !['none', 'design', 'text', 'design_and_text'].includes(ab.mode)) errors.push('Нужен корректный режим abTesting.')
  else if (ab.mode !== 'none') {
    for (const field of ['hypothesis', 'experimentKey', 'assignment', 'metric', 'tracking']) if (!text(ab[field])) errors.push(`A/B: нужно ${field}.`)
    if (!Array.isArray(ab.variants) || ab.variants.length < 2 || !unique(ab.variants.map(v => v.key)) ||
        ab.variants.some(v => !text(v.key) || !text(v.changes))) errors.push('A/B: нужны два различающихся варианта с уникальными ключами и описанными отличиями.')
  }
  return { ...type, style: design?.styleId === 'custom' ? design : styles.styles[design?.styleId],
    writing: writing && copywriting.styles[writing.styleId],
    mechanics: Object.fromEntries(selected.map(m => [m.type, mechanics.mechanics[m.type]]).filter(([, rule]) => rule)) }
}

function validateSeries(spec, errors, references) {
  const catalogData = catalog('email-types.json')
  if (!catalogData.types[spec.seriesType]) { errors.push(`Неизвестный seriesType ${spec.seriesType}`); return null }
  references.push('creative/catalog/email-design.md', 'creative/catalog/email-quality.md')
  const formats = spec.formats === undefined ? ['email'] : spec.formats
  if (!Array.isArray(formats) || !formats.length || !unique(formats) ||
      formats.some(format => !['email', 'messenger', 'sms'].includes(format)))
    errors.push('formats серии: укажите непустой список без повторов из email, messenger, sms.')
  for (const issue of validateChannelPlan(formats, spec.channelIdsByFormat).errors)
    errors.push(issue)
  const uses = format => Array.isArray(formats) && formats.includes(format)
  for (const field of ['addressing', 'character', 'emotionality', 'example']) if (!text(spec.voice?.[field])) errors.push(`Голос серии: нужно ${field}.`)
  if (uses('email')) for (const field of ['layout', 'components', 'colors', 'mobile'])
    if (!text(spec.emailDesign?.[field])) errors.push(`Дизайн писем: нужно ${field}.`)
  if (!Array.isArray(spec.messages) || !spec.messages.length || !unique(spec.messages.map(m => m.id))) errors.push('Нужны сообщения с уникальными ID.')
  if (Array.isArray(spec.messages) && !unique(spec.messages.map(m => m.path))) errors.push('У сообщений повторяется путь файла.')
  if (Array.isArray(spec.messages) && !unique(spec.messages.map(m => m.mainIdea))) errors.push('У писем повторяется главная мысль; серия должна развиваться.')
  const sourceIds = new Set((spec.sources || []).map(s => s.id))
  for (const m of spec.messages || []) {
    if (!text(m.id) || !text(m.path) || !text(m.goal) || !text(m.mainIdea) ||
        (uses('email') && !text(m.subject)) || !Array.isArray(m.blocks) || !m.blocks.length)
      errors.push(`Сообщение ${m.id || '?'}: нужны путь, роль, главная идея, содержание и тема для email.`)
    for (const field of ['hook', 'preheader']) if (m[field] !== undefined && typeof m[field] !== 'string')
      errors.push(`Письмо ${m.id || '?'}: ${field} должен быть строкой, если указан.`)
    for (const block of m.blocks || []) if (!text(block.type) || !text(block.text) || !sourceIds.has(block.sourceRef))
      errors.push(`Письмо ${m.id || '?'}: фрагмент без роли, текста или источника.`)
    if (m.cta && (!text(m.cta.label) || !text(m.cta.target))) errors.push(`Письмо ${m.id}: неполный CTA.`)
    for (const issue of validateMediaRequirements(m.requiredMedia)) errors.push(`Письмо ${m.id}: ${issue}`)
    if (m.marketingTrigger && (!text(m.marketingTrigger.purpose) || !sourceIds.has(m.marketingTrigger.sourceRef)))
      errors.push(`Письмо ${m.id}: приём не обоснован источником.`)
  }
  if (spec.seriesType === 'sales' && !(spec.messages || []).some(m => m.cta)) errors.push('В продающей серии нужен хотя бы один обоснованный следующий шаг к покупке.')
  if (spec.deliveryMode && !['automation', 'manual'].includes(spec.deliveryMode))
    errors.push('deliveryMode серии: нужен automation или manual.')
  if (spec.deliveryMode === 'manual') {
    if (spec.automationRef) errors.push('Ручная серия не должна ссылаться на фиктивную автоматизацию.')
    for (const field of ['caller', 'trigger', 'recipient', 'stop'])
      if (!text(spec.manualInvocation?.[field])) errors.push(`Ручная серия: нужен manualInvocation.${field}.`)
  } else if (!text(spec.automationRef)) errors.push('Автоматической серии нужна automationRef для проверки запуска и остановки.')
  return { guidance: catalogData.types[spec.seriesType], blocks: catalogData.blocks }
}

export function creativePacket({ root, slug, nodeId }) {
  const mapPath = safeTaskPath(root, `${slug}/process.yaml`)
  if (statSync(mapPath).size > 1024 * 1024) throw Error('Слишком большая карта процесса.')
  const map = parseYaml(readFileSync(mapPath, 'utf8'))
  const node = map?.nodes?.find(n => n.id === nodeId)
  if (!node || !['page', 'series'].includes(node.kind)) throw Error(`Нет узла page/series ${nodeId}.`)
  if (!text(node.creativeRef)) throw Error(`${nodeId}: нет creativeRef.`)
  if (node.creativeRef !== `${slug}/creative/${nodeId}/spec.yaml`) throw Error(`${nodeId}: creativeRef должен указывать на свой spec.yaml.`)
  const specPath = node.creativeRef
  const specFile = safeTaskPath(root, specPath)
  if (statSync(specFile).size > 512 * 1024) throw Error('Слишком большой конфигуратор.')
  const spec = parseYaml(readFileSync(specFile, 'utf8'))
  for (const [key, maximum] of Object.entries({ sources: 40, references: 40, sections: 50,
    mechanics: 40, images: 40, messages: 60, openQuestions: 50 }))
    if (Array.isArray(spec?.[key]) && spec[key].length > maximum) throw Error(`Слишком много ${key} (максимум ${maximum}).`)
  const errors = [], references = []
  if (spec?.version !== 1 || spec.targetNode !== nodeId || !['landing', 'series'].includes(spec.kind) ||
      spec.kind !== (node.kind === 'page' ? 'landing' : 'series')) errors.push('spec.yaml не соответствует узлу или версии схемы.')
  if (!text(spec?.objective) || !text(spec?.audience) || !Array.isArray(spec?.acceptance) || !spec.acceptance.length)
    errors.push('Нужны цель, аудитория и критерии результата.')
  if (!Array.isArray(spec?.sources) || !Array.isArray(spec?.openQuestions)) errors.push('Нужны sources и openQuestions.')
  if (spec?.references !== undefined && (!Array.isArray(spec.references) || !spec.references.every(text)))
    errors.push('references должен быть списком путей.')
  if ((spec?.openQuestions || []).some(q => q.blocking)) errors.push('Есть блокирующие вопросы.')
  const sources = sourceFiles(root, spec || {}, errors)
  const copyFiles = [], assetFiles = []
  if (spec?.kind === 'landing') {
    for (const section of spec.sections || []) if (text(section.copyRef)) {
      const [path, namedSection] = section.copyRef.split('#', 2)
      try {
        const file = safeTaskPath(root, path)
        if (statSync(file).size > 80000) throw Error('слишком большой файл текста')
        const content = readFileSync(file, 'utf8')
        requireContent(content, section.copyRef.includes('#') ? namedSection || '#' : null)
        if (!copyFiles.some(file => file.path === path)) copyFiles.push({ path, content })
      } catch (error) { errors.push(`Текст секции ${section.id}: ${error.message}`) }
    }
    for (const image of spec.images || []) if (text(image.asset)) try {
      const file = safeTaskPath(root, image.asset)
      const bytes = statSync(file).size
      if (bytes > 4 * 1024 * 1024) throw Error('слишком большой asset')
      if (image.sectionId === spec.sections?.[0]?.id && bytes > 1024 * 1024)
        throw Error('изображение первого экрана слишком велико: подготовьте оптимизированный asset до 1 МиБ')
      const content = readFileSync(file)
      assetFiles.push({ path: image.asset, bytes, sha256: hash(content) })
    } catch (error) { errors.push(`Asset ${image.id}: ${error.message}`) }
  }
  const guidance = spec?.kind === 'landing' ? validateLanding(spec, errors, references) :
    spec?.kind === 'series' ? validateSeries(spec, errors, references) : null
  const original = spec?.landingType === 'redesign' ? originalPage(root, spec.redesign, errors) : null
  if (node.kind === 'series' && Array.isArray(spec?.messages)) {
    const source = node.source?.endsWith('/') ? node.source : `${node.source}/`
    for (const message of spec.messages) if (!text(message.path) || !text(node.source) ||
        !message.path.startsWith(source) || !message.path.endsWith('.message.yaml'))
      errors.push(`Письмо ${message.id || '?'}: path должен вести на файл внутри ${node.source || 'source серии'}.`)
  }
  const selectedRefs = [...new Set([...(Array.isArray(spec?.references) ? spec.references : []), ...references])].sort()
  const referenceFiles = []
  for (const ref of selectedRefs) try {
    if (ref.startsWith('creative/') && !/^creative\/(?:catalog)\/[a-z0-9][a-z0-9._-]*$/.test(ref))
      throw Error('Некорректный путь встроенного референса.')
    const path = ref.startsWith('creative/') ? join(SKILL_DIR, ref) : safeTaskPath(root, ref)
    if (statSync(path).size > 80 * 1024) throw Error('Слишком большой референс.')
    referenceFiles.push({ path: ref.startsWith('creative/') ? `.agents/skills/processes/${ref}` : ref,
      content: readFileSync(path, 'utf8') })
  } catch (error) { errors.push(`Референс ${ref}: ${error.message}`) }
  let automationFile = null
  if (spec?.kind === 'series' && text(spec.automationRef)) try {
    const file = safeTaskPath(root, spec.automationRef)
    if (statSync(file).size > 256 * 1024) throw Error('слишком большой файл автоматизации')
    const content = readFileSync(file)
    automationFile = { path: spec.automationRef, sha256: hash(content) }
  } catch (error) { errors.push(`Автоматизация: ${error.message}`) }
  const parts = [{ path: specPath, sha256: hash(readFileSync(safeTaskPath(root, specPath))) },
    { node: hash(JSON.stringify(node)) },
    ...sources.map(s => ({ path: s.path, sha256: hash(s.content) })),
    ...copyFiles.map(file => ({ path: file.path, sha256: hash(file.content) })), ...assetFiles,
    ...(original?.path ? [{ path: original.path, sha256: original.sha256 }] : []),
    ...(automationFile ? [automationFile] : []),
    ...referenceFiles.map(r => ({ path: r.path, sha256: hash(r.content) })),
    { selectedCatalog: hash(JSON.stringify(guidance)) }]
  const inputDigest = hash(JSON.stringify(parts))
  const buildPath = `${slug}/creative/${nodeId}/build.md`
  return { node, spec, specPath, sources, copyFiles, assetFiles, original, automationFile, referenceFiles, guidance, errors, inputDigest, buildPath }
}

export function compileCreative(packet) {
  if (packet.errors.length) throw Error(packet.errors.join('\n'))
  const { spec, node, guidance, sources, copyFiles, assetFiles, automationFile, referenceFiles, inputDigest } = packet
  const requiredReferences = referenceFiles.map(r => r.path)
  const inputList = [{ kind: 'spec', path: packet.specPath },
    ...sources.map(s => ({ kind: 'knowledge', path: s.path })),
    ...copyFiles.map(f => ({ kind: 'reference', path: f.path })),
    ...assetFiles.map(f => ({ kind: 'asset', path: f.path })),
    ...(packet.original?.path ? [{ kind: 'asset', path: packet.original.path }] : []),
    ...(automationFile ? [{ kind: 'code', path: automationFile.path }] : [])]
  const requiredInputs = [...new Map(inputList.map(item => [item.path, item])).values()]
    .sort((a, b) => a.path.localeCompare(b.path))
  const header = `<!-- creative-build-v1 ${JSON.stringify({ generated: true, targetNode: node.id,
    kind: spec.kind, inputDigest, requiredReferences, requiredInputs })} -->`
  const lines = [header, `# Задание: ${node.title}`, '', `Цель: ${spec.objective}`, `Аудитория: ${spec.audience}`, '',
    '## Подтверждённые источники', ...sources.map(s => `- ${s.id}: ${s.path}${s.section ? `#${s.section}` : ''}`), '',
    '## Обязательные референсы', ...requiredReferences.map(path => `- ${path}`), '']
  if (spec.kind === 'landing') {
    if (copyFiles.length) lines.push('## Согласованные тексты', ...copyFiles.map(file => `### ${file.path}\n${file.content}`), '')
    lines.push(`## Тип: ${spec.landingType}`, guidance.purpose, guidance.guidance, '',
      'Возможные темы по задаче и фактуре: ' + guidance.recommendedBlocks.join(', '),
      'Это подсказки, не обязательное оглавление. Состав, порядок и названия секций выбраны в задании ниже.',
      '', '## Секции')
    for (const s of spec.sections) lines.push(`### ${s.id}: ${s.purpose}`, `Тип: ${s.type}; покрытие: ${s.covers.join(', ')}`,
      ...s.points.map(p => `- ${p.text} [${p.sourceRef}]`), `Desktop: ${s.presentation.desktop}`,
      `Mobile: ${s.presentation.mobile}`, `Механики: ${(s.mechanicRefs || []).join(', ') || 'нет'}`,
      `Приёмка: ${s.acceptance.join('; ')}`, '')
    lines.push('## Конверсионные механики')
    for (const m of spec.mechanics || []) lines.push(`- ${m.id} (${m.type}): ${json(m)}`)
    if (spec.event) lines.push('', '## Сценарий мероприятия', json(spec.event))
    if (spec.quiz) lines.push('', '## Результат квиза', json(spec.quiz))
    if (spec.redesign) lines.push('', '## Исходник и границы редизайна', json(spec.redesign))
    lines.push('', '## Дизайн-система', json(guidance.style), `Адаптация: ${spec.design.adaptation}`)
    if (spec.copywriting) lines.push('', '## Подача текста', json(guidance.writing),
      `Адаптация под аудиторию и бренд: ${spec.copywriting.adaptation}`,
      'Все факты, цифры, случаи, сроки и обещания сверяй с источниками; неподтверждённые не добавляй.')
    lines.push('', '## Изображения')
    for (const image of spec.images || []) lines.push(`- ${image.id}: ${json(image)}`)
    lines.push('', '## A/B', json(spec.abTesting))
  } else {
    const formats = spec.formats || ['email']
    lines.push(`## Тип серии: ${spec.seriesType}`, guidance.guidance, '', '## Голос', json(spec.voice),
      '', `## Нужные форматы: ${formats.join(', ')}`,
      ...(formats.includes('email') ? ['', '## Дизайн писем', json(spec.emailDesign)] : []), '',
      'Создай содержательные представления для выбранных форматов: email — subject/html/plain, messenger — plain, sms — short. Не добавляй другие каналы без задачи и настройки доставки.',
      '', '## Письма')
    for (const m of spec.messages) lines.push(`### ${m.id}: ${m.goal}`, `Файл: ${m.path}`, `Главная идея: ${m.mainIdea}`,
      ...(formats.includes('email') ? [`Тема: ${m.subject}`] : []), ...(m.preheader ? [`Прехедер: ${m.preheader}`] : []), ...(m.hook ? [`Хук: ${m.hook}`] : []),
      ...m.blocks.map(b => `- ${b.type}: ${b.text} [${b.sourceRef}]`),
      `Маркетинговый приём: ${m.marketingTrigger ? json(m.marketingTrigger) : 'не выбран'}`,
      `CTA: ${m.cta ? `${m.cta.label} → ${m.cta.target}` : 'не нужен по задаче'}`, '')
    if (spec.deliveryMode === 'manual') lines.push('## Ручной запуск', json(spec.manualInvocation))
    else lines.push('## Автоматизация', spec.automationRef)
  }
  lines.push('', '## Критерии приёмки', ...spec.acceptance.map(a => `- ${a}`), '',
    '## Вопросы независимому reviewer', ...(guidance.reviewQuestions || ['Достаточно ли содержания для задачи и аудитории?']).map(q => `- ${q}`), '')
  return lines.join('\n')
}

export function creativeStatus(args) {
  try {
    const packet = creativePacket(args)
    if (packet.errors.length) return { status: 'invalid', errors: packet.errors }
    const build = compileCreative(packet)
    const path = safeTaskPath(args.root, packet.buildPath, { mayBeMissing: true })
    if (!existsSync(path)) return { status: 'missing', errors: [`Нет ${packet.buildPath}`] }
    if (readFileSync(path, 'utf8') !== build) return { status: 'stale', errors: [`${packet.buildPath} не соответствует актуальному конфигуратору и источникам`] }
    return { status: 'ready', errors: [], path: packet.buildPath, inputDigest: packet.inputDigest }
  } catch (error) { return { status: 'invalid', errors: [error.message] } }
}

export function writeCreativeBuild(args, packet = creativePacket(args)) {
  const build = compileCreative(packet)
  const path = safeTaskPath(args.root, packet.buildPath, { mayBeMissing: true })
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, build, { flag: 'wx' })
  renameSync(temporary, path)
  return { path: packet.buildPath, inputDigest: packet.inputDigest }
}
