# Реестр тестов: `<process>/tests/records.ts`

Данные ветки и прода общие: тестовая заявка — это настоящая строка в
таблице, тестовое событие — настоящее событие. Поэтому всё тестовое
записывается в реестр. Реестр уходит в `main` вместе с процессом, а отчёты
и аналитика исключают эти id константой из кода — без запросов в Heap.

## Формат

```ts
// Реестр тестов процесса. Ведёт агент; отчёты исключают эти записи.

/** Тестовые записи: имя таблицы → id строк. */
export const TEST_RECORDS: Record<string, string[]> = {
  't_<process>_<entity>_K7q2': ['<id записи из exec>'],
}
```

## Правила

- Создал тестовую запись, заказ или контакт — сразу допиши id в реестр.
- Ограничение отправок и тестовые контакты задаются в `.workspace.json →
  config.mailings`: `testOnly: true`, `testContacts: [{type, value}]`.
  SDK Mailings проверяет их для ключей `processes/<process>/...`.
  `testOnly: false` ставится только в коммите согласованного запуска.
  Реестр записей сам ничего не блокирует. Подробности —
  [серия сообщений](../blocks/message-series.md).
- Тестовые строки таблиц можно удалить на запуске — с согласия владельца.
  Из событий и логов их не удалить, поэтому они и живут в реестре.

## Полный прогон автоматизаций

Перед боевым включением запусти каждую цепочку на опубликованной безопасной
версии `main`, пока `config.mailings.testOnly: true`. Сверь фактический журнал
и получателя. В `<process>/tests/automation-smoke.json` запиши проверяемые
сведения; `check --task-stage launch` сопоставляет хеш конфига и предшествующий
коммит для каждой автоматизации. Он также читает конфиг и `.workspace.json`
именно из `testedCommit`: там должны быть тот же конфиг и
`config.mailings.testOnly: true`.

```json
{
  "version": 1,
  "runs": [{
    "path": "<process>/automations/welcome/welcome.automationConfig.json",
    "configSha256": "<sha256 содержимого конфига>",
    "branch": "main",
    "testedCommit": "<40-символьный SHA исполненной версии main>",
    "testedAt": "2026-10-07T10:00:00.000Z",
    "testOnly": true,
    "testContact": { "type": "email", "value": "test@example.com" },
    "executionId": "<ID в журнале Automations>",
    "result": "passed"
  }]
}
```

Это запись агента о проведённой проверке, а не защищённое платформой
доказательство. При изменении конфига результат устаревает. Проверка
действий с реальными побочными эффектами требует отдельной изоляции: один
лишь `testOnly` Mailings не защищает, например, платёж или запись в CRM.

## Тестовая доставка сообщений

Перед запуском отправь каждое сообщение и каждый вариант через
`sendMessageFromTemplate` на разрешённые тестовые контакты. Если SDK выбирает
вариант случайно, используй отдельный временный ключ для испытания каждого
варианта либо добейся подтверждённого выбора нужного `variantUsed.filePath`;
не приписывай результат одному варианту по ключу серии. Из `getChannels(ctx)`
запиши действительные `id`, `type`, `active`. Для каждого заявленного ID
проверь `channelResults[].success: true`. Если сообщение обещает файл или
изображение, открой его в каждом указанном канале и запиши ключ в
`openedMediaByChannel`.

`<process>/tests/message-delivery.json`:

```json
{
  "version": 1,
  "channelCatalog": [
    {"id": "email-1", "type": "email", "active": true}
  ],
  "runs": [{
    "path": ".mailings/storage/processes/demo/welcome/01.message.yaml",
    "messageSha256": "<sha256 содержимого файла>",
    "branch": "main",
    "testedCommit": "<40-символьный SHA исполненной версии main>",
    "testedAt": "2026-10-07T10:00:00.000Z",
    "testOnly": true,
    "testContacts": [{"type": "email", "value": "test@example.com"}],
    "executionId": "<ID вызова или исполнения>",
    "variantUsed": {"filePath": ".mailings/storage/processes/demo/welcome/01.message.yaml"},
    "channelResults": [{"channelId": "email-1", "success": true}],
    "openedMediaByChannel": {}
  }]
}
```

`check --task-stage launch` сверяет версии файлов и `testOnly` в исполненном
коммите, активный тип каждого канала, результаты всех заявленных каналов и
обещанные медиа. Эта запись остаётся свидетельством на доверии: без
платформенного подтверждения агент может её подделать. Ревьюер проверяет
исходный журнал доставки и предпросмотр.
