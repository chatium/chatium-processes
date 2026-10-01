# Chatium processes skill

Этот репозиторий — единственный исходник скилла `processes`. Здесь его
разрабатывают; установленные копии в аккаунтах Chatium не являются отдельными
источниками правок. Позже скилл переедет в `chatium-agent-skills` рядом с
`chatium-development`.

Агент может клонировать репозиторий прямо в аккаунт:

```sh
git clone https://github.com/chatium/chatium-processes.git .agents/skills/processes
(cd .agents/skills/processes && npm ci --ignore-scripts)
```

Для обновления:

```sh
git -C .agents/skills/processes pull --ff-only
(cd .agents/skills/processes && npm ci --ignore-scripts)
```

В аккаунте также должен быть скилл `chatium-development`. Требования к
окружению и доступу к Chatium описаны в [build/environment.md](build/environment.md).

Если аккаунт сам находится в Git, каталог скилла будет отдельным вложенным
репозиторием. Его можно добавить в `.gitignore` аккаунта; не добавляйте его
через `git add` как обычные файлы аккаунта. При создании нового рабочего
окружения агент снова клонирует скилл по ссылке. Для воспроизводимых прогонов
можно переключиться на конкретный тег вместо текущего `main`.
