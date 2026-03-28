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
  const slash = raw.replace(/^resident@/, '').indexOf('/');
  return (slash >= 0 ? raw.replace(/^resident@/, '').slice(0, slash) : raw.replace(/^resident@/, '')).trim();
}

function canonicalVisibleAgentId(value) {
  const canonical = canonicalResidentAgentId(value);
  if (!canonical) return '';
  return ['subagent', 'spawn', 'cron', 'discord'].includes(canonical.toLowerCase()) ? '' : canonical;
}

function normalize(value, max = 240) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function inferSpawnActorId(payload) {
  return canonicalVisibleAgentId(payload?.spawnAgentId || payload?.agentId || (/qa[_ -]?agent/i.test(String(payload?.task || '')) ? 'qa_agent' : ''));
}

function isAdoptableChildLane(lane) { return String(lane || '').trim().toLowerCase() === 'subagent'; }
function hasAdoptableChildProof(sessionKey, residentAgentId) {
  const parsed = parseSessionIdentity(sessionKey, residentAgentId);
  return isAdoptableChildLane(parsed.lane) && canonicalResidentAgentId(residentAgentId || parsed.residentAgentId) === parsed.residentAgentId;
}

function createRuntime() {
  const state = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
    observedChildSessions: new Map(),
    feed: [],
  };

  function persist() {
    return {
      spawnedSessionAgentIds: Object.fromEntries(state.spawnedSessionAgentIds.entries()),
      pending: Array.from(state.pendingByParent.values()).flat(),
      observedChildSessions: Array.from(state.observedChildSessions.values()),
    };
  }

  function mergeObserved(entry) {
    const existing = state.observedChildSessions.get(entry.sessionKey);
    state.observedChildSessions.set(entry.sessionKey, {
      ...existing,
      ...entry,
      parentSessionKeys: Array.from(new Set([...(existing?.parentSessionKeys || []), ...(entry.parentSessionKeys || [])].filter(Boolean))),
    });
  }

  function bind(sessionKey, actorId) {
    const visible = canonicalVisibleAgentId(actorId);
    if (!visible || !hasAdoptableChildProof(sessionKey, parseSessionIdentity(sessionKey).residentAgentId)) return false;
    state.spawnedSessionAgentIds.set(sessionKey, visible);
    state.observedChildSessions.delete(sessionKey);
    return true;
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
        if (entry.actorId !== actorId) return { index, score: -1 };
        score += 8;
      }
      if (label) {
        if (normalize(entry.label, 120) !== label) return { index, score: -1 };
        score += 4;
      }
      if (task) {
        if (normalize(entry.task, 240) !== task) return { index, score: -1 };
        score += 4;
      }
      if (!actorId && !label && !task) score = 1;
      return { index, score };
    }).filter((x) => x.score >= 0);
    if (!scored.length) return undefined;
    const best = Math.max(...scored.map((x) => x.score));
    const winners = scored.filter((x) => x.score === best);
    if (best <= 0 || winners.length !== 1) return undefined;
    const [pickedEntry] = queue.splice(winners[0].index, 1);
    if (queue.length) bucket.set(key, queue); else bucket.delete(key);
    return pickedEntry;
  }

  function forgetResident(entry) {
    const queue = state.pendingByResident.get(entry.residentAgentId) || [];
    const next = queue.filter((candidate) => candidate !== entry);
    if (next.length) state.pendingByResident.set(entry.residentAgentId, next); else state.pendingByResident.delete(entry.residentAgentId);
  }

  function adopt(sessionKey, ctx = {}) {
    if (state.spawnedSessionAgentIds.has(sessionKey)) return { actorId: state.spawnedSessionAgentIds.get(sessionKey) };
    const observed = state.observedChildSessions.get(sessionKey);
    const matcher = {
      actorId: canonicalVisibleAgentId(ctx.actorId || observed?.actorId),
      label: normalize(ctx.label || observed?.label, 120),
      task: normalize(ctx.task || observed?.task, 240),
    };
    const parentKeys = Array.from(new Set([...(ctx.parentSessionKeys || []), ...(observed?.parentSessionKeys || [])].filter(Boolean)));
    for (const parentSessionKey of parentKeys) {
      const adopted = pick(state.pendingByParent, parentSessionKey, matcher);
      if (!adopted) continue;
      forgetResident(adopted);
      bind(sessionKey, adopted.actorId);
      return adopted;
    }
    const resident = canonicalVisibleAgentId(parseSessionIdentity(sessionKey).residentAgentId);
    const eligible = (state.pendingByResident.get(resident) || []).filter((entry) => parseSessionIdentity(entry.parentSessionKey, entry.residentAgentId).lane !== 'cron');
    if (eligible.length === 1 && !matcher.actorId && !matcher.label && !matcher.task) {
      const adopted = eligible[0];
      forgetResident(adopted);
      const parentQueue = state.pendingByParent.get(adopted.parentSessionKey) || [];
      state.pendingByParent.set(adopted.parentSessionKey, parentQueue.filter((candidate) => candidate !== adopted));
      if (!(state.pendingByParent.get(adopted.parentSessionKey) || []).length) state.pendingByParent.delete(adopted.parentSessionKey);
      bind(sessionKey, adopted.actorId);
      return adopted;
    }
    return undefined;
  }

  function observeChild(sessionKey, ctx = {}) {
    mergeObserved({
      sessionKey,
      residentAgentId: canonicalResidentAgentId(sessionKey),
      parentSessionKeys: ctx.parentSessionKeys || [],
      actorId: canonicalVisibleAgentId(ctx.actorId),
      label: normalize(ctx.label, 120) || undefined,
      task: normalize(ctx.task, 240) || undefined,
      observedAt: 1,
    });
    return adopt(sessionKey, ctx);
  }

  function rememberPending(parentSessionKey, payload) {
    const entry = {
      actorId: inferSpawnActorId(payload),
      parentSessionKey,
      residentAgentId: canonicalResidentAgentId(parentSessionKey),
      label: normalize(payload?.label, 120) || undefined,
      task: normalize(payload?.task, 240) || undefined,
      source: 'explicit',
      createdAt: 2,
    };
    state.pendingByParent.set(parentSessionKey, (state.pendingByParent.get(parentSessionKey) || []).concat([entry]));
    state.pendingByResident.set(entry.residentAgentId, (state.pendingByResident.get(entry.residentAgentId) || []).concat([entry]));
    for (const observed of Array.from(state.observedChildSessions.values())) {
      if (observed.residentAgentId !== entry.residentAgentId) continue;
      adopt(observed.sessionKey, observed);
    }
    return entry;
  }

  function resolveVisibleFeedItemAgentId(item) {
    const bound = state.spawnedSessionAgentIds.get(item.sessionKey);
    return bound || canonicalVisibleAgentId(item.agentId) || 'unknown';
  }

  function feedGet() {
    const rows = state.feed.map((item) => ({ ...item, agentId: resolveVisibleFeedItemAgentId(item) }));
    const childTask = { sessionKey: state.feed[0].sessionKey, agentId: rows[0].agentId };
    return { rows, latest: rows[rows.length - 1], tasks: [childTask] };
  }

  return { state, persist, rememberPending, observeChild, bind, adopt, feedGet };
}

