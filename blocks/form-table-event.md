# Компонент: форма → таблица → событие

**Для бизнеса.** Клиент оставляет заявку — она сохраняется, в CRM
появляется карточка клиента, и процесс реагирует: шлёт подтверждение,
ставит напоминания.

**Когда брать.** Любая заявка, регистрация, анкета, заказ. Одна форма —
одна таблица — одно событие «создано».

Платформенный поток формы — `chatium-development`, `references/forms.md`;
таблицы — `heap.md`; роуты — `routing.md`. Здесь — как это собрать внутри
процесса.

## Контракт


1. **Таблица** `<process>/tables/<entity>.table.ts`. Имя уникальное:
   `t_<process>_<entity>_<4 символа>`, например
   `t_trial_class_bookings_K7q2`. Таблица живая сразу после push ветки.
2. **Серверная функция создания** в `<process>/api/<action>.ts`: пишет
   запись и событие. Её же вызывает smoke через `chatium exec`, поэтому она
   отдельно от роута. Пример — запись на пробную тренировку в фитнес-студии:

   ```ts
   import { captureCustomerEvent } from '@crm/sdk'
   import Bookings from '../tables/bookings.table'

   export async function createBooking(ctx: app.Ctx, input: { name: string; email: string; serviceType: string }) {
     const row = await Bookings.create(ctx, { name: input.name, email: input.email, serviceType: input.serviceType })
     const captured = await captureCustomerEvent(ctx, {
       event: 'trial_booked',
       name: 'Запись на пробную тренировку',
       contacts: [{ type: 'email', value: row.email }],
       customer: { displayName: row.name, utm: { source: undefined, medium: undefined, campaign: undefined, content: undefined, term: undefined } },
       linkRecords: [row],
       metricEventData: { action_param1: row.id, action_param2: row.serviceType },
     })
     if (!captured.success) ctx.account.log('CRM не приняла событие', { level: 'warn', json: captured })
     return row
   }
   ```

3. **POST-роут** в том же файле: схема тела, проверка, вызов функции.
4. **Событие** объявлено в `<process>/specs/events.yaml` с `type:
   customerEvent` и `payloadMapping` на те же слоты —
   [формат и правила выбора полей](../formats/events-yaml.md).
5. **Форма** — Vue-компонент страницы, вызывает POST-роут через `.run(ctx, body)`.

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
  должна ронять форму — логируй её.
- Ключ события — строкой прямо в вызове: иначе `check` его не найдёт.
- Поля вне слотов метрики не сохраняются.
- Email и телефон передавай в `contacts`, имя — в `customer.displayName`;
  не копируй их в метрику как запасной способ найти получателя.
- Смена имени таблицы — это новая пустая таблица.
