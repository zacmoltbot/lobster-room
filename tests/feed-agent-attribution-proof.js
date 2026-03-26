const assert = require('assert');

function parseSessionIdentity(sessionKey, fallbackAgentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey) : '';
  const parts = sk ? sk.split(':') : [];
  if (parts.length >= 3 && parts[0] === 'agent') {
    const residentAgentId = parts[1] || 'main';
    const lane = parts[2] || 'main';
    if (lane === 'main') return { agentId: residentAgentId, residentAgentId, lane };
    const tail = parts.slice(3).filter(Boolean).join(':');
    const scoped = tail ? `${residentAgentId}/${lane}:${tail}` : `${residentAgentId}/${lane}`;
    return { agentId: scoped, residentAgentId, lane };
  }
  const id = typeof fallbackAgentId === 'string' ? String(fallbackAgentId).trim() : '';
  return { agentId: id || 'main', residentAgentId: id || 'main', lane: 'main' };
}

function canonicalResidentAgentId(value) {
  if (typeof value !== 'string') return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (raw.startsWith('agent:')) return parseSessionIdentity(raw).residentAgentId;
  const stripped = raw.replace(/^resident@/, '');
  const slash = stripped.indexOf('/');
  return (slash >= 0 ? stripped.slice(0, slash) : stripped).trim();
}

function canonicalVisibleAgentId(value) {
  if (typeof value !== 'string') return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const canonical = canonicalResidentAgentId(raw);
  if (!canonical) return '';
  if (['subagent', 'spawn', 'cron', 'discord'].includes(canonical.toLowerCase())) return '';
  return canonical;
}

const spawnedSessionAgentIds = new Map();
const pendingSpawnAgentIds = new Map();
const pendingSpawnAgentIdsByResident = new Map();

function enqueuePendingSpawnAgent(bucket, key, visible) {
  bucket.set(key, (bucket.get(key) || []).concat([visible]));
}

function dequeuePendingSpawnAgent(bucket, key) {
  const queue = bucket.get(key) || [];
  const next = queue.shift() || '';
  if (queue.length) bucket.set(key, queue);
  else bucket.delete(key);
  return next;
}

function rememberPendingSpawnAgent(parentSessionKey, agentId) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  const visible = canonicalVisibleAgentId(agentId);
  if (!sk || !visible) return;
  enqueuePendingSpawnAgent(pendingSpawnAgentIds, sk, visible);
  const resident = canonicalResidentAgentId(sk);
  if (resident) enqueuePendingSpawnAgent(pendingSpawnAgentIdsByResident, resident, visible);
}

function consumePendingSpawnAgent(parentSessionKey) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  if (!sk) return '';
  const next = dequeuePendingSpawnAgent(pendingSpawnAgentIds, sk);
  if (!next) return '';
  const resident = canonicalResidentAgentId(sk);
  if (resident) dequeuePendingSpawnAgent(pendingSpawnAgentIdsByResident, resident);
  return next;
}

function adoptPendingSpawnAgentForSession(sessionKey, residentAgentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
  if (!sk || spawnedSessionAgentIds.has(sk)) return spawnedSessionAgentIds.get(sk) || '';
  const resident = canonicalVisibleAgentId(residentAgentId);
  if (!resident) return '';
  const adopted = dequeuePendingSpawnAgent(pendingSpawnAgentIdsByResident, resident);
  if (!adopted) return '';
  spawnedSessionAgentIds.set(sk, adopted);
  return adopted;
}

function rememberSpawnedSessionAgent(sessionKey, agentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
  const visible = canonicalVisibleAgentId(agentId);
  if (!sk || !visible) return;
  spawnedSessionAgentIds.set(sk, visible);
}

