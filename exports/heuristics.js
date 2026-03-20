function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

export function makeAction(overrides = {}) {
  const base = {
    id: overrides.id || `${overrides.area || 'general'}-${overrides.type || 'fix'}-${slugify(overrides.title)}`,
    type: 'fix',
    priority: 'medium',
    area: 'content',
    title: '',
    why: '',
    evidence: [],
    implementationHints: [],
  };

  return {
    ...base,
    ...overrides,
    evidence: Array.isArray(overrides.evidence) ? overrides.evidence.filter(Boolean) : [],
    implementationHints: Array.isArray(overrides.implementationHints) ? overrides.implementationHints.filter(Boolean) : [],
  };
}

export function priorityWeight(priority) {
  return ({ critical: 4, high: 3, medium: 2, low: 1 })[priority] || 0;
}

export function summarizeActions(actions) {
  return actions.reduce((acc, action) => {
    acc[action.priority] = (acc[action.priority] || 0) + 1;
    return acc;
  }, { critical: 0, high: 0, medium: 0, low: 0 });
}

export function sortActions(actions) {
  return [...actions].sort((a, b) => {
    const priorityDelta = priorityWeight(b.priority) - priorityWeight(a.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return a.title.localeCompare(b.title);
  });
}

export function normalizePriority(priority, fallback = 'medium') {
  const value = String(priority || '').toLowerCase();
  return ['critical', 'high', 'medium', 'low'].includes(value) ? value : fallback;
}

export function normalizeActionType(type, fallback = 'improve') {
  const value = String(type || '').toLowerCase();
  return ['fix', 'new_page', 'improve', 'add_schema'].includes(value) ? value : fallback;
}

export function inferPriorityFromCount(count, thresholds = { critical: 20, high: 10, medium: 3 }) {
  if (count >= thresholds.critical) return 'critical';
  if (count >= thresholds.high) return 'high';
  if (count >= thresholds.medium) return 'medium';
  return 'low';
}

export function collectTop(values, limit = 5) {
  return [...values].slice(0, limit);
}