const runtime = createRuntime();
const parentSessionKey = 'agent:main:main';
const childSessionKey = 'agent:main:subagent:qa-live-child';

runtime.state.feed.push(
  { ts: 1, kind: 'before_agent_start', sessionKey: childSessionKey, agentId: 'main', rawAgentId: 'main/subagent:qa-live-child' },
  { ts: 2, kind: 'before_tool_call', sessionKey: childSessionKey, agentId: 'main', rawAgentId: 'main/subagent:qa-live-child', toolName: 'browser' },
);

assert.equal(runtime.observeChild(childSessionKey), undefined, 'child-first event should stay unresolved before pending proof exists');
let disk = runtime.persist();
assert.equal(disk.spawnedSessionAgentIds[childSessionKey], undefined, 'no canonical bind should exist yet');
assert.equal(disk.observedChildSessions[0].sessionKey, childSessionKey, 'writer should persist observed unbound child key for later reconciliation');

runtime.rememberPending(parentSessionKey, {
  spawnAgentId: 'qa_agent',
  label: 'qa acceptance',
  task: '你是 qa_agent。請重放 live writer-side adoption path。',
});

disk = runtime.persist();
assert.equal(disk.spawnedSessionAgentIds[childSessionKey], 'qa_agent', 'pending write must reconcile previously observed child into canonical persisted map');
assert.equal(disk.observedChildSessions.length, 0, 'reconciled child should leave observed backlog');
assert.equal(runtime.state.pendingByResident.get('main'), undefined, 'pending proof should be consumed once canonical child bind lands');

const feed = runtime.feedGet();
assert.ok(feed.rows.every((row) => row.agentId === 'qa_agent'), 'stored child rows must rebind through canonical persisted child map');
assert.equal(feed.latest.agentId, 'qa_agent');
assert.equal(feed.tasks[0].agentId, 'qa_agent');

console.log('PASS writer-side persisted adoption replay');
