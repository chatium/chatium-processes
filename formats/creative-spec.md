# Формат задания страницы и серии

Для узла `page` или `series` в `process.yaml` укажи
`creativeRef: <process>/creative/<node-id>/spec.yaml`. `targetNode` совпадает
с ID узла, `kind` — `landing` для страницы и `series` для серии. Источник
должен быть непустым; если задан `section`, заголовок `# …` в этом файле
должен существовать и содержать текст. Затем запусти `creative.mjs validate`
и `compile`. Ошибки валидатора показывают недостающие поля.
Для `creative.mjs validate/status` код выхода `0` означает, что проверка
пройдена, `1` — найдено недостающее или устаревшее содержимое, `2` — команду
не удалось выполнить (например, неверная команда или недоступен файл).

## Страница

```yaml
version: 1
kind: landing
targetNode: signup
landingType: lead_magnet
objective: Получить заявку на консультацию
audience: Новые посетители
sources:
  - id: offer
    path: .knowledge-base/processes/demo/offer.md
    section: Условия консультации
references: []
sections:
  - id: hero
    type: introduction
    purpose: Объяснить пользу консультации
    covers: [результат и следующий шаг]
    points:
      - text: После заявки менеджер предложит время
        sourceRef: offer
    presentation:
      desktop: Заголовок и видимая форма рядом
      mobile: Заголовок, короткое пояснение, форма
    mechanicRefs: []
    acceptance: [С первого экрана понятен следующий шаг]
mechanics: []
design:
  styleId: clean_service
  adaptation: Спокойная цветовая схема соответствует материалам бизнеса
copywriting:
  styleId: educational
  adaptation: Объяснить пользу простыми словами для новых посетителей
images: []
abTesting:
  mode: none
openQuestions: []
acceptance: [Заявка записана, пользователь видит подтверждение]
```

Допустимые `landingType`, `styleId` и типы механик смотри в
`creative/catalog/`. Для `sales` нужен реальный путь к покупке или заявке.
Если выбираешь направление текста, укажи `copywriting.styleId` из
`creative/catalog/copywriting.json` и объясни его адаптацию под аудиторию и
бренд. Это ориентиры для подачи, не шаблоны обещаний и не требование
подражать конкретному автору. Все факты и примеры берутся из источников.
Для `webinar` заполни `event.date`, `timezone`, `format`, `program`,
`presenter`, `registrationOutcome` и механику регистрации. Для
`autowebinar` вместо даты нужен `event.schedule`; запись нельзя выдавать
за прямой эфир. Для `quiz` нужны механика `quiz` и `quiz.resultRule`,
`outcomes`, `nextStep`: вопросы должны менять полезный результат.
Каждая механика требует `id`, `type`, `purpose`, `expectedOutcome`,
`placement` (ID существующей секции) и поля её типа. В этой секции добавь ID
механики в `mechanicRefs`. Задача и ожидаемый результат объясняют, зачем
механика нужна человеку; сам факт наличия кнопки, таймера или формы недостаточен.
Для изображения укажи `id`, `sectionId`, `purpose`, `alt`, готовый `asset`
или `generationBrief`, `aspect`, `mobileCrop`; до сборки нужен готовый asset.
Исходник изображения первого раздела ограничен 1 МиБ. Это лишь предварительный
порог; в итоговом ревью проверь фактически загружаемый файл на телефоне.
В редизайне сохрани исходную страницу/снимок в доступном файле и добавь его
в `sources` с `role: original`. Укажи `redesign.sourceRef` на ID этого
источника, `redesign.preserve` со списком фактов, условий и работающих
действий, `redesign.changes` с согласованными изменениями и
`redesign.verification` со способом сравнения результата с исходником.
Например:

```yaml
sources:
  - id: old-page
    path: demo/materials/old-page.md
    role: original
redesign:
  sourceRef: old-page
  preserve: [Условие оплаты, Адрес формы заявки]
  changes: [Упростить первый экран]
  verification: [Сравнить условия и путь заявки до и после]
```

В `demo/materials/old-page.md` должны быть сами исходные факты и действия,
а не только ссылка на URL. Валидатор проверяет наличие и полноту записи;
сохранение смысла в итоговой странице подтверждает независимое ревью.

## Серия сообщений

```yaml
version: 1
kind: series
targetNode: welcome
seriesType: welcome
objective: Помочь клиенту после заявки
audience: Оставившие заявку
sources:
  - id: offer
    path: .knowledge-base/processes/demo/offer.md
references: []
voice:
  addressing: вы
  character: спокойный помощник
  emotionality: сдержанно
  example: Покажем, что делать дальше.
emailDesign:
  layout: Одна колонка
  components: Текст и кнопка
  colors: Контрастный текст
  mobile: Читается на телефоне
messages:
  - id: first
    path: .mailings/storage/processes/demo/welcome/01.message.yaml
    goal: Подтвердить заявку
    mainIdea: Менеджер ответит и предложит время
    subject: Мы получили вашу заявку
    blocks:
      - type: confirmation
        text: Мы получили заявку и скоро предложим время.
        sourceRef: offer
deliveryMode: manual
manualInvocation:
  caller: Менеджер по текущей заявке
  trigger: После разговора с клиентом
  recipient: Контакт этого клиента из CRM
  stop: Клиент отказался или уже получил ответ
openQuestions: []
acceptance: [Сообщение отправлено только нужному клиенту]
```

`deliveryMode: manual` нужен для серии, которую вызывает человек или
бизнес-операция без автоматизации. Без `manualInvocation` такая серия не
проходит сборку. Для автоматической серии опусти `deliveryMode` или поставь
`automation`, убери `manualInvocation` и укажи существующий
`automationRef: <process>/automations/<name>/<name>.automationConfig.json`.
Серию не надо привязывать к фиктивному событию ради формата. У каждого
сообщения отдельный `.message.yaml` с `subject`, `html`, `plain` и `short`;
[формат письма](letters.md) и [отправка](../blocks/message-series.md).
