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
  const stripped = raw.startsWith('agent:') ? parseSessionIdentity(raw).residentAgentId : raw.replace(/^resident@/, '');
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

const isAdoptableChildLane = (lane) => String(lane || '').trim().toLowerCase() === 'subagent';
const isUnknownChildActor = (value) => value === UNKNOWN_CHILD_ACTOR_ID;
const isFeedVisibleActorId = (value) => isUnknownChildActor(value) || !!canonicalVisibleAgentId(value);

function createRuntime() {
  const spawnedSessionAgentIds = new Map();
  const feedBuf = [];

  function visibleFeedAgentId(value, fallback = 'main') {
    if (value === UNKNOWN_CHILD_ACTOR_ID) return UNKNOWN_CHILD_ACTOR_ID;
    return canonicalVisibleAgentId(value) || fallback;
  }

  function resolveVisibleFeedItemAgentId(it, fallback = 'main') {
    if (!it) return fallback;
    if (isUnknownChildActor(it.agentId)) return UNKNOWN_CHILD_ACTOR_ID;
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

  function isUserVisibleFeedItem(it) {
    return !!it && isFeedVisibleActorId(resolveVisibleFeedItemAgentId(it, ''));
  }

  function feedPreview(it) {
    if (it.kind === 'before_tool_call' && it.toolName === 'sessions_spawn') return 'started helper task for inspect feed truth';
    if (it.kind === 'before_agent_start') return '@coding_agent started';
    if (it.kind === 'before_tool_call') return '@coding_agent inspected feed attribution';
    if (it.kind === 'after_tool_call') return '@coding_agent verified visible feed rows';
    return it.kind;
  }

  function sanitize(it) {
    return {
      ts: it.ts,
      kind: it.kind,
      sessionKey: it.sessionKey,
      toolName: it.toolName,
      rawAgentId: it.rawAgentId,
      agentId: resolveVisibleFeedItemAgentId(it),
      preview: feedPreview(it),
    };
  }

  function groupFeedIntoTasks(items) {
    const byKey = new Map();
    for (const it of items) {
      const sk = String(it.sessionKey || '').trim();
      byKey.set(sk, (byKey.get(sk) || []).concat([it]));
    }
    return [...byKey.entries()].map(([sessionKey, arr]) => ({
      sessionKey,
      agentId: resolveVisibleFeedItemAgentId(arr[0], 'unknown'),
      items: arr.map((it) => sanitize(it)),
    }));
  }

  return {
    spawnedSessionAgentIds,
    feedBuf,
    push(item) { feedBuf.push(item); },
    feedGet() {
      const items = feedBuf.slice();
      const visibleItems = items.filter((it) => isUserVisibleFeedItem(it));
      const tasks = groupFeedIntoTasks(items).filter((task) => isFeedVisibleActorId(task.agentId));
      return {
        rows: visibleItems.slice().reverse().map(sanitize),
        tasks,
        latest: visibleItems.length ? sanitize(visibleItems[visibleItems.length - 1]) : null,
      };
    },
  };
}

const runtime = createRuntime();
const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
const childSessionKey = 'agent:main:subagent:truth-audit-child';

runtime.push({
  ts: 1,
  kind: 'before_tool_call',
  agentId: 'main',
  sessionKey: parentSessionKey,
  toolName: 'sessions_spawn',
  details: {
    spawnAgentId: 'coding_agent',
    label: 'feed-truth-audit',
    task: '你是 coding_agent。做 Lobster Room message feed truth audit。',
  },
});

runtime.push({
  ts: 2,
  kind: 'before_agent_start',
  agentId: 'main',
  rawAgentId: 'main/subagent:truth-audit-child',
  sessionKey: childSessionKey,
});
runtime.push({
  ts: 3,
  kind: 'before_tool_call',
  agentId: 'main',
  rawAgentId: 'main/subagent:truth-audit-child',
  sessionKey: childSessionKey,
  toolName: 'read',
});
runtime.push({
  ts: 4,
  kind: 'after_tool_call',
  agentId: 'main',
  rawAgentId: 'main/subagent:truth-audit-child',
  sessionKey: childSessionKey,
  toolName: 'read',
});

runtime.spawnedSessionAgentIds.set(childSessionKey, 'coding_agent');

const feed = runtime.feedGet();
const parentRows = feed.rows.filter((row) => row.sessionKey === parentSessionKey);
const childRows = feed.rows.filter((row) => row.sessionKey === childSessionKey);
const parentTask = feed.tasks.find((task) => task.sessionKey === parentSessionKey);
const childTask = feed.tasks.find((task) => task.sessionKey === childSessionKey);

assert.equal(parentRows.length, 1, 'parent helper orchestration row should remain visible');
assert.equal(childRows.length, 3, 'child work rows should remain visible alongside parent row');
assert.equal(parentRows[0].agentId, 'main', 'parent row must stay attributed to main');
assert.ok(childRows.every((row) => row.agentId === 'coding_agent'), 'child rows must rebind to coding_agent at visible read time');
assert.equal(parentTask.agentId, 'main', 'parent orchestration task must stay on main');
assert.equal(childTask.agentId, 'coding_agent', 'child work task must stay on coding_agent');
assert.equal(feed.latest.agentId, 'coding_agent', 'latest visible row should reflect the child doing the latest real work');
assert.ok(feed.rows.some((row) => row.preview.includes('started helper task')), 'parent helper preview should still exist');
assert.ok(feed.rows.some((row) => row.preview.includes('verified visible feed rows')), 'child work preview should still exist');

console.log('feed-parent-child-coexistence-visible: PASS');
