# Компонент: форма → таблица → событие

**Для бизнеса.** Клиент оставляет заявку — она сохраняется, в CRM
появляется карточка клиента, и процесс реагирует: шлёт подтверждение,
ставит напоминания.

**Когда брать.** Любая заявка, регистрация, анкета, заказ. Одна форма —
одна таблица — одно событие «создано».

Платформенный поток формы — [forms.md](../../chatium-development/forms.md);
таблицы — `heap.md`; роуты — `routing.md`. Здесь — как это собрать внутри
процесса.

## Контракт


1. **Таблица** `<process>/tables/<entity>.table.ts`. Имя уникальное:
   `t_<process>_<entity>_<4 символа>`, например
   `t_trial_class_bookings_K7q2`. Таблица живая сразу после push ветки.
   В `<process>/specs/data.yaml` опиши каждый табличный узел карты: `id`,
   тот же `source`, назначение `purpose`, ответственного `owner`, роли чтения
   `readers`, идентичность записи `identity: {key, rule}` и `fields` с
   `name`, `type`, `purpose`. Общее `retention: {decided, current, open}`
   фиксирует согласованное правило хранения и удаления. Незакрытый срок
   допустим при проектировании, но перед запуском `decided` должен быть `true`.
   Пример минимальной записи:

   ```yaml
   version: 1
   tables:
     - id: requests
       source: <process>/tables/requests.table.ts
       purpose: Заявки на консультацию
       owner: Менеджер по заявкам
       readers: [Менеджер по заявкам, Администратор]
       identity: { key: requestId, rule: Повтор по ID не создаёт вторую заявку }
       fields:
         - { name: requestId, type: string, purpose: Устойчивый номер заявки }
   retention:
     decided: true
     current: Храним по согласованной политике; удаляем по запросу владельца данных
   ```
2. **Серверная функция создания** в `<process>/api/<action>.ts`: пишет
   запись и событие. Её же вызывает smoke через `chatium exec`, поэтому она
   отдельно от роута. Пример — запись на пробную тренировку в фитнес-студии:

   ```ts
   import { captureCustomerEvent } from '@crm/sdk'
   import Bookings from '../tables/bookings.table'

   export async function createBooking(ctx: app.Ctx, input: {
     name: string; email: string; serviceType: string;
     utm?: { source?: string; medium?: string; campaign?: string; content?: string; term?: string }
   }) {
     const row = await Bookings.create(ctx, { name: input.name, email: input.email, serviceType: input.serviceType })
     let eventAccepted = false
     try {
       const captured = await captureCustomerEvent(ctx, {
         event: 'trial_booked',
         name: 'Запись на пробную тренировку',
         contacts: [{ type: 'email', value: row.email }],
         customer: { displayName: row.name, ...(input.utm ? { utm: input.utm } : {}) },
         linkRecords: [row],
         metricEventData: {
           action_param1: row.id, action_param2: row.serviceType,
           ...(input.utm?.source ? { utm_source: input.utm.source } : {}),
           ...(input.utm?.medium ? { utm_medium: input.utm.medium } : {}),
           ...(input.utm?.campaign ? { utm_campaign: input.utm.campaign } : {}),
           ...(input.utm?.content ? { utm_content: input.utm.content } : {}),
           ...(input.utm?.term ? { utm_term: input.utm.term } : {}),
         },
       })
       eventAccepted = captured.success
       if (!captured.success) ctx.account.log('CRM не приняла событие', {
         level: 'warn', json: { bookingId: row.id, errorCode: captured.errorCode },
       })
     } catch (error) {
       ctx.account.log('Подтверждение события CRM не получено', {
         level: 'warn', json: { bookingId: row.id, errorType: error instanceof Error ? error.name : 'unknown' },
       })
     }
     return { row, eventAccepted }
   }
   ```

   Передай `eventAccepted` из функции в ответ POST-роута. Если он `false`,
   запись уже сохранена, но запуск письма или автоматизации не подтверждён:
   интерфейс сообщает об этом отдельно и не пишет «письмо отправлено».
   В журнале остаётся ID записи для разбора; порядок безопасного повтора
   события определи до запуска, чтобы повтор формы не создавал дубли.
   Даже `eventAccepted: true` означает принятие события CRM, а не
   подтверждённую доставку сообщения.
