# Каталог компонентов

Компонент — типовая часть процесса. Карточка компонента: назначение для бизнеса,
когда брать и когда нет, контракт (файлы, SDK), связи, как проверить,
грабли. `context` печатает карточки тех видов, что есть в карте процесса.

| Компонент | Вид в карте | Карточка | Справка `chatium-development` |
| --- | --- | --- | --- |
| Страница / лендинг | `page` | [page.md](page.md) | `coding.md`, `routing.md` |
| Форма → таблица → событие | `page` + `table` | [form-table-event.md](form-table-event.md) | `references/forms.md`, `references/automations/events.md`, `heap.md` |
| Серия сообщений | `series` | [message-series.md](message-series.md) | `references/sender/messaging.md` |
| Автоматизация | стрелка с `via` | [automation.md](automation.md) | `references/automations/*` |
| Каналы и настройки процесса | — | [channels.md](channels.md) | `references/sender/entities.md` |
| Оплата | `payment` | [payment.md](payment.md) | `references/payments.md` |
| CRM | `crm` | [crm.md](crm.md) | `references/automations/events.md` |
| Самостоятельный помощник | `agent` | [ai-agent.md](ai-agent.md) | `references/ai/agent-config.md`, `references/ai/routing-and-handoff.md`, `references/ai/autonomy.md`, `references/ai/tools.md` |

Общая разработка — роуты, Vue, Heap, auth, jobs, `chatium exec`, SDK
модулей — в скилле `chatium-development`. Карточки её не повторяют: они
говорят, как компонент устроен внутри процесса, и ссылаются на справку.

Правила для всех компонентов:

- в рантайме процесса опирайся на готовые SDK: события клиента —
  `captureCustomerEvent` из `@crm/sdk`, служебные и браузерные события —
  `writeWorkspaceEvent` из `@start/sdk`, конфиг процесса —
  `getWorkspaceConfig` из `@start/sdk`;
- запись файлов через SDK Start не работает: что меняется в рантайме, — в
  Heap;
- каждый компонент процесса — обычная папка внутри `<process>/`, без своего
  `.workspace.json`.
