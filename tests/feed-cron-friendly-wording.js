const assert = require('assert');

function normalizeIntentText(value, maxLen = 120) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (!text) return '';
  text = text.replace(/^you are\s+[^。.!?\n]+[。.!?]?\s*/i, '');
  text = text.replace(/^你是\s*[^。.!?\n]+[。.!?]?\s*/u, '');
  text = text.replace(/^(please|pls|kindly)\s+/i, '');
  text = text.replace(/^(請|麻煩)\s*/u, '');
  text = text.replace(/^(task|label|prompt)\s*[:：-]\s*/i, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length > maxLen) text = text.slice(0, maxLen).trimEnd() + '…';
  return text;
}

function canonicalVisibleAgentId(agentId, fallback = 'main') {
  const raw = typeof agentId === 'string' ? agentId.trim() : '';
  if (!raw) return fallback;
  const clean = raw.replace(/^@+/, '').trim();
  return clean || fallback;
}

function titleCaseCronLabel(value) {
  const clean = normalizeIntentText(value, 120);
  if (!clean) return '';
  return clean.split(/\s+/).map((part) => {
    if (!part) return '';
    if (/^AI$/i.test(part)) return 'AI';
    if (/^RSS$/i.test(part)) return 'RSS';
    if (/^gmail$/i.test(part)) return 'Gmail';
    if (/^github$/i.test(part)) return 'GitHub';
    if (/^youtube$/i.test(part)) return 'YouTube';
    if (/^notion$/i.test(part)) return 'Notion';
    if (/^discord$/i.test(part)) return 'Discord';
    if (/^[A-Z0-9]+$/.test(part)) return part;
    return part.charAt(0).toUpperCase() + part.slice(1);
  }).join(' ').trim();
}

function buildCronJobNameCache(jobs) {
  const next = new Map();
  for (const job of jobs || []) {
    const jobId = typeof job?.id === 'string' && job.id.trim()
      ? job.id.trim()
      : (typeof job?.jobId === 'string' && job.jobId.trim() ? job.jobId.trim() : '');
    const name = normalizeIntentText(job?.name || job?.label || job?.title, 120);
    if (!jobId || !name) continue;
    next.set(jobId, name);
  }
  return next;
}

const cronJobNameCache = buildCronJobNameCache([
  { id: '8267978b-1135-4736-973b-ed370beec448', name: 'Gmail Checker' },
  { id: '807dbcb2-16df-4eef-b2ec-a74fdce0ed96', name: 'AI News Digest' },
  { id: '0c30b9e4-0a8a-41a1-b714-56002839b65c', name: 'Daily Idea' },
]);

function cronJobLabelFromSessionKey(sessionKey) {
  const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const match = sk.match(/^agent:([^:]+):cron:([^:]+)$/i);
  if (!match) return '';
  const rawJobId = String(match[2] || '').trim();
  if (!rawJobId) return '';
  const named = cronJobNameCache.get(rawJobId);
  if (named) return named;
  return titleCaseCronLabel(rawJobId.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim());
}

function cronActorPrefix(sessionKey) {
  const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const match = sk.match(/^agent:([^:]+):cron:([^:]+)$/i);
  if (!match) return '';
  const actor = canonicalVisibleAgentId(String(match[1] || '').trim(), '');
  return actor ? `@${actor}` : '';
}

function cronFriendlyIntent(sessionKey, toolName, phase = 'active', opts) {
  const label = cronJobLabelFromSessionKey(sessionKey);
  if (!label) return '';
  const actor = opts?.includeActor === false ? '' : cronActorPrefix(sessionKey);
  const tn = String(toolName || '').trim();
  const verb = tn === 'message'
    ? (phase === 'done' ? 'posted' : 'posting')
    : (tn === 'browser' || tn === 'web_fetch')
      ? (phase === 'done' ? 'checked' : 'checking')
      : (phase === 'done' ? 'ran' : 'running');
  return `${actor ? actor + ' ' : ''}${verb} ${label}`.trim();
}

function extractExplicitTaskIntent(details) {
  const candidates = [details?.task, details?.label, details?.prompt, details?.goal, details?.summary, details?.title, details?.purpose, details?.name];
  for (const candidate of candidates) {
    const text = normalizeIntentText(candidate, 120);
    if (text) return text;
  }
  return '';
}

