# Рабочие задачи, задания и профильное ревью

Для новых процессов `scaffold` создаёт `<process>/tasks/index.json`. Это
маркер формата рабочих карточек. Старые процессы переходят на него только
после явной миграции `PLAN.md` и карты; отсутствие маркера не означает,
что прежняя работа завершена.

## Составь мини-планы

В `PLAN.md` запиши все результаты текущего объёма как T-задачи. Под каждой —
проверяемые критерии `T1.A1 [build] …`, `T1.A2 [test] …` и т. д. Рубежи:
`design`, `build`, `test`, `launch`. Каждому критерию нужна хотя бы одна
рабочая карточка `tasks/W001.json`; отдельный результат, исполнитель или
зависимость — отдельная карточка. Шаги внутри карточки короткие. Статус
`[x]` плана ставь после приёмки связанных карточек. Новую существенную
работу сначала добавь в план и карточки.

Карточка содержит `executor.kind: main|specialist`, `mode`, `stage`, цель,
границы, `dependsOn`, `inputs`, `expectedOutputs`, `steps`, непустой
`acceptanceCriteria` и состояние. В `inputs` укажи нужные знания,
`spec.yaml`, `build.md`, референсы и контракты с `kind`, `path`, `purpose`.
Для страницы/серии исходные `spec.yaml`, знания, тексты, assets и выбранные
референсы дополнительно берутся из заголовка `build.md`. Полный формат и пример — в
[описании карточки](../formats/work-task.md).

```sh
node .agents/skills/processes/scripts/tasks.mjs create <process> W001 --file /path/task.json
node .agents/skills/processes/scripts/tasks.mjs status <process> --stage build
node .agents/skills/processes/scripts/tasks.mjs context <process> W001
```

`create` добавляет ссылку в `PLAN.md`. Создавай карточки до большой сборки,
чтобы `check` видел покрытие всех требований, а `context` — следующий шаг.
Перед работой открой выбранную карточку и её материалы. Задачи с
неразрешёнными зависимостями ждут, но остаются видны.

## Выполни и прими

```sh
node .agents/skills/processes/scripts/tasks.mjs start <process> W001
node .agents/skills/processes/scripts/tasks.mjs verify-base <process> W001
node .agents/skills/processes/scripts/tasks.mjs step <process> W001 --step P1 --status done
node .agents/skills/processes/scripts/tasks.mjs record <process> W001 --file /path/result.json
node .agents/skills/processes/scripts/tasks.mjs accept <process> W001
```

`record` связывает результат с текущей попыткой; `accept` требует все
критерии с актуальными подтверждениями. В результате `outputs` — пути файлов,
`criteriaResults` — по одному `pass/fail` на каждый критерий, с evidence
`{path,locator,observation}`. Для `test` evidence указывает на JSON-отчёт
`{version: 1, method: "как запускали", inputDigest: "хеш входов попытки", testedFiles: [{path,sha256}], checks: [{id,status: "pass"}]}`.
В `testedFiles` перечисли все `expectedOutputs` с хешами проверенной версии.
Для `review` evidence указывает на положительный отчёт
независимого субагента. Скрипт сам вычисляет хеши. Произвольная фраза
«проверено» не закрывает критерий. Подтверждение сохраняй в Git, например
`<process>/reviews/tasks/W001/tests.json`. Общий `check` запускай после
приёмки карточек: нельзя сделать его зелёный итог критерием отдельной задачи.

Если существующий файл одновременно вход и результат карточки, перед
применением правки запусти `verify-base`: он сравнит файл с версией на
старте попытки. После чужой правки начни новую попытку. Это обязательный
предохранитель агента; без платформенного хука он не исключает гонку между
проверкой и самой записью.

Если нужен факт от владельца, `ask` записывает вопросы из JSON-файла,
основной агент проверяет материалы, объединяет повторения и задаёт короткий
вопрос. Ответ сначала вносится в базу знаний, затем привязывается к вопросу:

```sh
node .agents/skills/processes/scripts/tasks.mjs ask <process> W001 --file /path/questions.json
node .agents/skills/processes/scripts/tasks.mjs resolve <process> W001 --question Q1 --file /path/answer.json
node .agents/skills/processes/scripts/tasks.mjs start <process> W001
```

Файл ответа: `{ "summary": "…", "sourceRefs": [".knowledge-base/…/article.md"] }`.
Повторный `start` создаёт новую попытку с актуальными входами. Старый ответ
не может затереть её результат. Незавершённые задачи и вопросы видны в
`context`; при закрытии этапа они дают красный `check`.

## Поручи специалисту

Для карточки `executor.kind: specialist` после `start` подготовь пакет:

