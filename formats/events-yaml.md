# Реестр событий: `<process>/specs/events.yaml`

Событие — сигнал «с клиентом что-то произошло»: заявка, запись, заказ,
оплата. Его пишет код процесса, а слушают автоматизации и аналитика. Реестр
нужен рантайму: поля `event.*` автоматизация берёт из `payloadMapping`
объявления события.

Контракт SDK и актуальные URL сверяй с `chatium-development`,
`references/automations/events.md`; здесь — правила проектирования событий
процесса.

## Спроектируй события до сборки

Пройди путь клиента от первого действия до результата, отказа и повторного
входа. Для каждой формы, заявки, заказа, брони, оплаты/смены её статуса,
регистрации, подписки, записи на встречу и получения материала реши, какое
бизнес-событие фиксирует переход. Событие нужно и тогда, когда его пока не
слушает автоматизация, но оно необходимо CRM или отчёту. Не создавай событие
только ради наличия узла на карте.

Обычные просмотры страниц уже учитываются платформенной аналитикой. Не
дублируй платформенную телеметрию отправки/открытия писем, состояние
транспорта Sender, диагностику повторов и технические «срок ожидания вышел»
как бизнес-события. Задержку и проверку условия держи внутри автоматизации.
Повтор того же действия обычно остаётся тем же событием с контекстом повтора;
отдельный ключ нужен, если это самостоятельный бизнес-факт. Внешнее действие
считай произошедшим только при наличии достоверного источника (callback/API).

Для каждого события до написания кода определи: кто его пишет и когда, кто
его потребляет, какие **строковые ID** нужны автоматизациям, какие небольшие
поля нужны отчётам для фильтрации/группировки и откуда берутся известные
контакты. Автоматизация по ID может прочитать запись; не копируй в метрику
всю запись Heap. ClickHouse не соединяет событие с Heap-таблицей для отчёта,
поэтому нужные срезы (статус, категория, тариф, сумма) передавай прямо в
метрических слотах. Не добавляй поля «на всякий случай».

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
      serviceType:
        title: Вид услуги
        fieldName: action_param2
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
    action_param2: row.serviceType,
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
  `context.customerContacts`; действие сообщения может использовать их или
  получить получателя по бизнес-сущности из события. Контакты есть не во
  всех событиях: для каждого сообщения явно определи источник получателя.
  Передавай все действительно известные контакты, не выдумывай отсутствующие.
  CRM сама формирует `customer_contacts` при `captureCustomerEvent` — не
  передавай его в `metricEventData` и не описывай в `payloadMapping`.
- Email, телефон, адрес мессенджера и другие контакты не дублируй в
  `action_param*` ради получения адресата: используй контактный контекст
  события. Имя клиента передавай как `customer.displayName`, если оно известно.
  Для иной обработки данных клиента сначала установи конкретную цель и
  разрешённую область доступа; ревью должно проверить такую необходимость.

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
- атрибуция: `uid`, `utm_source`, `utm_medium`, `utm_campaign`,
  `utm_content`, `utm_term`. Известные UTM передавай в выделенные поля,
  а не в `action_param*`; `uid` всегда строка.

ID записи/заказа/клиента — строка в `action_param1..3`, не `_int`.
Целые числа и флаги 0/1 — в `_int` с `type: number`; суммы и проценты —
в `_float` с `type: number`. Эти правила одинаковы для объявления
`payloadMapping` и фактических значений `metricEventData`/`writeWorkspaceEvent`.

Один скалярный слот — одно поле события. Не пиши два поля в
`action_param1`. Словарь можно разобрать на несколько полей через
`fieldExpr` (`event.action_param1_mapstrstr.city`) — тогда `fieldName`
указывает на сам словарь.
