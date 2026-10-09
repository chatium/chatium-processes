# Качество и согласованность серии

Вымышленная веломастерская отвечает людям, уже попросившим осмотр.
Парные спецификации проверяют E01–E05 и E12 на уровне задания: тип серии,
адресат, подтверждённые обещания, развитие мысли, единый голос и
согласованность соседнего касания. Массовая рассылка, доставка и рендер
писем здесь не выполняются.

`account/` — исправленный вариант. Для отрицательного варианта во
временной копии замените `followup/spec.yaml` и `next/spec.yaml`
одноимёнными файлами из корня фикстуры, затем пересоздайте
`followup/build.md`:

```sh
mkdir -p /path/to/temporary/account/.agents/skills/processes/creative/catalog
cp creative/catalog/email-design.md creative/catalog/email-quality.md \
  /path/to/temporary/account/.agents/skills/processes/creative/catalog/
node scripts/creative.mjs compile repair followup --root /path/to/temporary/account
node scripts/creative-review.mjs prepare repair followup --stage spec --root /path/to/temporary/account
```

Ревьюер сравнивает `task`, `truth`, `depth`, `series` и
`series-consistency` с исходным рассказом владельца. Зелёный spec
не означает, что письма написаны, показаны или доставлены.

Сохранены заключения независимого `series_quality_reviewer`:
`negative-recorded.json` — 10 блокирующих замечаний из 10;
`positive-recorded.json` — `ready`, 9 положительных ответов и одно
advisory о ещё не проверенном живом канале. Оба отчёта приняты
`creative-review record`. В исправленном варианте подтверждены адресат
после собственной заявки, фактические 500 ₽ за осмотр, три разные роли
сообщений, единый голос и одинаковые условия соседней серии. Плановый
`test-email-channel` и `replyTo` в фикстуре служат только заданием:
Sender, фактические письма и доставку требуется проверять отдельно.