```sh
node .agents/skills/processes/scripts/tasks.mjs prepare <process> W001
```

Прочитай `prompt.md`, передай его DSH `subagent` с `continuable: true` и
`run_in_background: true`. После получения ID вызови `tasks.mjs bind
<process> W001 --agent-id <id>`. `send_message` продолжает сохранённого
специалиста. Подтверждение доставки не считается ответом; дождись
содержательного результата, сохрани сырой ответ вне репозитория и укажи
его абсолютный путь как `responseRef` при `record`. Без связанного ID вызова
и сохранённого ответа приёмка специалиста блокируется.
После ответа владельца снова выполни `start` и `prepare`, затем передай
обновлённый пакет тому же ID через `send_message`. Если сессия утрачена,
новый специалист той же роли получает сохранённую карточку и материалы.
Основной агент остаётся ответственным за проверку результата и запись в
канонические файлы. Пакет содержит выбранные материалы, не весь каталог.

## Собери страницу или серию

У page/series-узла карты укажи `creativeRef:
<process>/creative/<node-id>/spec.yaml`. Конфиг содержит тип материала,
аудиторию, цель, источники с ID, конкретные секции/письма, выбранные
механики, дизайн, изображения и критерии. Для страницы используй выбранные
типы/правила из `creative/catalog/landing-types.json`, для серии —
`email-types.json`. Стиль-пак раскрывается полностью. A/B включается по
задаче с гипотезой, ключами вариантов и метрикой. Не придумывай доказательства.

Каталоги типов предлагают идеи, а не обязательный набор блоков. Агент
сам выбирает секции страницы, их названия, порядок и состав, исходя из
содержания и задачи. `sections[].covers` описывает выбранные смысловые
задачи своими словами; не нужно заполнять все позиции каталога.
У писем `blocks[].type` — понятная автору роль фрагмента, а не закрытый
список. Письмо может быть одним абзацем; хук, прехедер и CTA добавляй по
задаче. Продающая серия в целом должна давать путь к покупке, но отдельное
полезное сообщение не обязано содержать кнопку. Проверяющий оценивает
содержание и согласованную задачу, а не совпадение с оглавлением примера.

```sh
node .agents/skills/processes/scripts/creative.mjs validate <process> <node-id>
node .agents/skills/processes/scripts/creative.mjs compile <process> <node-id>
node .agents/skills/processes/scripts/creative.mjs status <process> <node-id>
```

`compile` детерминированно создаёт `build.md` с полной выбранной методикой.
Файл генерируемый: меняй `spec.yaml`, знания, тексты и референсы, затем
пересобирай. Перед сборкой открой актуальный `build.md` и все обязательные
референсы из его заголовка. Привяжи их к карточке реализации. Изменение
источника, asset или используемого референса делает задание устаревшим.

## Проведи независимое ревью

```sh
node .agents/skills/processes/scripts/creative-review.mjs prepare <process> <node-id> --stage spec
node .agents/skills/processes/scripts/creative-review.mjs record <process> <node-id> --stage spec --packet /path/packet.json --report /path/report.json --agent <id>
node .agents/skills/processes/scripts/creative-review.mjs status <process> <node-id> --stage spec
```

На этапе `result` команда такая же с `--stage result`. Ревьюер — отдельный
субагент с чистым контекстом; его пакет лежит вне репозитория. Он отвечает
на все вопросы, подкрепляя положительные ответы цитатами из пакета. Для
визуального ревью подготовь `<process>/reviews/creative/<node-id>-visual.json`:

```json
{
  "captures": [
    { "path": "<process>/reviews/creative/desktop.png", "viewport": "desktop", "codeVersion": "<sha опубликованного кода>" },
    { "path": "<process>/reviews/creative/mobile.png", "viewport": "mobile", "codeVersion": "<sha опубликованного кода>" }
  ]
}
```

Reviewer должен действительно открыть снимки и сверить их с версией кода.
`codeVersion` — полный SHA коммита с реализацией. Скрипт проверяет, что
этот коммит входит в текущую ветку и реализация с тех пор не менялась;
общий `check` затем проверяет опубликованную ветку. Скрипт проверяет пути
и хеши, но не может доказать просмотр моделью.
После изменения задания или результата ревью устаревает. Общий `check`
требует ревью `spec` к сборке и `result` к тестовому прогону.

Проверяй рубеж явно: `check.mjs <process> --task-stage build|test|launch`.
До первого пуша используй `--no-snapshot`; перед сдачей следуй обычной
процедуре сохранения и контрольного чтения карты. Платформенного хука нет:
эти вызовы — обязательная процедура агента.