function resolveRequestedSpawnAgentId(payload) {
  for (const candidate of [payload && payload.agentId, payload && payload.spawnAgentId, payload && payload.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  return '';
}

function resolveFeedAgentIdentity(ctx) {
  const parsed = parseSessionIdentity(ctx && ctx.sessionKey, ctx && ctx.agentId);
  const rawSessionAgentId = parsed.agentId;
  const childSessionKey = typeof (ctx && ctx.sessionKey) === 'string' ? ctx.sessionKey.trim() : '';
  const spawnedVisible = childSessionKey
    ? (spawnedSessionAgentIds.get(childSessionKey)
      || (parsed.lane !== 'main' ? adoptPendingSpawnAgentForSession(childSessionKey, parsed.residentAgentId) : ''))
    : '';
  if (spawnedVisible) {
    return {
      agentId: spawnedVisible,
      rawAgentId: rawSessionAgentId && rawSessionAgentId !== spawnedVisible ? rawSessionAgentId : undefined,
    };
  }
  for (const candidate of [ctx && ctx.agentId, ctx && ctx.agent && ctx.agent.id, ctx && ctx.agent && ctx.agent.agentId, ctx && ctx.session && ctx.session.agentId, ctx && ctx.residentAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return { agentId: visible, rawAgentId: rawSessionAgentId !== visible ? rawSessionAgentId : undefined };
  }
  const fallback = canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || 'main';
  return { agentId: fallback, rawAgentId: rawSessionAgentId && rawSessionAgentId !== fallback ? rawSessionAgentId : undefined };
}

const parentSessionKey = 'agent:main:main';
const childSessionKey = 'agent:main:subagent:qa-proof';
const sessionsSpawnBeforeToolEvent = {
  toolName: 'sessions_spawn',
  params: {
    spawnAgentId: 'qa_agent',
    label: 'qa-lobster-final-agent-attribution-truth-20260326',
    task: 'Run final acceptance checks',
  },
};
const childBeforeAgentStartCtx = { sessionKey: childSessionKey, agentId: 'main' };
const childBeforeToolCtx = { sessionKey: childSessionKey, agentId: 'main' };
const sessionsSpawnAfterToolEvent = {
  toolName: 'sessions_spawn',
  params: { spawnAgentId: 'qa_agent' },
  result: { childSessionKey },
};

console.log('TRACE before rememberPendingSpawnAgent', {
  parentSessionKey,
  eventParamsAgentId: sessionsSpawnBeforeToolEvent.params.agentId || null,
  eventParamsSpawnAgentId: sessionsSpawnBeforeToolEvent.params.spawnAgentId || null,
});

rememberPendingSpawnAgent(parentSessionKey, resolveRequestedSpawnAgentId(sessionsSpawnBeforeToolEvent.params));

console.log('TRACE after rememberPendingSpawnAgent', {
  pendingSpawnAgentIds: pendingSpawnAgentIds.get(parentSessionKey) || [],
  pendingSpawnAgentIdsByResident: pendingSpawnAgentIdsByResident.get('main') || [],
});

const beforeAgentStartIdentity = resolveFeedAgentIdentity(childBeforeAgentStartCtx);
const beforeToolIdentity = resolveFeedAgentIdentity(childBeforeToolCtx);
rememberSpawnedSessionAgent(sessionsSpawnAfterToolEvent.result.childSessionKey, resolveRequestedSpawnAgentId(sessionsSpawnAfterToolEvent.params) || consumePendingSpawnAgent(parentSessionKey));
const afterSpawnIdentity = resolveFeedAgentIdentity(childBeforeToolCtx);

console.log('TRACE child ctx', {
  sessionKey: childBeforeAgentStartCtx.sessionKey,
  ctxAgentId: childBeforeAgentStartCtx.agentId,
  parsed: parseSessionIdentity(childBeforeAgentStartCtx.sessionKey, childBeforeAgentStartCtx.agentId),
  firstBeforeAgentStart: beforeAgentStartIdentity,
  followupBeforeTool: beforeToolIdentity,
  afterSpawnResult: afterSpawnIdentity,
});

assert.equal(beforeAgentStartIdentity.agentId, 'qa_agent', 'first before_agent_start for subagent must resolve to qa_agent');
assert.equal(beforeToolIdentity.agentId, 'qa_agent', 'follow-up before_tool_call must stay on qa_agent before spawn result lands');
assert.equal(afterSpawnIdentity.agentId, 'qa_agent', 'post-result events must stay on qa_agent');

console.log('feed-agent-attribution proof: PASS');
