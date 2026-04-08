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

function resolveExplicitSpawnAgentId(payload) {
  for (const candidate of [payload && payload.agentId, payload && payload.spawnAgentId, payload && payload.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  return '';
}

function inferSpawnActorId(payload) {
  const explicit = resolveExplicitSpawnAgentId(payload);
  if (explicit) return explicit;
  const text = [payload && payload.label, payload && payload.task, payload && payload.prompt, payload && payload.instructions]
    .map((part) => normalizeSpawnText(part, 400).toLowerCase())
    .filter(Boolean)
    .join('\n');
  if (!text) return '';
  if (/\bqa[_ -]?agent\b/i.test(text) || /你是\s*qa[_ -]?agent/i.test(text)) return 'qa_agent';
  if (/\bcoding[_ -]?agent\b/i.test(text) || /你是\s*coding[_ -]?agent/i.test(text)) return 'coding_agent';
  return '';
}

function createRuntime() {
  const state = {
    feedBuf: [],
    spawnedSessionAgentIds: new Map(),
    pendingSpawnAttributionsByResident: new Map(),
    traces: [],
  };

  const pushTrace = (step, data) => state.traces.push({ step, ...data });

  const rememberPendingSpawnAttribution = (parentSessionKey, payload) => {
    const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
    const actorId = inferSpawnActorId(payload);
    const residentAgentId = canonicalResidentAgentId(sk);
    if (!sk || !actorId || !residentAgentId) return undefined;
    const entry = {
      actorId,
      parentSessionKey: sk,
      residentAgentId,
      label: normalizeSpawnText(payload && payload.label, 120) || undefined,
      task: normalizeSpawnText(payload && payload.task, 240) || undefined,
      source: resolveExplicitSpawnAgentId(payload) ? 'explicit' : 'inferred',
    };
    state.pendingSpawnAttributionsByResident.set(
      residentAgentId,
      (state.pendingSpawnAttributionsByResident.get(residentAgentId) || []).concat([entry]),
    );
    pushTrace('pending.remember', {
      parentSessionKey: sk,
      residentAgentId,
      actorId,
      pendingByResident: Array.from(state.pendingSpawnAttributionsByResident.entries()),
    });
    return entry;
  };

  const adoptPendingSpawnAttributionForSession = (sessionKey, residentAgentId) => {
    const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
    if (!sk) return undefined;
    const existing = state.spawnedSessionAgentIds.get(sk);
    if (existing) {
      const viaSpawned = { actorId: existing, via: 'spawned' };
      pushTrace('pending.adopt', {
        sessionKey: sk,
        residentAgentId,
        existingSpawned: existing,
        adopted: viaSpawned,
        pendingByResident: Array.from(state.pendingSpawnAttributionsByResident.entries()),
        spawnedSessionAgentIds: Array.from(state.spawnedSessionAgentIds.entries()),
      });
      return viaSpawned;
    }
    const resident = canonicalVisibleAgentId(residentAgentId);
    const queue = state.pendingSpawnAttributionsByResident.get(resident) || [];
    const adopted = queue.shift();
    if (queue.length) state.pendingSpawnAttributionsByResident.set(resident, queue);
    else state.pendingSpawnAttributionsByResident.delete(resident);
    if (!adopted) {
      pushTrace('pending.adopt', {
        sessionKey: sk,
        residentAgentId,
        adopted: undefined,
        pendingByResident: Array.from(state.pendingSpawnAttributionsByResident.entries()),
        spawnedSessionAgentIds: Array.from(state.spawnedSessionAgentIds.entries()),
      });
      return undefined;
    }
    state.spawnedSessionAgentIds.set(sk, adopted.actorId);
    pushTrace('pending.adopt', {
      sessionKey: sk,
      residentAgentId,
      adopted,
      pendingByResident: Array.from(state.pendingSpawnAttributionsByResident.entries()),
      spawnedSessionAgentIds: Array.from(state.spawnedSessionAgentIds.entries()),
    });
    return adopted;
  };

  const resolveFeedAgentIdentity = (ctx) => {
    const parsed = parseSessionIdentity(ctx && ctx.sessionKey, ctx && ctx.agentId);
    const rawSessionAgentId = parsed.agentId;
    const childSessionKey = typeof (ctx && ctx.sessionKey) === 'string' ? ctx.sessionKey.trim() : '';
    const adoptedAttribution = childSessionKey && parsed.lane !== 'main'
      ? adoptPendingSpawnAttributionForSession(childSessionKey, parsed.residentAgentId)
      : undefined;
    const spawnedVisible = childSessionKey
      ? (state.spawnedSessionAgentIds.get(childSessionKey) || (adoptedAttribution && adoptedAttribution.actorId) || '')
      : '';
    let result;
    let branch;
    if (spawnedVisible) {
      branch = 'spawnedOrAdopted';
      result = {
        agentId: spawnedVisible,
        rawAgentId: rawSessionAgentId && rawSessionAgentId !== spawnedVisible ? rawSessionAgentId : undefined,
      };
    } else {
      branch = 'fallback';
      const fallback = canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || 'main';
      result = {
        agentId: fallback,
        rawAgentId: rawSessionAgentId && rawSessionAgentId !== fallback ? rawSessionAgentId : undefined,
      };
    }
    pushTrace('resolve', {
      ctx: {
        sessionKey: ctx && ctx.sessionKey,
        agentId: ctx && ctx.agentId,
        messageProvider: ctx && ctx.messageProvider,
      },
      parsed,
      branch,
      adoptedAttribution,
      pendingByResident: Array.from(state.pendingSpawnAttributionsByResident.entries()),
      spawnedSessionAgentIds: Array.from(state.spawnedSessionAgentIds.entries()),
      result,
    });
    return result;
  };

  const pushFeed = (item) => {
    pushTrace('pushFeed.before', {
      item: { kind: item.kind, agentId: item.agentId, rawAgentId: item.rawAgentId, sessionKey: item.sessionKey },
    });
    state.feedBuf.push(item);
    pushTrace('pushFeed.after', {
      feedBuf: state.feedBuf.map((it) => ({ kind: it.kind, agentId: it.agentId, rawAgentId: it.rawAgentId, sessionKey: it.sessionKey })),
    });
  };

  const groupFeedIntoTasks = (items) => {
    const byKey = new Map();
    for (const it of items) {
      const sk = typeof it.sessionKey === 'string' && it.sessionKey.trim() ? it.sessionKey.trim() : '';
      if (sk) byKey.set(sk, (byKey.get(sk) || []).concat([it]));
    }
    const tasks = [];
    for (const [sk, arr] of byKey.entries()) {
      const sorted = arr.slice().sort((a, b) => a.ts - b.ts);
      const agentId = sorted.find((x) => x.agentId).agentId || 'unknown';
      tasks.push({ sessionKey: sk, agentId, items: sorted.map((it) => ({ kind: it.kind, agentId: it.agentId })) });
    }
    return tasks;
  };

  const feedGet = () => {
    const items = state.feedBuf.slice();
    const tasks = groupFeedIntoTasks(items);
    const latest = items.length ? items[items.length - 1] : null;
    const result = {
      rows: items.slice().reverse().map((it) => ({ kind: it.kind, agentId: it.agentId, rawAgentId: it.rawAgentId, sessionKey: it.sessionKey })),
      tasks,
      latest: latest ? { kind: latest.kind, agentId: latest.agentId, rawAgentId: latest.rawAgentId, sessionKey: latest.sessionKey } : null,
    };
    pushTrace('feedGet', result);
    return result;
  };

  return { state, rememberPendingSpawnAttribution, resolveFeedAgentIdentity, pushFeed, feedGet };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function simulate(order) {
  const runtime = createRuntime();
  const gate = deferred();
  const parentCtx = { sessionKey: 'agent:main:main', agentId: 'main', messageProvider: 'discord' };
  const childCtx = { sessionKey: 'agent:main:subagent:qa-child', agentId: 'main', messageProvider: 'discord' };
  const spawnPayload = {
    label: 'qa-feed-row-trace-proof',
    task: '你是 qa_agent。做 row-level trace 驗證。',
  };

  const parentBeforeToolCall = (async () => {
    if (order === 'old') {
      await gate.promise;
      runtime.resolveFeedAgentIdentity(parentCtx);
      runtime.rememberPendingSpawnAttribution(parentCtx.sessionKey, spawnPayload);
    } else {
      runtime.rememberPendingSpawnAttribution(parentCtx.sessionKey, spawnPayload);
      await gate.promise;
      runtime.resolveFeedAgentIdentity(parentCtx);
    }
  })();

  const childBeforeAgentStart = (async () => {
    const identity = runtime.resolveFeedAgentIdentity(childCtx);
    runtime.pushFeed({
      ts: 1,
      kind: 'before_agent_start',
      agentId: identity.agentId,
      rawAgentId: identity.rawAgentId,
      sessionKey: childCtx.sessionKey,
    });
    return { ctx: childCtx, identity };
  })();

  const childResult = await childBeforeAgentStart;
  gate.resolve();
  await parentBeforeToolCall;
  const feed = runtime.feedGet();

  return { order, childResult, feed, traces: runtime.state.traces };
}

(async () => {
  const oldRun = await simulate('old');
  const newRun = await simulate('new');

  assert.equal(oldRun.childResult.identity.agentId, 'main', 'old ordering reproduces bug: child before_agent_start resolves to main');
  assert.equal(oldRun.feed.rows[0].agentId, 'main', 'old ordering writes main into row');
  assert.equal(oldRun.feed.tasks[0].agentId, 'main', 'old ordering keeps main in grouped task');
  assert.equal(oldRun.feed.latest.agentId, 'main', 'old ordering keeps main in latest');

  assert.equal(newRun.childResult.identity.agentId, 'qa_agent', 'new ordering resolves child before_agent_start to qa_agent');
  assert.equal(newRun.feed.rows[0].agentId, 'qa_agent', 'new ordering writes qa_agent into row');
  assert.equal(newRun.feed.tasks[0].agentId, 'qa_agent', 'new ordering keeps qa_agent in grouped task');
  assert.equal(newRun.feed.latest.agentId, 'qa_agent', 'new ordering keeps qa_agent in latest');
  assert.equal(newRun.feed.rows[0].rawAgentId, 'main/subagent:qa-child', 'raw lineage remains internal/debug only');

  console.log(JSON.stringify({ oldRun, newRun }, null, 2));
  console.log('feed-row-trace-before-agent-start: PASS');
})().catch((err) => {
  console.error(err && err.stack || err);
  process.exit(1);
});
