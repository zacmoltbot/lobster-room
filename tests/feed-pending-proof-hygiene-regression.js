const assert = require('assert/strict');

const UNKNOWN_CHILD_ACTOR_ID = 'unknown';
const PENDING_SPAWN_ATTRIBUTION_TTL_MS = 30 * 60 * 1000;

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
  const canonical = canonicalResidentAgentId(value);
  if (!canonical) return '';
  const lower = canonical.toLowerCase();
  if (['subagent', 'spawn', 'cron', 'discord', 'unknown'].includes(lower)) return '';
  return canonical;
}

function normalizeSpawnText(value, maxLen = 240) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function pendingIdentityKey(entry) {
  return [entry.parentSessionKey, entry.residentAgentId, entry.actorId, entry.label || '', entry.task || '', entry.source].join('\u0000');
}

function createRuntime(nowMs) {
  const state = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
  };

  function prune(referenceNow = nowMs) {
    const keep = new Map();
    const collect = (entry) => {
      if (!entry) return;
      if (referenceNow - entry.createdAt > PENDING_SPAWN_ATTRIBUTION_TTL_MS) return;
      const key = pendingIdentityKey(entry);
      const existing = keep.get(key);
      if (!existing || existing.createdAt <= entry.createdAt) keep.set(key, entry);
    };
    for (const queue of state.pendingByParent.values()) for (const entry of queue) collect(entry);
    for (const queue of state.pendingByResident.values()) for (const entry of queue) collect(entry);
    state.pendingByParent.clear();
    state.pendingByResident.clear();
    for (const entry of keep.values()) {
      state.pendingByParent.set(entry.parentSessionKey, (state.pendingByParent.get(entry.parentSessionKey) || []).concat([entry]));
      state.pendingByResident.set(entry.residentAgentId, (state.pendingByResident.get(entry.residentAgentId) || []).concat([entry]));
    }
  }

  function rememberPending(parentSessionKey, payload, createdAt) {
    const actorId = canonicalVisibleAgentId(payload?.spawnAgentId || payload?.agentId);
    const residentAgentId = canonicalResidentAgentId(parentSessionKey);
    const entry = {
      actorId,
      parentSessionKey,
      residentAgentId,
      label: normalizeSpawnText(payload?.label, 120) || undefined,
      task: normalizeSpawnText(payload?.task, 240) || undefined,
      source: 'explicit',
      createdAt,
    };
    prune(createdAt);
    const identityKey = pendingIdentityKey(entry);
    for (const [bucket, key] of [[state.pendingByParent, parentSessionKey], [state.pendingByResident, residentAgentId]]) {
      const queue = bucket.get(key) || [];
      bucket.set(key, queue.filter((candidate) => pendingIdentityKey(candidate) !== identityKey).concat([entry]));
    }
  }

  function adopt(sessionKey) {
    prune(nowMs);
    const parsed = parseSessionIdentity(sessionKey);
    const resident = canonicalVisibleAgentId(parsed.residentAgentId);
    const eligible = (state.pendingByResident.get(resident) || []).filter((candidate) => parseSessionIdentity(candidate.parentSessionKey).lane !== 'cron');
    if (eligible.length !== 1) return { agentId: UNKNOWN_CHILD_ACTOR_ID, eligible: eligible.map((x) => x.actorId) };
    state.spawnedSessionAgentIds.set(sessionKey, eligible[0].actorId);
    return { agentId: eligible[0].actorId, eligible: eligible.map((x) => x.actorId) };
  }

  return { state, rememberPending, adopt, prune };
}

const nowMs = Date.now();
const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
const childSessionKey = 'agent:main:subagent:live-qa-child';

// Legacy live-fail shape: dirty persisted resident queue with an old unrelated pending proof
// made resident fallback ambiguous, so child adoption never bound and visible actor fell to unknown.
const legacy = createRuntime(nowMs);
legacy.rememberPending(parentSessionKey, { spawnAgentId: 'coding_agent', task: 'stale previous run' }, nowMs - (PENDING_SPAWN_ATTRIBUTION_TTL_MS + 1000));
legacy.rememberPending(parentSessionKey, { spawnAgentId: 'qa_agent', task: 'current qa run' }, nowMs - 1000);
legacy.state.pendingByResident.set('main', [
  { actorId: 'coding_agent', parentSessionKey, residentAgentId: 'main', source: 'explicit', task: 'stale previous run', createdAt: nowMs - (PENDING_SPAWN_ATTRIBUTION_TTL_MS + 1000) },
  { actorId: 'qa_agent', parentSessionKey, residentAgentId: 'main', source: 'explicit', task: 'current qa run', createdAt: nowMs - 1000 },
]);
const beforePrune = (legacy.state.pendingByResident.get('main') || []).length;
legacy.prune(nowMs);
const afterPrune = (legacy.state.pendingByResident.get('main') || []).length;
const adopted = legacy.adopt(childSessionKey);

assert.equal(beforePrune, 2, 'fixture must start with ambiguous dirty resident pending proofs');
assert.equal(afterPrune, 1, 'pending hygiene must prune stale resident proofs before child adoption');
assert.equal(adopted.agentId, 'qa_agent', 'live-shaped child must bind to qa_agent after stale proof cleanup');
assert.equal(legacy.state.spawnedSessionAgentIds.get(childSessionKey), 'qa_agent', 'canonical child map must be written during adoption');

// Duplicate identical pending proofs should collapse to one semantic entry instead of poisoning later adoption.
const duplicate = createRuntime(nowMs);
duplicate.rememberPending(parentSessionKey, { spawnAgentId: 'qa_agent', label: 'qa', task: 'run acceptance' }, nowMs - 5000);
duplicate.rememberPending(parentSessionKey, { spawnAgentId: 'qa_agent', label: 'qa', task: 'run acceptance' }, nowMs - 1000);
duplicate.prune(nowMs);
assert.equal((duplicate.state.pendingByParent.get(parentSessionKey) || []).length, 1, 'semantic duplicate pending proofs must collapse to one latest entry');
assert.equal(duplicate.adopt('agent:main:subagent:deduped-qa-child').agentId, 'qa_agent', 'deduped resident fallback must still adopt the intended actor');

console.log('feed-pending-proof-hygiene-regression: PASS');
