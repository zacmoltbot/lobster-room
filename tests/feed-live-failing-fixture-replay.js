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

function visibleFeedAgentId(value, fallback = 'main') {
  return canonicalVisibleAgentId(value) || fallback;
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
  if (!text) return '';
  if (/\bqa[_ -]?agent\b/i.test(text) || /你是\s*qa[_ -]?agent/i.test(text)) return 'qa_agent';
  if (/\bcoding[_ -]?agent\b/i.test(text) || /你是\s*coding[_ -]?agent/i.test(text)) return 'coding_agent';
  return '';
}

function createRuntime(mode) {
  const state = {
    feedBuf: [],
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
    diskState: { spawnedSessionAgentIds: {}, pending: [] },
    hydrated: false,
  };

  const pendingKey = (entry) => [
    entry.parentSessionKey,
    entry.residentAgentId,
    entry.actorId,
    entry.label || '',
    entry.task || '',
    entry.source,
    String(entry.createdAt || 0),
  ].join('\u0000');

  function enqueue(bucket, key, entry) {
    bucket.set(key, (bucket.get(key) || []).concat([entry]));
  }

  function mergeEntry(entry) {
    const key = pendingKey(entry);
    const merge = (bucket, bucketKey) => {
      const queue = bucket.get(bucketKey) || [];
      if (queue.some((candidate) => pendingKey(candidate) === key)) return;
      bucket.set(bucketKey, queue.concat([entry]));
    };
    merge(state.pendingByParent, entry.parentSessionKey);
    merge(state.pendingByResident, entry.residentAgentId);
  }

  async function loadState() {
    const data = state.diskState;
    if (mode === 'buggy') {
      state.spawnedSessionAgentIds.clear();
      state.pendingByParent.clear();
      state.pendingByResident.clear();
    } else if (!state.hydrated) {
      state.spawnedSessionAgentIds.clear();
      state.pendingByParent.clear();
      state.pendingByResident.clear();
      state.hydrated = true;
    }

    for (const [key, value] of Object.entries(data.spawnedSessionAgentIds || {})) {
      const sk = typeof key === 'string' ? key.trim() : '';
      const agentId = canonicalVisibleAgentId(value);
      if (!sk || !agentId) continue;
      if (mode === 'buggy' || !state.spawnedSessionAgentIds.has(sk)) state.spawnedSessionAgentIds.set(sk, agentId);
    }

    for (const raw of Array.isArray(data.pending) ? data.pending : []) {
      const parentSessionKey = typeof raw?.parentSessionKey === 'string' ? raw.parentSessionKey.trim() : '';
      const residentAgentId = canonicalResidentAgentId(raw?.residentAgentId || parentSessionKey);
      const actorId = canonicalVisibleAgentId(raw?.actorId);
      if (!parentSessionKey || !residentAgentId || !actorId) continue;
      const entry = {
        actorId,
        parentSessionKey,
        residentAgentId,
        label: normalizeSpawnText(raw?.label, 120) || undefined,
        task: normalizeSpawnText(raw?.task, 240) || undefined,
        source: raw?.source === 'explicit' ? 'explicit' : 'inferred',
        createdAt: typeof raw?.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
      };
      if (mode === 'buggy') {
        enqueue(state.pendingByParent, parentSessionKey, entry);
        enqueue(state.pendingByResident, residentAgentId, entry);
      } else {
        mergeEntry(entry);
      }
    }
  }

  async function persistState() {
    const pendingEntries = [];
    if (mode === 'buggy') {
      for (const queue of state.pendingByParent.values()) {
        for (const entry of queue) pendingEntries.push(entry);
      }
    } else {
      const uniq = new Map();
      for (const queue of state.pendingByParent.values()) {
        for (const entry of queue) uniq.set(pendingKey(entry), entry);
      }
      pendingEntries.push(...uniq.values());
    }
    state.diskState = {
      spawnedSessionAgentIds: Object.fromEntries(state.spawnedSessionAgentIds.entries()),
      pending: pendingEntries,
    };
  }

  async function rememberPendingSpawnAttribution(parentSessionKey, payload) {
    await loadState();
    const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
    const actorId = inferSpawnActorId(payload);
    const residentAgentId = canonicalResidentAgentId(sk);
    if (!sk || !actorId || !residentAgentId) return undefined;
    const entry = {
      actorId,
      parentSessionKey: sk,
      residentAgentId,
      label: normalizeSpawnText(payload?.label, 120) || undefined,
      task: normalizeSpawnText(payload?.task, 240) || undefined,
      source: 'inferred',
      createdAt: 1711516800000,
    };
    if (mode === 'buggy') {
      enqueue(state.pendingByParent, sk, entry);
      enqueue(state.pendingByResident, residentAgentId, entry);
    } else {
      mergeEntry(entry);
    }
    return { entry, persistPromise: persistState() };
  }

  async function adoptPendingSpawnAttributionForSession(sessionKey, residentAgentId) {
    await loadState();
    const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
    if (!sk) return undefined;
    const existing = state.spawnedSessionAgentIds.get(sk);
    if (existing) return { actorId: existing, via: 'spawned' };
    const resident = canonicalVisibleAgentId(residentAgentId);
    const queue = state.pendingByResident.get(resident) || [];
    const adopted = queue.shift();
    if (queue.length) state.pendingByResident.set(resident, queue);
    else state.pendingByResident.delete(resident);
    if (!adopted) return undefined;
    state.spawnedSessionAgentIds.set(sk, adopted.actorId);
    const parentQueue = (state.pendingByParent.get(adopted.parentSessionKey) || []).filter((candidate) => candidate !== adopted);
    if (parentQueue.length) state.pendingByParent.set(adopted.parentSessionKey, parentQueue);
    else state.pendingByParent.delete(adopted.parentSessionKey);
    return { ...adopted, via: 'pending' };
  }

  async function resolveFeedAgentIdentity(ctx) {
    const parsed = parseSessionIdentity(ctx?.sessionKey, ctx?.agentId);
    const rawSessionAgentId = parsed.agentId;
    const childSessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
    const adopted = childSessionKey && parsed.lane !== 'main'
      ? await adoptPendingSpawnAttributionForSession(childSessionKey, parsed.residentAgentId)
      : undefined;
    const visible = childSessionKey
      ? (state.spawnedSessionAgentIds.get(childSessionKey) || adopted?.actorId || '')
      : '';
    if (visible) return { agentId: visible, rawAgentId: rawSessionAgentId };
    return {
      agentId: canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || 'main',
      rawAgentId: rawSessionAgentId,
    };
  }

  function pushFeed(item) {
    state.feedBuf.push(item);
  }

  function feedGet() {
    const items = state.feedBuf.slice();
    const rows = items.slice().reverse().map((it) => ({
      kind: it.kind,
      agentId: visibleFeedAgentId(it.agentId),
      rawAgentId: it.rawAgentId,
      sessionKey: it.sessionKey,
    }));
    const bySession = new Map();
    for (const it of items) bySession.set(it.sessionKey, (bySession.get(it.sessionKey) || []).concat([it]));
    const tasks = [...bySession.entries()].map(([sessionKey, arr]) => ({
      sessionKey,
      agentId: visibleFeedAgentId(arr.find((it) => it.agentId)?.agentId, 'unknown'),
      items: arr.map((it) => ({ kind: it.kind, agentId: visibleFeedAgentId(it.agentId) })),
    }));
    const latest = items.length ? items[items.length - 1] : null;
    return {
      rows,
      tasks,
      latest: latest ? { kind: latest.kind, agentId: visibleFeedAgentId(latest.agentId), rawAgentId: latest.rawAgentId } : null,
    };
  }

  return { state, rememberPendingSpawnAttribution, resolveFeedAgentIdentity, pushFeed, feedGet };
}

