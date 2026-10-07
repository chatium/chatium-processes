const ids = value => Array.isArray(value) && value.length > 0 &&
  value.every(id => typeof id === 'string' && id.trim()) && new Set(value).size === value.length

export function validateChannelPlan(formats, plan, configuredChannels = []) {
  if (plan === undefined) return { channelIds: [], formatById: {}, errors: [] }
  if (!plan || typeof plan !== 'object' || Array.isArray(plan))
    return { channelIds: [], formatById: {}, errors: ['channelIdsByFormat должен быть объектом форматов и ID каналов.'] }
  const errors = []
  const expected = Array.isArray(formats) ? formats : []
  const keys = Object.keys(plan)
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key)))
    errors.push('channelIdsByFormat должен содержать ровно выбранные spec.formats.')
  const channelIds = [], formatById = {}
  for (const format of expected) {
    if (!ids(plan[format])) { errors.push(`channelIdsByFormat.${format}: нужен непустой список уникальных ID.`); continue }
    channelIds.push(...plan[format])
    for (const id of plan[format]) formatById[id] = format
  }
  if (new Set(channelIds).size !== channelIds.length)
    errors.push('channelIdsByFormat: один ID канала не может принадлежать нескольким форматам.')
  if (configuredChannels.length)
    for (const id of channelIds) if (!configuredChannels.includes(id))
      errors.push(`Канал ${id} отсутствует в config.senderChannels.`)
  return { channelIds, formatById, errors }
}

export function validateMessageDelivery(letter, channelIds) {
  if (!ids(letter?.processDeliveryChannelIds))
    return ['processDeliveryChannelIds: нужен непустой список уникальных ID каналов.']
  if (channelIds.length !== letter.processDeliveryChannelIds.length ||
      channelIds.some(id => !letter.processDeliveryChannelIds.includes(id)))
    return ['processDeliveryChannelIds не совпадает с channelIdsByFormat спецификации.']
  return []
}
