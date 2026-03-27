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
  const lower = canonical.toLowerCase();
  if (lower === 'subagent' || lower === 'spawn' || lower === 'cron' || lower === 'discord') return '';
  return canonical;
}

function inferSpawnActorId(payload) {
  for (const candidate of [payload && payload.agentId, payload && payload.spawnAgentId, payload && payload.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  const text = [payload && payload.label, payload && payload.task, payload && payload.prompt, payload && payload.instructions]
    .filter((x) => typeof x === 'string')
    .join('\n');
  if (/coding[_ -]?agent/i.test(text)) return 'coding_agent';
  if (/qa[_ -]?agent/i.test(text)) return 'qa_agent';
  return '';
}

function createRuntime() {
  const state = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
  };

  const enqueue = (bucket, key, entry) => {
    bucket.set(key, (bucket.get(key) || []).concat([entry]));
  };
  const dequeue = (bucket, key) => {
    const queue = bucket.get(key) || [];
    const next = queue.shift();
    if (queue.length) bucket.set(key, queue);
    else bucket.delete(key);
    return next;
  };
  const forgetPendingFromResident = (residentAgentId, entry) => {
    const queue = state.pendingByResident.get(residentAgentId) || [];
    const next = queue.filter((candidate) => candidate !== entry);
    if (next.length) state.pendingByResident.set(residentAgentId, next);
    else state.pendingByResident.delete(residentAgentId);
  };

  const rememberPendingSpawnAttribution = (parentSessionKey, payload) => {
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    const actorId = inferSpawnActorId(payload);
    const residentAgentId = canonicalResidentAgentId(sk);
    if (!sk || !actorId || !residentAgentId) return undefined;
    const entry = { actorId, parentSessionKey: sk, residentAgentId };
    enqueue(state.pendingByParent, sk, entry);
    enqueue(state.pendingByResident, residentAgentId, entry);
    return entry;
  };

  const consumePendingSpawnAttribution = (parentSessionKey) => {
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    if (!sk) return undefined;
    const next = dequeue(state.pendingByParent, sk);
    if (!next) return undefined;
    forgetPendingFromResident(next.residentAgentId, next);
    return next;
  };

  const adoptPendingSpawnAttributionForSession = (sessionKey, residentAgentId) => {
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (!sk) return undefined;
    const existing = state.spawnedSessionAgentIds.get(sk);
    if (existing) return { actorId: existing, via: 'explicit' };
    const resident = canonicalVisibleAgentId(residentAgentId);
    const adopted = dequeue(state.pendingByResident, resident);
    if (!adopted) return undefined;
    const parentQueue = (state.pendingByParent.get(adopted.parentSessionKey) || []).filter((entry) => entry !== adopted);
    if (parentQueue.length) state.pendingByParent.set(adopted.parentSessionKey, parentQueue);
    else state.pendingByParent.delete(adopted.parentSessionKey);
    state.spawnedSessionAgentIds.set(sk, adopted.actorId);
    return { ...adopted, via: 'pending' };
  };

  const resolveSpawnedChildSessionKey = (event, ctx) => {
    const parentSessionKey = typeof (ctx && ctx.sessionKey) === 'string' ? ctx.sessionKey.trim() : '';
    const candidates = [
      event && event.result && event.result.childSessionKey,
      event && event.childSessionKey,
      event && event.result && event.result.sessionKey,
    ];
    for (const candidate of candidates) {
      const sk = typeof candidate === 'string' ? candidate.trim() : '';
      if (!sk || sk === parentSessionKey) continue;
      const parsed = parseSessionIdentity(sk);
      if (parsed.lane === 'subagent' || parsed.lane === 'cron') return sk;
    }
    return '';
  };

  const afterToolCall = (event, ctx) => {
    if ((event && event.toolName) !== 'sessions_spawn') return;
    const childSessionKey = resolveSpawnedChildSessionKey(event, ctx);
    if (!childSessionKey) return;
    const pending = consumePendingSpawnAttribution(ctx && ctx.sessionKey);
    const actorId = inferSpawnActorId((event && event.params) || {}) || (pending && pending.actorId);
    if (childSessionKey && actorId) state.spawnedSessionAgentIds.set(childSessionKey, actorId);
  };

  const resolveFeedAgentIdentity = (ctx) => {
    const parsed = parseSessionIdentity(ctx && ctx.sessionKey, ctx && ctx.agentId);
    const adopted = parsed.lane !== 'main'
      ? adoptPendingSpawnAttributionForSession(ctx && ctx.sessionKey, parsed.residentAgentId)
      : undefined;
    const visible = state.spawnedSessionAgentIds.get(ctx && ctx.sessionKey) || (adopted && adopted.actorId) || '';
    return { agentId: visible || 'main', adopted };
  };

  return {
    state,
    rememberPendingSpawnAttribution,
    consumePendingSpawnAttribution,
    resolveSpawnedChildSessionKey,
    afterToolCall,
    resolveFeedAgentIdentity,
  };
}

const runtime = createRuntime();
const parentCtx = { sessionKey: 'agent:main:discord:channel:1476111438186680416', agentId: 'main' };
const childCtx = { sessionKey: 'agent:main:subagent:child-code', agentId: 'main' };
const spawnParams = {
  label: 'coding-parent-key-guard-proof',
  task: 'You are coding_agent. Minimal patch only.',
};

const pending = runtime.rememberPendingSpawnAttribution(parentCtx.sessionKey, spawnParams);
assert.equal(pending && pending.actorId, 'coding_agent', 'spawn intent should be inferred and queued');

const malformedAfter = {
  toolName: 'sessions_spawn',
  params: spawnParams,
  sessionKey: parentCtx.sessionKey,
  result: {
    message: 'spawned helper',
  },
};

assert.equal(runtime.resolveSpawnedChildSessionKey(malformedAfter, parentCtx), '', 'parent event.sessionKey fallback must not be accepted as child session key');
runtime.afterToolCall(malformedAfter, parentCtx);
assert.deepEqual(
  Array.from(runtime.state.spawnedSessionAgentIds.entries()),
  [],
  'after_tool_call without proven child key must not write spawnedSessionAgentIds',
);
assert.equal((runtime.state.pendingByParent.get(parentCtx.sessionKey) || []).length, 1, 'pending attribution must remain queued on parent');
assert.equal((runtime.state.pendingByResident.get('main') || []).length, 1, 'pending attribution must remain adoptable by resident');

const childFirst = runtime.resolveFeedAgentIdentity(childCtx);
assert.equal(childFirst.agentId, 'coding_agent', 'child first event should adopt pending attribution instead of falling back to main');
assert.equal(childFirst.adopted && childFirst.adopted.via, 'pending', 'child should adopt through pending path');
assert.equal(runtime.state.spawnedSessionAgentIds.get(childCtx.sessionKey), 'coding_agent', 'adopted child session should be linked after first child event');
assert.equal((runtime.state.pendingByParent.get(parentCtx.sessionKey) || []).length, 0, 'pending parent queue should be drained after adoption');

console.log('feed-agent-attribution parent sessionKey guard: PASS');
console.log(JSON.stringify({
  spawnedSessionAgentIds: Array.from(runtime.state.spawnedSessionAgentIds.entries()),
  pendingByParent: Array.from(runtime.state.pendingByParent.entries()),
  pendingByResident: Array.from(runtime.state.pendingByResident.entries()),
  childFirst,
}, null, 2));
