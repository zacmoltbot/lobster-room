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

function feedDetailTaskLabel(details, recentEvents) {
  const d = details && typeof details === 'object' ? details : {};
  const direct = [d.label, d.task, d.title, d.summary, d.purpose, d.name, d.prompt].find(Boolean);
  if (direct) return String(direct).trim();
  const evs = Array.isArray(recentEvents) ? recentEvents : [];
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const data = evs[i] && evs[i].data && typeof evs[i].data === 'object' ? evs[i].data : null;
    if (!data) continue;
    const found = [data.label, data.task, data.title, data.summary, data.purpose, data.name, data.prompt].find(Boolean);
    if (found) return String(found).trim();
  }
  return '';
}

function feedActivityFromTool(toolName, details, recentEvents) {
  const tn = String(toolName || '').trim().toLowerCase();
  if (tn === 'browser') return 'checking the live page';
  if (tn === 'read') return 'reviewing project files';
  if (tn === 'write' || tn === 'edit') return 'updating project files';
  if (tn === 'sessions_spawn') {
    const label = feedDetailTaskLabel(details, recentEvents);
    return label ? ('starting a helper task — ' + label) : 'starting a helper task';
  }
  return 'working';
}

function feedInferRecentActivity(details, recentEvents) {
  if (details && details.toolName) return feedActivityFromTool(details.toolName, details, recentEvents);
  const evs = Array.isArray(recentEvents) ? recentEvents : [];
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const ev = evs[i];
    if (!ev) continue;
    const kind = String(ev.kind || '').trim().toLowerCase();
    const data = ev.data && typeof ev.data === 'object' ? ev.data : {};
    if (kind === 'before_tool_call' || kind === 'after_tool_call' || kind === 'tool_result_persist') {
      const evTool = String(ev.toolName || data.toolName || '').trim();
      if (evTool) return feedActivityFromTool(evTool, data, recentEvents);
    }
  }
  return '';
}

function activityNeedsFreshSession(state) {
  return state === 'thinking' || state === 'tool' || state === 'reply';
}

function inferActivityFromFeedItem(item) {
  if (!item) return null;
  if (item.kind === 'before_tool_call') return 'tool';
  if (item.kind === 'before_agent_start' || item.kind === 'after_tool_call' || item.kind === 'tool_result_persist') return 'thinking';
  if (item.kind === 'agent_end') return item.success === false || !!item.error ? 'error' : 'idle';
  return null;
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

function skToAgentIdBefore(sk) {
  if (typeof sk !== 'string') return null;
  const m = sk.match(/^agent:([^:]+):/);
  return m && m[1] ? m[1] : null;
}

function skToAgentIdAfter(sk, spawnedSessionAgentIds) {
  if (typeof sk !== 'string') return null;
  const raw = String(sk).trim();
  if (!raw) return null;
  const spawnedVisible = spawnedSessionAgentIds.get(raw);
  if (spawnedVisible) return spawnedVisible;
  const parsed = parseSessionIdentity(raw);
  if (parsed.lane !== 'main') {
    const visible = canonicalVisibleAgentId(parsed.agentId);
    if (visible && visible !== parsed.residentAgentId) return visible;
  }
  return canonicalVisibleAgentId(parsed.residentAgentId) || null;
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

function pickCurrentTruth(agentId, sessionsByAgent, feedBuf, nowMs, staleMs) {
  const list = (sessionsByAgent.get(agentId) || []).slice().sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  const fresh = list.filter((s) => (nowMs - Number(s.updatedAt || 0)) <= staleMs);
  const feedTruth = latestVisibleFeedItemForAgent(feedBuf, agentId, nowMs, staleMs);
  const feedTruthState = inferActivityFromFeedItem(feedTruth);
  const feedTruthUsable = !!(feedTruthState && (!activityNeedsFreshSession(feedTruthState) || fresh.length));
  return feedTruthUsable ? feedTruthState : 'idle';
}

const nowMs = Date.UTC(2026, 2, 27, 13, 0, 0);
const staleMs = 15 * 1000;
const qaChildKey = 'agent:main:subagent:qa-child-final';
const spawned = new Map([[qaChildKey, 'qa_agent']]);
const sessions = [
  { key: qaChildKey, updatedAt: nowMs - 1000 },
];
const feedBuf = [
  { ts: nowMs - 2500, kind: 'before_tool_call', agentId: 'main', toolName: 'sessions_spawn', details: { label: 'qa-lobster-final-critical' } },
  { ts: nowMs - 1200, kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'browser', sessionKey: qaChildKey, details: { url: 'https://example.com' } },
  { ts: nowMs - 800, kind: 'after_tool_call', agentId: 'qa_agent', toolName: 'browser', sessionKey: qaChildKey },
];
const eventBuf = [
  { ts: nowMs - 2500, kind: 'before_tool_call', agentId: 'main', data: { toolName: 'sessions_spawn', label: 'qa-lobster-final-critical' } },
  { ts: nowMs - 1200, kind: 'before_tool_call', agentId: 'qa_agent', data: { toolName: 'browser', url: 'https://example.com' } },
  { ts: nowMs - 800, kind: 'after_tool_call', agentId: 'qa_agent', data: { toolName: 'browser' } },
  { ts: nowMs - 300, kind: 'before_tool_call', agentId: 'main', data: { toolName: 'sessions_spawn', label: 'other-helper-followup' } },
];

// Reproduce fail: resident-based bucketing loses the fresh child session for qa_agent, so room/Now collapse to idle.
{
  const sessionsByAgent = new Map();
  for (const s of sessions) {
    const aid = skToAgentIdBefore(s.key);
    sessionsByAgent.set(aid, (sessionsByAgent.get(aid) || []).concat([s]));
  }
  assert.equal(pickCurrentTruth('qa_agent', sessionsByAgent, feedBuf, nowMs, staleMs), 'idle', 'old resident-based bucketing incorrectly idles qa_agent');
}

// Fixed: visible-actor bucketing keeps the child session under qa_agent, so feed truth can drive Now/room.
{
  const sessionsByAgent = new Map();
  for (const s of sessions) {
    const aid = skToAgentIdAfter(s.key, spawned);
    sessionsByAgent.set(aid, (sessionsByAgent.get(aid) || []).concat([s]));
  }
  assert.equal(pickCurrentTruth('qa_agent', sessionsByAgent, feedBuf, nowMs, staleMs), 'thinking', 'visible-actor bucketing should keep qa_agent in a non-idle current truth');
}

// Reproduce fail: global recent events make qa_agent inherit main's helper-start wording.
{
  const label = feedInferRecentActivity({}, eventBuf);
  assert.equal(label, 'starting a helper task — other-helper-followup', 'global recent events regress to the latest helper-start story from another actor');
}

// Fixed: per-agent recent events keep only qa_agent work story.
{
  const qaEvents = recentVisibleEventsForAgent(eventBuf, 'qa_agent');
  const label = feedInferRecentActivity({}, qaEvents);
  assert.equal(label, 'checking the live page', 'per-agent recent events should surface real qa work after helper start');
  assert.ok(qaEvents.every((ev) => ev.agentId === 'qa_agent'), 'recent events must stay actor-scoped');
}

console.log('feed-room-now-consistency-final-critical: PASS');
