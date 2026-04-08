const assert = require('assert');

const UNKNOWN_CHILD_ACTOR_ID = 'unknown';

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
  if (lower === 'subagent' || lower === 'spawn' || lower === 'cron' || lower === 'discord' || lower === 'unknown') return '';
  return canonical;
}

function normalizeSpawnText(value, maxLen = 240) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function isAdoptableChildLane(lane) {
  return String(lane || '').trim().toLowerCase() === 'subagent';
}

function hasAdoptableChildProof(sessionKey, residentAgentId) {
  const parsed = parseSessionIdentity(sessionKey, residentAgentId);
  if (!isAdoptableChildLane(parsed.lane)) return false;
  const resident = canonicalResidentAgentId(residentAgentId ?? parsed.residentAgentId);
  return !!resident && resident === parsed.residentAgentId;
}

function resolveExplicitSpawnAgentId(payload) {
  for (const candidate of [payload?.agentId, payload?.spawnAgentId, payload?.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  return '';
}

function uniqueVisibleAgentIds(values) {
  return [...new Set(values.filter(Boolean))];
}

function extractSpawnDirectiveActorIds(text) {
  const out = [];
  const directivePatterns = [
    /\byou are\s+([a-z][a-z0-9_-]{1,63})\b/gi,
    /你是\s*([a-z][a-z0-9_-]{1,63})/giu,
    /角色\s*[:：]?\s*([a-z][a-z0-9_-]{1,63})/giu,
  ];
  for (const pattern of directivePatterns) {
    for (const match of text.matchAll(pattern)) {
      const visible = canonicalVisibleAgentId(match?.[1]);
      if (visible) out.push(visible);
    }
  }
  return uniqueVisibleAgentIds(out);
}

function extractSpawnMentionActorIds(text) {
  const out = [];
  const mentionPatterns = [/\b([a-z][a-z0-9_-]*agent)\b/gi, /@([a-z][a-z0-9_-]{1,63})/gi];
  for (const pattern of mentionPatterns) {
    for (const match of text.matchAll(pattern)) {
      const visible = canonicalVisibleAgentId(match?.[1]);
      if (visible) out.push(visible);
    }
  }
  return uniqueVisibleAgentIds(out);
}

function inferSpawnActorId(payload) {
  const explicit = resolveExplicitSpawnAgentId(payload);
  if (explicit) return explicit;
  const text = [payload?.label, payload?.task, payload?.prompt, payload?.instructions]
    .map((part) => normalizeSpawnText(part, 400))
    .filter(Boolean)
    .join('\n');
  if (!text) return '';
  const directive = extractSpawnDirectiveActorIds(text);
  if (directive.length === 1) return directive[0];
  if (directive.length > 1) return '';
  const mentions = extractSpawnMentionActorIds(text);
  if (mentions.length === 1) return mentions[0];
  return '';
}

function pendingSpawnMatcherFromPayload(payload) {
  return {
    actorId: inferSpawnActorId(payload) || undefined,
    label: normalizeSpawnText(payload?.label, 120) || undefined,
    task: normalizeSpawnText(payload?.task, 240) || undefined,
  };
}

function createRuntime() {
  const state = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
  };

  function enqueue(bucket, key, entry) {
    bucket.set(key, (bucket.get(key) || []).concat([entry]));
  }

  function forgetPendingSpawnAttributionFromResident(residentAgentId, entry) {
    const queue = state.pendingByResident.get(residentAgentId) || [];
    const next = queue.filter((candidate) => candidate !== entry);
    if (next.length) state.pendingByResident.set(residentAgentId, next);
    else state.pendingByResident.delete(residentAgentId);
  }

  function pickPendingSpawnAttribution(bucket, key, matcher) {
    const queue = bucket.get(key) || [];
    if (!queue.length) return undefined;
    const actorId = canonicalVisibleAgentId(matcher?.actorId);
    const label = normalizeSpawnText(matcher?.label, 120);
    const task = normalizeSpawnText(matcher?.task, 240);
    const index = queue.findIndex((entry) => {
      if (actorId && entry.actorId !== actorId) return false;
      if (label && normalizeSpawnText(entry.label, 120) !== label) return false;
      if (task && normalizeSpawnText(entry.task, 240) !== task) return false;
      return true;
    });
    if (index < 0) return undefined;
    const [picked] = queue.splice(index, 1);
    if (queue.length) bucket.set(key, queue);
    else bucket.delete(key);
    return picked;
  }

  function rememberPendingSpawnAttribution(parentSessionKey, payload) {
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    const actorId = inferSpawnActorId(payload);
    const residentAgentId = canonicalResidentAgentId(sk);
    if (!sk || !actorId || !residentAgentId) return undefined;
    const entry = {
      actorId,
      parentSessionKey: sk,
      residentAgentId,
      label: normalizeSpawnText(payload?.label, 120) || undefined,
      task: normalizeSpawnText(payload?.task, 240) || undefined,
    };
    enqueue(state.pendingByParent, sk, entry);
    enqueue(state.pendingByResident, residentAgentId, entry);
    return entry;
  }

  function consumePendingSpawnAttribution(parentSessionKey, matcher) {
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    if (!sk) return undefined;
    const next = matcher
      ? (pickPendingSpawnAttribution(state.pendingByParent, sk, matcher) || pickPendingSpawnAttribution(state.pendingByParent, sk, {}))
      : pickPendingSpawnAttribution(state.pendingByParent, sk, {});
    if (!next) return undefined;
    forgetPendingSpawnAttributionFromResident(next.residentAgentId, next);
    return next;
  }

  function resolveChildParentSessionKeys(ctx) {
    const candidates = [ctx?.parentSessionKey, ctx?.parent?.sessionKey, ctx?.session?.parentSessionKey, ctx?.session?.parentKey, ctx?.parent?.key];
    const out = [];
    for (const candidate of candidates) {
      const sk = typeof candidate === 'string' ? candidate.trim() : '';
      if (!sk || out.includes(sk)) continue;
      out.push(sk);
    }
    return out;
  }

  function adoptPendingSpawnAttributionForSession(sessionKey, ctx) {
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (!sk) return undefined;
    const parsed = parseSessionIdentity(sk, ctx?.agentId);
    if (!hasAdoptableChildProof(sk, parsed.residentAgentId)) return undefined;
    const existing = state.spawnedSessionAgentIds.get(sk);
    if (existing) return { actorId: existing, via: 'spawned' };

    for (const parentSessionKey of resolveChildParentSessionKeys(ctx)) {
      const adopted = pickPendingSpawnAttribution(state.pendingByParent, parentSessionKey, {});
      if (!adopted) continue;
      forgetPendingSpawnAttributionFromResident(adopted.residentAgentId, adopted);
      state.spawnedSessionAgentIds.set(sk, adopted.actorId);
      return { ...adopted, via: 'parent' };
    }

    const resident = canonicalVisibleAgentId(parsed.residentAgentId);
    const queue = state.pendingByResident.get(resident) || [];
    if (queue.length !== 1) return undefined;
    const adopted = queue[0];
    forgetPendingSpawnAttributionFromResident(resident, adopted);
    const parentQueue = (state.pendingByParent.get(adopted.parentSessionKey) || []).filter((candidate) => candidate !== adopted);
    if (parentQueue.length) state.pendingByParent.set(adopted.parentSessionKey, parentQueue);
    else state.pendingByParent.delete(adopted.parentSessionKey);
    state.spawnedSessionAgentIds.set(sk, adopted.actorId);
    return { ...adopted, via: 'resident-singleton' };
  }

  function rememberSpawnedSessionAgent(sessionKey, agentId) {
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    const visible = canonicalVisibleAgentId(agentId);
    if (!sk || !visible) return;
    if (!state.spawnedSessionAgentIds.has(sk)) state.spawnedSessionAgentIds.set(sk, visible);
  }

  function resolveFeedAgentIdentity(ctx) {
    const parsed = parseSessionIdentity(ctx?.sessionKey, ctx?.agentId);
    const childSessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
    const adopted = childSessionKey && isAdoptableChildLane(parsed.lane)
      ? adoptPendingSpawnAttributionForSession(childSessionKey, ctx)
      : undefined;
    const visible = childSessionKey ? (state.spawnedSessionAgentIds.get(childSessionKey) || adopted?.actorId || '') : '';
    if (visible) return { agentId: visible, lane: parsed.lane, source: 'spawned' };
    const explicit = canonicalVisibleAgentId(parsed.agentId);
    if (explicit && !(isAdoptableChildLane(parsed.lane) && explicit === canonicalVisibleAgentId(parsed.residentAgentId) && parsed.agentId !== explicit)) {
      return { agentId: explicit, lane: parsed.lane, source: 'explicit' };
    }
    return {
      agentId: isAdoptableChildLane(parsed.lane) ? UNKNOWN_CHILD_ACTOR_ID : (canonicalVisibleAgentId(parsed.residentAgentId) || 'main'),
      lane: parsed.lane,
      source: 'fallback',
    };
  }

  return {
    state,
    rememberPendingSpawnAttribution,
    consumePendingSpawnAttribution,
    rememberSpawnedSessionAgent,
    resolveFeedAgentIdentity,
  };
}

assert.equal(
  inferSpawnActorId({ task: 'You are research_agent. Please verify the live API contract.' }),
  'research_agent',
  'generalized directive parsing should support arbitrary agent ids',
);
assert.equal(
  inferSpawnActorId({ task: '請讓 qa_agent 和 research_agent 一起看這題。' }),
  '',
  'ambiguous multi-agent prompt must stay unresolved',
);

const runtime = createRuntime();
const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
runtime.rememberPendingSpawnAttribution(parentSessionKey, {
  spawnAgentId: 'qa_agent',
  label: 'qa pass',
  task: 'You are qa_agent. Validate feed ordering.',
});
runtime.rememberPendingSpawnAttribution(parentSessionKey, {
  spawnAgentId: 'research_agent',
  label: 'research pass',
  task: 'You are research_agent. Gather docs.',
});

const unboundQaChild = runtime.resolveFeedAgentIdentity({
  sessionKey: 'agent:main:subagent:child-qa',
  agentId: 'main',
});
assert.equal(unboundQaChild.agentId, UNKNOWN_CHILD_ACTOR_ID, 'ambiguous sibling children must stay unknown before canonical binding');

const researchPending = runtime.consumePendingSpawnAttribution(parentSessionKey, pendingSpawnMatcherFromPayload({
  spawnAgentId: 'research_agent',
  label: 'research pass',
  task: 'You are research_agent. Gather docs.',
}));
runtime.rememberSpawnedSessionAgent('agent:main:subagent:child-research', researchPending.actorId);

const qaPending = runtime.consumePendingSpawnAttribution(parentSessionKey, pendingSpawnMatcherFromPayload({
  spawnAgentId: 'qa_agent',
  label: 'qa pass',
  task: 'You are qa_agent. Validate feed ordering.',
}));
runtime.rememberSpawnedSessionAgent('agent:main:subagent:child-qa', qaPending.actorId);

assert.equal(
  runtime.resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:child-research', agentId: 'main' }).agentId,
  'research_agent',
  'reordered spawn results must still bind the right child actor',
);
assert.equal(
  runtime.resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:child-qa', agentId: 'main' }).agentId,
  'qa_agent',
  'canonical child binding must stay immutable after bind',
);
assert.equal(
  runtime.resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:child-qa', agentId: 'coding_agent' }).agentId,
  'qa_agent',
  'canonical binding must win over noisy later ctx.agentId values',
);

console.log('feed-generalized-actor-binding-redesign: PASS');
