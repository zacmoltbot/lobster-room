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

function createAttributionRuntime() {
  const state = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
    feed: [],
  };

  function rememberPendingSpawnAttribution(parentSessionKey, payload) {
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    if (!sk) return undefined;
    const actorId = inferSpawnActorId(payload);
    if (!actorId) return undefined;
    const residentAgentId = canonicalResidentAgentId(sk);
    const entry = { actorId, parentSessionKey: sk, residentAgentId, source: resolveExplicitSpawnAgentId(payload) ? 'explicit' : 'inferred' };
    state.pendingByParent.set(sk, (state.pendingByParent.get(sk) || []).concat([entry]));
    state.pendingByResident.set(residentAgentId, (state.pendingByResident.get(residentAgentId) || []).concat([entry]));
    return entry;
  }

  function consumePendingSpawnAttribution(parentSessionKey) {
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    const parentQueue = state.pendingByParent.get(sk) || [];
    const next = parentQueue.shift();
    if (parentQueue.length) state.pendingByParent.set(sk, parentQueue);
    else state.pendingByParent.delete(sk);
    if (!next) return undefined;
    const residentQueue = state.pendingByResident.get(next.residentAgentId) || [];
    const filtered = residentQueue.filter((candidate) => candidate !== next);
    if (filtered.length) state.pendingByResident.set(next.residentAgentId, filtered);
    else state.pendingByResident.delete(next.residentAgentId);
    return next;
  }

  function adoptPendingSpawnAttributionForSession(sessionKey, residentAgentId) {
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (!sk) return undefined;
    const existing = state.spawnedSessionAgentIds.get(sk);
    if (existing) return { actorId: existing };
    const resident = canonicalVisibleAgentId(residentAgentId);
    const residentQueue = state.pendingByResident.get(resident) || [];
    const adopted = residentQueue.shift();
    if (residentQueue.length) state.pendingByResident.set(resident, residentQueue);
    else state.pendingByResident.delete(resident);
    if (!adopted) return undefined;
    state.spawnedSessionAgentIds.set(sk, adopted.actorId);
    const parentQueue = state.pendingByParent.get(adopted.parentSessionKey) || [];
    const filtered = parentQueue.filter((candidate) => candidate !== adopted);
    if (filtered.length) state.pendingByParent.set(adopted.parentSessionKey, filtered);
    else state.pendingByParent.delete(adopted.parentSessionKey);
    return adopted;
  }

  function resolveFeedAgentIdentity(ctx) {
    const parsed = parseSessionIdentity(ctx && ctx.sessionKey, ctx && ctx.agentId);
    const rawSessionAgentId = parsed.agentId;
    const childSessionKey = typeof (ctx && ctx.sessionKey) === 'string' ? ctx.sessionKey.trim() : '';
    const adopted = childSessionKey && parsed.lane !== 'main'
      ? adoptPendingSpawnAttributionForSession(childSessionKey, parsed.residentAgentId)
      : undefined;
    const visible = childSessionKey ? (state.spawnedSessionAgentIds.get(childSessionKey) || (adopted && adopted.actorId) || '') : '';
    if (visible) return { agentId: visible, rawAgentId: rawSessionAgentId };
    return { agentId: canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || 'main', rawAgentId: rawSessionAgentId };
  }

  function beforeToolCall(event, ctx) {
    if ((event && event.toolName) === 'sessions_spawn') {
      rememberPendingSpawnAttribution(ctx && ctx.sessionKey, event && event.params);
    }
    const identity = resolveFeedAgentIdentity(ctx);
    state.feed.push({ kind: 'before_tool_call', toolName: event.toolName, sessionKey: ctx.sessionKey, agentId: identity.agentId });
    return identity;
  }

  function beforeAgentStart(ctx) {
    const identity = resolveFeedAgentIdentity(ctx);
    state.feed.push({ kind: 'before_agent_start', sessionKey: ctx.sessionKey, agentId: identity.agentId, rawAgentId: identity.rawAgentId });
    return identity;
  }

  function afterToolCall(event, ctx) {
    if ((event && event.toolName) === 'sessions_spawn') {
      const pending = consumePendingSpawnAttribution(ctx && ctx.sessionKey);
      const agentId = inferSpawnActorId((event && event.params) || {}) || (pending && pending.actorId);
      const childSessionKey = event && event.result && event.result.childSessionKey;
      if (childSessionKey && agentId) state.spawnedSessionAgentIds.set(childSessionKey, agentId);
    }
    const identity = resolveFeedAgentIdentity(ctx);
    state.feed.push({ kind: 'after_tool_call', toolName: event.toolName, sessionKey: ctx.sessionKey, agentId: identity.agentId });
    return identity;
  }

  return { state, beforeToolCall, beforeAgentStart, afterToolCall };
}

