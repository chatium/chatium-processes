# Формат задания страницы и серии

Для узла `page` или `series` в `process.yaml` укажи
`creativeRef: <process>/creative/<node-id>/spec.yaml`. `targetNode` совпадает
с ID узла, `kind` — `landing` для страницы и `series` для серии. Источник
должен быть непустым; если задан `section`, заголовок `# …` в этом файле
должен существовать и содержать текст. Для источника с `section` задание и
ревью читают только этот раздел: правка другого раздела не устаревает их.
Затем запусти `creative.mjs validate`
и `compile`. Ошибки валидатора показывают недостающие поля.
Заголовок, комментарий или `TODO` без содержательного текста не считается
источником. `sections[].copyRef` может указывать на файл или на его раздел
в виде `path/to/copy.md#Название раздела`; нужный раздел тоже должен
существовать и содержать текст. Валидатор проверяет наличие материала,
а соответствие фактов и обещаний ему оценивает независимый ревьюер.
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
      desktop: Заголовок и ссылка к форме ниже
      mobile: Заголовок, короткое пояснение, кнопка к форме
    mechanicRefs: []
    acceptance: [С первого экрана понятен следующий шаг]
  - id: request
    type: form_section
    purpose: Получить контакт для консультации
    covers: [поля заявки и подтверждение]
    points:
      - text: После заявки менеджер предложит время
        sourceRef: offer
    presentation:
      desktop: Короткая форма и пояснение о следующем шаге
      mobile: Поля друг под другом, видимая кнопка
    mechanicRefs: [request-form]
    acceptance: [Ошибку можно исправить, успешная заявка сохранена]
mechanics:
  - id: request-form
    type: form
    purpose: Передать заявку менеджеру
    expectedOutcome: Заявка сохранена, посетитель видит подтверждение
    placement: request
    fields: [name, email]
    target: demo/api/request
    success: Показать подтверждение после сохранения
    error: Показать ошибку и оставить введённые данные
    mobile: Поля и кнопка доступны на узком экране
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

Для этого примера в `.knowledge-base/processes/demo/offer.md` должен быть
раздел `# Условия консультации` с подтверждённым описанием предложения.
`demo/api/request` — запланированный обработчик формы: задание описывает
ожидаемое поведение, а реализация и тест должны подтвердить сохранение
заявки, ошибку и уведомление менеджера.

Допустимые `landingType`, `styleId` и типы механик смотри в
`creative/catalog/`. Большой каталог стилей не нужно читать целиком:
`node .agents/skills/processes/scripts/catalog.mjs styles --search "образование"`
покажет подходящие ID, а `catalog.mjs styles <id>` — только выбранное
направление. Так же доступны `pages`, `mechanics` и `copywriting`.
Направления — ориентиры композиции, а не разрешение копировать чужой бренд,
логотип или изображение. Выбор и адаптация должны соответствовать аудитории,
материалам и правам на изображения. Для `sales` нужен реальный путь к покупке или заявке.
Если выбираешь направление текста, укажи `copywriting.styleId` из
`creative/catalog/copywriting.json` и объясни его адаптацию под аудиторию и
бренд. Это ориентиры для подачи, не шаблоны обещаний и не требование
подражать конкретному автору. Все факты и примеры берутся из источников.
Для `webinar` заполни `event.date`, `timezone`, `format`, `program`,
`presenter`, `registrationOutcome` и механику регистрации. Для
`autowebinar` вместо даты нужен `event.schedule`; запись нельзя выдавать
за прямой эфир. Если дата и программа ещё не утверждены, а форма только
фиксирует интерес без обещания приглашения, выбери `interest`, а не
`webinar` или `waitlist`. В YAML заключай текст со запятыми в кавычки,
особенно внутри `{...}`: иначе часть фразы станет отдельным пустым полем.
Для `quiz` нужны механика `quiz` и `quiz.resultRule`,
`outcomes`, `nextStep`: вопросы должны менять полезный результат.
Каждая механика требует `id`, `type`, `purpose`, `expectedOutcome`,
`placement` (ID существующей секции) и поля её типа. В этой секции добавь ID
механики в `mechanicRefs`. Задача и ожидаемый результат объясняют, зачем
механика нужна человеку; сам факт наличия кнопки, таймера или формы недостаточен.
Каталог содержит и интерактивные, и редкие механики. Выбирай их по
задаче страницы, а не ради количества эффектов. Для цены, скидки, дефицита,
отзывов, имён покупателей и других проверяемых утверждений требуется
`sourceRef` на соответствующий элемент `sources`; если данных нет, убери
механику. Поля `requires` в `creative/catalog/mechanics.json` обязательны.
Попапы должны закрываться и иметь ограничение частоты, движущиеся элементы —
не перекрывать контент и учитывать доступность на телефоне.
Для изображения укажи `id`, `sectionId`, `purpose`, `alt`, готовый `asset`
или `generationBrief`, `aspect`, `mobileCrop`; до сборки нужен готовый asset.
Добавь `provenance: {kind, reference, usageRights}`: `owner` для материала
владельца с ID вложения или сообщения, `generated` с ID результата генерации,
`licensed` со ссылкой на источник и условия лицензии. `usageRights` фиксирует,
на каком основании изображение можно использовать именно в этом процессе.
Ревьюер открывает файл и сверяет источник; заполненное поле само по себе не
доказывает права или соответствие задаче.
Исходник изображения первого раздела ограничен 1 МиБ. Это лишь предварительный
порог; в итоговом ревью проверь фактически загружаемый файл на телефоне.
В редизайне сохрани факты и действия исходной страницы в текстовом файле и
добавь его в `sources` с `role: original`. Дополнительно укажи HTTPS-адрес
доступной исходной страницы в `redesign.originalUrl` или путь к сохранённому
PNG в `redesign.originalCapture`. Если используется URL опубликованной ветки,
запиши её коммит в `originalRevision`; одна ссылка на движущуюся ветку может
перестать показывать тот же оригинал. Ревьюер открывает оригинал и сравнивает
его с результатом; текстовый пересказ или сам URL не доказывают сохранение.
Укажи `redesign.sourceRef` на ID этого
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
  originalUrl: https://example.org/old-page
  originalRevision: 0123456789abcdef0123456789abcdef01234567
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
formats: [email]
channelIdsByFormat:
  email: [email-1]
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
    path: .mailings/storage/processes/demo/welcome/01-welcome.message.yaml
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

