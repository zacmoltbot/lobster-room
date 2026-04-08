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
  return raw.replace(/^resident@/, '').split('/')[0].trim();
}

function canonicalVisibleAgentId(value) {
  const canonical = canonicalResidentAgentId(value);
  if (!canonical) return '';
  return ['subagent', 'spawn', 'cron', 'discord', 'unknown'].includes(canonical.toLowerCase()) ? '' : canonical;
}

function normalize(value, max = 240) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

const UNKNOWN_CHILD_ACTOR_ID = 'unknown';
const isAdoptableChildLane = (lane) => String(lane || '').trim().toLowerCase() === 'subagent';

function matcherVariants(matcher = {}) {
  const normalized = {
    actorId: canonicalVisibleAgentId(matcher.actorId) || undefined,
    label: normalize(matcher.label, 120) || undefined,
    task: normalize(matcher.task, 240) || undefined,
  };
  const variants = [
    normalized,
    normalized.actorId ? { actorId: normalized.actorId } : undefined,
    normalized.label ? { label: normalized.label } : undefined,
    normalized.task ? { task: normalized.task } : undefined,
    (!normalized.actorId && !normalized.label && !normalized.task) ? {} : undefined,
  ].filter(Boolean);
  const seen = new Set();
  return variants.filter((variant) => {
    const key = JSON.stringify(variant);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pick(bucket, key, matcher = {}) {
  const queue = bucket.get(key) || [];
  if (!queue.length) return undefined;
  const actorId = canonicalVisibleAgentId(matcher.actorId);
  const label = normalize(matcher.label, 120);
  const task = normalize(matcher.task, 240);
  const scored = queue.map((entry, index) => {
    let score = 0;
    if (actorId) {
      if (entry.actorId !== actorId) return { entry, index, score: -1 };
      score += 8;
    }
    if (label) {
      if (normalize(entry.label, 120) !== label) return { entry, index, score: -1 };
      score += 4;
    }
    if (task) {
      if (normalize(entry.task, 240) !== task) return { entry, index, score: -1 };
      score += 4;
    }
    if (!actorId && !label && !task) score = 1;
    else if (entry.source === 'explicit') score += 1;
    return { entry, index, score };
  }).filter((candidate) => candidate.score >= 0);
  if (!scored.length) return undefined;
  const bestScore = Math.max(...scored.map((candidate) => candidate.score));
  const winners = scored.filter((candidate) => candidate.score === bestScore);
  if (bestScore <= 0 || winners.length !== 1) return undefined;
  const [picked] = queue.splice(winners[0].index, 1);
  if (queue.length) bucket.set(key, queue); else bucket.delete(key);
  return picked;
}

function createRuntime() {
  const state = {
    pendingByParent: new Map(),
    pendingByResident: new Map(),
    observedChildSessions: new Map(),
    spawnedSessionAgentIds: new Map(),
    feed: [],
  };

  function bind(sessionKey, actorId) {
    state.spawnedSessionAgentIds.set(sessionKey, actorId);
    state.observedChildSessions.delete(sessionKey);
  }

  function observeChild(sessionKey, ctx = {}) {
    state.observedChildSessions.set(sessionKey, {
      sessionKey,
      residentAgentId: canonicalResidentAgentId(sessionKey),
      parentSessionKeys: ctx.parentSessionKeys || [],
      actorId: canonicalVisibleAgentId(ctx.actorId) || undefined,
      label: normalize(ctx.label, 120) || undefined,
      task: normalize(ctx.task, 240) || undefined,
    });
  }

  function rememberPending(parentSessionKey, payload) {
    const entry = {
      actorId: canonicalVisibleAgentId(payload.spawnAgentId),
      parentSessionKey,
      residentAgentId: canonicalResidentAgentId(parentSessionKey),
      label: normalize(payload.label, 120) || undefined,
      task: normalize(payload.task, 240) || undefined,
      source: payload.explicit === false ? 'inferred' : 'explicit',
    };
    state.pendingByParent.set(parentSessionKey, (state.pendingByParent.get(parentSessionKey) || []).concat([entry]));
    state.pendingByResident.set(entry.residentAgentId, (state.pendingByResident.get(entry.residentAgentId) || []).concat([entry]));
    for (const observed of Array.from(state.observedChildSessions.values())) {
      if (observed.residentAgentId !== entry.residentAgentId) continue;
      adopt(observed.sessionKey, observed);
    }
    return entry;
  }

  function adopt(sessionKey, ctx = {}) {
    if (state.spawnedSessionAgentIds.has(sessionKey)) return state.spawnedSessionAgentIds.get(sessionKey);
    const observed = state.observedChildSessions.get(sessionKey) || {};
    const matcher = {
      actorId: ctx.actorId || observed.actorId,
      label: ctx.label || observed.label,
      task: ctx.task || observed.task,
    };
    const parentSessionKeys = Array.from(new Set([...(ctx.parentSessionKeys || []), ...(observed.parentSessionKeys || [])].filter(Boolean)));
    for (const parentSessionKey of parentSessionKeys) {
      let adopted;
      for (const variant of matcherVariants(matcher)) {
        adopted = pick(state.pendingByParent, parentSessionKey, variant);
        if (adopted) break;
      }
      if (!adopted) continue;
      bind(sessionKey, adopted.actorId);
      return adopted.actorId;
    }
    const resident = canonicalVisibleAgentId(parseSessionIdentity(sessionKey).residentAgentId);
    const eligible = (state.pendingByResident.get(resident) || []).filter((entry) => parseSessionIdentity(entry.parentSessionKey, entry.residentAgentId).lane !== 'cron');
    if (eligible.length === 1 && !matcher.actorId && !matcher.label && !matcher.task) {
      bind(sessionKey, eligible[0].actorId);
      return eligible[0].actorId;
    }
    return undefined;
  }

  function resolveFeedAgentIdentity(ctx = {}) {
    const parsed = parseSessionIdentity(ctx.sessionKey, ctx.agentId);
    const childSessionKey = typeof ctx.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
    const adopted = childSessionKey && isAdoptableChildLane(parsed.lane) ? adopt(childSessionKey, ctx) : undefined;
    const visible = childSessionKey ? (state.spawnedSessionAgentIds.get(childSessionKey) || adopted || '') : '';
    if (visible) return { agentId: visible, rawAgentId: parsed.agentId, lane: parsed.lane, source: 'spawned' };
    return {
      agentId: isAdoptableChildLane(parsed.lane) ? UNKNOWN_CHILD_ACTOR_ID : (canonicalVisibleAgentId(parsed.residentAgentId) || 'main'),
      rawAgentId: parsed.agentId,
      lane: parsed.lane,
      source: 'fallback',
    };
  }

  function resolveVisibleSessionBucket(sk) {
    const raw = typeof sk === 'string' ? sk.trim() : '';
    if (!raw) return { agentId: null, source: 'none' };
    const visible = state.spawnedSessionAgentIds.get(raw);
    if (visible && visible !== UNKNOWN_CHILD_ACTOR_ID) return { agentId: visible, source: 'spawned' };
    const parsed = parseSessionIdentity(raw);
    if (isAdoptableChildLane(parsed.lane)) return { agentId: null, source: 'none' };
    const resident = canonicalVisibleAgentId(parsed.residentAgentId);
    return { agentId: resident || null, source: resident ? 'resident' : 'none' };
  }

  function pushFeed(item) {
    state.feed.push(item);
  }

  function feedGet() {
    const grouped = new Map();
    for (const item of state.feed) {
      const key = item.sessionKey;
      grouped.set(key, (grouped.get(key) || []).concat([item]));
    }
    const tasks = Array.from(grouped.values()).map((items) => ({
      sessionKey: items[0].sessionKey,
      agentId: resolveFeedAgentIdentity(items[items.length - 1]).agentId,
      items: items.map((it) => ({ kind: it.kind, agentId: resolveFeedAgentIdentity(it).agentId })),
    }));
    return {
      rows: state.feed.map((it) => ({ kind: it.kind, sessionKey: it.sessionKey, agentId: resolveFeedAgentIdentity(it).agentId })),
      tasks,
      latest: state.feed.length ? { kind: state.feed[state.feed.length - 1].kind, sessionKey: state.feed[state.feed.length - 1].sessionKey, agentId: resolveFeedAgentIdentity(state.feed[state.feed.length - 1]).agentId } : null,
    };
  }

  return { state, observeChild, rememberPending, resolveFeedAgentIdentity, resolveVisibleSessionBucket, pushFeed, feedGet };
}

const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
const childSessionKey = 'agent:main:subagent:unknown-child-cluster';

// target live-shaped case: parent/main orchestration exists, child work exists, child initially unknown.
const runtime = createRuntime();
runtime.observeChild(childSessionKey, {
  parentSessionKeys: [parentSessionKey],
  actorId: 'qa_agent',
  task: 'qa child runtime prompt diverged after start, should not block actor binding',
});

const beforeBinding = runtime.resolveFeedAgentIdentity({ sessionKey: childSessionKey, agentId: 'main' });
assert.equal(beforeBinding.agentId, UNKNOWN_CHILD_ACTOR_ID, 'child stays honestly unknown before canonical proof arrives');
assert.deepEqual(runtime.resolveVisibleSessionBucket(childSessionKey), { agentId: null, source: 'none' }, 'Now/room bucketing must not lie by collapsing unresolved child to main');

runtime.pushFeed({ kind: 'before_agent_start', sessionKey: childSessionKey, agentId: 'main' });
runtime.pushFeed({ kind: 'before_tool_call', sessionKey: childSessionKey, agentId: 'main' });
assert.equal(runtime.feedGet().latest.agentId, UNKNOWN_CHILD_ACTOR_ID, 'visible latest must stay honest while child is still unresolved');

runtime.rememberPending(parentSessionKey, {
  spawnAgentId: 'qa_agent',
  label: 'qa-live-unknown-child-cluster-fix',
  task: '你是 qa_agent。請重放 unknown child cluster lane assignment fixture，確認 feed/Now 不會誤導成全 idle。',
});

const afterBinding = runtime.resolveFeedAgentIdentity({ sessionKey: childSessionKey, agentId: 'main' });
assert.equal(afterBinding.agentId, 'qa_agent', 'same observed unknown child cluster should rebind to qa_agent once reliable parent intent arrives');
assert.deepEqual(runtime.resolveVisibleSessionBucket(childSessionKey), { agentId: 'qa_agent', source: 'spawned' }, 'Now/room bucketing must follow canonical child actor after binding');

const feed = runtime.feedGet();
assert.ok(feed.rows.every((row) => row.agentId === 'qa_agent'), 'feed rows must all rebind from unknown to qa_agent');
assert.equal(feed.tasks[0].agentId, 'qa_agent', 'task actor must rebind from unknown to qa_agent');
assert.equal(feed.latest.agentId, 'qa_agent', 'latest must rebind from unknown to qa_agent');

console.log('feed-unknown-child-lane-assignment-replay: PASS');
