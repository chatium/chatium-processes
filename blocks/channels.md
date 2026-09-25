# Кубик: каналы и настройки процесса

**Для бизнеса.** Через что процесс говорит с клиентом (email, Telegram) и
какие значения владелец может поменять без разработчика: дата эфира, цена,
ссылки.

## Контракт

`<process>/.workspace.json`:

```json
{
  "type": "process",
  "config": {
    "senderChannels": [],
    "variables": {
      "webinar_date": { "value": "1 октября, 19:00 МСК", "description": "Дата и время эфира" },
      "webinar_url": { "value": "https://example.com/room", "description": "Ссылка на комнату эфира" }
    }
  }
}
```

- `senderChannels` — id каналов Sender, через которые шлёт процесс. Пусто —
  Sender выбирает каналы сам. Каналы подключает владелец в Sender
  (`/app/sender/v2#/settings/channel/add`) — это пункт «нужно от вас».
  Список подключённых — `getChannels(ctx)` из `@sender/sdk` через
  `chatium exec` (`chatium-development`, `references/sender/entities.md`).
- `variables` — значения процесса. В коде:
  `(await getWorkspaceConfig(ctx)).variables?.<key>?.value`. Функция берёт
  конфиг ближайшего воркспейса, то есть процесса.
- Меняет этот файл только агент. Если значение должен менять владелец в
  интерфейсе, храни его в Heap-таблице процесса.

## Как проверить

- `check`: `.workspace.json` разбирается, `type: process`; каждая
  переменная процесса, на которую ссылается код через `variables.<key>`,
  объявлена.
- Каналы: `getChannels(ctx)` в `chatium exec` — нужный канал активен.

## Грабли

- Дочерний `.workspace.json` внутри процесса отрежет папку от процесса:
  `getWorkspaceConfig` и события начнут работать от неё.
