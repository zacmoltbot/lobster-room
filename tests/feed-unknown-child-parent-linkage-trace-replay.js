const assert = require('assert/strict');

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
  return raw.replace(/^resident@/, '').split('/')[0].trim();
}

function canonicalVisibleAgentId(value) {
  if (typeof value !== 'string') return '';
  const canonical = canonicalResidentAgentId(value);
  if (!canonical) return '';
  return ['subagent', 'spawn', 'cron', 'discord', 'unknown'].includes(canonical.toLowerCase()) ? '' : canonical;
}

function normalize(value, max = 240) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
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

function createRuntime() {
  const state = {
    pendingByParent: new Map(),
    observedChildSessions: new Map(),
    spawnedSessionAgentIds: new Map(),
    feed: [],
  };

  function rememberPending(parentSessionKey, payload) {
    const entry = {
      actorId: canonicalVisibleAgentId(payload.spawnAgentId),
      parentSessionKey,
      residentAgentId: canonicalResidentAgentId(parentSessionKey),
      label: normalize(payload.label, 120) || undefined,
      task: normalize(payload.task, 240) || undefined,
      source: 'explicit',
    };
    state.pendingByParent.set(parentSessionKey, (state.pendingByParent.get(parentSessionKey) || []).concat([entry]));
    return entry;
  }

  function observeChild(sessionKey, ctx = {}) {
    state.observedChildSessions.set(sessionKey, {
      sessionKey,
      residentAgentId: canonicalResidentAgentId(sessionKey),
      parentSessionKeys: resolveChildParentSessionKeys(ctx),
      actorId: canonicalVisibleAgentId(ctx.actorId) || undefined,
      label: normalize(ctx.label, 120) || undefined,
      task: normalize(ctx.task, 240) || undefined,
    });
  }

  function adopt(sessionKey) {
    const observed = state.observedChildSessions.get(sessionKey);
    if (!observed) return undefined;
    for (const parentSessionKey of observed.parentSessionKeys) {
      const queue = state.pendingByParent.get(parentSessionKey) || [];
      const match = queue.find((entry) => entry.actorId === observed.actorId || normalize(entry.label, 120) === normalize(observed.label, 120));
      if (!match) continue;
      state.spawnedSessionAgentIds.set(sessionKey, match.actorId);
      return match.actorId;
    }
    return undefined;
  }

  function resolveFeedAgentIdentity(item) {
    const parsed = parseSessionIdentity(item.sessionKey, item.agentId);
    if (parsed.lane !== 'subagent') return canonicalVisibleAgentId(item.agentId) || 'main';
    return state.spawnedSessionAgentIds.get(item.sessionKey) || 'unknown';
  }

  function latestFor(agentId) {
    for (let i = state.feed.length - 1; i >= 0; i -= 1) {
      if (resolveFeedAgentIdentity(state.feed[i]) === agentId) return state.feed[i];
    }
    return null;
  }

  function trace(childSessionKey, agentId) {
    const observed = state.observedChildSessions.get(childSessionKey);
    const parentSessionKeys = observed?.parentSessionKeys || [];
    const pending = parentSessionKeys.flatMap((key) => (state.pendingByParent.get(key) || []).filter((entry) => !agentId || entry.actorId === agentId));
    const feedTruth = latestFor(agentId);
    return {
      observedChildExists: !!observed,
      observedParentSessionKeys: parentSessionKeys,
      pendingParentIntentCount: pending.length,
      spawnedSessionAgentId: state.spawnedSessionAgentIds.get(childSessionKey) || null,
      feedTruthAgentId: feedTruth ? resolveFeedAgentIdentity(feedTruth) : null,
      feedTruthSessionKey: feedTruth?.sessionKey || null,
      freshCanonicalChildFeedCluster: !!(feedTruth && state.spawnedSessionAgentIds.get(feedTruth.sessionKey) === agentId),
    };
  }

  return { state, rememberPending, observeChild, adopt, resolveFeedAgentIdentity, latestFor, trace };
}

const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
const childSessionKey = 'agent:main:subagent:qa-nested-parent-proof';
const runtime = createRuntime();

runtime.rememberPending(parentSessionKey, {
  spawnAgentId: 'qa_agent',
  label: 'qa-live-unknown-child-cluster-fix',
  task: '你是 qa_agent。請重放 unknown child cluster lane assignment fixture，確認 feed/Now 不會誤導成全 idle。',
});
runtime.state.feed.push({ ts: 1, kind: 'before_tool_call', sessionKey: childSessionKey, agentId: 'main', toolName: 'browser' });

runtime.observeChild(childSessionKey, {
  details: { parentSessionKey },
  actorId: 'qa_agent',
  label: 'qa-live-unknown-child-cluster-fix',
});

const phase1 = runtime.trace(childSessionKey, 'qa_agent');
assert.equal(phase1.observedChildExists, true, 'state 1 should exist');
assert.deepEqual(phase1.observedParentSessionKeys, [parentSessionKey], 'state 2 should retain nested detail parent linkage');
assert.equal(phase1.pendingParentIntentCount, 1, 'state 3 should see the matching parent intent');
assert.equal(phase1.spawnedSessionAgentId, null, 'before adoption state 4 is still empty');

runtime.adopt(childSessionKey);
const phase2 = runtime.trace(childSessionKey, 'qa_agent');
assert.equal(phase2.spawnedSessionAgentId, 'qa_agent', 'state 4 should bind canonical actor');
assert.equal(runtime.resolveFeedAgentIdentity(runtime.state.feed[0]), 'qa_agent', 'state 5 feed row should promote to qa_agent');
assert.equal(phase2.feedTruthSessionKey, childSessionKey, 'state 6 feed truth should point at the child session');
assert.equal(phase2.freshCanonicalChildFeedCluster, true, 'state 6 should confirm canonical child feed cluster');

console.log('feed-unknown-child-parent-linkage-trace-replay: PASS');
