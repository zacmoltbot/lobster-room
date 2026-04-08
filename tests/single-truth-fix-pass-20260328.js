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

function feedActivityFromTool(toolName, details, recentEvents) {
  const tn = String(toolName || '').trim().toLowerCase();
  if (tn === 'browser') return 'checking the live page';
  if (tn === 'read') return 'reviewing project files';
  if (tn === 'write' || tn === 'edit') return 'updating project files';
  if (tn === 'exec') return 'running a command';
  if (tn === 'sessions_spawn') {
    const label = feedDetailTaskLabel(details, recentEvents);
    return label ? ('starting a helper task — ' + label) : 'starting a helper task';
  }
  return 'working';
}

function feedDetailTaskLabel(details, recentEvents) {
  const d = details && typeof details === 'object' ? details : {};
  for (const value of [d.label, d.task, d.title, d.summary, d.purpose, d.name, d.prompt]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const evs = Array.isArray(recentEvents) ? recentEvents : [];
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const ev = evs[i];
    const data = ev && ev.data && typeof ev.data === 'object' ? ev.data : (ev && ev.details && typeof ev.details === 'object' ? ev.details : null);
    if (!data) continue;
    for (const value of [data.label, data.task, data.title, data.summary, data.purpose, data.name, data.prompt]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

function feedInferRecentActivity(details, recentEvents) {
  const directTool = details && details.toolName;
  if (directTool) return feedActivityFromTool(directTool, details, recentEvents);
  const evs = Array.isArray(recentEvents) ? recentEvents : [];
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const ev = evs[i];
    if (!ev) continue;
    const kind = String(ev.kind || '').trim().toLowerCase();
    const data = ev.data && typeof ev.data === 'object' ? ev.data : (ev.details && typeof ev.details === 'object' ? ev.details : {});
    if (kind === 'before_tool_call' || kind === 'after_tool_call' || kind === 'tool_result_persist') {
      const evTool = String(ev.toolName || data.toolName || '').trim();
      if (evTool) return feedActivityFromTool(evTool, data, recentEvents);
    }
  }
  return '';
}

function recentVisibleEventsForAgent(source, agentId, limit = 24) {
  const out = [];
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const item = source[i];
    const visible = canonicalVisibleAgentId(item && item.agentId);
    if (!visible || visible !== agentId) continue;
    out.push(item);
    if (out.length >= limit) break;
  }
  return out.reverse();
}

function inferActivityFromFeedItem(item) {
  if (!item) return null;
  if (item.kind === 'message_sending' || item.kind === 'message_sent') return 'reply';
  if (item.kind === 'before_tool_call') return 'tool';
  if (item.kind === 'before_agent_start' || item.kind === 'after_tool_call' || item.kind === 'tool_result_persist') return 'thinking';
  if (item.kind === 'agent_end') return item.success === false || !!item.error ? 'error' : 'idle';
  return null;
}

function activityNeedsFreshSession(state) {
  return state === 'thinking' || state === 'tool' || state === 'reply';
}

function latestVisibleFeedItemForAgent(feedBuf, agentId, nowMs, staleMs) {
  for (let i = feedBuf.length - 1; i >= 0; i -= 1) {
    const item = feedBuf[i];
    if (!item || item.agentId !== agentId) continue;
    if ((nowMs - Number(item.ts || 0)) > staleMs) continue;
    return item;
  }
  return null;
}

function createRuntime() {
  const state = {
    feedBuf: [],
    eventBuf: [],
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
  };

  function enqueue(bucket, key, entry) {
    bucket.set(key, (bucket.get(key) || []).concat([entry]));
  }

  function rememberPendingSpawnAttribution(parentSessionKey, payload) {
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    const actorId = inferSpawnActorId(payload);
    const residentAgentId = canonicalResidentAgentId(sk);
    if (!sk || !actorId || !residentAgentId) return undefined;
    const entry = { actorId, parentSessionKey: sk, residentAgentId };
    enqueue(state.pendingByParent, sk, entry);
    enqueue(state.pendingByResident, residentAgentId, entry);
    return entry;
  }

  function adoptPendingSpawnAttributionForSession(sessionKey, residentAgentId) {
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
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

  function rememberSpawnedSessionAgent(sessionKey, agentId) {
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    const visible = canonicalVisibleAgentId(agentId);
    if (sk && visible) state.spawnedSessionAgentIds.set(sk, visible);
  }

  function resolveFeedAgentIdentity(ctx) {
    const parsed = parseSessionIdentity(ctx?.sessionKey, ctx?.agentId);
    const rawSessionAgentId = parsed.agentId;
    const childSessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
    const adopted = childSessionKey && parsed.lane !== 'main'
      ? adoptPendingSpawnAttributionForSession(childSessionKey, parsed.residentAgentId)
      : undefined;
    const visible = childSessionKey
      ? (state.spawnedSessionAgentIds.get(childSessionKey) || adopted?.actorId || '')
      : '';
    if (visible) {
      return { agentId: visible, rawAgentId: rawSessionAgentId, residentAgentId: parsed.residentAgentId, lane: parsed.lane, source: 'spawned' };
    }
    return {
      agentId: canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || 'main',
      rawAgentId: rawSessionAgentId,
      residentAgentId: parsed.residentAgentId,
      lane: parsed.lane,
      source: 'fallback',
    };
  }

  function pushFeed(item) {
    state.feedBuf.push(item);
  }

  function pushEvent(item) {
    state.eventBuf.push(item);
  }

  function sanitizeFeedItemForApi(it) {
    return {
      ts: it.ts,
      kind: it.kind,
      agentId: visibleFeedAgentId(it.agentId),
      rawAgentId: it.rawAgentId,
      sessionKey: it.sessionKey,
      toolName: it.toolName,
      details: it.details,
    };
  }

  function groupFeedIntoTasks() {
    const byKey = new Map();
    for (const it of state.feedBuf) {
      const sk = it.sessionKey || '';
      byKey.set(sk, (byKey.get(sk) || []).concat([it]));
    }
    return [...byKey.entries()].map(([sessionKey, arr]) => ({
      sessionKey,
      agentId: visibleFeedAgentId(arr.find((it) => it.agentId)?.agentId, 'unknown'),
      items: arr.map(sanitizeFeedItemForApi),
    }));
  }

  function feedGet() {
    const rows = state.feedBuf.slice().reverse().map(sanitizeFeedItemForApi);
    const tasks = groupFeedIntoTasks();
    const latest = state.feedBuf.length ? sanitizeFeedItemForApi(state.feedBuf[state.feedBuf.length - 1]) : null;
    return { rows, tasks, latest };
  }

  function resolveVisibleSessionBucket(sessionKey) {
    const raw = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (!raw) return { agentId: null, source: 'none' };
    const spawnedVisible = state.spawnedSessionAgentIds.get(raw);
    if (spawnedVisible) return { agentId: spawnedVisible, source: 'spawned' };
    const parsed = parseSessionIdentity(raw);
    const resident = canonicalVisibleAgentId(parsed.residentAgentId);
    return { agentId: resident || null, source: resident ? 'resident' : 'none' };
  }

  function buildRoomTruth(agentId, sessions, nowMs, staleMs) {
    const sessionsByAgent = new Map();
    const sessionBucketDebug = new Map();
    for (const s of sessions) {
      const bucket = resolveVisibleSessionBucket(s.key);
      if (!bucket.agentId) continue;
      sessionsByAgent.set(bucket.agentId, (sessionsByAgent.get(bucket.agentId) || []).concat([s]));
      sessionBucketDebug.set(bucket.agentId, (sessionBucketDebug.get(bucket.agentId) || []).concat([{ key: s.key, source: bucket.source }]));
    }
    const list = (sessionsByAgent.get(agentId) || []).slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const freshSessions = list.filter((s) => (nowMs - Number(s.updatedAt || 0)) <= staleMs);
    const feedTruth = latestVisibleFeedItemForAgent(state.feedBuf, agentId, nowMs, staleMs);
    const feedTruthState = inferActivityFromFeedItem(feedTruth);
    const feedTruthUsable = !!(feedTruthState && (!activityNeedsFreshSession(feedTruthState) || freshSessions.length));
    const recentEvents = recentVisibleEventsForAgent(state.eventBuf, agentId);
    return {
      activityState: feedTruthUsable ? feedTruthState : 'idle',
      currentTruthSource: feedTruthUsable ? 'feed' : (freshSessions.length ? 'fresh_session_idle' : 'stale_or_none'),
      recentEvents,
      details: {
        feedTruthSessionKey: feedTruth?.sessionKey || null,
        sessionBucketing: sessionBucketDebug.get(agentId) || [],
      },
    };
  }

  return {
    state,
    rememberPendingSpawnAttribution,
    adoptPendingSpawnAttributionForSession,
    rememberSpawnedSessionAgent,
    resolveFeedAgentIdentity,
    pushFeed,
    pushEvent,
    feedGet,
    buildRoomTruth,
  };
}

const nowMs = Date.UTC(2026, 2, 27, 18, 0, 0);
const staleMs = 15 * 1000;
const runtime = createRuntime();

const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
const qaSessionKey = 'agent:main:subagent:qa-20260328';
const codingSessionKey = 'agent:main:subagent:coding-20260328';

runtime.rememberPendingSpawnAttribution(parentSessionKey, {
  label: 'qa-helper-pass',
  task: '你是 qa_agent。請做 live feed acceptance trace。',
});
runtime.rememberPendingSpawnAttribution(parentSessionKey, {
  label: 'coding-helper-pass',
  task: '你是 coding_agent。請修 single-truth pipeline。',
});

for (const [sessionKey, toolName, actorId] of [
  [qaSessionKey, 'browser', 'qa_agent'],
  [codingSessionKey, 'read', 'coding_agent'],
]) {
  const identityStart = runtime.resolveFeedAgentIdentity({ sessionKey, agentId: 'main' });
  runtime.pushFeed({ ts: nowMs - 5000, kind: 'before_agent_start', agentId: identityStart.agentId, rawAgentId: identityStart.rawAgentId, sessionKey });
  runtime.pushEvent({ ts: nowMs - 5000, kind: 'before_agent_start', agentId: identityStart.agentId, data: { sessionKey } });

  const identityTool = runtime.resolveFeedAgentIdentity({ sessionKey, agentId: 'main' });
  runtime.pushFeed({ ts: nowMs - (actorId === 'qa_agent' ? 2000 : 1500), kind: 'before_tool_call', agentId: identityTool.agentId, rawAgentId: identityTool.rawAgentId, sessionKey, toolName, details: actorId === 'qa_agent' ? { url: 'https://example.com' } : {} });
  runtime.pushEvent({ ts: nowMs - (actorId === 'qa_agent' ? 2000 : 1500), kind: 'before_tool_call', agentId: identityTool.agentId, data: { toolName, sessionKey } });

  const identityAfter = runtime.resolveFeedAgentIdentity({ sessionKey, agentId: 'main' });
  runtime.pushFeed({ ts: nowMs - (actorId === 'qa_agent' ? 1200 : 800), kind: 'after_tool_call', agentId: identityAfter.agentId, rawAgentId: identityAfter.rawAgentId, sessionKey, toolName, details: {} });
  runtime.pushEvent({ ts: nowMs - (actorId === 'qa_agent' ? 1200 : 800), kind: 'after_tool_call', agentId: identityAfter.agentId, data: { toolName, sessionKey } });
}

runtime.pushEvent({
  ts: nowMs - 300,
  kind: 'before_tool_call',
  agentId: 'main',
  data: { toolName: 'sessions_spawn', label: 'another helper opener that must not leak into qa story' },
});

runtime.rememberSpawnedSessionAgent(qaSessionKey, 'qa_agent');
runtime.rememberSpawnedSessionAgent(codingSessionKey, 'coding_agent');

const feed = runtime.feedGet();
const qaRows = feed.rows.filter((row) => row.sessionKey === qaSessionKey);
const codingRows = feed.rows.filter((row) => row.sessionKey === codingSessionKey);
const qaTask = feed.tasks.find((task) => task.sessionKey === qaSessionKey);
const codingTask = feed.tasks.find((task) => task.sessionKey === codingSessionKey);
const latest = feed.latest;

assert.ok(qaRows.length >= 3 && qaRows.every((row) => row.agentId === 'qa_agent'), 'qa child rows must stay attributed to qa_agent');
assert.ok(codingRows.length >= 3 && codingRows.every((row) => row.agentId === 'coding_agent'), 'coding child rows must stay attributed to coding_agent');
assert.equal(qaTask?.agentId, 'qa_agent', 'qa task agentId must stay qa_agent');
assert.equal(codingTask?.agentId, 'coding_agent', 'coding task agentId must stay coding_agent');
assert.equal(latest?.agentId, 'coding_agent', 'latest agentId must reflect the latest visible child actor, not main');
assert.equal(qaRows[qaRows.length - 1].rawAgentId, 'main/subagent:qa-20260328', 'raw qa lineage stays debug-only');
assert.equal(codingRows[codingRows.length - 1].rawAgentId, 'main/subagent:coding-20260328', 'raw coding lineage stays debug-only');

const sessions = [
  { key: qaSessionKey, updatedAt: nowMs - 1000 },
  { key: codingSessionKey, updatedAt: nowMs - 600 },
];
const qaTruth = runtime.buildRoomTruth('qa_agent', sessions, nowMs, staleMs);
const codingTruth = runtime.buildRoomTruth('coding_agent', sessions, nowMs, staleMs);

assert.notEqual(qaTruth.activityState, 'idle', 'qa room/Now should not collapse to idle while fresh child activity exists');
assert.notEqual(codingTruth.activityState, 'idle', 'coding room/Now should not collapse to idle while fresh child activity exists');
assert.equal(qaTruth.currentTruthSource, 'feed', 'qa current truth should be driven by visible child feed');
assert.equal(codingTruth.currentTruthSource, 'feed', 'coding current truth should be driven by visible child feed');
assert.equal(qaTruth.details.feedTruthSessionKey, qaSessionKey, 'qa feed truth should point at the qa child session');
assert.equal(codingTruth.details.feedTruthSessionKey, codingSessionKey, 'coding feed truth should point at the coding child session');
assert.ok(qaTruth.details.sessionBucketing.some((row) => row.key === qaSessionKey && row.source === 'spawned'), 'qa fresh session must bucket via spawned visible attribution');
assert.ok(codingTruth.details.sessionBucketing.some((row) => row.key === codingSessionKey && row.source === 'spawned'), 'coding fresh session must bucket via spawned visible attribution');

const qaStory = feedInferRecentActivity({}, qaTruth.recentEvents);
const codingStory = feedInferRecentActivity({}, codingTruth.recentEvents);
assert.equal(qaStory, 'checking the live page', 'qa story must come from qa-visible work, not main helper-start');
assert.equal(codingStory, 'reviewing project files', 'coding story must come from coding-visible work, not cross-actor helper-start');
assert.ok(qaTruth.recentEvents.every((ev) => ev.agentId === 'qa_agent'), 'qa recent events must be actor-scoped only');
assert.ok(codingTruth.recentEvents.every((ev) => ev.agentId === 'coding_agent'), 'coding recent events must be actor-scoped only');

const visiblePayload = JSON.stringify({ rows: feed.rows, tasks: feed.tasks, latest, qaTruth, codingTruth });
assert.ok(!/main\/subagent:(?!qa-20260328|coding-20260328)/.test(visiblePayload), 'no stray descendant leakage beyond debug lineage');
assert.ok(!/"agentId":"main"/.test(visiblePayload), 'visible single-truth payload should not regress child work back to main');

console.log('single-truth-fix-pass-20260328: PASS');
console.log(JSON.stringify({
  rows: feed.rows.map((row) => ({ sessionKey: row.sessionKey, kind: row.kind, agentId: row.agentId, rawAgentId: row.rawAgentId })),
  tasks: feed.tasks.map((task) => ({ sessionKey: task.sessionKey, agentId: task.agentId })),
  latest: { sessionKey: latest?.sessionKey, kind: latest?.kind, agentId: latest?.agentId },
  qaTruth: { activityState: qaTruth.activityState, currentTruthSource: qaTruth.currentTruthSource, details: qaTruth.details, story: qaStory },
  codingTruth: { activityState: codingTruth.activityState, currentTruthSource: codingTruth.currentTruthSource, details: codingTruth.details, story: codingStory },
}, null, 2));
