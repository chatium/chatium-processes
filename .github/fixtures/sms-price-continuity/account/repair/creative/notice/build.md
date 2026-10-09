<!-- creative-build-v1 {"generated":true,"targetNode":"notice","kind":"series","inputDigest":"05f7988a6d2afba063534fe8fbaa6430ce0e93c902e9840aff39453937abd461","requiredReferences":[".agents/skills/processes/creative/catalog/email-design.md",".agents/skills/processes/creative/catalog/email-quality.md"],"requiredInputs":[{"kind":"knowledge","path":".knowledge-base/processes/repair/overview.md"},{"kind":"spec","path":"repair/creative/notice/spec.yaml"},{"kind":"knowledge","path":"repair/materials/owner-brief.md"}]} -->
# Задание: Одно короткое сообщение после запроса

Цель: Подтвердить получение собственного запроса без обещания записи
Аудитория: Человек, который сам оставил заявку на осмотр

## Подтверждённые источники
- owner: repair/materials/owner-brief.md
- knowledge: .knowledge-base/processes/repair/overview.md

## Обязательные референсы
- .agents/skills/processes/creative/catalog/email-design.md
- .agents/skills/processes/creative/catalog/email-quality.md

## Тип серии: follow_up
Сопровождение после заявки, помощь с решением и снятие барьеров.

## Голос
{
  "addressing": "вы",
  "character": "спокойный и точный мастер",
  "emotionality": "уважительно, без давления",
  "example": "Запрос получен; осмотр стоит 500 ₽; время согласуем в ответе."
}

## Нужные форматы: sms

Создай содержательные представления для выбранных форматов: email — subject/html/plain, messenger — plain, sms — short. Не добавляй другие каналы без задачи и настройки доставки.

## Письма
### received: Подтвердить получение запроса
Файл: .mailings/storage/processes/repair/notice/01-received.message.yaml
Главная идея: Запрос получен; осмотр стоит 500 ₽; время ещё не подтверждено
- confirmation: Запрос на осмотр получен, но время ещё не назначено [owner]
- condition: Первичный осмотр стоит 500 ₽; цена ремонта будет после осмотра [knowledge]
Маркетинговый приём: не выбран
CTA: Ответить на SMS → ответ на это же сообщение

## Ручной запуск
{
  "caller": "Сотрудник мастерской",
  "trigger": "После запроса клиента на осмотр",
  "recipient": "Только контакт собственной заявки",
  "stop": "Отказ клиента или подтверждение времени"
}

## Критерии приёмки
- SMS самостоятельно сообщает подтверждённый факт, цену и следующий шаг
- Старая цена и незавершённая фраза не попадают в итоговый текст

## Вопросы независимому reviewer
- Достаточно ли содержания для задачи и аудитории?