const runtime = createAttributionRuntime();
const parentCtx = { sessionKey: 'agent:main:main', agentId: 'main' };
const qaChildCtx = { sessionKey: 'agent:main:subagent:child-qa', agentId: 'main' };
const codingChildCtx = { sessionKey: 'agent:main:subagent:child-code', agentId: 'main' };

runtime.beforeToolCall({
  toolName: 'sessions_spawn',
  params: {
    label: 'qa-lobster-room-proof',
    task: '你是 qa_agent。請做接近 live pipeline 的驗證。',
  },
}, parentCtx);

const qaFirst = runtime.beforeAgentStart(qaChildCtx);
const qaFollowup = runtime.beforeToolCall({ toolName: 'browser', params: { url: 'https://example.com' } }, qaChildCtx);
runtime.afterToolCall({
  toolName: 'sessions_spawn',
  params: {
    label: 'qa-lobster-room-proof',
    task: '你是 qa_agent。請做接近 live pipeline 的驗證。',
  },
  result: { childSessionKey: qaChildCtx.sessionKey },
}, parentCtx);

runtime.beforeToolCall({
  toolName: 'sessions_spawn',
  params: {
    label: 'coding-lobster-room-proof',
    task: 'You are coding_agent. Implement the feed actor truth linkage patch.',
  },
}, parentCtx);
const codingFirst = runtime.beforeAgentStart(codingChildCtx);
const codingFollowup = runtime.beforeToolCall({ toolName: 'read', params: { path: 'plugin/lobster-room/index.ts' } }, codingChildCtx);
runtime.afterToolCall({
  toolName: 'sessions_spawn',
  params: {
    label: 'coding-lobster-room-proof',
    task: 'You are coding_agent. Implement the feed actor truth linkage patch.',
  },
  result: { childSessionKey: codingChildCtx.sessionKey },
}, parentCtx);

assert.equal(qaFirst.agentId, 'qa_agent', 'first child event should attribute to qa_agent');
assert.equal(qaFollowup.agentId, 'qa_agent', 'qa follow-up tool call should stay on qa_agent');
assert.equal(codingFirst.agentId, 'coding_agent', 'second child event should attribute to coding_agent');
assert.equal(codingFollowup.agentId, 'coding_agent', 'coding follow-up tool call should stay on coding_agent');
assert.ok(runtime.state.feed.every((row) => !/subagent|cron/i.test(row.agentId)), 'visible feed must never leak internal descendant ids');
assert.deepEqual(
  runtime.state.feed.map((row) => [row.kind, row.toolName || null, row.agentId]),
  [
    ['before_tool_call', 'sessions_spawn', 'main'],
    ['before_agent_start', null, 'qa_agent'],
    ['before_tool_call', 'browser', 'qa_agent'],
    ['after_tool_call', 'sessions_spawn', 'main'],
    ['before_tool_call', 'sessions_spawn', 'main'],
    ['before_agent_start', null, 'coding_agent'],
    ['before_tool_call', 'read', 'coding_agent'],
    ['after_tool_call', 'sessions_spawn', 'main'],
  ],
  'event pipeline should keep parent as main while children resolve to inferred helper actors',
);

console.log('feed-agent-attribution liveish proof: PASS');
console.log(JSON.stringify(runtime.state.feed, null, 2));
