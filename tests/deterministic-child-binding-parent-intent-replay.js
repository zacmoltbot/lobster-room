const assert = require('assert');

function parseSessionIdentity(sessionKey, fallbackAgentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey) : '';
  const parts = sk ? sk.split(':') : [];
  if (parts.length >= 3 && parts[0] === 'agent') {
    const residentAgentId = parts[1] || 'main';
    const lane = parts[2] || 'main';
    if (lane === 'main') return { agentId: residentAgentId, residentAgentId, lane };
    const tail = parts.slice(3).filter(Boolean).join(':');
    return { agentId: tail ? `${residentAgentId}/${lane}:${tail}` : `${residentAgentId}/${lane}`, residentAgentId, lane };
  }
  const id = typeof fallbackAgentId === 'string' ? fallbackAgentId.trim() : '';
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
  return ['subagent', 'spawn', 'cron', 'discord'].includes(canonical.toLowerCase()) ? '' : canonical;
}

function createRuntime() {
  let seq = 0;
  const state = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
    observedChildSessions: new Map(),
  };

  function nextIntentId() { seq += 1; return `spawn-intent:${seq}`; }
  function enqueue(bucket, key, entry) { bucket.set(key, (bucket.get(key) || []).concat([entry])); }
  function forgetResident(entry) {
    const queue = state.pendingByResident.get(entry.residentAgentId) || [];
    const next = queue.filter((candidate) => candidate !== entry);
    if (next.length) state.pendingByResident.set(entry.residentAgentId, next); else state.pendingByResident.delete(entry.residentAgentId);
  }
  function bind(sessionKey, actorId) {
    state.spawnedSessionAgentIds.set(sessionKey, canonicalVisibleAgentId(actorId));
    state.observedChildSessions.delete(sessionKey);
  }
  function rememberPending(parentSessionKey, actorId) {
    const entry = {
      intentId: nextIntentId(),
      actorId: canonicalVisibleAgentId(actorId),
      parentSessionKey,
      residentAgentId: canonicalResidentAgentId(parentSessionKey),
      createdAt: seq,
    };
    enqueue(state.pendingByParent, parentSessionKey, entry);
    enqueue(state.pendingByResident, entry.residentAgentId, entry);
    return entry;
  }
  function observeChild(sessionKey, parentSessionKey, actorHint) {
    state.observedChildSessions.set(sessionKey, { sessionKey, parentSessionKeys: [parentSessionKey], actorId: canonicalVisibleAgentId(actorHint) || undefined });
    const queue = state.pendingByParent.get(parentSessionKey) || [];
    const index = actorHint ? queue.findIndex((entry) => entry.actorId === canonicalVisibleAgentId(actorHint)) : 0;
    if (index < 0) return undefined;
    const [adopted] = queue.splice(index, 1);
    if (queue.length) state.pendingByParent.set(parentSessionKey, queue); else state.pendingByParent.delete(parentSessionKey);
    forgetResident(adopted);
    adopted.childSessionKey = sessionKey;
    bind(sessionKey, adopted.actorId);
    return adopted;
  }
  return { state, rememberPending, observeChild };
}

const runtime = createRuntime();
const parentSessionKey = 'agent:main:discord:channel:room';
const childA = 'agent:main:subagent:child-a';
const childB = 'agent:main:subagent:child-b';

const intentA = runtime.rememberPending(parentSessionKey, 'qa_agent');
const intentB = runtime.rememberPending(parentSessionKey, 'coding_agent');

const adoptedA = runtime.observeChild(childA, parentSessionKey);
const adoptedB = runtime.observeChild(childB, parentSessionKey);

assert.equal(adoptedA.intentId, intentA.intentId, 'first observed child must bind to first parent intent deterministically');
assert.equal(adoptedB.intentId, intentB.intentId, 'second observed child must bind to second parent intent deterministically');
assert.equal(runtime.state.spawnedSessionAgentIds.get(childA), 'qa_agent');
assert.equal(runtime.state.spawnedSessionAgentIds.get(childB), 'coding_agent');
assert.equal((runtime.state.pendingByParent.get(parentSessionKey) || []).length, 0, 'parent intent queue should fully drain after both children bind');

console.log('PASS deterministic child binding parent intent replay');
