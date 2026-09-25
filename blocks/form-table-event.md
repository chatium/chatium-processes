# Кубик: форма → таблица → событие

**Для бизнеса.** Клиент оставляет заявку — она сохраняется, в CRM
появляется карточка клиента, и процесс реагирует: шлёт письмо, запускает
прогрев.

**Когда брать.** Любая заявка, регистрация, анкета, заказ. Одна форма —
одна таблица — одно событие «создано».

Платформенный поток формы — `chatium-development`, `references/forms.md`;
таблицы — `heap.md`; роуты — `routing.md`. Здесь — как это собрать внутри
процесса.

## Контракт

> **Сейчас в аккаунтах Source Git `captureCustomerEvent` падает** на
> внутреннем `getCustomerEventUrl` с ошибкой «Source build runtime index not
> found» (замечено 2026-09-25). Пока платформа не починит, пиши события
> процесса через `writeWorkspaceEvent` с `customer_contacts`
> (`type: workspaceEvent`) — автоматизации и письма работают так же, нет
> только карточки клиента в CRM.

1. **Таблица** `<process>/tables/<entity>.table.ts`. Имя уникальное:
   `t_<process>_<entity>_<4 символа>`, например
   `t_webinar_demo_registrations_K7q2`. Таблица живая сразу после push
   ветки.
2. **Серверная функция создания** в `<process>/api/<action>.ts`: пишет
   запись и событие. Её же вызывает smoke через `chatium exec`, поэтому она
   отдельно от роута:

   ```ts
   import { captureCustomerEvent } from '@crm/sdk'
   import Registrations from '../tables/registrations.table'

   export async function createRegistration(ctx: app.Ctx, input: { name: string; email: string }) {
     const row = await Registrations.create(ctx, { name: input.name, email: input.email })
     const captured = await captureCustomerEvent(ctx, {
       event: 'registration_created',
       name: 'Заявка на вебинар',
       contacts: [{ type: 'email', value: row.email }],
       customer: { displayName: row.name, utm: { source: undefined, medium: undefined, campaign: undefined, content: undefined, term: undefined } },
       linkRecords: [row],
       metricEventData: { action_param1: row.id, action_param2: row.email, action_param3: row.name },
     })
     if (!captured.success) ctx.account.log('CRM не приняла событие', { level: 'warn', json: captured })
     return row
   }
   ```

3. **POST-роут** в том же файле: схема тела, проверка, вызов функции.
4. **Событие** объявлено в `<process>/specs/events.yaml` с `type:
   customerEvent` и `payloadMapping` на те же слоты —
   [формат](../formats/events-yaml.md).
5. **Форма** — Vue-компонент страницы, вызывает `registerRoute.run(ctx, body)`.

## Связи

- Событие слушает автоматизация: `eventUrls:
  ["event://crm/customer/event/<process>/<key>"]`.
- В карте: узел `page` (где форма), узел `table`, стрелка от страницы
  дальше с `signal: event:<key>`.

## Как проверить

- `check`: ключ события объявлен, тип совпадает с функцией записи, у
  события есть слушатель, `fieldName` — допустимый слот.
- Smoke через `chatium exec` (после коммита и сборки ветки): вызвать
  функцию создания, убедиться, что запись есть, а событие видно в
  `getAccountEvents`. Id записи — в
  [реестр тестов](../formats/test-records.md).

## Грабли

- Событие пишется только после успешной записи в таблицу. Ошибка CRM не
  должна ронять форму — логируй её.
- Ключ события — строкой прямо в вызове: иначе `check` его не найдёт.
- Поля вне слотов метрики не сохраняются.
- Смена имени таблицы — это новая пустая таблица.
