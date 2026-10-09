# Цена и полнота короткого сообщения

Вымышленная веломастерская изменила цену осмотра с 1 000 ₽ на 500 ₽.
`account/` содержит исправленный однократный SMS после собственной заявки.
`01-received-negative.message.yaml` заменяет его на старую цену и фразу
«ответьте до» без завершения. У обоих вариантов `creative` и `letters` в
детерминированном `check --no-snapshot` зелёные: это содержательный разрыв,
который должен заметить независимый ревьюер результата.

Для повторения скопируйте `account/` в два временных каталога; во втором
замените `.mailings/storage/processes/repair/notice/01-received.message.yaml`
отрицательным файлом. В каждом каталоге скопируйте из установленного скилла
`creative/catalog/email-design.md` и `email-quality.md` в
`.agents/skills/processes/creative/catalog/`, затем выполните:

```sh
node .agents/skills/processes/scripts/creative.mjs compile repair notice --root /path/to/account
node .agents/skills/processes/scripts/creative-review.mjs prepare repair notice --stage result --root /path/to/account --out /path/outside/account
```

Пакет имеет 10 файлов, 9 вопросов и не требует PNG: выбран только формат
SMS. Ревью проверяет `short` по плану, источнику и заданию. Это проверка
содержимого, не доставки: номер телефона и реальная отправка отсутствуют.

Независимый `sms_price_reviewer` ответил на все 9 вопросов в каждом пакете;
оба отчёта приняты `creative-review record`. В отрицательном результате
`truth`, `action`, `message.received.short` и ещё четыре вопроса блокируют
приёмку; исправленный текст получил 9 pass и `ready` **для содержимого**.
Ревью прямо отмечает, что SMS не отправлялось и ответ клиента не наблюдался.
