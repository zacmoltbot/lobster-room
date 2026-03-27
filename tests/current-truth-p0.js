const assert = require('assert');

function mapActivityToUiState(state) {
  if (state === 'thinking') return 'think';
  if (state === 'idle') return 'wait';
  return state;
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

function inferActivityFromFeedItem(item) {
  if (!item) return null;
  if (item.kind === 'message_sending' || item.kind === 'message_sent') return 'reply';
  if (item.kind === 'before_tool_call') return 'tool';
  if (item.kind === 'agent_end') return item.success === false || !!item.error ? 'error' : 'idle';
  if (item.kind === 'before_agent_start' || item.kind === 'after_tool_call' || item.kind === 'tool_result_persist') return 'thinking';
  return null;
}

function pickCurrentTruth({ agentId, nowMs, staleMs, sessions, feedBuf, snapRow, queueDepth }) {
  const list = (sessions || []).slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const maxUpdatedAt = list.length ? Number(list[0].updatedAt || 0) : 0;
  const freshSessions = list.filter((s) => {
    const updatedAt = Number(s && s.updatedAt || 0);
    return !!(updatedAt && (nowMs - updatedAt) <= staleMs);
  });
  const freshMaxUpdatedAt = freshSessions.length ? Number(freshSessions[0].updatedAt || 0) : 0;
  const snapFresh = !!(snapRow && typeof snapRow.lastEventMs === 'number' && (nowMs - snapRow.lastEventMs) <= staleMs);
  const feedTruth = latestVisibleFeedItemForAgent(feedBuf || [], agentId, nowMs, staleMs);
  const feedTruthState = inferActivityFromFeedItem(feedTruth);

  let activityState = 'idle';
  let uiState = 'wait';
  let currentTruthSource = 'idle';

  if (snapFresh) {
    activityState = snapRow.state;
    uiState = mapActivityToUiState(activityState);
    currentTruthSource = 'snapshot';
  } else if (feedTruthState) {
    activityState = feedTruthState;
    uiState = mapActivityToUiState(activityState);
    currentTruthSource = 'feed';
  } else if (typeof queueDepth === 'number' && queueDepth > 0 && freshSessions.length) {
    activityState = 'thinking';
    uiState = 'think';
    currentTruthSource = 'session_status';
  } else {
    activityState = 'idle';
    uiState = 'wait';
    currentTruthSource = freshSessions.length ? 'fresh_session_idle' : 'stale_or_none';
  }

  return {
    activityState,
    uiState,
    currentTruthSource,
    sinceMs: snapFresh ? (snapRow.sinceMs || null) : (feedTruth ? Number(feedTruth.ts) : (freshMaxUpdatedAt || null)),
    lastEventMs: snapFresh ? (snapRow.lastEventMs || null) : (feedTruth ? Number(feedTruth.ts) : (freshMaxUpdatedAt || null)),
    maxUpdatedAt: maxUpdatedAt || null,
    feedTruth,
  };
}

const DAY = 24 * 60 * 60 * 1000;
const nowMs = Date.UTC(2026, 2, 27, 7, 39, 0);
const staleMs = 15 * 1000;

// 1. stale session (8d old) must not dominate room/Now.
{
  const result = pickCurrentTruth({
    agentId: 'qa_agent',
    nowMs,
    staleMs,
    sessions: [{ key: 'agent:qa_agent:main', updatedAt: nowMs - 8 * DAY, kind: 'main' }],
    feedBuf: [],
    snapRow: null,
    queueDepth: 0,
  });
  assert.equal(result.uiState, 'wait', '8d-old session must not produce visible activity');
  assert.equal(result.activityState, 'idle', 'stale session should collapse to idle');
  assert.equal(result.currentTruthSource, 'stale_or_none');
}

// 2. recent qa_agent feed/task should beat stale session residue and align room/Now with feed/tasks.
{
  const result = pickCurrentTruth({
    agentId: 'qa_agent',
    nowMs,
    staleMs,
    sessions: [
      { key: 'agent:qa_agent:main', updatedAt: nowMs - 8 * DAY, kind: 'main' },
      { key: 'agent:qa_agent:subagent:old', updatedAt: nowMs - 8 * DAY, kind: 'subagent' },
    ],
    feedBuf: [
      { ts: nowMs - 3000, kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'browser', sessionKey: 'agent:qa_agent:subagent:fresh-qa' },
    ],
    snapRow: null,
    queueDepth: 0,
  });
  assert.equal(result.uiState, 'tool', 'recent visible qa feed row should drive Now');
  assert.equal(result.activityState, 'tool');
  assert.equal(result.currentTruthSource, 'feed');
  assert.equal(result.feedTruth.sessionKey, 'agent:qa_agent:subagent:fresh-qa');
}

// 3. internal observation / debug probe must not make main look busy.
{
  const result = pickCurrentTruth({
    agentId: 'main',
    nowMs,
    staleMs,
    sessions: [{ key: 'agent:main:discord:channel:probe', updatedAt: nowMs - 1500, kind: 'main' }],
    feedBuf: [], // visible feed intentionally excludes internal observation tools
    snapRow: null,
    queueDepth: 0,
  });
  assert.equal(result.uiState, 'wait', 'fresh probe-only session must not create fake busy state');
  assert.equal(result.activityState, 'idle');
  assert.equal(result.currentTruthSource, 'fresh_session_idle');
}

// 4. actor attribution fix must not regress: recent child activity attributed to qa_agent should still win.
{
  const result = pickCurrentTruth({
    agentId: 'qa_agent',
    nowMs,
    staleMs,
    sessions: [{ key: 'agent:qa_agent:main', updatedAt: nowMs - 2000, kind: 'main' }],
    feedBuf: [
      { ts: nowMs - 1000, kind: 'before_agent_start', agentId: 'qa_agent', rawAgentId: 'main/subagent:qa-child', sessionKey: 'agent:main:subagent:qa-child' },
    ],
    snapRow: null,
    queueDepth: 0,
  });
  assert.equal(result.uiState, 'think');
  assert.equal(result.currentTruthSource, 'feed');
  assert.equal(result.feedTruth.agentId, 'qa_agent', 'visible actor attribution must remain qa_agent');
  assert.equal(result.feedTruth.rawAgentId, 'main/subagent:qa-child', 'debug raw lineage remains preserved');
}

console.log('current-truth-p0: PASS');
