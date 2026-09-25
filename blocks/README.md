# Каталог кубиков

Кубик — типовая часть процесса. Карточка кубика: назначение для бизнеса,
когда брать и когда нет, контракт (файлы, SDK), связи, как проверить,
грабли. `context` печатает карточки тех видов, что есть в карте процесса.

| Кубик | Вид в карте | Карточка | Справка `chatium-development` | Статус |
| --- | --- | --- | --- | --- |
| Страница / лендинг | `page` | [page.md](page.md) | `coding.md`, `routing.md` | v0 |
| Форма → таблица → событие | `page` + `table` | [form-table-event.md](form-table-event.md) | `references/forms.md`, `references/automations/events.md`, `heap.md` | v0 |
| Серия сообщений | `series` | [message-series.md](message-series.md) | `references/sender/messaging.md` | v0 |
| Автоматизация | стрелка с `via` | [automation.md](automation.md) | `references/automations/*` | v0 |
| Каналы и настройки процесса | — | [channels.md](channels.md) | `references/sender/entities.md` | v0 |
| Оплата | `payment` | [payment.md](payment.md) | `references/payments.md` | черновик |
| CRM | `crm` | [crm.md](crm.md) | `references/automations/events.md` | черновик |

Общая разработка — роуты, Vue, Heap, auth, jobs, `chatium exec`, SDK
модулей — в скилле `chatium-development`. Карточки её не повторяют: они
говорят, как кубик устроен внутри процесса, и ссылаются на справку.

Правила для всех кубиков:

- в рантайме процесса опирайся на готовые SDK: события клиента —
  `captureCustomerEvent` из `@crm/sdk`, служебные и браузерные события —
  `writeWorkspaceEvent` из `@start/sdk`, конфиг процесса —
  `getWorkspaceConfig` из `@start/sdk`;
- запись файлов через SDK Start не работает: что меняется в рантайме, — в
  Heap;
- каждый компонент процесса — обычная папка внутри `<process>/`, без своего
  `.workspace.json`.
