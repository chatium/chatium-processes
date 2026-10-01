# Реестр событий: `<process>/specs/events.yaml`

Событие — сигнал «с клиентом что-то произошло»: заявка, запись, заказ,
оплата. Его пишет код процесса, а слушают автоматизации и аналитика. Реестр
нужен рантайму: поля `event.*` автоматизация берёт из `payloadMapping`
объявления события.

Как и когда писать события вообще — `chatium-development`,
`references/automations/events.md`. Здесь — как это устроено в процессе.

## Два типа

| Тип | Чем пишется | URL для `eventUrls` | Когда |
| --- | --- | --- | --- |
| `customerEvent` | `captureCustomerEvent` из `@crm/sdk` | `event://crm/customer/event/<process>/<key>` | Действие конкретного клиента: заявка, запись, заказ, оплата. Создаёт или обновляет карточку клиента в CRM |
| `workspaceEvent` | `writeWorkspaceEvent` из `@start/sdk` | `event://account/<process>/<key>` | Событие без клиента (служебное) или браузерное (клик, скролл) — его можно писать прямо во Vue |

В процессе почти все события — `customerEvent`. Путь `<process>` в URL
подставляется сам: SDK берёт ближайший воркспейс процесса — модуля, из
которого идёт вызов. Поэтому из сниппета `chatium exec` событие процесса не
пишут: зови функцию процесса (например, `tests/smoke.ts`).


## Пример

`<…>` — заглушки: подставь своё.

```yaml
events:
  - key: <key>
    type: customerEvent
    name: <Что произошло, для человека>
    description: <Кто и где это сделал>
    category: conversion
    payloadMapping:
      recordId:
        title: ID записи
        fieldName: action_param1
        type: string
      email:
        title: Email
        fieldName: action_param2
        type: string
      name:
        title: Имя
        fieldName: action_param3
        type: string
```

| Поле | Что это |
| --- | --- |
| `key` | Ключ события латиницей, `snake_case`, что случилось: `request_created`, `order_paid`; уникален в процессе |
| `type` | `customerEvent` или `workspaceEvent` |
| `name`, `description` | Для человека, оба обязательны |
| `category` | `traffic`, `engagement`, `conversion`, `revenue`, `retention`, `content`, `forms` или `other` |
| `payloadMapping.<поле>` | Плоское имя, по которому автоматизация берёт значение: `$ref: event.<поле>` |
| `title` поля | Для человека, обязателен |
| `fieldName` поля | Слот метрики, откуда брать значение (см. ниже), обязателен |
| `type` поля | `string`, `number`, `boolean`, `date`, `object`, `array` или `any`, обязателен |
| `fieldExpr` поля | По желанию: выражение над сырым событием `event`, например `event.action_param1_mapstrstr.city`; если есть, важнее `fieldName` |

## Запись события в коде

Событие пишется **после** успешного бизнес-действия.

```ts
import { captureCustomerEvent } from '@crm/sdk'

const captured = await captureCustomerEvent(ctx, {
  event: '<key>',
  name: '<Что произошло>',
  contacts: [{ type: 'email', value: row.email }],
  customer: {
    displayName: row.name,
    utm: { source: utmSource, medium: undefined, campaign: undefined, content: undefined, term: undefined },
  },
  linkRecords: [row],
  metricEventData: {
    action_param1: row.id,
    action_param2: row.email,
    action_param3: row.name,
  },
})
if (!captured.success) ctx.account.log('CRM не приняла событие', { level: 'warn', json: captured })
```

- Ключ — строкой прямо в вызове (`event: '...'` или второй аргумент
  `writeWorkspaceEvent`): так его находит `check`.
- Тип в реестре совпадает с функцией записи, иначе у события другой URL и
  автоматизация его не услышит.
- Контакты клиента: у `captureCustomerEvent` — `contacts`, у
  `writeWorkspaceEvent` — `customer_contacts`. Автоматизация получит их в
  `context.customerContacts`, общее действие Mailings отправит по ним. Не передавай
  `customer_contacts` в `metricEventData`.

## Слоты метрики

Событие — это запись метрики с фиксированными колонками. Другие ключи в
данных события не сохранятся. `fieldName` — строго один из слотов:

- строки: `action_param1`, `action_param2`, `action_param3`;
- целые: `action_param1_int`, `action_param2_int`, `action_param3_int`;
- дробные: `action_param1_float` … `action_param8_float`;
- массивы: `action_param1_arrstr` … `action_param3_arrstr`,
  `action_param1_uint32arr`;
- словари: `action_param1_mapstrstr`, `action_param2_mapstrstr`,
  `action_params`;
- контакты и метки: `customer_contacts`, `uid`, `utm_source`, `utm_medium`,
  `utm_campaign`, `utm_content`, `utm_term`.

Один скалярный слот — одно поле события. Не пиши два поля в
`action_param1`. Словарь можно разобрать на несколько полей через
`fieldExpr` (`event.action_param1_mapstrstr.city`) — тогда `fieldName`
указывает на сам словарь.
