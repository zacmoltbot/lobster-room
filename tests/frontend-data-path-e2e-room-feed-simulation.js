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

function inferSpawnActorId(payload) {
  for (const candidate of [payload?.agentId, payload?.spawnAgentId, payload?.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  const text = [payload?.label, payload?.task, payload?.prompt, payload?.instructions]
    .map((part) => normalizeSpawnText(part, 400).toLowerCase())
    .filter(Boolean)
    .join('\n');
  if (/\bqa[_ -]?agent\b/i.test(text) || /你是\s*qa[_ -]?agent/i.test(text)) return 'qa_agent';
  if (/\bcoding[_ -]?agent\b/i.test(text) || /你是\s*coding[_ -]?agent/i.test(text)) return 'coding_agent';
  return '';
}

function inferActivityFromFeedItem(item) {
  if (!item) return null;
  if (item.kind === 'before_tool_call') return 'tool';
  if (item.kind === 'after_tool_call' || item.kind === 'tool_result_persist' || item.kind === 'before_agent_start') return 'thinking';
  if (item.kind === 'agent_end') return item.success === false || !!item.error ? 'error' : 'idle';
  return null;
}

function activityNeedsFreshSession(state) {
  return state === 'thinking' || state === 'tool' || state === 'reply';
}

function createRuntime(mode) {
  const UNKNOWN_CHILD_ACTOR_ID = 'unknown';
  const state = {
    feedBuf: [],
    eventBuf: [],
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
    observedChildSessions: new Map(),
    hydrated: false,
    diskState: {
      spawnedSessionAgentIds: {},
      pending: [],
      observedChildSessions: [],
    },
  };

  const pendingKey = (entry) => String(entry.intentId || '').trim();
  const enqueue = (bucket, key, entry) => {
    bucket.set(key, (bucket.get(key) || []).concat([entry]));
  };
  const mergeIntoBucket = (bucket, key, entry) => {
    const queue = bucket.get(key) || [];
    const next = queue.filter((candidate) => pendingKey(candidate) !== pendingKey(entry));
    bucket.set(key, next.concat([entry]).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
  };
  const mergePending = (entry) => {
    mergeIntoBucket(state.pendingByParent, entry.parentSessionKey, entry);
    mergeIntoBucket(state.pendingByResident, entry.residentAgentId, entry);
  };

  async function loadState() {
    if (mode === 'buggy') {
      state.spawnedSessionAgentIds.clear();
      state.pendingByParent.clear();
      state.pendingByResident.clear();
      state.observedChildSessions.clear();
    } else if (!state.hydrated) {
      state.spawnedSessionAgentIds.clear();
      state.pendingByParent.clear();
      state.pendingByResident.clear();
      state.observedChildSessions.clear();
      state.hydrated = true;
    }

    for (const [key, value] of Object.entries(state.diskState.spawnedSessionAgentIds || {})) {
      const sk = typeof key === 'string' ? key.trim() : '';
      const actorId = canonicalVisibleAgentId(value);
      if (!sk || !actorId) continue;
      if (mode === 'buggy' || !state.spawnedSessionAgentIds.has(sk)) state.spawnedSessionAgentIds.set(sk, actorId);
    }

    for (const raw of Array.isArray(state.diskState.pending) ? state.diskState.pending : []) {
      const parentSessionKey = typeof raw?.parentSessionKey === 'string' ? raw.parentSessionKey.trim() : '';
      const residentAgentId = canonicalResidentAgentId(raw?.residentAgentId || parentSessionKey);
      const actorId = canonicalVisibleAgentId(raw?.actorId);
      if (!parentSessionKey || !residentAgentId || !actorId) continue;
      const entry = {
        intentId: typeof raw?.intentId === 'string' ? raw.intentId : 'spawn-intent:disk:1',
        actorId,
        parentSessionKey,
        residentAgentId,
        label: normalizeSpawnText(raw?.label, 120) || undefined,
        task: normalizeSpawnText(raw?.task, 240) || undefined,
        createdAt: Number(raw?.createdAt || 0),
      };
      if (mode === 'buggy') {
        enqueue(state.pendingByParent, parentSessionKey, entry);
        enqueue(state.pendingByResident, residentAgentId, entry);
      } else {
        mergePending(entry);
      }
    }

    for (const raw of Array.isArray(state.diskState.observedChildSessions) ? state.diskState.observedChildSessions : []) {
      const sessionKey = typeof raw?.sessionKey === 'string' ? raw.sessionKey.trim() : '';
      const residentAgentId = canonicalResidentAgentId(raw?.residentAgentId || sessionKey);
      if (!sessionKey || !residentAgentId) continue;
      const observed = {
        sessionKey,
        residentAgentId,
        parentSessionKeys: Array.isArray(raw?.parentSessionKeys) ? raw.parentSessionKeys.slice() : [],
        actorId: canonicalVisibleAgentId(raw?.actorId) || undefined,
        label: normalizeSpawnText(raw?.label, 120) || undefined,
        task: normalizeSpawnText(raw?.task, 240) || undefined,
        observedAt: Number(raw?.observedAt || 0),
      };
      state.observedChildSessions.set(sessionKey, observed);
    }
  }

  async function rememberPendingSpawnAttribution(parentSessionKey, payload, createdAt) {
    await loadState();
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    const residentAgentId = canonicalResidentAgentId(sk);
    const actorId = inferSpawnActorId(payload);
    if (!sk || !residentAgentId || !actorId) return undefined;
    const entry = {
      intentId: 'spawn-intent:test:1',
      actorId,
      parentSessionKey: sk,
      residentAgentId,
      label: normalizeSpawnText(payload?.label, 120) || undefined,
      task: normalizeSpawnText(payload?.task, 240) || undefined,
      createdAt,
    };
    if (mode === 'buggy') {
      enqueue(state.pendingByParent, sk, entry);
      enqueue(state.pendingByResident, residentAgentId, entry);
    } else {
      mergePending(entry);
    }
    return entry;
  }

  async function observeChildSession(sessionKey, residentAgentId, parentSessionKeys, observedAt) {
    await loadState();
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    const resident = canonicalResidentAgentId(residentAgentId || sk);
    if (!sk || !resident) return undefined;
    const existingPending = (state.pendingByResident.get(resident) || [])[0];
    const observed = {
      sessionKey: sk,
      residentAgentId: resident,
      parentSessionKeys: parentSessionKeys.slice(),
      actorId: existingPending?.actorId,
      label: existingPending?.label,
      task: existingPending?.task,
      observedAt,
    };
    state.observedChildSessions.set(sk, observed);
    return observed;
  }

  async function adoptPendingSpawnAttributionForSession(sessionKey, residentAgentId) {
    await loadState();
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (!sk) return undefined;
    const existing = state.spawnedSessionAgentIds.get(sk);
    if (existing) return { actorId: existing, via: 'spawned' };
    const resident = canonicalVisibleAgentId(residentAgentId);
    const queue = resident ? (state.pendingByResident.get(resident) || []) : [];
    const adopted = queue[0];
    if (!adopted) return undefined;
    const nextResident = queue.filter((candidate) => pendingKey(candidate) !== pendingKey(adopted));
    if (nextResident.length) state.pendingByResident.set(resident, nextResident);
    else state.pendingByResident.delete(resident);
    const parentQueue = state.pendingByParent.get(adopted.parentSessionKey) || [];
    const nextParent = parentQueue.filter((candidate) => pendingKey(candidate) !== pendingKey(adopted));
    if (nextParent.length) state.pendingByParent.set(adopted.parentSessionKey, nextParent);
    else state.pendingByParent.delete(adopted.parentSessionKey);
    state.spawnedSessionAgentIds.set(sk, adopted.actorId);
    state.observedChildSessions.delete(sk);
    return { actorId: adopted.actorId, via: 'pending' };
  }

  async function resolveFeedAgentIdentity(ctx) {
    const parsed = parseSessionIdentity(ctx?.sessionKey, ctx?.agentId);
    const childSessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
    const adopted = childSessionKey && parsed.lane === 'subagent'
      ? await adoptPendingSpawnAttributionForSession(childSessionKey, parsed.residentAgentId)
      : undefined;
    const visible = childSessionKey ? (state.spawnedSessionAgentIds.get(childSessionKey) || adopted?.actorId || '') : '';
    if (visible) return { agentId: visible, rawAgentId: parsed.agentId };
    if (parsed.lane === 'subagent') return { agentId: UNKNOWN_CHILD_ACTOR_ID, rawAgentId: parsed.agentId };
    return { agentId: canonicalVisibleAgentId(parsed.agentId) || 'main', rawAgentId: parsed.agentId };
  }

  function pushEvent(kind, row) {
    state.eventBuf.push({ ts: row.ts, kind, agentId: row.agentId, data: row.details || {} });
  }

  function pushFeed(row) {
    state.feedBuf.push(row);
  }

  function resolveVisibleFeedItemAgentId(item) {
    if (!item) return 'main';
    if (item.agentId === UNKNOWN_CHILD_ACTOR_ID) return UNKNOWN_CHILD_ACTOR_ID;
    const sessionKey = typeof item.sessionKey === 'string' ? item.sessionKey.trim() : '';
    if (sessionKey) {
      const parsed = parseSessionIdentity(sessionKey, item.agentId);
      if (parsed.lane === 'subagent') {
        const bound = state.spawnedSessionAgentIds.get(sessionKey);
        if (bound) return bound;
        return UNKNOWN_CHILD_ACTOR_ID;
      }
    }
    return canonicalVisibleAgentId(item.agentId) || 'main';
  }

  function feedGet() {
    const items = state.feedBuf.slice();
    const rows = items.slice().reverse().map((it) => ({
      kind: it.kind,
      sessionKey: it.sessionKey,
      toolName: it.toolName,
      agentId: resolveVisibleFeedItemAgentId(it),
      rawAgentId: it.rawAgentId,
    }));
    const bySession = new Map();
    for (const it of items) {
      const sk = String(it.sessionKey || '');
      bySession.set(sk, (bySession.get(sk) || []).concat([it]));
    }
    const tasks = [...bySession.entries()].map(([sessionKey, arr]) => ({
      sessionKey,
      agentId: resolveVisibleFeedItemAgentId(arr[0]),
      items: arr.map((it) => ({ kind: it.kind, agentId: resolveVisibleFeedItemAgentId(it) })),
    }));
    const latest = items.length ? items[items.length - 1] : null;
    return {
      rows,
      tasks,
      latest: latest ? {
        kind: latest.kind,
        sessionKey: latest.sessionKey,
        toolName: latest.toolName,
        agentId: resolveVisibleFeedItemAgentId(latest),
        rawAgentId: latest.rawAgentId,
      } : null,
    };
  }

  function resolveVisibleSessionBucket(sk) {
    if (typeof sk !== 'string') return { agentId: null, source: 'none' };
    const raw = String(sk).trim();
    if (!raw) return { agentId: null, source: 'none' };
    const spawnedVisible = state.spawnedSessionAgentIds.get(raw);
    if (spawnedVisible) return { agentId: spawnedVisible, source: 'spawned' };
    const parsed = parseSessionIdentity(raw);
    if (parsed.lane === 'subagent') return { agentId: null, source: 'none' };
    const resident = canonicalVisibleAgentId(parsed.residentAgentId);
    return { agentId: resident || null, source: resident ? 'resident' : 'none' };
  }

  function recentVisibleEventsForAgent(agentId) {
    return state.eventBuf.filter((ev) => canonicalVisibleAgentId(ev.agentId) === agentId);
  }

  function currentTruth(agentId, sessions, nowMs, staleMs) {
    const sessionsByAgent = new Map();
    for (const s of sessions) {
      const bucket = resolveVisibleSessionBucket(s.key);
      if (!bucket.agentId) continue;
      sessionsByAgent.set(bucket.agentId, (sessionsByAgent.get(bucket.agentId) || []).concat([s]));
    }
    const freshSessions = (sessionsByAgent.get(agentId) || []).filter((s) => (nowMs - Number(s.updatedAt || 0)) <= staleMs);
    let feedTruth = null;
    for (let i = state.feedBuf.length - 1; i >= 0; i -= 1) {
      const item = state.feedBuf[i];
      if (resolveVisibleFeedItemAgentId(item) !== agentId) continue;
      if ((nowMs - Number(item.ts || 0)) > staleMs) continue;
      feedTruth = item;
      break;
    }
    const feedTruthState = inferActivityFromFeedItem(feedTruth);
    const feedTruthUsable = !!(feedTruthState && (!activityNeedsFreshSession(feedTruthState) || freshSessions.length));
    return {
      activityState: feedTruthUsable ? feedTruthState : 'idle',
      currentTruthSource: feedTruthUsable ? 'feed' : (freshSessions.length ? 'fresh_session_idle' : 'stale_or_none'),
      recentEvents: recentVisibleEventsForAgent(agentId),
      feedTruthAgentId: feedTruth ? resolveVisibleFeedItemAgentId(feedTruth) : null,
      sessionBucketKeys: (sessionsByAgent.get(agentId) || []).map((s) => s.key),
    };
  }

  return {
    state,
    rememberPendingSpawnAttribution,
    observeChildSession,
    resolveFeedAgentIdentity,
    pushEvent,
    pushFeed,
    feedGet,
    currentTruth,
  };
}

async function replay(mode) {
  const nowMs = Date.UTC(2026, 2, 29, 5, 37, 0);
  const staleMs = 15 * 1000;
  const runtime = createRuntime(mode);
  const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
  const childSessionKey = 'agent:main:subagent:child-frontend-e2e';
  const sessions = [{ key: childSessionKey, updatedAt: nowMs - 1200 }];
  const spawnPayload = {
    label: 'qa-agent-child-attribution-live',
    task: '你是 qa_agent。請驗證 Lobster Room front-end feedGet 與 room current truth 是否一致。',
  };

  const pending = await runtime.rememberPendingSpawnAttribution(parentSessionKey, spawnPayload, nowMs - 4000);
  assert.equal(pending.actorId, 'qa_agent', 'raw parent sessions_spawn hook should infer qa_agent');
  const observed = await runtime.observeChildSession(childSessionKey, 'main', [parentSessionKey], nowMs - 3000);

  const childStartIdentity = await runtime.resolveFeedAgentIdentity({ sessionKey: childSessionKey, agentId: 'main' });
  runtime.pushEvent('before_agent_start', { ts: nowMs - 2500, agentId: childStartIdentity.agentId, details: { sessionKey: childSessionKey } });
  runtime.pushFeed({ ts: nowMs - 2500, kind: 'before_agent_start', sessionKey: childSessionKey, agentId: childStartIdentity.agentId, rawAgentId: childStartIdentity.rawAgentId });

  const childToolIdentity = await runtime.resolveFeedAgentIdentity({ sessionKey: childSessionKey, agentId: 'main' });
  runtime.pushEvent('before_tool_call', { ts: nowMs - 1800, agentId: childToolIdentity.agentId, details: { toolName: 'browser', sessionKey: childSessionKey } });
  runtime.pushFeed({ ts: nowMs - 1800, kind: 'before_tool_call', toolName: 'browser', sessionKey: childSessionKey, agentId: childToolIdentity.agentId, rawAgentId: childToolIdentity.rawAgentId });

  const childAfterIdentity = await runtime.resolveFeedAgentIdentity({ sessionKey: childSessionKey, agentId: 'main' });
  runtime.pushEvent('after_tool_call', { ts: nowMs - 1200, agentId: childAfterIdentity.agentId, details: { toolName: 'browser', sessionKey: childSessionKey } });
  runtime.pushFeed({ ts: nowMs - 1200, kind: 'after_tool_call', toolName: 'browser', sessionKey: childSessionKey, agentId: childAfterIdentity.agentId, rawAgentId: childAfterIdentity.rawAgentId });

  const feed = runtime.feedGet();
  const room = runtime.currentTruth('qa_agent', sessions, nowMs, staleMs);
  return {
    raw: {
      pending,
      observed,
      childStartIdentity,
      childToolIdentity,
      childAfterIdentity,
    },
    canonical: {
      spawnedSessionAgentIds: Object.fromEntries(runtime.state.spawnedSessionAgentIds.entries()),
      pendingByParent: [...runtime.state.pendingByParent.entries()].map(([key, value]) => ({ key, count: value.length })),
      pendingByResident: [...runtime.state.pendingByResident.entries()].map(([key, value]) => ({ key, count: value.length })),
      observedChildSessions: [...runtime.state.observedChildSessions.values()],
    },
    feed,
    room,
  };
}

(async () => {
  const buggy = await replay('buggy');
  assert.equal(buggy.raw.pending.actorId, 'qa_agent');
  assert.equal(buggy.raw.observed.actorId, undefined, 'buggy reload race should drop the pending hint before observed child state can retain it');
  assert.deepEqual(buggy.canonical.spawnedSessionAgentIds, {}, 'buggy writer-side retention loses spawned binding');
  assert.equal(buggy.feed.rows[0].agentId, 'unknown', 'buggy feedGet should surface unknown child row');
  assert.equal(buggy.feed.tasks[0].agentId, 'unknown', 'buggy task lane should also stay unknown');
  assert.equal(buggy.feed.latest.agentId, 'unknown', 'buggy latest should stay unknown');
  assert.equal(buggy.room.activityState, 'idle', 'buggy current-truth should idle because child session is not bucketed into qa_agent');
  assert.equal(buggy.room.feedTruthAgentId, null, 'buggy room truth should not find a qa_agent feed lane');
  assert.equal(buggy.room.recentEvents.length, 0, 'buggy room truth should not have actor-scoped recent events for qa_agent');

  const fixed = await replay('fixed');
  assert.equal(fixed.raw.pending.actorId, 'qa_agent');
  assert.equal(fixed.raw.observed.actorId, 'qa_agent', 'fixed retention should let observed child state inherit the pending actor hint');
  assert.equal(fixed.canonical.spawnedSessionAgentIds['agent:main:subagent:child-frontend-e2e'], 'qa_agent', 'fixed writer-side retention should preserve child binding into canonical state');
  assert.equal(fixed.feed.rows[0].agentId, 'qa_agent', 'fixed feedGet row should reflect bound child actor');
  assert.equal(fixed.feed.tasks[0].agentId, 'qa_agent', 'fixed task lane should reflect bound child actor');
  assert.equal(fixed.feed.latest.agentId, 'qa_agent', 'fixed latest should reflect bound child actor');
  assert.equal(fixed.room.activityState, 'thinking', 'fixed current-truth should become active once session bucketing sees qa_agent child session');
  assert.equal(fixed.room.currentTruthSource, 'feed', 'fixed current-truth should be driven by the same visible feed lane');
  assert.equal(fixed.room.feedTruthAgentId, 'qa_agent');
  assert.equal(fixed.room.sessionBucketKeys[0], 'agent:main:subagent:child-frontend-e2e');
  assert.ok(fixed.room.recentEvents.length >= 2, 'fixed room truth should have actor-scoped recent events for qa_agent');
  assert.ok(fixed.room.recentEvents.every((ev) => ev.agentId === 'qa_agent'), 'recent events must stay actor-scoped after fix');

  console.log('frontend-data-path-e2e-room-feed-simulation: PASS');
  console.log(JSON.stringify({ buggy, fixed }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
