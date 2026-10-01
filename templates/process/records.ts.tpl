// Реестр тестов процесса. Ведёт агент; отчёты исключают эти записи.

// Ограничение отправок и тестовые контакты: .workspace.json → config.mailings.

/** Тестовые записи: имя таблицы → id строк. */
export const TEST_RECORDS: Record<string, string[]> = {}