async function replay(mode) {
  const runtime = createRuntime(mode);

  const parentBeforeToolCallCtx = {
    sessionKey: 'agent:main:discord:channel:1476111438186680416',
    agentId: 'main',
    messageProvider: 'discord',
  };
  const parentBeforeToolCallEvent = {
    toolName: 'sessions_spawn',
    params: {
      label: 'qa-agent-child-attribution-live',
      task: '你是 qa_agent。請重放 live failing fixture，驗證 rows/tasks/latest actor consistency。',
      spawnAgentId: undefined,
    },
  };
  const childBeforeAgentStartCtx = {
    sessionKey: 'agent:main:subagent:944af8c1-b024-496b-9959-3b2c01a2f980',
    agentId: 'main',
    messageProvider: 'discord',
  };
  const childBeforeToolCallCtx = childBeforeAgentStartCtx;
  const childBeforeToolCallEvent = {
    toolName: 'browser',
    params: { url: 'https://example.com/lobster-room/live-fixture' },
  };

  const pending = await runtime.rememberPendingSpawnAttribution(parentBeforeToolCallCtx.sessionKey, parentBeforeToolCallEvent.params);
  // Live-like race: child hook arrives before parent persist completes, so disk still looks empty.
  runtime.state.diskState = { spawnedSessionAgentIds: {}, pending: [] };

  const firstIdentity = await runtime.resolveFeedAgentIdentity(childBeforeAgentStartCtx);
  runtime.pushFeed({
    ts: 1,
    kind: 'before_agent_start',
    agentId: firstIdentity.agentId,
    rawAgentId: firstIdentity.rawAgentId,
    sessionKey: childBeforeAgentStartCtx.sessionKey,
  });

  const followupIdentity = await runtime.resolveFeedAgentIdentity(childBeforeToolCallCtx);
  runtime.pushFeed({
    ts: 2,
    kind: 'before_tool_call',
    agentId: followupIdentity.agentId,
    rawAgentId: followupIdentity.rawAgentId,
    sessionKey: childBeforeToolCallCtx.sessionKey,
    toolName: childBeforeToolCallEvent.toolName,
  });

  await pending.persistPromise;

  const latestIdentity = await runtime.resolveFeedAgentIdentity(childBeforeToolCallCtx);
  runtime.pushFeed({
    ts: 3,
    kind: 'after_tool_call',
    agentId: latestIdentity.agentId,
    rawAgentId: latestIdentity.rawAgentId,
    sessionKey: childBeforeToolCallCtx.sessionKey,
    toolName: childBeforeToolCallEvent.toolName,
  });

  return {
    fixture: {
      parentBeforeToolCall: { event: parentBeforeToolCallEvent, ctx: parentBeforeToolCallCtx },
      childBeforeAgentStart: { ctx: childBeforeAgentStartCtx },
      childBeforeToolCall: { event: childBeforeToolCallEvent, ctx: childBeforeToolCallCtx },
      sharedStateAtRacePoint: { diskState: { spawnedSessionAgentIds: {}, pending: [] } },
    },
    firstIdentity,
    followupIdentity,
    latestIdentity,
    feed: runtime.feedGet(),
  };
}

