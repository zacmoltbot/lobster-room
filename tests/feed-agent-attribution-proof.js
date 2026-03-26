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
const pendingSpawnAttributionsByParent = new Map();
const pendingSpawnAttributionsByResident = new Map();

function normalizeSpawnText(value, maxLen = 240) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function resolveExplicitSpawnAgentId(payload) {
  for (const candidate of [payload && payload.agentId, payload && payload.spawnAgentId, payload && payload.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  return '';
}

function inferSpawnActorId(payload) {
  const explicit = resolveExplicitSpawnAgentId(payload);
  if (explicit) return explicit;
  const text = [payload && payload.label, payload && payload.task, payload && payload.prompt, payload && payload.instructions]
    .map((part) => normalizeSpawnText(part, 400).toLowerCase())
    .filter(Boolean)
    .join('\n');
  if (!text) return '';
  const actorHints = [
    { actorId: 'qa_agent', patterns: [/\bqa[_ -]?agent\b/i, /\byou are\s+qa[_ -]?agent\b/i, /你是\s*qa[_ -]?agent/i, /角色[:：]?\s*qa[_ -]?agent/i] },
    { actorId: 'coding_agent', patterns: [/\bcoding[_ -]?agent\b/i, /\byou are\s+coding[_ -]?agent\b/i, /你是\s*coding[_ -]?agent/i, /角色[:：]?\s*coding[_ -]?agent/i] },
  ];
  for (const hint of actorHints) {
    if (hint.patterns.some((pattern) => pattern.test(text))) return hint.actorId;
  }
  return '';
}

function rememberPendingSpawnAttribution(parentSessionKey, payload) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  if (!sk) return undefined;
  const actorId = inferSpawnActorId(payload);
  if (!actorId) return undefined;
  const residentAgentId = canonicalResidentAgentId(sk);
  if (!residentAgentId) return undefined;
  const entry = {
    actorId,
    parentSessionKey: sk,
    residentAgentId,
    label: normalizeSpawnText(payload && payload.label, 120) || undefined,
    task: normalizeSpawnText(payload && payload.task, 240) || undefined,
    source: resolveExplicitSpawnAgentId(payload) ? 'explicit' : 'inferred',
  };
  pendingSpawnAttributionsByParent.set(sk, (pendingSpawnAttributionsByParent.get(sk) || []).concat([entry]));
  pendingSpawnAttributionsByResident.set(residentAgentId, (pendingSpawnAttributionsByResident.get(residentAgentId) || []).concat([entry]));
  return entry;
}

function consumePendingSpawnAttribution(parentSessionKey) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  if (!sk) return undefined;
  const queue = pendingSpawnAttributionsByParent.get(sk) || [];
  const next = queue.shift();
  if (queue.length) pendingSpawnAttributionsByParent.set(sk, queue);
  else pendingSpawnAttributionsByParent.delete(sk);
  if (!next) return undefined;
  const residentQueue = pendingSpawnAttributionsByResident.get(next.residentAgentId) || [];
  const filtered = residentQueue.filter((candidate) => candidate !== next);
  if (filtered.length) pendingSpawnAttributionsByResident.set(next.residentAgentId, filtered);
  else pendingSpawnAttributionsByResident.delete(next.residentAgentId);
  return next;
}

function adoptPendingSpawnAttributionForSession(sessionKey, residentAgentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
  if (!sk) return undefined;
  const existingActorId = spawnedSessionAgentIds.get(sk);
  if (existingActorId) return { actorId: existingActorId, residentAgentId: canonicalResidentAgentId(residentAgentId) };
  const resident = canonicalVisibleAgentId(residentAgentId);
  if (!resident) return undefined;
  const queue = pendingSpawnAttributionsByResident.get(resident) || [];
  const adopted = queue.shift();
  if (queue.length) pendingSpawnAttributionsByResident.set(resident, queue);
  else pendingSpawnAttributionsByResident.delete(resident);
  if (!adopted) return undefined;
  spawnedSessionAgentIds.set(sk, adopted.actorId);
  const parentQueue = pendingSpawnAttributionsByParent.get(adopted.parentSessionKey) || [];
  const filtered = parentQueue.filter((candidate) => candidate !== adopted);
  if (filtered.length) pendingSpawnAttributionsByParent.set(adopted.parentSessionKey, filtered);
  else pendingSpawnAttributionsByParent.delete(adopted.parentSessionKey);
  return adopted;
}

