// These gates evaluate a requested workflow stage, while a board snapshot is
// tied to source commit. Their result cannot define graph freshness.
export const STAGE_CHECKS = new Set([
  'tasks', 'creative', 'creative.review', 'knowledge.review', 'implementation.review',
  'reviews', 'owner.plan', 'owner.plan.board', 'owner.launch', 'owner.launch.board',
  'automation.smoke', 'launch.variables', 'table.changes', 'typecheck',
  'workspace', 'map', 'owner.questions', 'data.contracts', 'map.sources',
  'agents.runtime', 'events.used', 'automations', 'letters', 'letters.delivery',
])
