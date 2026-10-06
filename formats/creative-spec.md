# Формат задания страницы и серии

Для узла `page` или `series` в `process.yaml` укажи
`creativeRef: <process>/creative/<node-id>/spec.yaml`. `targetNode` совпадает
с ID узла, `kind` — `landing` для страницы и `series` для серии. Источник
должен быть непустым; если задан `section`, заголовок `# …` в этом файле
должен существовать и содержать текст. Затем запусти `creative.mjs validate`
и `compile`. Ошибки валидатора показывают недостающие поля.

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
images: []
abTesting:
  mode: none
openQuestions: []
acceptance: [Заявка записана, пользователь видит подтверждение]
```

Допустимые `landingType`, `styleId` и типы механик смотри в
`creative/catalog/`. Для `sales` нужен реальный путь к покупке или заявке.
Каждая механика требует `id`, `type`, `purpose`, `placement` и поля её типа.
Для изображения укажи `id`, `sectionId`, `purpose`, `alt`, готовый `asset`
или `generationBrief`, `aspect`, `mobileCrop`; до сборки нужен готовый asset.
В редизайне добавь исходные страницы как источники и критерии сохранения
существенных условий.

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
