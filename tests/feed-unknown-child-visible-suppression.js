const assert = require('node:assert/strict');

const UNKNOWN_CHILD_ACTOR_ID = 'unknown';

function parseSessionIdentity(sessionKey, fallbackAgentId) {
  const raw = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
  if (raw) {
    const parts = raw.split(':');
    if (parts[0] === 'agent') {
      const residentAgentId = String(parts[1] || '').trim() || 'main';
      const lane = String(parts[2] || '').trim() || 'main';
      const tail = parts.slice(3).join(':').trim();
      const agentId = lane === 'subagent' && tail ? `${residentAgentId}/subagent:${tail}` : residentAgentId;
      return { agentId, residentAgentId, lane };
    }
  }
  const id = typeof fallbackAgentId === 'string' ? String(fallbackAgentId).trim() : '';
  return { agentId: id || 'main', residentAgentId: id || 'main', lane: 'main' };
}

function canonicalResidentAgentId(value) {
  if (typeof value !== 'string') return '';
  const raw = String(value).trim();
  if (!raw) return '';
  const stripped = raw.startsWith('agent:') ? parseSessionIdentity(raw).residentAgentId : raw;
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
  if (value === UNKNOWN_CHILD_ACTOR_ID) return UNKNOWN_CHILD_ACTOR_ID;
  return canonicalVisibleAgentId(value) || fallback;
}

const isAdoptableChildLane = (lane) => String(lane || '').trim().toLowerCase() === 'subagent';
const isUnknownChildActor = (value) => value === UNKNOWN_CHILD_ACTOR_ID;
const isUserVisibleActorId = (value) => !isUnknownChildActor(value) && !!canonicalVisibleAgentId(value);
const isFeedVisibleActorId = (value) => isUnknownChildActor(value) || !!canonicalVisibleAgentId(value);
const isUserVisibleFeedItem = (it) => !!it && isFeedVisibleActorId(it.agentId);

function resolveVisibleSessionBucket(sessionKey, spawnedSessionAgentIds) {
  if (typeof sessionKey !== 'string') return { agentId: null, source: 'none' };
  const raw = String(sessionKey).trim();
  if (!raw) return { agentId: null, source: 'none' };
  const spawnedVisible = spawnedSessionAgentIds.get(raw);
  if (spawnedVisible && spawnedVisible !== UNKNOWN_CHILD_ACTOR_ID) return { agentId: spawnedVisible, source: 'spawned' };
  const parsed = parseSessionIdentity(raw);
  if (isAdoptableChildLane(parsed.lane)) return { agentId: null, source: 'none' };
  const resident = canonicalVisibleAgentId(parsed.residentAgentId);
  return { agentId: resident || null, source: resident ? 'resident' : 'none' };
}

function resolveFeedAgentIdentity(ctx, spawnedSessionAgentIds) {
  const parsed = parseSessionIdentity(ctx && ctx.sessionKey, ctx && ctx.agentId);
  const childSessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
  const spawnedVisible = childSessionKey ? (spawnedSessionAgentIds.get(childSessionKey) || '') : '';
  if (spawnedVisible) return { agentId: spawnedVisible, residentAgentId: parsed.residentAgentId, lane: parsed.lane, source: 'spawned' };
  const explicit = canonicalVisibleAgentId(ctx && ctx.agentId);
  if (explicit && !(isAdoptableChildLane(parsed.lane) && explicit === canonicalVisibleAgentId(parsed.residentAgentId) && parsed.agentId !== explicit)) {
    return { agentId: explicit, residentAgentId: parsed.residentAgentId, lane: parsed.lane, source: 'explicit' };
  }
  return {
    agentId: isAdoptableChildLane(parsed.lane) ? UNKNOWN_CHILD_ACTOR_ID : (canonicalVisibleAgentId(parsed.residentAgentId) || 'main'),
    residentAgentId: parsed.residentAgentId,
    lane: parsed.lane,
    source: 'fallback',
  };
}

