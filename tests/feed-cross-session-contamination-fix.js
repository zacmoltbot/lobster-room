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

function shouldPersistSpawnedSessionAgent(sessionKey, agentId) {
  const visible = canonicalVisibleAgentId(agentId);
  if (!visible) return false;
  return hasAdoptableChildProof(sessionKey, parseSessionIdentity(sessionKey).residentAgentId);
}

function inferSpawnActorId(payload) {
  for (const candidate of [payload?.agentId, payload?.spawnAgentId, payload?.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  const text = [payload?.label, payload?.task, payload?.prompt, payload?.instructions]
    .map((part) => normalizeSpawnText(part, 400))
    .filter(Boolean)
    .join('\n');
  if (!text) return '';
  const actorHints = [
    {
      actorId: 'qa_agent',
      directivePatterns: [/\byou are\s+qa[_ -]?agent\b/i, /你是\s*qa[_ -]?agent/i, /角色[:：]?\s*qa[_ -]?agent/i],
      mentionPatterns: [/\bqa[_ -]?agent\b/gi],
    },
    {
      actorId: 'coding_agent',
      directivePatterns: [/\byou are\s+coding[_ -]?agent\b/i, /你是\s*coding[_ -]?agent/i, /角色[:：]?\s*coding[_ -]?agent/i],
      mentionPatterns: [/\bcoding[_ -]?agent\b/gi],
    },
  ];
  const directiveMatches = actorHints
    .filter((hint) => hint.directivePatterns.some((pattern) => pattern.test(text)))
    .map((hint) => hint.actorId);
  if (directiveMatches.length === 1) return directiveMatches[0] || '';
  if (directiveMatches.length > 1) return '';
  const mentionMatches = actorHints
    .filter((hint) => hint.mentionPatterns.some((pattern) => Array.from(text.matchAll(pattern)).length > 0))
    .map((hint) => hint.actorId);
  if (mentionMatches.length === 1) return mentionMatches[0] || '';
  return '';
}

function createRuntime(seedState = {}) {
  const state = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
  };

  const spawned = seedState.spawnedSessionAgentIds || {};
  for (const [sessionKey, agentId] of Object.entries(spawned)) {
    if (shouldPersistSpawnedSessionAgent(sessionKey, agentId)) state.spawnedSessionAgentIds.set(sessionKey, agentId);
  }

  function rememberPendingSpawnAttribution(parentSessionKey, payload) {
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    const actorId = inferSpawnActorId(payload);
    const residentAgentId = canonicalResidentAgentId(sk);
    if (!sk || !actorId || !residentAgentId) return undefined;
    const entry = { actorId, parentSessionKey: sk, residentAgentId };
    state.pendingByParent.set(sk, (state.pendingByParent.get(sk) || []).concat([entry]));
    state.pendingByResident.set(residentAgentId, (state.pendingByResident.get(residentAgentId) || []).concat([entry]));
    return entry;
  }

  function adoptPendingSpawnAttributionForSession(sessionKey, residentAgentId) {
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (!sk || !hasAdoptableChildProof(sk, residentAgentId)) return undefined;
    const existing = state.spawnedSessionAgentIds.get(sk);
    if (existing) return { actorId: existing, via: 'spawned' };
    const resident = canonicalVisibleAgentId(residentAgentId);
    const queue = state.pendingByResident.get(resident) || [];
    const adopted = queue.find((candidate) => {
      if (!candidate) return false;
      if (candidate.parentSessionKey === sk) return false;
      const parentParsed = parseSessionIdentity(candidate.parentSessionKey, candidate.residentAgentId);
      return parentParsed.residentAgentId === resident && parentParsed.lane !== 'cron';
    });
    if (!adopted) return undefined;
    const nextResident = queue.filter((candidate) => candidate !== adopted);
    if (nextResident.length) state.pendingByResident.set(resident, nextResident);
    else state.pendingByResident.delete(resident);
    const parentQueue = (state.pendingByParent.get(adopted.parentSessionKey) || []).filter((candidate) => candidate !== adopted);
    if (parentQueue.length) state.pendingByParent.set(adopted.parentSessionKey, parentQueue);
    else state.pendingByParent.delete(adopted.parentSessionKey);
    state.spawnedSessionAgentIds.set(sk, adopted.actorId);
    return { ...adopted, via: 'pending' };
  }

  function resolveFeedAgentIdentity(ctx) {
    const parsed = parseSessionIdentity(ctx?.sessionKey, ctx?.agentId);
    const childSessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
    const adopted = childSessionKey && isAdoptableChildLane(parsed.lane)
      ? adoptPendingSpawnAttributionForSession(childSessionKey, parsed.residentAgentId)
      : undefined;
    const visible = childSessionKey
      ? (state.spawnedSessionAgentIds.get(childSessionKey) || adopted?.actorId || '')
      : '';
    return {
      agentId: visible || canonicalVisibleAgentId(parsed.agentId) || canonicalVisibleAgentId(parsed.residentAgentId) || 'main',
      rawAgentId: parsed.agentId,
      lane: parsed.lane,
    };
  }

  return { state, rememberPendingSpawnAttribution, adoptPendingSpawnAttributionForSession, resolveFeedAgentIdentity };
}

assert.equal(
  inferSpawnActorId({ task: '請 review qa_agent 的報告。你是 coding_agent，直接修。' }),
  'coding_agent',
  'explicit directive should beat mixed-agent prompt mentions',
);
assert.equal(
  inferSpawnActorId({ task: '請讓 qa_agent 和 coding_agent 一起看這題。' }),
  '',
  'ambiguous mixed mentions without directive should return empty',
);

const runtime = createRuntime({
  spawnedSessionAgentIds: {
    'agent:main:discord:channel:stale': 'qa_agent',
    'agent:main:cron:daily': 'coding_agent',
    'agent:main:subagent:real-child': 'qa_agent',
  },
});
assert.deepStrictEqual(
  [...runtime.state.spawnedSessionAgentIds.entries()],
  [['agent:main:subagent:real-child', 'qa_agent']],
  'state hydration should prune stale discord/cron contamination and keep legal child mapping',
);

runtime.rememberPendingSpawnAttribution('agent:main:discord:channel:1476111438186680416', {
  task: '你是 qa_agent。請做 acceptance checks。',
});
assert.equal(
  runtime.resolveFeedAgentIdentity({ sessionKey: 'agent:main:discord:channel:1476111438186680416', agentId: 'main' }).agentId,
  'main',
  'discord lane must not adopt resident pending attribution',
);
assert.equal(
  runtime.resolveFeedAgentIdentity({ sessionKey: 'agent:main:cron:nightly', agentId: 'main' }).agentId,
  'main',
  'cron lane must not adopt resident pending attribution by default',
);
assert.equal(
  runtime.resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:child-qa', agentId: 'main' }).agentId,
  'qa_agent',
  'real child subagent should still adopt pending attribution',
);

const runtimeCronParent = createRuntime();
runtimeCronParent.rememberPendingSpawnAttribution('agent:main:cron:builder', {
  task: '你是 coding_agent。請修 build。',
});
assert.equal(
  runtimeCronParent.resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:child-from-cron-pending', agentId: 'main' }).agentId,
  'main',
  'resident-only adoption must reject cron-origin pending attribution without stronger proof',
);

console.log('feed-cross-session-contamination-fix: PASS');
