# Компонент: автоматизация

**Для бизнеса.** «Когда случилось X — сделай Y»: после заявки
отправить подтверждение, через день напомнить, если не оплатил — дожать. На карте
это стрелка, а не узел.

**Когда брать.** Реакция на событие процесса, цепочка касаний по времени.

Контракт действий и условий — [automations-actions.md](../../chatium-development/automations-actions.md)
и [automations-conditions.md](../../chatium-development/automations-conditions.md);
реестр событий и действий аккаунта — [automations-registry.md](../../chatium-development/automations-registry.md).
Формат конфига — ниже: он сверен с рантаймом автоматизаций.

## Где лежит

- `<process>/automations/<automation>/`:
  - `<automation>.automationConfig.json` — конфиг; рантайм находит его по
    суффиксу имени в любой папке;
  - `actions/*.ts` — действия подготовки данных этой автоматизации (в
    процессе они живут здесь, а не в общей `automationActions/`).
- Общие для процесса действия — в `<process>/actions/`, там же
  `register.ts`: хук `@automations/actions` со списком всех действий.
  Перед запуском `check --task-stage launch` требует регистрации каждого
  локального действия из конфигураций; при сборке отсутствие регистрации
  показывается предупреждением. Перед запуском также передай `--registry FILE`
  со свежим ответом [реестра Automations](../../chatium-development/automations-registry.md)
  целевого аккаунта (`{events, actions, conditions}`):
  локальный импорт хука сам по себе не доказывает публикацию действия.
  Не записывай фиктивное действие в снимок ради зелёной проверки.
- Собирается **выключенной**. Включение — только на запуске, после второго
  «да».

## Конфиг

Пример — напоминания о консультации (процесс `consult-booking`):

```json
{
  "title": "Напоминания о консультации",
  "description": "Подтверждение заявки и напоминание накануне",
  "eventUrls": ["event://crm/customer/event/consult-booking/consultation_requested"],
  "defaultTimezone": "<часовой пояс бизнеса после подтверждения владельцем>",
  "settings": { "continueOnError": true },
  "steps": [
    {
      "type": "action",
      "id": "prepare",
      "actionName": "Данные консультации",
      "actionRoute": {
        "routeType": "function",
        "routeJson": [12345, "consult-booking/automations/reminders/actions/prepare-consultation", "/prepare-consultation"]
      },
      "params": { "requestId": { "$ref": "event.requestId" } }
    },
    { "type": "delay", "id": "wait_1d", "delay": { "type": "delay", "amount": 1, "units": "days" } },
    { "type": "action", "id": "send_reminder", "...": "шаг отправки, см. message-series.md" }
  ]
}
```

| `type` шага | Поля | Что делает |
| --- | --- | --- |
| `action` | `id`, `actionName`, `actionRoute`, `params` | Вызывает функцию; её `result` доступен дальше как `steps.<id>.*` |
| `delay` | `id`, `delay` | Ждёт: `{ type: delay, amount, units: seconds/minutes/hours/days }`, `{ type: exactTime, exactTime: ISO }`, `{ type: waitForTime, weekdays: [monday…], weekdayTime: "10:00" }`, `{ type: dateExpression, dateExpression: "steps.prepare.startsAt" }`. Последнее — JS-выражение, не шаблон `{{ ... }}`. |
| `continueCondition` | `id`, `conditionName`, `conditionRoute`, `params` | Идёт дальше, только если условие выполнено |

Шаг `condition` и поля `thenBranch`/`elseBranch`/`thenSteps`/`elseSteps`
текущий рантайм не поддерживает.
Для разных исходов создавай отдельные автоматизации с собственными условиями
продолжения и событиями; не представляй их одним ветвящимся конфигом.
`check` разбирает синтаксис `dateExpression`, не выполняя его; реальное
значение и дату проверяй в тестовом прогоне.

**Ссылка на функцию** — `routeJson: [<accountId>, "<модуль>", "<путь>"]`:
числовой id аккаунта из `process.yaml`, путь модуля от корня аккаунта без
`.ts`, путь — как в `app.function('/prepare-consultation')`.

**Значения параметров:** строка или число как есть;
`{ "$ref": "event.<поле>" }` — поле из `payloadMapping` события;
`{ "$ref": "steps.<id>.<поле>" }` — поле из `result` шага выше;
`{ "$template": "текст {{ event.<поле> }}" }`; `{ "$static": <json> }`.
Ещё доступны `user.*` и `customerContacts`. **Параметры плоские:** рантайм
не разбирает `$ref` внутри вложенных объектов.

## Действие подготовки

Ничего не отправляет, только возвращает значения в `result`:

