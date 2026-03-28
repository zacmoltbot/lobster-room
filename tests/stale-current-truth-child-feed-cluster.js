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
  const slash = raw.indexOf('/');
  return (slash >= 0 ? raw.slice(0, slash) : raw).trim();
}

function canonicalVisibleAgentId(value) {
  if (typeof value !== 'string') return '';
  const canonical = canonicalResidentAgentId(value);
  if (!canonical) return '';
  const lower = canonical.toLowerCase();
  if (['subagent', 'spawn', 'cron', 'discord', 'unknown'].includes(lower)) return '';
  return canonical;
}

const UNKNOWN_CHILD_ACTOR_ID = 'unknown';
const isAdoptableChildLane = (lane) => String(lane || '').trim().toLowerCase() === 'subagent';

function inferActivityFromFeedItem(item) {
  if (!item) return null;
  if (item.kind === 'message_sending' || item.kind === 'message_sent') return 'reply';
  if (item.kind === 'before_tool_call') return 'tool';
  if (item.kind === 'agent_end') return item.success === false || !!item.error ? 'error' : 'idle';
  if (item.kind === 'before_agent_start' || item.kind === 'after_tool_call' || item.kind === 'tool_result_persist') return 'thinking';
  return null;
}

function activityNeedsFreshSession(state) {
  return state === 'thinking' || state === 'tool' || state === 'reply';
}

function resolveVisibleFeedItemAgentId(item, spawnedSessionAgentIds, fallback = 'main') {
  if (!item) return fallback;
  if (item.agentId === UNKNOWN_CHILD_ACTOR_ID) return UNKNOWN_CHILD_ACTOR_ID;
  const sessionKey = typeof item.sessionKey === 'string' ? item.sessionKey.trim() : '';
  if (sessionKey) {
    const parsed = parseSessionIdentity(sessionKey, item.agentId);
    if (isAdoptableChildLane(parsed.lane)) {
      const bound = spawnedSessionAgentIds.get(sessionKey);
      if (bound && bound !== UNKNOWN_CHILD_ACTOR_ID) return bound;
      const explicit = canonicalVisibleAgentId(item.agentId);
      const resident = canonicalVisibleAgentId(parsed.residentAgentId);
      const rawAgentId = typeof item.rawAgentId === 'string' ? item.rawAgentId.trim() : '';
      if (explicit && !(resident && explicit === resident && (rawAgentId || parsed.agentId !== explicit))) return explicit;
      return UNKNOWN_CHILD_ACTOR_ID;
    }
  }
  return canonicalVisibleAgentId(item.agentId) || fallback;
}

function latestVisibleFeedItemForAgent(feedBuf, agentId, nowMs, staleMs, spawnedSessionAgentIds) {
  for (let i = feedBuf.length - 1; i >= 0; i -= 1) {
    const item = feedBuf[i];
    if (!item || resolveVisibleFeedItemAgentId(item, spawnedSessionAgentIds, '') !== agentId) continue;
    if (!Number.isFinite(Number(item.ts))) continue;
    if ((nowMs - Number(item.ts)) > staleMs) continue;
    return item;
  }
  return null;
}

