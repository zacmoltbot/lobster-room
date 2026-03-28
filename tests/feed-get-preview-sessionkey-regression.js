const assert = require('assert');

function canonicalVisibleAgentId(value) {
  if (typeof value !== 'string') return '';
  const raw = String(value).trim();
  if (!raw) return '';
  return raw;
}

function humanizedWorkDescription(toolName, details, phase) {
  const sessionKey = typeof details?.sessionKey === 'string' ? details.sessionKey : '';
  if (toolName === 'exec' && /cron/i.test(sessionKey)) return phase === 'done' ? 'finished cron check' : 'running cron check';
  return phase === 'done' ? 'finished work' : 'working';
}

function cronStoryLabel(details) {
  const sessionKey = typeof details?.sessionKey === 'string' ? details.sessionKey : '';
  return /cron/i.test(sessionKey) ? 'cron check' : '';
}

function extractTaskIntent(details) {
  return typeof details?.task === 'string' ? details.task.trim() : '';
}

function fallbackTaskIntentForTool(toolName) {
  return toolName === 'exec' ? 'inspect runtime' : 'working';
}

function feedPreview(it, opts) {
  const canonicalAgentId = it.agentId ? canonicalVisibleAgentId(it.agentId) || 'main' : '';
  const actorPrefix = opts?.includeActor !== false && canonicalAgentId ? `@${canonicalAgentId} ` : '';
  const details = it.details || null;
  const detailsWithSessionKey = details
    ? { ...details, sessionKey: details.sessionKey ?? it.sessionKey }
    : (it.sessionKey ? { sessionKey: it.sessionKey } : null);

  if (it.kind === 'before_tool_call') {
    const tn = it.toolName || 'tool';
    const desc = humanizedWorkDescription(String(tn), detailsWithSessionKey, 'active');
    return `${actorPrefix}${desc}`.trim();
  }
  if (it.kind === 'after_tool_call') {
    const tn = it.toolName || 'tool';
    const desc = humanizedWorkDescription(String(tn), detailsWithSessionKey, 'done');
    return `${actorPrefix}${desc}`.trim();
  }
  if (it.kind === 'tool_result_persist') {
    const cronLabel = cronStoryLabel(detailsWithSessionKey);
    if (cronLabel) return `${actorPrefix}continuing ${cronLabel}`.trim();
    const intent = extractTaskIntent(detailsWithSessionKey) || fallbackTaskIntentForTool(String(it.toolName || ''), detailsWithSessionKey);
    return `${actorPrefix}${intent ? `continuing ${intent}` : 'continuing work'}`.trim();
  }
  return `${actorPrefix}started`.trim();
}

function sanitizeFeedItemForApi(it) {
  return {
    ts: it.ts,
    kind: it.kind,
    agentId: it.agentId,
    sessionKey: it.sessionKey,
    preview: feedPreview(it, { includeActor: false }),
    previewWithActor: feedPreview(it, { includeActor: true }),
  };
}

const items = [
  {
    ts: Date.now(),
    kind: 'before_tool_call',
    agentId: 'main',
    sessionKey: 'agent:main:cron:heartbeat',
    toolName: 'exec',
    details: { command: 'uptime' },
  },
  {
    ts: Date.now() + 1,
    kind: 'after_tool_call',
    agentId: 'main',
    sessionKey: 'agent:main:cron:heartbeat',
    toolName: 'exec',
  },
  {
    ts: Date.now() + 2,
    kind: 'tool_result_persist',
    agentId: 'main',
    sessionKey: 'agent:main:cron:heartbeat',
    toolName: 'exec',
  },
];

const rows = items.map((it) => sanitizeFeedItemForApi(it));
assert.equal(rows.length, 3);
assert.equal(rows[0].preview, 'running cron check');
assert.equal(rows[0].previewWithActor, '@main running cron check');
assert.equal(rows[1].preview, 'finished cron check');
assert.equal(rows[2].preview, 'continuing cron check');

console.log('feed-get-preview-sessionkey-regression: PASS');
