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

function hasFreshCorroboratedActiveSignal({ snapFresh, snapState, snapRow, feedTruth, feedTruthState }) {
  if (!snapFresh || !feedTruth || !feedTruthState) return false;
  if (!activityNeedsFreshSession(snapState) || !activityNeedsFreshSession(feedTruthState)) return false;
  const snapSessionKey = typeof snapRow?.details?.sessionKey === 'string' ? snapRow.details.sessionKey.trim() : '';
  const feedSessionKey = typeof feedTruth?.sessionKey === 'string' ? feedTruth.sessionKey.trim() : '';
  if (snapSessionKey && feedSessionKey && snapSessionKey !== feedSessionKey) return false;
  return true;
}

function pickCurrentTruth({ nowMs, staleMs, agentId, sessions, feedBuf, snapRow }) {
  const freshSessions = (sessions || []).filter((s) => {
    const updatedAt = Number(s && s.updatedAt || 0);
    return !!(updatedAt && (nowMs - updatedAt) <= staleMs);
  });

  const snapLowSignal = !!(snapRow?.details && (
    snapRow.details.lowSignal === true
    || ['sessions_history', 'sessions_list', 'session_status'].includes(String(snapRow.details.toolName || ''))
  ));
  const snapFresh = !!(snapRow && !snapLowSignal && typeof snapRow.lastEventMs === 'number' && (nowMs - snapRow.lastEventMs) <= staleMs);
  const snapState = snapFresh ? snapRow.state : null;
  const feedTruth = latestVisibleFeedItemForAgent(feedBuf || [], agentId, nowMs, staleMs);
  const feedTruthState = inferActivityFromFeedItem(feedTruth);
  const freshActiveCorroborated = hasFreshCorroboratedActiveSignal({ snapFresh, snapState, snapRow, feedTruth, feedTruthState });
  const snapUsable = !!(snapFresh && (!activityNeedsFreshSession(snapState) || freshSessions.length || freshActiveCorroborated));
  const feedTruthUsable = !!(feedTruthState && (!activityNeedsFreshSession(feedTruthState) || freshSessions.length || freshActiveCorroborated));

  if (snapUsable) return { source: 'snapshot', state: mapActivityToUiState(snapState), freshActiveCorroborated };
  if (feedTruthUsable) return { source: 'feed', state: mapActivityToUiState(feedTruthState), freshActiveCorroborated };
  return { source: freshSessions.length ? 'fresh_session_idle' : 'stale_or_none', state: 'wait', freshActiveCorroborated };
}

const nowMs = Date.UTC(2026, 2, 28, 2, 20, 0);
const staleMs = 15 * 1000;

// Live failing shape: fresh snapshot + fresh visible tool_result_persist, but sessions_list has not yielded a fresh session.
{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'coding_agent',
    sessions: [],
    feedBuf: [{
      ts: nowMs - 1200,
      kind: 'tool_result_persist',
      agentId: 'coding_agent',
      sessionKey: 'agent:main:subagent:coding-live',
      toolName: 'edit',
      details: { task: 'patch current-truth gate' },
    }],
    snapRow: {
      state: 'tool',
      lastEventMs: nowMs - 900,
      details: { toolName: 'edit', sessionKey: 'agent:main:subagent:coding-live', persisted: true },
    },
  });
  assert.equal(result.freshActiveCorroborated, true, 'fresh snapshot + feed should corroborate active work');
  assert.notEqual(result.state, 'wait', 'room/Now must not collapse to idle/wait when live activity is corroborated');
  assert.equal(result.source, 'snapshot');
  assert.equal(result.state, 'tool');
}

// Guard: snapshot alone is still insufficient.
{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'coding_agent',
    sessions: [],
    feedBuf: [],
    snapRow: {
      state: 'tool',
      lastEventMs: nowMs - 900,
      details: { toolName: 'edit', sessionKey: 'agent:main:subagent:coding-live' },
    },
  });
  assert.deepEqual(result, { source: 'stale_or_none', state: 'wait', freshActiveCorroborated: false });
}

// Guard: feed residue alone is still insufficient.
{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'qa_agent',
    sessions: [],
    feedBuf: [{
      ts: nowMs - 1200,
      kind: 'tool_result_persist',
      agentId: 'qa_agent',
      sessionKey: 'agent:main:subagent:qa-live',
      toolName: 'browser',
    }],
    snapRow: null,
  });
  assert.deepEqual(result, { source: 'stale_or_none', state: 'wait', freshActiveCorroborated: false });
}

// Guard: mismatched session keys must not corroborate.
{
  const result = pickCurrentTruth({
    nowMs,
    staleMs,
    agentId: 'qa_agent',
    sessions: [],
    feedBuf: [{
      ts: nowMs - 1200,
      kind: 'tool_result_persist',
      agentId: 'qa_agent',
      sessionKey: 'agent:main:subagent:qa-live-a',
      toolName: 'browser',
    }],
    snapRow: {
      state: 'tool',
      lastEventMs: nowMs - 900,
      details: { toolName: 'browser', sessionKey: 'agent:main:subagent:qa-live-b' },
    },
  });
  assert.deepEqual(result, { source: 'stale_or_none', state: 'wait', freshActiveCorroborated: false });
}

console.log('final-summary-current-truth-gate: PASS');
