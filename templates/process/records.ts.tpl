// Реестр тестов процесса. Ведёт агент; отчёты исключают эти записи.

/** Пока true — письма уходят только на TEST_CONTACTS. Снимается на запуске. */
export const TEST_ONLY = true

/** Контакты, на которые можно слать до запуска. */
export const TEST_CONTACTS: { type: string; value: string; note?: string }[] = []

/** Тестовые записи: имя таблицы → id строк. */
export const TEST_RECORDS: Record<string, string[]> = {}