function extractTaskIntent(details) {
  const explicitIntent = extractExplicitTaskIntent(details);
  if (explicitIntent) return explicitIntent;
  const cronIntent = cronFriendlyIntent(details?.sessionKey, details?.toolName, 'active', { includeActor: false });
  if (cronIntent) return cronIntent;
  return '';
}

function humanizedWorkDescription(toolName, details, phase = 'active') {
  const tn = String(toolName || 'tool').trim();
  const intent = extractTaskIntent(details);
  if (tn === 'exec' || tn === 'process') {
    if (intent) return phase === 'done' ? `finished ${intent}` : `${intent}`;
    const cronIntent = cronFriendlyIntent(details?.sessionKey, tn, phase, { includeActor: false });
    if (cronIntent) return cronIntent;
    return phase === 'done' ? 'finished a check' : 'running a check';
  }
  if (tn === 'message') {
    const explicitIntent = extractExplicitTaskIntent(details);
    if (explicitIntent) return phase === 'done' ? `prepared reply for ${explicitIntent}` : `preparing reply for ${explicitIntent}`;
    const cronIntent = cronFriendlyIntent(details?.sessionKey, tn, phase, { includeActor: false });
    if (cronIntent) return cronIntent;
    return phase === 'done' ? 'prepared a reply' : 'preparing a reply';
  }
  return intent || '';
}

function feedPreview(it, opts) {
  const canonicalAgentId = it.agentId ? canonicalVisibleAgentId(it.agentId) || 'main' : '';
  const actorPrefix = opts?.includeActor !== false && canonicalAgentId ? `@${canonicalAgentId} ` : '';
  const details = it.details || null;
  if (it.kind === 'before_agent_start') {
    const cronStart = cronFriendlyIntent(it.sessionKey, undefined, 'active', { includeActor: false });
    if (cronStart) return `${actorPrefix}${cronStart}`.trim();
    return `${actorPrefix}started`.trim();
  }
  if (it.kind === 'before_tool_call') {
    return `${actorPrefix}${humanizedWorkDescription(String(it.toolName || 'tool'), details, 'active')}`.trim();
  }
  if (it.kind === 'tool_result_persist') {
    const intent = extractTaskIntent(details) || 'inspect runtime';
    return `${actorPrefix}${intent ? `continuing ${intent}` : 'continuing work'}`.trim();
  }
  return '';
}

assert.equal(cronJobLabelFromSessionKey('agent:main:cron:8267978b-1135-4736-973b-ed370beec448'), 'Gmail Checker');
assert.equal(cronFriendlyIntent('agent:main:cron:8267978b-1135-4736-973b-ed370beec448', 'browser', 'active'), '@main checking Gmail Checker');
assert.equal(cronFriendlyIntent('agent:main:cron:807dbcb2-16df-4eef-b2ec-a74fdce0ed96', 'message', 'active'), '@main posting AI News Digest');
assert.equal(extractTaskIntent({ sessionKey: 'agent:main:cron:8267978b-1135-4736-973b-ed370beec448', toolName: 'browser' }), 'checking Gmail Checker');
assert.equal(feedPreview({ kind: 'before_agent_start', agentId: 'main', sessionKey: 'agent:main:cron:0c30b9e4-0a8a-41a1-b714-56002839b65c' }, { includeActor: true }), '@main running Daily Idea');
assert.equal(feedPreview({ kind: 'before_tool_call', agentId: 'main', toolName: 'browser', details: { sessionKey: 'agent:main:cron:8267978b-1135-4736-973b-ed370beec448', toolName: 'browser' } }, { includeActor: true }), '@main checking Gmail Checker');
assert.equal(humanizedWorkDescription('message', { sessionKey: 'agent:main:cron:807dbcb2-16df-4eef-b2ec-a74fdce0ed96', toolName: 'message' }, 'active'), 'posting AI News Digest');
assert.equal(feedPreview({ kind: 'tool_result_persist', agentId: 'main', toolName: 'message', details: { sessionKey: 'agent:main:cron:807dbcb2-16df-4eef-b2ec-a74fdce0ed96', toolName: 'message' } }, { includeActor: true }), '@main continuing posting AI News Digest');
assert.equal(cronJobLabelFromSessionKey('agent:main:cron:kanban_checker'), 'Kanban Checker', 'fallback should still humanize raw job ids when cache misses');

console.log('feed-cron-friendly-wording: PASS');
