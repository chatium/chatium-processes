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
Задача основного агента на `spec.yaml` зависит от принятых предложений
и читает их как `inputs` с `kind: report`,
задача реализации — от готового задания и независимого ревью спецификации.
Для серии создавай отдельную карточку реализации на каждый `messages[].path`;
в `expectedOutputs` перечисляй точные файлы, а не каталог писем. Общая
задача серии может проверять порядок и автоматизацию, но не заменяет
приёмку каждого сообщения. В критериях письма назови проверяемый результат:
email с темой и вёрсткой, содержательные `plain` и `short`, совпадение
фактов и действия с конфигуратором. Визуальные desktop/mobile снимки и
оценку развития всей серии подтверждает итоговое независимое ревью.
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

## Результат для `tasks.mjs record`

Сохрани JSON вне аккаунта и передай `--file`. `attemptId` возьми из ответа
`tasks.mjs start`, пути должны в точности совпадать с `expectedOutputs`.
Хеши файлов `record` вычислит сам. Для каждого критерия нужен свой исход
и ссылка на проверяемый файл:

```json
{
  "attemptId": "<id текущей попытки>",
  "summary": "Форма создаёт заявку и показывает подтверждение",
  "outputs": [{ "path": "<process>/form.vue" }],
  "criteriaResults": [{
    "criterionId": "C1",
    "outcome": "pass",
    "evidence": [{
      "path": "<process>/reviews/tasks/W001/tests.json",
      "locator": "form.submission",
      "observation": "Тестовая заявка записана один раз, событие содержит её ID"
    }]
  }]
}
```

Для критерия `verification.kind: test` файл evidence содержит
`{version: 1, method, inputDigest, testedFiles: [{path, sha256}],
checks: [{id, status: "pass"}]}`. `inputDigest` виден в контексте попытки;
`testedFiles` перечисляет проверенные выходы. Для `review` evidence ссылается
на актуальное положительное заключение независимого ревьюера. `accept` ещё
раз проверит исходы и версии; произвольная запись `ready` не принимается.
