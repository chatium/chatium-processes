const text = value => typeof value === 'string' && value.trim().length > 0
const unique = values => new Set(values).size === values.length
const route = value => typeof value === 'string' && value.startsWith('/') &&
  (value === '/' || value.slice(1).split('/').every(part =>
    /^[a-zA-Z0-9_-]+$/.test(part) || /^:[a-zA-Z][a-zA-Z0-9_]*$/.test(part)))

/** Structural contracts for services and sites represented by existing board node kinds. */
export function validateComponentContracts({ map, site, services, creativeSpecs = new Map() }) {
  const errors = []
  const nodes = Array.isArray(map?.nodes) ? map.nodes : []
  const byId = new Map(nodes.filter(node => text(node?.id)).map(node => [node.id, node]))

  if (site !== undefined) {
    if (site?.version !== 1 || !text(site.title) || !text(site.businessModel) ||
        !Array.isArray(site.requiredRoles) || !site.requiredRoles.length ||
        !site.requiredRoles.every(text) || !unique(site.requiredRoles) ||
        !Array.isArray(site.entityFields) || !site.entityFields.every(text) || !unique(site.entityFields) ||
        !Array.isArray(site.pages) || site.pages.length < 2 || site.pages.length > 50)
      errors.push('site.yaml: нужны version: 1, title, businessModel, requiredRoles, entityFields и 2–50 pages.')
    const pages = Array.isArray(site?.pages) ? site.pages : []
    if (!unique(pages.map(page => page?.nodeId))) errors.push('site.yaml: nodeId страницы повторяется.')
    if (!unique(pages.map(page => page?.route))) errors.push('site.yaml: route страницы повторяется.')
    const roles = new Set(pages.map(page => page?.role))
    for (const role of site?.requiredRoles || []) if (!roles.has(role))
      errors.push(`site.yaml: обязательная роль ${role} не имеет страницы.`)
    const fields = new Set(site?.entityFields || [])
    for (const [index, page] of pages.entries()) {
      const where = `site.pages[${index}]`
      if (byId.get(page?.nodeId)?.kind !== 'page') errors.push(`${where}: nodeId ${page?.nodeId} не указывает на страницу карты.`)
      if (!text(page?.role) || !text(page?.purpose) || !text(page?.route) ||
          !route(page.route) || !Array.isArray(page.filters))
        errors.push(`${where}: нужны role, purpose, безопасный route и filters[].`)
      for (const filter of page?.filters || []) if (!fields.has(filter))
        errors.push(`${where}: фильтр ${filter} не объявлен в entityFields.`)
    }
    const forms = Array.isArray(site?.forms) ? site.forms : []
    if (site?.forms !== undefined && !Array.isArray(site.forms))
      errors.push('site.yaml: forms должен быть списком форм страниц.')
    const pageIds = new Set(pages.map(page => page?.nodeId))
    for (const [index, form] of forms.entries()) {
      const where = `site.forms[${index}]`
      if (!pageIds.has(form?.page)) errors.push(`${where}: страница ${form?.page} отсутствует в site.pages.`)
      if (!Array.isArray(form?.fields) || !form.fields.length ||
          !form.fields.every(text) || !unique(form.fields))
        errors.push(`${where}: нужны неповторяющиеся fields[].`)
    }
    for (const [nodeId, spec] of creativeSpecs) {
      if (!pageIds.has(nodeId) || spec?.kind !== 'landing') continue
      const siteForms = forms.filter(form => form?.page === nodeId)
      const creativeForms = (Array.isArray(spec.mechanics) ? spec.mechanics : [])
        .filter(mechanic => mechanic?.type === 'form')
      const fieldsKey = form => Array.isArray(form?.fields) ? [...form.fields].sort().join('\0') : null
      for (const form of siteForms) if (!creativeForms.some(mechanic => fieldsKey(mechanic) === fieldsKey(form)))
        errors.push(`site.yaml: поля формы ${nodeId} не совпадают с creative/${nodeId}/spec.yaml.`)
      for (const mechanic of creativeForms) if (!siteForms.some(form => fieldsKey(form) === fieldsKey(mechanic)))
        errors.push(`site.yaml: форма ${nodeId} из creative/${nodeId}/spec.yaml отсутствует или имеет другие поля.`)
    }
  }

  const referenced = nodes.filter(node => node?.serviceRef !== undefined)
  if (referenced.length && services === undefined) errors.push('Узел с serviceRef требует specs/services.yaml.')
  if (services !== undefined) {
    if (services?.version !== 1 || !Array.isArray(services.services) || services.services.length > 50)
      errors.push('services.yaml: нужны version: 1 и services[] (не более 50).')
    const entries = Array.isArray(services?.services) ? services.services : []
    if (!unique(entries.map(service => service?.id))) errors.push('services.yaml: id сервиса повторяется.')
    for (const [index, service] of entries.entries()) {
      const where = `services[${index}]`
      if (!text(service?.id) || !text(service?.nodeId) || !text(service?.input) || !text(service?.output))
        errors.push(`${where}: нужны id, nodeId, input и output.`)
      if (!text(service?.access)) errors.push(`${where}: нужен access для прямого вызова.`)
      if (!text(service?.repeat)) errors.push(`${where}: нужен repeat для повтора и идемпотентности.`)
      if (!Array.isArray(service?.errors) || !service.errors.length || !service.errors.every(text))
        errors.push(`${where}: нужны errors с существенными отказами.`)
      const node = byId.get(service?.nodeId)
      if (node?.kind !== 'external' || node.serviceRef !== service.id)
        errors.push(`${where}: узел карты должен быть external и ссылаться на serviceRef: ${service?.id}.`)
    }
    for (const node of referenced) if (!entries.some(service => service?.id === node.serviceRef && service.nodeId === node.id))
      errors.push(`Узел ${node.id}: serviceRef ${node.serviceRef} не описан в services.yaml.`)
  }
  return { errors }
}
