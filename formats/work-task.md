# Карточка `<process>/tasks/W001.json`

Это мини-план основного агента или специалиста. Для работы ориентируйся на
поля ниже, [JSON-схему](../tasks/schema.json) и проверку `tasks.mjs`.
`PLAN.md` содержит T-задачи и критерии уровня процесса,
карточка — действия и критерии конкретной работы.

`executor.kind: main` владеет каноническими файлами: в `produce` сводит
предложения в `spec.yaml`, в `implement` пишет код и проводит проверки.
`specialist` работает в `consult`, `produce`, `review` или `verify`;
`implement` для него запрещён. Его ожидаемые выходы — предложения/отчёты
`.md` или `.json` в `proposals/` или `reviews/`; основной агент сохраняет
их после проверки ответа субагента. Для страницы сначала создай задачу
`landing` на предложение,
для серии — `email`; при необходимости добавь маркетолога и копирайтера.
Задача основного агента на `spec.yaml` зависит от принятых предложений,
задача реализации — от готового задания и независимого ревью спецификации.
См. [границы ролей](../build/tasks-and-creative.md#кто-выполняет-работу).

Пример `W001` ниже — **реализация**. Он предполагает принятые `W003`
(`landing/produce`, предложение) и `W002` (`main/produce`, `spec.yaml`),
а также положительное независимое ревью спецификации. `W002` зависит от
`W003`, `W001` — от `W002`.

```json
{
  "version": 1,
  "id": "W001",
  "planTask": "T1",
  "title": "Собрать страницу заявки",
  "targetNode": "signup-page",
  "executor": { "kind": "main", "role": "developer" },
  "mode": "implement",
  "stage": "build",
  "objective": "Посетитель может оставить заявку",
  "scope": { "includes": ["Форма и обработчик"], "excludes": ["Отправка писем"] },
  "status": "queued",
  "revision": 0,
  "createdAt": "2026-10-02T00:00:00Z",
  "updatedAt": "2026-10-02T00:00:00Z",
  "dependsOn": ["W002"],
  "session": null,
  "inputs": [
    { "kind": "knowledge", "path": ".knowledge-base/processes/example/form.md", "purpose": "Поля заявки" },
    { "kind": "spec", "path": "example/creative/signup-page/spec.yaml", "purpose": "Решения о странице" },
    { "kind": "build", "path": "example/creative/signup-page/build.md", "purpose": "Подробное задание" }
  ],
  "expectedOutputs": [{ "path": "example/pages/signup/index.vue", "purpose": "Страница и её состояния" }],
  "steps": [{ "id": "P1", "action": "Собрать форму", "status": "todo", "reason": null }],
  "acceptanceCriteria": [{
    "id": "C1", "planCriteria": ["T1.A1"],
    "condition": "Корректная заявка создаёт запись и событие",
    "verification": { "kind": "test", "instruction": "Проверить запись и событие" }
  }],
  "questions": [],
  "drafts": [],
  "latestAttempt": null,
  "attempts": [],
  "result": null,
  "acceptance": null,
  "cancellation": null
}
```

`inputs` должны существовать перед `start`. Исключение: будущий файл от
явной задачи в `dependsOn`. Для страницы/серии обязательные референсы
`build.md` добавляются к входам автоматически при подготовке пакета.
Смена входов после приёмки делает карточку устаревшей. Прямое изменение
`status` не заменяет `tasks.mjs accept`.
