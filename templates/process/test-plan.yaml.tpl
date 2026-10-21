version: 1
# Заполните сценарии из требований процесса. Пустой план не подтверждает тестирование.
# targets: [{kind: node, id: ...}, {kind: link, id: ...}, {kind: step, source: ..., id: ...}]
# sources: полный набор значимых исходников, настроек и зависимостей аккаунта.
# kind: runtime | browser; required: true | false.
# У runtime обязательны script: <process>/tests/scenarios/<case>.mjs и capabilities.
# Сообщения по умолчанию проверяйте через sender.transport.* с TestContext;
# внутреннему транспорту не нужны реальные контакты/каналы (scope: contacts: [], channels: []).
# Подключение внешнего канала — зависимость launch; его приёмка отдельна от внутреннего теста.
cases: []
