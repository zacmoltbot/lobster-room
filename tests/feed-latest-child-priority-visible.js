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

const isAdoptableChildLane = (lane) => String(lane || '').trim().toLowerCase() === 'subagent';
const isUnknownChildActor = (value) => value === UNKNOWN_CHILD_ACTOR_ID;
const isFeedVisibleActorId = (value) => isUnknownChildActor(value) || !!canonicalVisibleAgentId(value);

function createRuntime() {
  const spawnedSessionAgentIds = new Map();

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
    return canonicalVisibleAgentId(it.agentId) || fallback;
  }

  function isUserVisibleFeedItem(it) {
    return !!it && isFeedVisibleActorId(resolveVisibleFeedItemAgentId(it, ''));
  }

  function shouldSuppressFeedItem(it, allItems) {
    if (it.kind === 'tool_result_persist') {
      const hasIntent = !!String(it.details && it.details.intent || '').trim();
      if (hasIntent) return false;
      const resolvedAgentId = resolveVisibleFeedItemAgentId(it, '');
      if (resolvedAgentId === UNKNOWN_CHILD_ACTOR_ID) return false;
      const sessionKey = typeof it.sessionKey === 'string' ? it.sessionKey.trim() : '';
      if (!sessionKey) return false;
      const sameSessionVisible = allItems.filter((candidate) => candidate !== it && candidate.sessionKey === sessionKey && isUserVisibleFeedItem(candidate));
      const hasStory = sameSessionVisible.some((candidate) => ['before_agent_start', 'before_tool_call', 'after_tool_call', 'message_sent'].includes(candidate.kind));
      return hasStory;
    }
    return false;
  }

  function feedItemLatestPriority(it) {
    const resolvedAgentId = resolveVisibleFeedItemAgentId(it, '');
    const sessionKey = typeof it.sessionKey === 'string' ? it.sessionKey.trim() : '';
    const parsed = sessionKey ? parseSessionIdentity(sessionKey, it.agentId) : { lane: 'main' };
    const isChildLane = isAdoptableChildLane(parsed.lane);
    const hasIntent = !!String(it.details && it.details.intent || '').trim();
    switch (it.kind) {
      case 'message_sent':
      case 'message_sending':
        return 90;
      case 'after_tool_call':
        return isChildLane ? 82 : 74;
      case 'before_tool_call':
        if (String(it.toolName || '') === 'sessions_spawn') return isChildLane ? 64 : 28;
        return isChildLane ? 78 : 70;
      case 'tool_result_persist':
        if (resolvedAgentId === UNKNOWN_CHILD_ACTOR_ID) return 76;
        return hasIntent ? (isChildLane ? 80 : 72) : (isChildLane ? 68 : 40);
      case 'before_agent_start':
        return isChildLane ? 62 : 52;
      case 'agent_end':
        return it.success === false || !!it.error ? 85 : 18;
      default:
        return isChildLane ? 60 : 50;
    }
  }

  function pickLatestVisibleFeedItem(items) {
    let best = null;
    let bestScore = -Infinity;
    for (const it of items) {
      const score = feedItemLatestPriority(it);
      if (!best || score > bestScore || (score === bestScore && Number(it.ts || 0) >= Number(best.ts || 0))) {
        best = it;
        bestScore = score;
      }
    }
    return best;
  }

  function feedGet(feedBuf) {
    const visibleItems = feedBuf.filter((it) => isUserVisibleFeedItem(it) && !shouldSuppressFeedItem(it, feedBuf));
    return {
      rows: visibleItems,
      latest: pickLatestVisibleFeedItem(visibleItems),
    };
  }

  return { spawnedSessionAgentIds, feedGet, resolveVisibleFeedItemAgentId };
}

{
  const runtime = createRuntime();
  const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
  const childSessionKey = 'agent:main:subagent:coding-real-work';
  runtime.spawnedSessionAgentIds.set(childSessionKey, 'coding_agent');

  const payload = runtime.feedGet([
    { ts: 1, kind: 'before_tool_call', agentId: 'main', sessionKey: parentSessionKey, toolName: 'sessions_spawn' },
    { ts: 2, kind: 'before_tool_call', agentId: 'main', rawAgentId: 'main/subagent:coding-real-work', sessionKey: childSessionKey, toolName: 'read' },
    { ts: 3, kind: 'after_tool_call', agentId: 'main', rawAgentId: 'main/subagent:coding-real-work', sessionKey: childSessionKey, toolName: 'read' },
    { ts: 4, kind: 'before_tool_call', agentId: 'main', sessionKey: parentSessionKey, toolName: 'sessions_spawn' },
  ]);

  assert.equal(runtime.resolveVisibleFeedItemAgentId(payload.latest), 'coding_agent', 'latest should prefer real child work over later helper orchestration row');
  assert.equal(payload.rows.length, 4, 'parent and child rows should coexist visibly');
}

{
  const runtime = createRuntime();
  const childSessionKey = 'agent:main:subagent:unknown-visible-work';
  const payload = runtime.feedGet([
    { ts: 1, kind: 'tool_result_persist', agentId: UNKNOWN_CHILD_ACTOR_ID, sessionKey: childSessionKey, toolName: 'read', details: {} },
  ]);

  assert.equal(payload.rows.length, 1, 'unknown child visible work must not be swallowed when intent is missing');
  assert.equal(runtime.resolveVisibleFeedItemAgentId(payload.latest), UNKNOWN_CHILD_ACTOR_ID, 'latest should stay honest when child actor is still unresolved');
}

console.log('feed-latest-child-priority-visible: PASS');
