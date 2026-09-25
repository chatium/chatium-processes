# Кубик: автоматизация

**Для бизнеса.** «Когда случилось X — сделай Y»: после регистрации
отправить письмо, через день напомнить, если не оплатил — дожать. На карте
это стрелка, а не узел.

**Когда брать.** Реакция на событие процесса, цепочка касаний по времени.

Контракт действий и условий — `chatium-development`,
`references/automations/actions.md` и `conditions.md`; реестр событий и
действий аккаунта — `registry.md`. Формат конфига — ниже: он сверен с
рантаймом автоматизаций.

## Где лежит

- `<process>/automations/<automation>/`:
  - `<automation>.automationConfig.json` — конфиг; рантайм находит его по
    суффиксу имени в любой папке;
  - `actions/*.ts` — действия подготовки данных этой автоматизации (в
    процессе они живут здесь, а не в общей `automationActions/`).
- Общие для процесса действия — в `<process>/actions/`, там же
  `register.ts`: хук `@automations/actions` со списком всех действий.
- Собирается **выключенной**. Включение — только на запуске, после второго
  «да».

## Конфиг

```json
{
  "title": "Прогрев после регистрации",
  "description": "Подтверждение регистрации и напоминание",
  "eventUrls": ["event://crm/customer/event/webinar-demo/registration_created"],
  "defaultTimezone": "Europe/Moscow",
  "settings": { "continueOnError": true },
  "steps": [
    {
      "type": "action",
      "id": "prepare",
      "actionName": "Данные вебинара",
      "actionRoute": {
        "routeType": "function",
        "routeJson": [12345, "webinar-demo/automations/warmup/actions/prepare-webinar", "/prepare-webinar"]
      },
      "params": { "registrationId": { "$ref": "event.registrationId" } }
    },
    { "type": "delay", "id": "wait_1d", "delay": { "type": "delay", "amount": 1, "units": "days" } },
    { "type": "action", "id": "send_reminder", "...": "шаг отправки, см. message-series.md" }
  ]
}
```

| `type` шага | Поля | Что делает |
| --- | --- | --- |
| `action` | `id`, `actionName`, `actionRoute`, `params` | Вызывает функцию; её `result` доступен дальше как `steps.<id>.*` |
| `delay` | `id`, `delay` | Ждёт: `{ type: delay, amount, units: seconds/minutes/hours/days }`, `{ type: exactTime, exactTime: ISO }`, `{ type: waitForTime, weekdays: [monday…], weekdayTime: "10:00" }`, `{ type: dateExpression, dateExpression: "{{ steps.prepare.startsAt }}" }` |
| `continueCondition` | `id`, `conditionName`, `conditionRoute`, `params` | Идёт дальше, только если условие выполнено |
| `condition` | `id`, `conditionName`, `conditionRoute`, `params`, `thenBranch`, `elseBranch` | Ветвление; ветка — `{ steps: [...], afterBranch: continue/stop }` |

**Ссылка на функцию** — `routeJson: [<accountId>, "<модуль>", "<путь>"]`:
числовой id аккаунта из `process.yaml`, путь модуля от корня аккаунта без
`.ts`, путь — как в `app.function('/prepare-webinar')`.

**Значения параметров:** строка или число как есть;
`{ "$ref": "event.<поле>" }` — поле из `payloadMapping` события;
`{ "$ref": "steps.<id>.<поле>" }` — поле из `result` шага выше;
`{ "$template": "текст {{ event.<поле> }}" }`; `{ "$static": <json> }`.
Ещё доступны `user.*` и `customerContacts`. **Параметры плоские:** рантайм
не разбирает `$ref` внутри вложенных объектов.

## Действие подготовки

Ничего не отправляет, только возвращает значения в `result`:

```ts
export const prepareWebinarAction = app
  .function('/prepare-webinar')
  .meta({ name: 'prepareWebinar', description: 'Дата и ссылка эфира', hrTitle: 'Данные вебинара', icon: '🗓️', category: 'data' })
  .body(s => ({
    context: s.unknown().optional(),
    params: s.object({ registrationId: s.string().optional().meta({ title: 'ID заявки' }) }),
  }))
  .result(s => ({
    success: s.boolean(),
    result: s.smartUnion([
      s.object({ webinarDate: s.string().meta({ title: 'Дата эфира' }), webinarUrl: s.string().meta({ title: 'Ссылка' }) }),
      s.string().meta({ title: 'Сообщение об ошибке' }),
    ]).optional(),
  }))
  .handle(async ctx => {
    try {
      const config = await getWorkspaceConfig(ctx, 'webinar-demo')
      return { success: true, result: { webinarDate: config.variables?.webinar_date?.value ?? '', webinarUrl: config.variables?.webinar_url?.value ?? '' } }
    } catch (err) {
      return { success: false, result: String(err) }
    }
  })
```

- `name` — латиница camelCase; у каждого параметра `.meta({ title })`.
- Возвращай `{ success, result }`: при ошибке `result` — текст ошибки.
- Поля, на которые ссылается `steps.<id>.<поле>`, объяви в `.result(...)` —
  `check` сверяет их по коду.
- `getWorkspaceConfig` вызывай с путём процесса: из `chatium exec` ближайший
  воркспейс — корень аккаунта.
- Новое действие добавь в `<process>/actions/register.ts`.

## Как проверить

- `check`: конфиг разбирается; `eventUrls` ведут на объявленные события с
  правильным типом; модули из `routeJson` существуют и содержат
  `app.function('<путь>')`; `accountId` совпадает с картой; id шагов
  уникальны; `$ref` корректны; действия зарегистрированы; автоматизация —
  чья-то стрелка `via` в карте.
- Реестр аккаунта через `chatium exec`: `getAccountEvents` из `@start/sdk`
  показывает события процесса, `getAutomationActions` из `@automations/sdk`
  — действия.
- Живая проверка — только с `TEST_ONLY = true` и на тестовом контакте:
  данные ветки и прода общие.

## Грабли

- Конфиги автоматизаций рантайм читает из опубликованных файлов (`cgs`), в
  превью ветки — из `db`. Автоматизация, собранная в ветке, работает только
  после merge в `main`: проверяй действия через `chatium exec` до merge.
- Задержки в тестах пока не ускоряются: для smoke ставь минимальные.
- Не ссылайся на шаг ниже по списку: его результата ещё нет.