function feedGet(items, includeRaw = false) {
  const bySession = new Map();
  for (const it of items) {
    const sk = String(it.sessionKey || '').trim();
    bySession.set(sk, (bySession.get(sk) || []).concat([it]));
  }
  const tasks = [...bySession.entries()].map(([sk, arr]) => ({
    sessionKey: sk,
    agentId: visibleFeedAgentId(arr.find((it) => it.agentId)?.agentId, 'unknown'),
    items: includeRaw ? arr.slice() : undefined,
  }));
  const visibleItems = items.filter((it) => isUserVisibleFeedItem(it));
  return {
    rows: visibleItems,
    latest: visibleItems.length ? visibleItems[visibleItems.length - 1] : null,
    tasks: tasks
      .filter((task) => isFeedVisibleActorId(task.agentId))
      .map((task) => ({
        ...task,
        items: task.items ? task.items.filter((it) => isUserVisibleFeedItem(it)) : undefined,
      })),
    items: includeRaw ? items.slice() : undefined,
  };
}

{
  const spawned = new Map();
  const sessionKey = 'agent:main:subagent:child-no-proof';
  const identity = resolveFeedAgentIdentity({ sessionKey, agentId: 'main' }, spawned);
  assert.equal(identity.agentId, UNKNOWN_CHILD_ACTOR_ID, 'internal canonical identity stays unknown/pending without proof');
  assert.equal(identity.source, 'fallback');

  const payload = feedGet([
    { ts: 1, kind: 'before_tool_call', agentId: identity.agentId, sessionKey, toolName: 'read' },
  ], true);
  assert.equal(payload.rows.length, 1, 'visible rows must keep unknown child activity visible');
  assert.equal(payload.tasks.length, 1, 'visible tasks must keep unknown child activity visible');
  assert.equal(payload.latest && payload.latest.agentId, UNKNOWN_CHILD_ACTOR_ID, 'visible latest must keep unknown child activity visible');
  assert.equal(payload.rows[0].agentId, UNKNOWN_CHILD_ACTOR_ID);
  assert.equal(payload.tasks[0].agentId, UNKNOWN_CHILD_ACTOR_ID);
  assert.equal(payload.items.length, 1, 'raw/debug payload may retain unknown child activity');
  assert.equal(payload.items[0].agentId, UNKNOWN_CHILD_ACTOR_ID);

  const bucket = resolveVisibleSessionBucket(sessionKey, spawned);
  assert.equal(bucket.agentId, null, 'room/Now session bucketing must not fallback unknown child to main');
}

{
  const spawned = new Map([['agent:main:subagent:child-qa-proof', 'qa_agent']]);
  const sessionKey = 'agent:main:subagent:child-qa-proof';
  const identity = resolveFeedAgentIdentity({ sessionKey, agentId: 'main' }, spawned);
  assert.equal(identity.agentId, 'qa_agent', 'proof-bound child keeps correct visible actor');
  assert.equal(identity.source, 'spawned');

  const payload = feedGet([
    { ts: 1, kind: 'before_tool_call', agentId: identity.agentId, sessionKey, toolName: 'browser' },
    { ts: 2, kind: 'after_tool_call', agentId: identity.agentId, sessionKey, toolName: 'browser' },
  ], true);
  assert.deepEqual(payload.rows.map((row) => row.agentId), ['qa_agent', 'qa_agent']);
  assert.deepEqual(payload.tasks.map((task) => task.agentId), ['qa_agent']);
  assert.equal(payload.latest && payload.latest.agentId, 'qa_agent');
  assert.ok(!JSON.stringify({ rows: payload.rows, tasks: payload.tasks, latest: payload.latest }).includes('\"agentId\":\"main\"'), 'proof-bound child must not regress back to main');

  const bucket = resolveVisibleSessionBucket(sessionKey, spawned);
  assert.equal(bucket.agentId, 'qa_agent', 'room/Now session bucketing must stay aligned with visible proof-bound actor');
}

console.log('feed-unknown-child-visible-suppression: PASS');
