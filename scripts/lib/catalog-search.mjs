// Search the mixed Russian/English catalog without loading whole style packs.
const topics = [
  ['образова', 'обуч', 'учеб', 'школ', 'курс', 'education', 'school', 'learn', 'academic'],
  ['медицин', 'клиник', 'здоров', 'medical', 'clinic', 'health'],
  ['финанс', 'банк', 'finance', 'financial', 'bank'],
  ['путешеств', 'туризм', 'турист', 'travel', 'tourism'],
  ['красот', 'космет', 'beauty', 'cosmetic', 'skincare'],
  ['ресторан', 'кафе', 'кулин', 'гастроном', 'food', 'restaurant', 'cafe'],
  ['технолог', 'софт', 'software', 'technology', 'tech', 'saas'],
  ['архитект', 'интерьер', 'мебел', 'architecture', 'interior', 'furniture'],
  ['магазин', 'торгов', 'ритейл', 'shop', 'store', 'commerce', 'retail'],
  ['спорт', 'фитнес', 'sport', 'fitness'],
  ['детск', 'детей', 'ребен', 'children', 'kids'],
]
const words = value => String(value ?? '').normalize('NFKC').toLocaleLowerCase('ru')
  .replaceAll('ё', 'е').match(/[\p{L}\p{N}]+/gu) || []

export function searchCatalog(entries, query) {
  const terms = [...new Set(words(query).filter(word =>
    !['для', 'и', 'в', 'на', 'с', 'of', 'for', 'and', 'the'].includes(word)))]
  return Object.entries(entries).map(([id, item]) => {
    const haystack = words([id, item.title, item.name, item.summary, item.description,
      item.purpose, item.suitedFor, item.vibe, item.mood, item.palette,
      item.tags, item.keywords].flat().filter(Boolean).join(' '))
    const matches = term => haystack.some(word => word.startsWith(term))
    const score = terms.reduce((sum, term) => {
      if (matches(term)) return sum + 2
      const synonyms = topics.find(group => group.some(root => term.startsWith(root))) || []
      return sum + Number(synonyms.some(matches))
    }, 0)
    return { id, item, score }
  }).filter(entry => !terms.length || entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ id, item }) => ({ id, title: item.title || item.name || item.summary || item.purpose || id }))
}
