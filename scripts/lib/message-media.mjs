const text = value => typeof value === 'string' && value.trim().length > 0
const list = value => Array.isArray(value) && value.length > 0 && value.every(text) &&
  new Set(value).size === value.length
const url = value => text(value) && /^https:\/\/[^\s@/]+(?:\/|$)/i.test(value) && !/\{\{/.test(value)

export function validateMediaRequirements(requirements) {
  if (requirements === undefined) return []
  if (!Array.isArray(requirements)) return ['requiredMedia должен быть списком.']
  const errors = [], seen = new Set()
  for (const item of requirements) {
    if (!item || !['media', 'attachment'].includes(item.kind) || !text(item.key) || !list(item.channelIds)) {
      errors.push('requiredMedia: нужны kind (media/attachment), key и непустые channelIds.')
      continue
    }
    const id = `${item.kind}:${item.key}`
    if (seen.has(id)) errors.push(`requiredMedia: повторяется ${id}.`)
    seen.add(id)
  }
  return errors
}

export function validateMessageMedia(letter, { requirements = [], configuredChannels = [] } = {}) {
  const errors = []
  const entries = [
    { field: 'media', types: ['image', 'video', 'audio', 'video_note'] },
    { field: 'attachments', types: [] },
  ]
  for (const { field, types } of entries) {
    const items = letter?.[field]
    if (items === undefined) continue
    if (!Array.isArray(items)) { errors.push(`${field} должен быть списком.`); continue }
    const seen = new Set()
    for (const item of items) {
      if (!item || !text(item.key) || !url(item.url) || !text(item.mime_type) ||
          (field === 'media' && !types.includes(item.type)) ||
          (field === 'attachments' && !text(item.file_name))) {
        errors.push(`${field}: нужны key, HTTPS URL, mime_type${field === 'media' ? ' и допустимый type' : ' и file_name'}.`)
        continue
      }
      if (seen.has(item.key)) errors.push(`${field}: повторяется key ${item.key}.`)
      seen.add(item.key)
      if (item.only_channel_ids !== undefined && !list(item.only_channel_ids))
        errors.push(`${field} ${item.key}: only_channel_ids должен быть непустым списком уникальных ID.`)
      if (list(item.only_channel_ids) && configuredChannels.length)
        for (const id of item.only_channel_ids) if (!configuredChannels.includes(id))
          errors.push(`${field} ${item.key}: канал ${id} отсутствует в config.senderChannels.`)
    }
  }
  for (const requirement of requirements) {
    if (!requirement || !['media', 'attachment'].includes(requirement.kind) || !text(requirement.key) ||
        !list(requirement.channelIds)) {
      errors.push('requiredMedia: неверное требование к медиа.')
      continue
    }
    const field = requirement.kind === 'attachment' ? 'attachments' : 'media'
    const item = Array.isArray(letter?.[field]) ? letter[field].find(entry => entry?.key === requirement.key) : null
    if (!item) { errors.push(`${field}: нет обещанного медиа ${requirement.key}.`); continue }
    const allowed = item.only_channel_ids
    for (const id of requirement.channelIds || []) {
      if (configuredChannels.length && !configuredChannels.includes(id))
        errors.push(`requiredMedia ${requirement.key}: канал ${id} отсутствует в config.senderChannels.`)
      if (Array.isArray(allowed) && allowed.length && !allowed.includes(id))
        errors.push(`${field} ${requirement.key}: медиа не попадёт в канал ${id}.`)
    }
  }
  return errors
}
