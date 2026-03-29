const assert = require('assert/strict');

function canonicalResidentAgentId(value) {
  if (typeof value !== 'string') return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (raw.startsWith('agent:')) {
    const parts = raw.split(':');
    return parts[1] || 'main';
  }
  return raw.replace(/^resident@/, '').split('/')[0].trim();
}

function canonicalVisibleAgentId(value) {
  if (typeof value !== 'string') return '';
  const canonical = canonicalResidentAgentId(value);
  if (!canonical) return '';
  return ['subagent', 'spawn', 'cron', 'discord', 'unknown'].includes(canonical.toLowerCase()) ? '' : canonical;
}

function resolveChildParentSessionKeys(ctx = {}) {
  const candidates = [
    ctx?.parentSessionKey,
    ctx?.parent?.sessionKey,
    ctx?.session?.parentSessionKey,
    ctx?.session?.parentKey,
    ctx?.parent?.key,
    ctx?.details?.parentSessionKey,
    ctx?.details?.parent?.sessionKey,
    ctx?.details?.session?.parentSessionKey,
    ctx?.data?.parentSessionKey,
    ctx?.payload?.parentSessionKey,
    ctx?.event?.parentSessionKey,
    ctx?.event?.details?.parentSessionKey,
  ];
  const out = [];
  for (const candidate of candidates) {
    const sk = typeof candidate === 'string' ? candidate.trim() : '';
    if (!sk || out.includes(sk)) continue;
    out.push(sk);
  }
  return out;
}

function buildHookAttributionContext(event, ctx) {
  const merged = ctx && typeof ctx === 'object' ? { ...ctx } : {};
  if (event !== undefined && merged.event === undefined) merged.event = event;
  if (merged.payload === undefined) merged.payload = event?.params ?? event?.payload;
  if (merged.data === undefined) merged.data = event?.data;
  if (merged.details === undefined) merged.details = event?.details ?? event?.result?.details;
  return merged;
}

function createRuntime() {
  const state = {
    pendingByParent: new Map(),
    observedChildSessions: new Map(),
    spawnedSessionAgentIds: new Map(),
  };

  function rememberPending(parentSessionKey, payload) {
    const entry = {
      actorId: canonicalVisibleAgentId(payload.spawnAgentId),
      parentSessionKey,
      residentAgentId: canonicalResidentAgentId(parentSessionKey),
      label: payload.label,
      task: payload.task,
    };
    state.pendingByParent.set(parentSessionKey, (state.pendingByParent.get(parentSessionKey) || []).concat([entry]));
    return entry;
  }

  function observeChild(sessionKey, source) {
    state.observedChildSessions.set(sessionKey, {
      sessionKey,
      parentSessionKeys: resolveChildParentSessionKeys(source),
      actorId: canonicalVisibleAgentId(source?.payload?.spawnAgentId || source?.event?.spawnAgentId || source?.actorId) || undefined,
      label: source?.payload?.label || source?.label,
      task: source?.payload?.task || source?.task,
    });
    return state.observedChildSessions.get(sessionKey);
  }

  function adopt(sessionKey) {
    const observed = state.observedChildSessions.get(sessionKey);
    if (!observed) return undefined;
    for (const parentSessionKey of observed.parentSessionKeys) {
      const queue = state.pendingByParent.get(parentSessionKey) || [];
      const match = queue.find((entry) => entry.actorId === observed.actorId || entry.label === observed.label);
      if (!match) continue;
      state.spawnedSessionAgentIds.set(sessionKey, match.actorId);
      return match;
    }
    return undefined;
  }

  return { state, rememberPending, observeChild, adopt };
}

const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
const childSessionKey = 'agent:main:subagent:live-event-parent-linkage-child';
const runtime = createRuntime();

runtime.rememberPending(parentSessionKey, {
  spawnAgentId: 'qa_agent',
  label: 'qa-live-parent-shape',
  task: '你是 qa_agent。只做 exact live parent linkage trace。',
});

const ctx = {
  sessionKey: childSessionKey,
  agentId: 'main',
};
const beforeToolEvent = {
  toolName: 'browser',
  details: { parentSessionKey },
  params: {
    label: 'qa-live-parent-shape',
    task: '你是 qa_agent。只做 exact live parent linkage trace。',
  },
};

const legacyObserved = runtime.observeChild(childSessionKey, ctx);
assert.deepEqual(legacyObserved.parentSessionKeys, [], 'legacy bare ctx misses event-carried parentSessionKey');
assert.equal(runtime.adopt(childSessionKey), undefined, 'legacy path cannot adopt without parent linkage');

const bridgedObserved = runtime.observeChild(childSessionKey, buildHookAttributionContext(beforeToolEvent, ctx));
assert.deepEqual(bridgedObserved.parentSessionKeys, [parentSessionKey], 'bridged hook context must capture event.details.parentSessionKey');
const adopted = runtime.adopt(childSessionKey);
assert.equal(adopted && adopted.actorId, 'qa_agent', 'captured live event linkage must unlock parent intent adoption');
assert.equal(runtime.state.spawnedSessionAgentIds.get(childSessionKey), 'qa_agent', 'child session should bind to qa_agent after event-shape capture');

console.log('feed-live-parent-linkage-event-shape-regression: PASS');
