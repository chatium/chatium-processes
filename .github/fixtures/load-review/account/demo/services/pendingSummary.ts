type Request = { id: string; createdAt: string; status: 'pending' | 'done' }
type Repository = {
  findAll(ctx: unknown, query: {
    where: { status: 'pending' }; limit: number; order: Array<Record<string, 'asc' | 'desc'>>
  }): Promise<Request[]>
  countBy(ctx: unknown, where: { status: 'pending' }): Promise<number>
}

// Вызывающий Staff+ обработчик проверяет роль до обращения к репозиторию.
// Этот чистый помощник сам не является публичным маршрутом.
export async function pendingSummary(ctx: unknown, requests: Repository) {
  const where = { status: 'pending' as const }
  const [total, rows] = await Promise.all([
    requests.countBy(ctx, where),
    requests.findAll(ctx, { where, limit: 50, order: [{ createdAt: 'desc' }, { id: 'asc' }] }),
  ])
  return { total, rows }
}
