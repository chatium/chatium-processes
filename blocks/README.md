# Каталог компонентов

Компонент — типовая часть процесса. Карточка компонента: назначение для бизнеса,
когда брать и когда нет, контракт (файлы, SDK), связи, как проверить,
грабли. `context` печатает карточки тех видов, что есть в карте процесса.

| Компонент | Вид в карте | Карточка | Справка `chatium-development` |
| --- | --- | --- | --- |
| Страница / лендинг | `page` | [page.md](page.md) | `coding.md`, `routing.md` |
| Многостраничный сайт и сервис | `page` / `external` | [site-service.md](site-service.md) | `routing.md`, `auth.md`, `coding.md` |
| Форма → таблица → событие | `page` + `table` | [form-table-event.md](form-table-event.md) | [forms.md](../../chatium-development/forms.md), [automations-events.md](../../chatium-development/automations-events.md), [heap.md](../../chatium-development/heap.md) |
| Серия сообщений | `series` | [message-series.md](message-series.md) | [sender-messaging.md](../../chatium-development/sender-messaging.md) |
| Автоматизация | стрелка с `via` | [automation.md](automation.md) | [automations-configuration.md](../../chatium-development/automations-configuration.md), [automations-actions.md](../../chatium-development/automations-actions.md) |
| Каналы и настройки процесса | — | [channels.md](channels.md) | [sender-entities.md](../../chatium-development/sender-entities.md) |
| Оплата | `payment` | [payment.md](payment.md) | [payments.md](../../chatium-development/payments.md) |
| CRM | `crm` | [crm.md](crm.md) | [automations-events.md](../../chatium-development/automations-events.md) |
| Самостоятельный помощник | `agent` | [ai-agent.md](ai-agent.md) | [ai-agent-config.md](../../chatium-development/ai-agent-config.md), [ai-routing-and-handoff.md](../../chatium-development/ai-routing-and-handoff.md), [ai-autonomy.md](../../chatium-development/ai-autonomy.md), [ai-tools.md](../../chatium-development/ai-tools.md) |
| Аналитика пути клиента | `specs/analytics.yaml` | [analytics.md](analytics.md) | [analytics-traffic.md](../../chatium-development/analytics-traffic.md), [analytics-attribution.md](../../chatium-development/analytics-attribution.md) |

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