(async () => {
  const buggy = await replay('buggy');
  const fixed = await replay('fixed');

  assert.equal(buggy.firstIdentity.agentId, 'main', 'legacy behavior reproduces live fail: before_agent_start resolves to main');
  assert.equal(buggy.followupIdentity.agentId, 'main', 'legacy behavior reproduces live fail: follow-up row resolves to main');
  assert.equal(buggy.feed.rows[0].agentId, 'main', 'legacy behavior reproduces live fail: rows[].agentId = main');
  assert.equal(buggy.feed.tasks[0].agentId, 'main', 'legacy behavior reproduces live fail: tasks[].agentId = main');
  assert.equal(buggy.feed.latest.agentId, 'main', 'legacy behavior reproduces live fail: latest.agentId = main');

  assert.equal(fixed.firstIdentity.agentId, 'qa_agent', 'fixed behavior restores qa_agent on before_agent_start');
  assert.equal(fixed.followupIdentity.agentId, 'qa_agent', 'fixed behavior keeps follow-up rows on qa_agent');
  assert.equal(fixed.latestIdentity.agentId, 'qa_agent', 'fixed behavior keeps latest on qa_agent');
  assert.ok(fixed.feed.rows.every((row) => row.agentId === 'qa_agent'), 'fixed rows[].agentId must all be qa_agent');
  assert.equal(fixed.feed.tasks[0].agentId, 'qa_agent', 'fixed tasks[].agentId must be qa_agent');
  assert.equal(fixed.feed.latest.agentId, 'qa_agent', 'fixed latest.agentId must be qa_agent');
  assert.equal(fixed.feed.rows[2].rawAgentId, 'main/subagent:944af8c1-b024-496b-9959-3b2c01a2f980', 'debug rawAgentId still preserves internal lineage');

  console.log('feed-live-failing-fixture-replay: PASS');
  console.log(JSON.stringify({ buggy, fixed }, null, 2));
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
