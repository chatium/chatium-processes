type Request = { id: string; createdAt: string; status: 'pending' | 'done' }
type Repository = {
  findAll(ctx: unknown, query: { limit: number; offset: number }): Promise<Request[]>
}

// Вызывает экран сотрудника, но функция сама загружает всю таблицу.
export async function pendingSummary(ctx: unknown, requests: Repository) {
  const all: Request[] = []
  let offset = 0
  for (;;) {
    const page = await requests.findAll(ctx, { limit: 1000, offset })
    all.push(...page)
    if (page.length < 1000) break
    offset += 1000
  }
  const rows = all.filter(row => row.status === 'pending')
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return { total: rows.length, rows: rows.slice(0, 50) }
}