3. **POST-роут** в том же файле: схема тела, проверка, вызов функции.
4. **Событие** объявлено в `<process>/specs/events.yaml` с `type:
   customerEvent` и `payloadMapping` на те же слоты —
   [формат и правила выбора полей](../formats/events-yaml.md).
5. **Форма** — Vue-компонент страницы, вызывает POST-роут через `.run(ctx, body)`.
   При входе со страницы возьми фактические UTM из URL, проверь длину и
   допустимые значения, передай их в запрос вместе с данными формы. На
   сервере повтори проверку длины и допустимых значений; известные UTM
   передай и в выделенные поля `metricEventData`, если по ним нужен отчёт.
   Не подставляй `undefined` вместо известных UTM и не доверяй
   присланным контактам как доказательству личности клиента.
   Знание email не даёт права менять согласие или источник существующей
   заявки и получать её внутренний ID/состояние. Отдельно ограничь частоту
   публичных запросов и стоимость создания строк и событий.
   Если согласие и ссылка на политику ещё не согласованы, отключи отправку
   формы даже в превью опубликованной ветки; пустой `policyUrl` при активной
   форме недопустим.
6. **Уведомление сотруднику**, если по заявке кто-то должен действовать:
   после сохранения записи вызови `sendNotification` из `@store/sdk`
   по [справке Store Inbox](../../chatium-development/store-notifications.md).
   Укажи ответственного Staff+ и стабильный ID уведомления на основе ID
   заявки; обычным клиентам этот механизм недоступен. Неизвестен
   ответственный — выясни это до запуска. Ошибка уведомления не должна
   приводить к повторному созданию заявки.

**Та же связка в других процессах:**

- магазин: таблица `orders` → событие `order_created`, в событии номер и
  сумма заказа;
- консультация: `requests` → `consultation_requested`, в событии тема
  обращения;
- анкета: `surveys` → `survey_submitted`, ответы — словарём
  `action_param1_mapstrstr`, разобранным через `fieldExpr`.

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
  должна терять сохранённую заявку или превращаться в ложное подтверждение
  отправки: верни отдельное состояние, запиши ID для диагностики и проверь
  повтор без дубля.
- Ключ события — строкой прямо в вызове: иначе `check` его не найдёт.
- Поля вне слотов метрики не сохраняются.
- Email и телефон передавай в `contacts`, имя — в `customer.displayName`;
  не копируй их в метрику как запасной способ найти получателя.
- Смена имени таблицы — это новая пустая таблица.

## Правка существующей таблицы

Перед изменением `.table.ts` с реальными строками прочитай действующую схему
и проверь наличие строк на **целевом аккаунте** через Heap/Chatium SDK по
установленным typings. Сравни старую и новую схему: добавление и метаданные,
удаление поля/варианта enum, смена вида поля/ссылки/элемента массива — разные
риски. Заполненную таблицу не пересоздавай под новым физическим именем.

`check` сравнивает версии исходника таблицы в Git. Для изменённой таблицы
создай `<process>/tables/schema-decisions.json` с проверкой строк и решением:

```json
{
  "version": 1,
  "changes": [{
    "path": "<process>/tables/orders.table.ts",
    "previousSha256": "<sha256 старого исходника>",
    "currentSha256": "<sha256 нового исходника>",
    "occupancy": "populated",
    "rowsCheckedAt": "2026-10-07T10:00:00.000Z",
    "rowCheckReference": "<ID проверки строк в целевом аккаунте>",
    "changeClass": "migration",
    "reason": "Меняется тип amount на заполненной таблице",
    "ownerResponse": "<дословное решение владельца>",
    "ownerMessageReference": "<ссылка на ответ>",
    "migrationPlan": "<шаги переноса, сверки и отката>",
    "migrationResultReference": "<результат прогона миграции>",
    "persistedSchemaReference": "<повторное чтение сохранённой схемы после push>"
  }]
}
```

`occupancy`: `empty`, `populated`, `unknown`; неизвестное считай
потенциально заполненным. `changeClass`: `additive-or-metadata`,
`confirmation` или `migration`. Для заполненной таблицы `confirmation` и
`migration` требуют решения владельца; `migration` — отдельного плана и к
запуску результата переноса. Перед запуском перечитай сохранённую схему.
Статический контроль видит изменение файла и полноту записи, но не может
сам подтвердить число строк или правильность классификации: это проверяет
архитектурный и финальный ревьюер по фактическим данным.