```ts
export const prepareConsultationAction = app
  .function('/prepare-consultation')
  .meta({ name: 'prepareConsultation', description: 'Ссылка на встречу и имя специалиста', hrTitle: 'Данные консультации', icon: '🗓️', category: 'data' })
  .body(s => ({
    context: s.unknown().optional(),
    params: s.object({ requestId: s.string().optional().meta({ title: 'ID заявки' }) }),
  }))
  .result(s => ({
    success: s.boolean(),
    result: s.smartUnion([
      s.object({ meetingUrl: s.string().meta({ title: 'Ссылка на встречу' }), expertName: s.string().meta({ title: 'Специалист' }) }),
      s.string().meta({ title: 'Сообщение об ошибке' }),
    ]).optional(),
  }))
  .handle(async ctx => {
    try {
      const config = await getWorkspaceConfig(ctx, 'consult-booking')
      return { success: true, result: { meetingUrl: config.variables?.meeting_url?.value ?? '', expertName: config.variables?.expert_name?.value ?? '' } }
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
- Свои действия зарегистрируй через `app.accountHook('@automations/actions', ...)`,
  например в `<process>/actions/register.ts`. Для общей отправки используй
  действие Mailings, регистрация внутри процесса не нужна.
- Что ещё обычно готовит такой шаг: ссылку на оплату и сумму заказа, адрес
  и время визита, промокод и срок акции.

## Включение

- Включает автоматизацию владелец или ты — только после второго «да» на
  запуске. До этого она лежит выключенной.
- После build и завершения синка `main` получи постоянный ID через
  `getAutomationByPath(ctx, '<путь>.automationConfig.json', 'main')` из
  `@automations/sdk` и используй `automationId` из ответа. Путь нужен для
  поиска; `source-file:<путь>` — файловый ID, его нельзя составлять как ID
  автоматизации. При отсутствии результата проверь завершение синхронизации плагина. Для прежних аккаунтов фактический ID также
  бери из SDK или интерфейса.
- Включение — `enableAutomation(ctx, id)` из `@automations/sdk` в
  `chatium exec`; продолжай только при `{ success: true }`, при отказе покажи
  `reason` и оставь запуск незавершённым. Выключение — `disableAutomation`,
  его ответ тоже проверяй. Журнал выполнений —
  `getAutomationLogs(ctx, { workspacePath: '<process>' })`.
- Автоматические события обрабатывает только `main`. Ветка подходит для
  просмотра конфига и ручного тестового запуска. Build hook запускает синхронизацию без ожидания публикации. После изменения
  URL включённой автоматизации плагин сверяет подписки сам:
  добавляет новые URL и удаляет прежние. Повторное ручное включение не нужно.
  В старом файловом режиме автоматической переподписки нет: после изменения
  URL выключи и включи автоматизацию. Пустой `eventUrls` допустим и очищает
  группу подписок Source Git.
- Выключенная автоматизация не запускает новые события и следующие шаги
  начатых цепочек. Включай только после merge и проверки готовности `main`.
  Менять подписку из preview нельзя. Чтение списка и включение не запускают
  синхронизацию. Для уже переехавшего аккаунта первоначальный импорт можно
  выполнить явно при внедрении, без нового push.
  При копировании конфига удаляй `__legacyEntityId`. Если у двух файлов этот
  ID одинаков, оригинал сохраняет связь при известном старом пути подписки
  или выполнения. Без такой привязки оба файла остаются в конфликте.
  Перенос делай через `git mv`: ID сохраняется при явном Git rename;
  отдельные удаление и добавление создают новую выключенную автоматизацию.
  Алиасы старых ID нужны только для миграции; дальнейшие переносы их не добавляют.
  Новая автоматизация из preview может получить другой ID при появлении в main:
  перед включением снова получи ID main через SDK.
  Удалённый конфиг выключается после проверки через 24 часа. Невалидный конфиг
  не запускает действия; событие отображается ошибкой в истории.
- Для расследования передай `branchName` в `getAutomationLogs`, если нужна
  конкретная ветка. Без этого фильтра SDK возвращает прежний общий охват.
  Старые логи могут иметь `branchName: null`; для них есть
  `includeUnknownBranch: true`.

## Показать в превью

После завершения работы над автоматизацией и по просьбе «покажи» открой
на домене аккаунта `/app/automations/~view?path=<путь-к-конфигу>`.
Например, `path` для примера выше —
`consult-booking/automations/reminders/reminders.automationConfig.json`.
Передавай полный путь от корня аккаунта, включая расширение, через
`URLSearchParams`; префикс `source-file:` из ID здесь не нужен.
Способ открытия и выбор версии — `chatium-development/preview.md`.
Для показа оставляй автоматизацию выключенной до разрешённого запуска.
В финале всей работы открой [карту процесса](../build/preview.md) последней.

## Как проверить

- `check`: конфиг разбирается; `eventUrls` ведут на объявленные события с
  правильным типом; локальные модули из `routeJson` существуют и содержат
  `app.function('<путь>')`; у локальных функций `accountId` совпадает с картой,
  у общих действий плагинов маршрут подтверждается реестром (`--registry FILE`); id шагов
  уникальны; `$ref` корректны; действия зарегистрированы; автоматизация —
  чья-то стрелка `via` в карте.
- Реестр аккаунта через `chatium exec`: `getAccountEvents` из `@start/sdk`
  показывает события процесса, `getAutomationActions` из `@automations/sdk`
  — действия.
- Живая проверка — только с `config.mailings.testOnly: true` и на тестовом контакте:
  данные ветки и прода общие. Перед боевым включением нужен полный прогон
  каждого актуального конфига и запись в [реестре](../formats/test-records.md#полный-прогон-автоматизаций).

## Грабли

- Файлы в рантайме читай через SDK Start: `readWorkspaceFile` и
  `listWorkspaceFiles` видят воркспейс вызывающего модуля, настройки —
  `getWorkspaceConfig`. Прямой `findUgcFile` из кода аккаунта Source Git не
  работает. Письма хранилища — через `readMessageFile` из `@mailings/sdk`;
  отправка — через SDK Mailings внутри действия сообщения. Оно может само
  получить контакты и вычислить переменные; отдельный подготовительный шаг
  не обязателен. Общий экшен подходит для готовых данных (см. серию сообщений).
- Source Git плагин читает из Heap конфиг ветки, применённый по build hook;
  прежние аккаунты используют файловое хранение. Проверяй действия через
  `chatium exec` в ветке, а автоматические события — после merge в `main`
  на тестовом контакте.
- Задержки в тестах автоматически не ускоряются: для smoke ставь минимальные.
- Не ссылайся на шаг ниже по списку: его результата ещё нет.