`email-1` здесь условный ID. До тестовой отправки замени его ID активного
email-канала из `getChannels(ctx)` и запиши тот же ID в
`processDeliveryChannelIds` файла `01-welcome.message.yaml`. Для этого
примера шаблон должен иметь `title`, `description`, `subject`, `plain` и
`html`; полный формат — в [справке о письмах](letters.md).

`deliveryMode: manual` нужен для серии, которую вызывает человек или
бизнес-операция без автоматизации. Без `manualInvocation` такая серия не
проходит сборку. Для автоматической серии опусти `deliveryMode` или поставь
`automation`, убери `manualInvocation` и укажи существующий
`automationRef: <process>/automations/<name>/<name>.automationConfig.json`.
Серию не надо привязывать к фиктивному событию ради формата. `formats`
задаёт фактически используемые виды: `email`, `messenger`, `sms`. Если поле
не указано, для старых заданий считается `[email]`. Для email нужны
`subject`, `html`, `plain`; для мессенджера — `plain`; для SMS — `short`.
`emailDesign` нужен только при email. У каждого сообщения отдельный
`.message.yaml`. Выбранные форматы сверь с настройками доставки процесса;
для каждого укажи `channelIdsByFormat`, например
`{email: [email-1], messenger: [telegram-1]}`. ID возьми из
`getChannels(ctx)` Sender и проверь их `type` и `active`. Ключи объекта
должны точно совпадать с `formats`, а ID не должны повторяться. В каждом
шаблоне и варианте запиши `processDeliveryChannelIds` с объединением этих
ID. В Mailings это явное ограничение доставки новых шаблонов; старые
шаблоны продолжают работать по прежнему контракту. До подключения каналов
оставь вопрос владельцу; на запуске отсутствие ID блокирует `check`.
Несоответствие типа канала формату должен отклонить ревьюер, а тестовая
доставка подтверждает каждый ID. См. [формат письма](letters.md)
и [отправку](../blocks/message-series.md).

Если сообщение обещает медиа или вложение в конкретном канале, добавь к
сообщению `requiredMedia`, например:

```yaml
requiredMedia:
  - kind: media
    key: guide-photo
    channelIds: [telegram-1]
```

`kind` — `media` или `attachment`; `key` совпадает с элементом `media` или
`attachments` в `.message.yaml`. `channelIds` — выбранные ID из
`channelIdsByFormat`. `check` проверяет наличие и канальные ограничения,
а реальную доставку и открытие файла — тестовая отправка в каждом канале.
