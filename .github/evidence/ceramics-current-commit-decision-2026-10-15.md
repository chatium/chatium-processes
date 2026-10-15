# Одно решение на текущем исполняемом коммите, 15.10.2026

Аккаунт `funnels-git-3.chatium.ru`, опубликованный и исполненный
`main@c5ca00a3a23463a497d6a7f06d04b4701fe9ca18`. В
`ceramics-trial/.workspace.json` перед действием подтверждены
`mailings.testOnly: true`, единственный разрешённый контакт
`ratmir@chatium.io` и канал `mFNuoENLx6ClQXThIp00funne`.
Читающий `chatium exec` на том же SHA подтвердил бесплатную цену и ключи
трёх писем. Существующая заявка
`trial-2026-10-17-336d364543b8edba6761b0a2` была `waiting`, адрес
совпадал с разрешённым, письмо решения имело статус `none`.

Один раз вызван опубликованный `decideTrialRequest` от OAuth Admin:
`decision=declined`, `declineReason=email_already_confirmed`. Причина
соответствует уже подтверждённому месту на этот email. Ответ:

```json
{"requestId":"trial-2026-10-17-336d364543b8edba6761b0a2","decision":"declined","eventStatus":"ok","letterStatus":"accepted","letterAcceptedByChannel":true}
```

Один последующий читающий `chatium exec` на том же SHA подтвердил строку:
`status=declined`, `declineReason=email_already_confirmed`,
`decisionEventStatus=ok`, `decisionNoticeStatus=accepted`,
`decidedAt=2026-10-15T12:33:45.170Z`. Вызовы не повторялись; новые заявки,
оплаты и включение автоматизаций не выполнялись. Рабочее дерево аккаунта
после проверки не менялось.

Это живое подтверждение текущего пути **Admin-решение → CRM-событие →
принятие письма каналом**. Попадание письма в почтовый ящик, запуск письма
через одну из трёх выключенных автоматизаций и весь путь от новой формы на
этом SHA не утверждаются. Браузерный вход Admin отдельно не повторялся:
здесь проверены роль через `decideTrialRequest` и сохранённый результат.