function hasFreshCanonicalChildFeedCluster(agentId, feedTruth, feedBuf, nowMs, staleMs, spawnedSessionAgentIds) {
  if (!feedTruth || !activityNeedsFreshSession(inferActivityFromFeedItem(feedTruth))) return false;
  const sessionKey = typeof feedTruth.sessionKey === 'string' ? feedTruth.sessionKey.trim() : '';
  if (!sessionKey) return false;
  if (spawnedSessionAgentIds.get(sessionKey) !== agentId) return false;
  const parsed = parseSessionIdentity(sessionKey, agentId);
  if (!isAdoptableChildLane(parsed.lane)) return false;
  let hits = 0;
  for (let i = feedBuf.length - 1; i >= 0; i -= 1) {
    const item = feedBuf[i];
    if (!item) continue;
    if ((nowMs - Number(item.ts || 0)) > staleMs) break;
    if (resolveVisibleFeedItemAgentId(item, spawnedSessionAgentIds, '') !== agentId) continue;
    if (String(item.sessionKey || '').trim() !== sessionKey) continue;
    if (!activityNeedsFreshSession(inferActivityFromFeedItem(item))) continue;
    hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function pickCurrentTruth({ nowMs, staleMs, agentId, sessions, feedBuf, snapRow, spawnedSessionAgentIds }) {
  const freshSessions = (sessions || []).filter((s) => {
    const updatedAt = Number(s && s.updatedAt || 0);
    return !!(updatedAt && (nowMs - updatedAt) <= staleMs);
  });
  const snapFresh = !!(snapRow && typeof snapRow.lastEventMs === 'number' && (nowMs - snapRow.lastEventMs) <= staleMs);
  const snapState = snapFresh ? snapRow.state : null;
  const feedTruth = latestVisibleFeedItemForAgent(feedBuf || [], agentId, nowMs, staleMs, spawnedSessionAgentIds);
  const feedTruthState = inferActivityFromFeedItem(feedTruth);
  const freshCanonicalChildFeedCluster = hasFreshCanonicalChildFeedCluster(agentId, feedTruth, feedBuf || [], nowMs, staleMs, spawnedSessionAgentIds);
  const activeGrace = freshCanonicalChildFeedCluster;
  const snapUsable = !!(snapFresh && (!activityNeedsFreshSession(snapState) || freshSessions.length || activeGrace));
  const feedTruthUsable = !!(feedTruthState && (!activityNeedsFreshSession(feedTruthState) || freshSessions.length || activeGrace));
  if (snapUsable) return { source: 'snapshot', state: snapState, freshCanonicalChildFeedCluster };
  if (feedTruthUsable) return { source: 'feed', state: feedTruthState, freshCanonicalChildFeedCluster };
  return { source: freshSessions.length ? 'fresh_session_idle' : 'stale_or_none', state: 'idle', freshCanonicalChildFeedCluster };
}

const nowMs = Date.UTC(2026, 2, 29, 1, 40, 0);
const staleMs = 15 * 1000;
const sessionKey = 'agent:main:subagent:qa-live-cluster';
const spawnedSessionAgentIds = new Map([[sessionKey, 'qa_agent']]);

{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'qa_agent',
    sessions: [],
    snapRow: null,
    spawnedSessionAgentIds,
    feedBuf: [
      { ts: nowMs - 2200, kind: 'before_tool_call', agentId: 'main', rawAgentId: 'main/subagent:qa-live-cluster', sessionKey, toolName: 'browser' },
      { ts: nowMs - 900, kind: 'tool_result_persist', agentId: 'main', rawAgentId: 'main/subagent:qa-live-cluster', sessionKey, toolName: 'browser', details: { url: 'https://example.com' } },
    ],
  });
  assert.equal(result.freshCanonicalChildFeedCluster, true, 'canonical child feed cluster should provide short anti-flicker grace');
  assert.equal(result.source, 'feed', 'room/Now should stay on feed truth during child-session list lag');
  assert.notEqual(result.state, 'idle', 'room/Now should not flicker back to idle while child work is visibly ongoing');
}

{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'qa_agent',
    sessions: [],
    snapRow: null,
    spawnedSessionAgentIds,
    feedBuf: [
      { ts: nowMs - 900, kind: 'tool_result_persist', agentId: 'main', rawAgentId: 'main/subagent:qa-live-cluster', sessionKey, toolName: 'browser' },
    ],
  });
  assert.equal(result.freshCanonicalChildFeedCluster, false, 'single residue row must not trigger anti-flicker grace');
  assert.equal(result.source, 'stale_or_none');
  assert.equal(result.state, 'idle');
}

{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'qa_agent',
    sessions: [],
    snapRow: null,
    spawnedSessionAgentIds: new Map(),
    feedBuf: [
      { ts: nowMs - 2200, kind: 'before_tool_call', agentId: 'main', rawAgentId: 'main/subagent:qa-live-cluster', sessionKey, toolName: 'browser' },
      { ts: nowMs - 900, kind: 'tool_result_persist', agentId: 'main', rawAgentId: 'main/subagent:qa-live-cluster', sessionKey, toolName: 'browser' },
    ],
  });
  assert.equal(result.freshCanonicalChildFeedCluster, false, 'unknown/unbound child cluster must not fake proof');
  assert.equal(result.source, 'stale_or_none');
}

console.log('stale-current-truth-child-feed-cluster: PASS');
