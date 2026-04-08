const assert = require('assert');

function parseSessionIdentity(sessionKey, fallbackAgentId) {
  if (typeof sessionKey === 'string') {
    const raw = String(sessionKey).trim();
    const match = raw.match(/^agent:([^:]+):(main|subagent|cron)(?::(.+))?$/i);
    if (match) {
      const residentAgentId = String(match[1] || '').trim() || 'main';
      const lane = String(match[2] || 'main').trim().toLowerCase();
      const tail = String(match[3] || '').trim();
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
  if (lower === 'subagent' || lower === 'spawn' || lower === 'cron' || lower === 'discord' || lower === 'unknown') return '';
  return canonical;
}

const UNKNOWN_CHILD_ACTOR_ID = 'unknown';
const isAdoptableChildLane = (lane) => String(lane || '').trim().toLowerCase() === 'subagent';
const visibleFeedAgentId = (value, fallback = 'main') => value === UNKNOWN_CHILD_ACTOR_ID ? UNKNOWN_CHILD_ACTOR_ID : (canonicalVisibleAgentId(value) || fallback);

function createRuntime() {
  const spawnedSessionAgentIds = new Map();
  const feedBuf = [];

  function resolveVisibleFeedItemAgentId(it, fallback = 'main') {
    if (!it) return fallback;
    if (it.agentId === UNKNOWN_CHILD_ACTOR_ID) return UNKNOWN_CHILD_ACTOR_ID;
    const sessionKey = typeof it.sessionKey === 'string' ? it.sessionKey.trim() : '';
    if (sessionKey) {
      const parsed = parseSessionIdentity(sessionKey, it.agentId);
      if (isAdoptableChildLane(parsed.lane)) {
        const bound = spawnedSessionAgentIds.get(sessionKey);
        if (bound && bound !== UNKNOWN_CHILD_ACTOR_ID) return bound;
        const explicit = canonicalVisibleAgentId(it.agentId);
        const resident = canonicalVisibleAgentId(parsed.residentAgentId);
        const rawAgentId = typeof it.rawAgentId === 'string' ? it.rawAgentId.trim() : '';
        if (explicit && !(resident && explicit === resident && (rawAgentId || parsed.agentId !== explicit))) return explicit;
        return UNKNOWN_CHILD_ACTOR_ID;
      }
    }
    return visibleFeedAgentId(it.agentId, fallback);
  }

  function sanitizeFeedItemForApi(it) {
    return {
      kind: it.kind,
      sessionKey: it.sessionKey,
      rawAgentId: it.rawAgentId,
      agentId: resolveVisibleFeedItemAgentId(it),
    };
  }

  function groupFeedIntoTasks(items) {
    const byKey = new Map();
    for (const it of items) {
      const key = String(it.sessionKey || '');
      byKey.set(key, (byKey.get(key) || []).concat([it]));
    }
    return Array.from(byKey.entries()).map(([sessionKey, arr]) => ({
      sessionKey,
      agentId: resolveVisibleFeedItemAgentId(arr[0], 'unknown'),
      items: arr.map((it) => ({ kind: it.kind, agentId: resolveVisibleFeedItemAgentId(it, 'unknown') })),
    }));
  }

  function latestVisibleFeedItemForAgent(agentId) {
    for (let i = feedBuf.length - 1; i >= 0; i -= 1) {
      const item = feedBuf[i];
      if (resolveVisibleFeedItemAgentId(item, '') === agentId) return item;
    }
    return null;
  }

  function resolveVisibleSessionBucket(sessionKey) {
    const bound = spawnedSessionAgentIds.get(sessionKey);
    if (bound) return { agentId: bound, source: 'spawned' };
    const parsed = parseSessionIdentity(sessionKey);
    if (isAdoptableChildLane(parsed.lane)) return { agentId: null, source: 'none' };
    return { agentId: canonicalVisibleAgentId(parsed.residentAgentId) || null, source: 'resident' };
  }

  return {
    spawnedSessionAgentIds,
    feedBuf,
    push(item) { feedBuf.push(item); },
    feedGet() {
      const visible = feedBuf.filter((it) => resolveVisibleFeedItemAgentId(it, '') !== UNKNOWN_CHILD_ACTOR_ID);
      return {
        rows: visible.slice().reverse().map(sanitizeFeedItemForApi),
        tasks: groupFeedIntoTasks(visible),
        latest: visible.length ? sanitizeFeedItemForApi(visible[visible.length - 1]) : null,
      };
    },
    latestVisibleFeedItemForAgent,
    resolveVisibleSessionBucket,
    resolveVisibleFeedItemAgentId,
  };
}

const runtime = createRuntime();
const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
const childSessionKey = 'agent:main:subagent:live-qa-child';

const parentSpawnRow = {
  ts: 1,
  kind: 'before_tool_call',
  agentId: 'main',
  sessionKey: parentSessionKey,
  toolName: 'sessions_spawn',
  details: {
    toolName: 'sessions_spawn',
    label: 'qa-live-path',
    task: '你是 qa_agent。重放 QA live path，驗證 rows/tasks/latest/room/Now 一致性。',
    spawnAgentId: 'qa_agent',
  },
};

const childRowsStoredTooEarly = [
  { ts: 2, kind: 'before_agent_start', agentId: 'main', rawAgentId: 'main/subagent:live-qa-child', sessionKey: childSessionKey },
  { ts: 3, kind: 'before_tool_call', agentId: 'main', rawAgentId: 'main/subagent:live-qa-child', sessionKey: childSessionKey, toolName: 'browser' },
  { ts: 4, kind: 'after_tool_call', agentId: 'main', rawAgentId: 'main/subagent:live-qa-child', sessionKey: childSessionKey, toolName: 'browser' },
];

runtime.push(parentSpawnRow);
childRowsStoredTooEarly.forEach((row) => runtime.push(row));

assert.equal(runtime.resolveVisibleFeedItemAgentId(childRowsStoredTooEarly[0]), UNKNOWN_CHILD_ACTOR_ID, 'before canonical binding, child row must stay unknown/pending instead of regressing to main');
assert.equal(runtime.resolveVisibleSessionBucket(childSessionKey).agentId, null, 'before canonical binding, child session must not bucket to main');

runtime.spawnedSessionAgentIds.set(childSessionKey, 'qa_agent');

const feed = runtime.feedGet();
const latestQa = runtime.latestVisibleFeedItemForAgent('qa_agent');
const bucket = runtime.resolveVisibleSessionBucket(childSessionKey);

assert.equal(feed.rows[0].agentId, 'qa_agent', 'read-time canonical rebinding must fix latest row actor');
assert.ok(feed.rows.slice(0, 3).every((row) => row.agentId === 'qa_agent'), 'all stored child rows must rebind to qa_agent at read time');
assert.equal(feed.tasks.find((task) => task.sessionKey === childSessionKey).agentId, 'qa_agent', 'task actor must come from canonical child binding');
assert.equal(feed.latest.agentId, 'qa_agent', 'latest.agentId must come from canonical child binding');
assert.equal(latestQa.sessionKey, childSessionKey, 'Now/feed truth lookup must find the rebound child row under qa_agent');
assert.deepEqual(bucket, { agentId: 'qa_agent', source: 'spawned' }, 'room session bucketing must use childSessionKey -> canonical actor binding');
assert.equal(feed.rows[0].rawAgentId, 'main/subagent:live-qa-child', 'debug raw lineage stays intact');
const childVisiblePayload = JSON.stringify({
  childRows: feed.rows.filter((row) => row.sessionKey === childSessionKey),
  childTask: feed.tasks.find((task) => task.sessionKey === childSessionKey),
  latest: feed.latest,
  bucket,
});
assert.ok(!childVisiblePayload.includes('"agentId":"main"'), 'child visible payload must not regress rebound child work back to main');

console.log('live-shaped-canonical-child-binding-regression: PASS');
