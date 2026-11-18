// Owner-facing progress describes work on the process, not stages inside the funnel.
const steps = [
  ['Вводные о бизнесе', 'Уточняй и сверяй факты с владельцем. Исходники блоков оставь пустыми до согласования структуры.', 'method/interview.md', 'method/README.md'],
  ['План и согласование', 'Готовь только структуру: этапы, назначение блоков, переходы, критерии и будущие пути файлов. До «строим так?» запрещены тексты, код, конфигураторы и прогон воронки. Получи заключения методолога и архитектора, покажи владельцу путь клиента и дождись его решения.', 'formats/plan-md.md', 'build/procedure.md', 'build/commission.md'],
  ['Сборка', 'Возьми карточку согласованного блока. Для клиентской страницы или серии нужны предложения профильных субагентов, конфигуратор и независимое ревью задания. Затем выполняй реализацию по build.md.', 'build/tasks-and-creative.md', 'specialists/guide.md', 'formats/creative-spec.md'],
  ['Приёмка сборки', 'Сверь критерии карточек с результатами, получи независимое ревью и отметь принятую работу на доске. Открытые замечания передай на исправление.', 'build/review.md', 'build/construction-statuses.md'],
  ['Проверка пути клиента', 'После приёмки пройди согласованные сценарии с тестовыми данными и сохрани результаты на доске.', 'formats/test-records.md', 'build/procedure.md'],
  ['Согласование запуска', 'Покажи владельцу результаты, ограничения и точный объём включения. Дождись его решения о запуске для клиентов.', 'build/commission.md', 'build/preview.md'],
  ['Запуск', 'Включи только согласованный объём, проверь доступ клиентам, наблюдение и способ остановки.', 'build/procedure.md', 'build/operations.md'],
]

function step(number, next) {
  const [title, instruction, ...references] = steps[number - 1]
  return { number, label: `${number} из ${steps.length} — ${title}`, next, instruction, references }
}

export function stepGuidance(progress) {
  return `Правило шага ${progress.number}: ${progress.instruction}\nЧитать сейчас: ${progress.references.join(', ')}`
}

// A plan item with both build and test criteria stays unchecked until the test passes.
export function hasOpenBuildWork(planTasks, cards) {
  return planTasks.some(task => {
    if (task.done) return false
    if (!task.criteria?.length) return true
    return task.criteria.filter(item => item.stage === 'build' || item.stage === 'design').some(item => {
      const assigned = cards.filter(card => card.planTask === task.id && card.status !== 'cancelled' &&
        card.acceptanceCriteria?.some(criterion => criterion.planCriteria?.includes(item.id)))
      return !assigned.length || assigned.some(card => card.status !== 'done')
    })
  })
}

export function implementationStep({ hasKnowledge, hasPlan, prematureContent, designReady, planDecision,
  openTasks, buildReady, currentNodes, constructionStatus, testingStatus, checkPassed,
  taskStage, launchDecision }) {
  if (!hasKnowledge) return step(1, 'Я уточню вводные о бизнесе и запишу их в план работы.')
  if (!hasPlan) return step(2, 'Я опишу путь клиента и покажу его на доске.')
  if (prematureContent) return step(2, 'Я отделю преждевременные черновики и подготовлю схему для согласования.')
  if (!designReady) return step(2, 'Я проверю план и список материалов до согласования.')
  if (planDecision.status === 'declined') return step(2, 'Я учту ваши замечания к предложенному плану.')
  if (planDecision.status !== 'ready') return step(2, 'От вас нужно решение по плану, чтобы я мог начать сборку.')
  if (openTasks) return step(3, 'Я соберу и проверю оставшиеся части процесса.')
  if (!buildReady) return step(4, 'Я организую независимую проверку собранных частей.')
  if (!currentNodes?.length) return step(4, 'Я сверю доску и уточню, какие части уже прошли приёмку.')
  if (constructionStatus !== 'current' || currentNodes.some(node => node.status !== 'built'))
    return step(4, 'Я проверю результаты сборки и отмечу на доске, какие части прошли приёмку.')
  if (testingStatus !== 'passed') return step(5, 'Я проверю оставшиеся сценарии пути клиента и запишу результаты.')
  if (launchDecision.status === 'ready' && launchDecision.authority === 'owner')
    return step(7, checkPassed && taskStage === 'launch'
      ? 'Я проверю, какие части процесса действительно включены для клиентов.'
      : 'Я проверю условия согласованного запуска и устраню то, что мешает включению.')
  if (launchDecision.status === 'ready' && launchDecision.authority === 'delegated-test')
    return step(6, 'Разрешён только учебный запуск. Я сверю, что ещё нужно для запуска с клиентами.')
  if (!checkPassed || taskStage !== 'test') return step(5, 'Я сверю итог проверки и устраню оставшиеся замечания.')
  if (launchDecision.status === 'declined') return step(6, 'Запуск отложен по вашему решению.')
  return step(6, 'Я покажу результаты проверки. От вас нужно решение, открывать ли процесс клиентам.')
}

// Copy only the public origin of a Source Git checkout into a client message.
export function messageFooter(progress, accountRemote, boardPath) {
  const remote = URL.canParse(accountRemote) ? new URL(accountRemote) : null
  const lines = [`Текущий шаг: ${progress.label}`, `Следующий шаг: ${progress.next}`]
  if (remote?.protocol !== 'https:' || !/^\/s\/(?:git|source-git)\//.test(remote.pathname))
    return lines.join('\n')
  return ['---', `[Доска процесса](${remote.origin}${boardPath})`, ...lines].join('\n\n')
}
