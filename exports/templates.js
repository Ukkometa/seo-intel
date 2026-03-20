import { summarizeActions } from './heuristics.js';

export function buildExportPayload({ project, scope, actions }) {
  return {
    project,
    generatedAt: new Date().toISOString(),
    scope,
    summary: summarizeActions(actions),
    actions,
  };
}

export function formatActionsJson(payload) {
  return JSON.stringify(payload, null, 2);
}

export function formatActionsBrief(payload) {
  const { project, scope, summary, actions } = payload;
  const grouped = actions.reduce((acc, action) => {
    if (!acc[action.area]) acc[action.area] = [];
    acc[action.area].push(action);
    return acc;
  }, {});

  const lines = [
    `# SEO Intel Actions — ${project}`,
    '',
    `- Generated: ${payload.generatedAt}`,
    `- Scope: ${scope}`,
    `- Total actions: ${actions.length}`,
    `- Priority mix: critical ${summary.critical}, high ${summary.high}, medium ${summary.medium}, low ${summary.low}`,
    '',
    '## Summary',
    '',
    `- Critical: ${summary.critical}`,
    `- High: ${summary.high}`,
    `- Medium: ${summary.medium}`,
    `- Low: ${summary.low}`,
    '',
  ];

  for (const area of ['technical', 'content', 'schema', 'structure']) {
    const items = grouped[area] || [];
    if (!items.length) continue;
    lines.push(`## ${capitalize(area)}`);
    lines.push('');
    for (const action of items) {
      lines.push(`### ${action.title}`);
      lines.push(`- ID: ${action.id}`);
      lines.push(`- Type: ${action.type}`);
      lines.push(`- Priority: ${action.priority}`);
      lines.push(`- Why: ${action.why}`);
      if (action.evidence?.length) {
        lines.push('- Evidence:');
        for (const item of action.evidence) lines.push(`  - ${item}`);
      }
      if (action.implementationHints?.length) {
        lines.push('- Implementation hints:');
        for (const item of action.implementationHints) lines.push(`  - ${item}`);
      }
      lines.push('');
    }
  }

  if (!actions.length) {
    lines.push('## No actions found');
    lines.push('');
    lines.push('- The current dataset did not surface any qualifying actions for this scope.');
    lines.push('');
  }

  return lines.join('\n');
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
