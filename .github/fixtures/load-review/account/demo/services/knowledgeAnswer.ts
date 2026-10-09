type Hit = { title: string; excerpt: string }
type KnowledgeSearch = {
  search(ctx: unknown, query: {
    text: string; sectionIds: string[]; limit: number
  }): Promise<Hit[]>
}

const SECTION_IDS = ['support-instructions']

// В вызывающем Staff+ обработчике подтверждаются роль и доступ к разделу.
// Интерфейс поискового адаптера здесь тестовый, не объявлен SDK Chatium.
export async function knowledgeAnswer(ctx: unknown, search: KnowledgeSearch, question: string) {
  const hits = await search.search(ctx, {
    text: question.slice(0, 300),
    sectionIds: SECTION_IDS,
    limit: 5,
  })
  const excerpts = hits.slice(0, 5).map(hit => ({
    title: hit.title.slice(0, 100),
    excerpt: hit.excerpt.slice(0, 700),
  }))
  return excerpts.length ? excerpts : [{ title: 'Нет ответа', excerpt: 'Уточните у ответственного сотрудника.' }]
}
