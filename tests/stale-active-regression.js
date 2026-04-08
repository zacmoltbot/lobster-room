const assert = require('assert');

function mapActivityToUiState(state) {
  if (state === 'thinking') return 'think';
  if (state === 'idle') return 'wait';
  return state;
}

function inferActivityFromFeedItem(item) {
  if (!item) return null;
  if (item.kind === 'message_sending' || item.kind === 'message_sent') return 'reply';
  if (item.kind === 'before_tool_call') return 'tool';
  if (item.kind === 'agent_end') return item.success === false || !!item.error ? 'error' : 'idle';
  if (item.kind === 'before_agent_start' || item.kind === 'after_tool_call' || item.kind === 'tool_result_persist') return 'thinking';
  return null;
}

function latestVisibleFeedItemForAgent(feedBuf, agentId, nowMs, staleMs) {
  for (let i = feedBuf.length - 1; i >= 0; i -= 1) {
    const item = feedBuf[i];
    if (!item || item.agentId !== agentId) continue;
    if (!Number.isFinite(Number(item.ts))) continue;
    if ((nowMs - Number(item.ts)) > staleMs) continue;
    return item;
  }
  return null;
}

function activityNeedsFreshSession(state) {
  return state === 'thinking' || state === 'tool' || state === 'reply';
}

function pickCurrentTruth({ nowMs, staleMs, agentId, sessions, feedBuf, snapRow }) {
  const freshSessions = (sessions || []).filter((s) => {
    const updatedAt = Number(s && s.updatedAt || 0);
    return !!(updatedAt && (nowMs - updatedAt) <= staleMs);
  });

  const snapFresh = !!(snapRow && typeof snapRow.lastEventMs === 'number' && (nowMs - snapRow.lastEventMs) <= staleMs);
  const snapState = snapFresh ? snapRow.state : null;
  const snapUsable = !!(snapFresh && (!activityNeedsFreshSession(snapState) || freshSessions.length));

  const feedTruth = latestVisibleFeedItemForAgent(feedBuf || [], agentId, nowMs, staleMs);
  const feedTruthState = inferActivityFromFeedItem(feedTruth);
  const feedTruthUsable = !!(feedTruthState && (!activityNeedsFreshSession(feedTruthState) || freshSessions.length));

  if (snapUsable) return { source: 'snapshot', state: mapActivityToUiState(snapState) };
  if (feedTruthUsable) return { source: 'feed', state: mapActivityToUiState(feedTruthState) };
  return { source: freshSessions.length ? 'fresh_session_idle' : 'stale_or_none', state: 'wait' };
}

const nowMs = Date.UTC(2026, 2, 27, 12, 0, 0);
const staleMs = 15 * 1000;

{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'qa_agent',
    sessions: [],
    feedBuf: [{ ts: nowMs - 2000, kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'browser' }],
    snapRow: null,
  });
  assert.deepEqual(result, { source: 'stale_or_none', state: 'wait' });
}

{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'coding_agent',
    sessions: [],
    feedBuf: [],
    snapRow: { state: 'tool', lastEventMs: nowMs - 1000 },
  });
  assert.deepEqual(result, { source: 'stale_or_none', state: 'wait' });
}

{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'coding_agent',
    sessions: [{ key: 'agent:coding_agent:subagent:live', updatedAt: nowMs - 1000 }],
    feedBuf: [],
    snapRow: { state: 'tool', lastEventMs: nowMs - 1000 },
  });
  assert.deepEqual(result, { source: 'snapshot', state: 'tool' });
}

console.log('stale-active-regression: PASS');