function rememberSpawnedSessionAgent(sessionKey, agentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
  const visible = canonicalVisibleAgentId(agentId);
  if (!sk || !visible) return;
  spawnedSessionAgentIds.set(sk, visible);
}

function resolveFeedAgentIdentity(ctx) {
  const parsed = parseSessionIdentity(ctx && ctx.sessionKey, ctx && ctx.agentId);
  const rawSessionAgentId = parsed.agentId;
  const childSessionKey = typeof (ctx && ctx.sessionKey) === 'string' ? ctx.sessionKey.trim() : '';
  const adopted = childSessionKey && parsed.lane !== 'main'
    ? adoptPendingSpawnAttributionForSession(childSessionKey, parsed.residentAgentId)
    : undefined;
  const spawnedVisible = childSessionKey ? (spawnedSessionAgentIds.get(childSessionKey) || (adopted && adopted.actorId) || '') : '';
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
    label: 'qa-lobster-final-agent-attribution-truth-20260327',
    task: '你是 qa_agent。請做 final acceptance checks，驗證 lobster room actor attribution。',
  },
};
const childBeforeAgentStartCtx = { sessionKey: childSessionKey, agentId: 'main' };
const childBeforeToolCtx = { sessionKey: childSessionKey, agentId: 'main' };
const sessionsSpawnAfterToolEvent = {
  toolName: 'sessions_spawn',
  params: {
    label: sessionsSpawnBeforeToolEvent.params.label,
    task: sessionsSpawnBeforeToolEvent.params.task,
  },
  result: { childSessionKey },
};

const pending = rememberPendingSpawnAttribution(parentSessionKey, sessionsSpawnBeforeToolEvent.params);
console.log('TRACE pending attribution', pending);
assert.equal(pending && pending.actorId, 'qa_agent', 'parent spawn should infer qa_agent truth linkage even without requested actor fields');
assert.equal(pending && pending.source, 'inferred', 'truth linkage should record inferred source when payload lacks explicit actor ids');

const beforeAgentStartIdentity = resolveFeedAgentIdentity(childBeforeAgentStartCtx);
const beforeToolIdentity = resolveFeedAgentIdentity(childBeforeToolCtx);
const consumed = consumePendingSpawnAttribution(parentSessionKey);
rememberSpawnedSessionAgent(sessionsSpawnAfterToolEvent.result.childSessionKey, inferSpawnActorId(sessionsSpawnAfterToolEvent.params) || (consumed && consumed.actorId));
const afterSpawnIdentity = resolveFeedAgentIdentity(childBeforeToolCtx);

console.log('TRACE child ctx', {
  sessionKey: childBeforeAgentStartCtx.sessionKey,
  ctxAgentId: childBeforeAgentStartCtx.agentId,
  parsed: parseSessionIdentity(childBeforeAgentStartCtx.sessionKey, childBeforeAgentStartCtx.agentId),
  firstBeforeAgentStart: beforeAgentStartIdentity,
  followupBeforeTool: beforeToolIdentity,
  afterSpawnResult: afterSpawnIdentity,
  spawnedSessionAgentIds: Array.from(spawnedSessionAgentIds.entries()),
});

assert.equal(beforeAgentStartIdentity.agentId, 'qa_agent', 'first before_agent_start for subagent must resolve to qa_agent');
assert.equal(beforeToolIdentity.agentId, 'qa_agent', 'follow-up before_tool_call must stay on qa_agent before spawn result lands');
assert.equal(afterSpawnIdentity.agentId, 'qa_agent', 'post-result events must stay on qa_agent');
assert.equal(beforeAgentStartIdentity.rawAgentId, 'main/subagent:qa-proof', 'raw/debug lineage should stay internal only');

console.log('feed-agent-attribution proof: PASS');
