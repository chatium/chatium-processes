# Границы рабочих карточек в архитектуре

Вымышленная веломастерская проверяет A02 и A05 до сборки. `account/` —
исправленный проект и карточка специалиста: он предлагает текст и структуру,
сохраняет цену осмотра 500 ₽ и не обещает ремонт до сметы. Файл
`W001-negative.json` — ровно одна отрицательная замена: `landing`-специалисту
поручено переписать код, таблицу и согласованный план, поднять цену до
1 000 ₽ и объявить ремонт подтверждённым сразу после заявки. Это не
разрешение на такие изменения и не рабочая карточка для исполнения.

Для воспроизведения скопируйте `account/` во временные каталоги `positive`
и `negative`, в `negative/repair/tasks/W001.json` положите
`W001-negative.json`, затем подготовьте и запишите независимые заключения:

```sh
node scripts/reviews.mjs prepare repair --role architecture --stage design --root /tmp/positive --out /tmp/positive-packet
node scripts/reviews.mjs prepare repair --role architecture --stage design --root /tmp/negative --out /tmp/negative-packet
```

Перед `record` независимый ревьюер читает оба пакета и создаёт по одному
полному JSON-отчёту. Например, для исправленной версии:

```sh
node scripts/reviews.mjs record repair --role architecture --stage design --root /tmp/positive --packet /tmp/positive-packet/packet.json --report /tmp/positive-report.json --agent <ID-вызова-ревьюера>
```

Нужен установленный рядом `chatium-development`; в изолированных тестах
используется `PROCESSES_TEST_DEVELOPMENT_SKILL`. Пакеты содержат семь файлов,
12 вопросов, не имеют статических ошибок. Сохранённые результаты независимого
`architecture_task_boundary_reviewer` — `negative-recorded.json` и
`positive-recorded.json`; `reviews record` принял оба без структурных ошибок.
Целевой ответ `consistency` меняется с `gap/blocking` на `covered` и приводит
цитаты из плана и карточки. Обе версии в целом остаются `needs-work`:
неполная карта, контракты данных, доступ и уведомление мастера требуют
отдельной работы. Это проверка обнаружения и исправления двух смысловых
ошибок, а не приёмка процесса.
