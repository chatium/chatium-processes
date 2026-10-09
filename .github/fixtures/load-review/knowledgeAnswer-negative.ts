type Document = { title: string; body: string }
type KnowledgeRepository = {
  listAll(ctx: unknown, offset: number, limit: number): Promise<Document[]>
}

// Плохой вариант: перечитывает всю базу и повторяет это на каждом ходе.
export async function knowledgeAnswer(ctx: unknown, kb: KnowledgeRepository, question: string) {
  const all: Document[] = []
  for (let offset = 0; ; offset += 1000) {
    const page = await kb.listAll(ctx, offset, 1000)
    all.push(...page)
    if (page.length < 1000) break
  }
  return `${question}\n${all.map(doc => `${doc.title}: ${doc.body}`).join('\n')}`
}
