import { sendLetterAction } from './send-letter'

// Действия процесса в палитре автоматизаций. Новое действие — добавь сюда.
app.accountHook('@automations/actions', async () => {
  return [sendLetterAction]
})
