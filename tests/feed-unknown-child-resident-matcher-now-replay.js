const assert = require('assert/strict');

const UNKNOWN_CHILD_ACTOR_ID = 'unknown';

function parseSessionIdentity(sessionKey, fallbackAgentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey) : '';
  const parts = sk ? sk.split(':') : [];
  if (parts.length >= 3 && parts[0] === 'agent') {
    const residentAgentId = parts[1] || 'main';
    const lane = parts[2] || 'main';
    if (lane === 'main') return { agentId: residentAgentId, residentAgentId, lane };
    const tail = parts.slice(3).filter(Boolean).join(':');
    return { agentId: tail ? `${residentAgentId}/${lane}:${tail}` : `${residentAgentId}/${lane}`, residentAgentId, lane };
  }
  const id = typeof fallbackAgentId === 'string' ? fallbackAgentId.trim() : '';
  return { agentId: id || 'main', residentAgentId: id || 'main', lane: 'main' };
}

function canonicalResidentAgentId(value) {
  if (typeof value !== 'string') return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (raw.startsWith('agent:')) return parseSessionIdentity(raw).residentAgentId;
  return raw.replace(/^resident@/, '').split('/')[0].trim();
}

function canonicalVisibleAgentId(value) {
  if (typeof value !== 'string') return '';
  const canonical = canonicalResidentAgentId(value);
  if (!canonical) return '';
  return ['subagent', 'spawn', 'cron', 'discord', 'unknown'].includes(canonical.toLowerCase()) ? '' : canonical;
}

function normalize(value, max = 240) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function matcherVariants(matcher = {}) {
  const normalized = {
    actorId: canonicalVisibleAgentId(matcher.actorId) || undefined,
    label: normalize(matcher.label, 120) || undefined,
    task: normalize(matcher.task, 240) || undefined,
  };
  const variants = [
    normalized,
    normalized.actorId ? { actorId: normalized.actorId } : undefined,
    normalized.label ? { label: normalized.label } : undefined,
    normalized.task ? { task: normalized.task } : undefined,
    (!normalized.actorId && !normalized.label && !normalized.task) ? {} : undefined,
  ].filter(Boolean);
  const seen = new Set();
  return variants.filter((variant) => {
    const key = JSON.stringify(variant);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveVisibleFeedItemAgentId(item, spawnedSessionAgentIds, fallback = 'main') {
  if (!item) return fallback;
  if (item.agentId === UNKNOWN_CHILD_ACTOR_ID) return UNKNOWN_CHILD_ACTOR_ID;
  const sessionKey = typeof item.sessionKey === 'string' ? item.sessionKey.trim() : '';
  const parsed = parseSessionIdentity(sessionKey, item.agentId);
  if (parsed.lane === 'subagent') {
    const bound = spawnedSessionAgentIds.get(sessionKey);
    if (bound) return bound;
    return UNKNOWN_CHILD_ACTOR_ID;
  }
  return canonicalVisibleAgentId(item.agentId) || fallback;
}

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

function latestVisibleFeedItemForAgent(feedBuf, agentId, nowMs, staleMs, spawnedSessionAgentIds) {
  for (let i = feedBuf.length - 1; i >= 0; i -= 1) {
    const item = feedBuf[i];
    if (!item || resolveVisibleFeedItemAgentId(item, spawnedSessionAgentIds, '') !== agentId) continue;
    if ((nowMs - Number(item.ts || 0)) > staleMs) continue;
    return item;
  }
  return null;
}

function hasFreshCanonicalChildFeedCluster(agentId, feedTruth, feedBuf, nowMs, staleMs, spawnedSessionAgentIds) {
  if (!feedTruth || !activityNeedsFreshSession(inferActivityFromFeedItem(feedTruth))) return false;
  const sessionKey = String(feedTruth.sessionKey || '').trim();
  if (!sessionKey || spawnedSessionAgentIds.get(sessionKey) !== agentId) return false;
  if (parseSessionIdentity(sessionKey, agentId).lane !== 'subagent') return false;
  let hits = 0;
  for (let i = feedBuf.length - 1; i >= 0; i -= 1) {
    const item = feedBuf[i];
    if (!item) continue;
    if ((nowMs - Number(item.ts || 0)) > staleMs) break;
    if (String(item.sessionKey || '').trim() !== sessionKey) continue;
    if (resolveVisibleFeedItemAgentId(item, spawnedSessionAgentIds, '') !== agentId) continue;
    if (!activityNeedsFreshSession(inferActivityFromFeedItem(item))) continue;
    hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

function pickResidentAdoption(eligible, matcher) {
  for (const variant of matcherVariants(matcher)) {
    const actorId = canonicalVisibleAgentId(variant.actorId);
    const label = normalize(variant.label, 120);
    const task = normalize(variant.task, 240);
    const scored = eligible.map((entry, index) => {
      let score = 0;
      if (actorId) {
        if (entry.actorId !== actorId) return { entry, index, score: -1 };
        score += 8;
      }
      if (label) {
        if (normalize(entry.label, 120) !== label) return { entry, index, score: -1 };
        score += 4;
      }
      if (task) {
        if (normalize(entry.task, 240) !== task) return { entry, index, score: -1 };
        score += 4;
      }
      if (!actorId && !label && !task) {
        if (eligible.length !== 1) return { entry, index, score: -1 };
        score = 1;
      } else if (entry.source === 'explicit') {
        score += 1;
      }
      return { entry, index, score };
    }).filter((candidate) => candidate.score >= 0);
    if (!scored.length) continue;
    const best = Math.max(...scored.map((candidate) => candidate.score));
    const winners = scored.filter((candidate) => candidate.score === best);
    if (best <= 0 || winners.length !== 1) continue;
    return winners[0].entry;
  }
  return undefined;
}

const parentA = 'agent:main:discord:channel:parent-a';
const parentB = 'agent:main:discord:channel:parent-b';
const childSessionKey = 'agent:main:subagent:qa-live-child';
const nowMs = Date.UTC(2026, 2, 29, 4, 9, 0);
const staleMs = 15 * 1000;

const pendingByResident = new Map([[
  'main',
  [
    { actorId: 'coding_agent', parentSessionKey: parentA, residentAgentId: 'main', label: 'coding run', task: '你是 coding_agent。修別的 bug。', source: 'explicit' },
    { actorId: 'qa_agent', parentSessionKey: parentB, residentAgentId: 'main', label: 'qa-live-unknown-child-cluster-fix', task: '你是 qa_agent。請重放 unknown child cluster lane assignment fixture，確認 feed/Now 不會誤導成全 idle。', source: 'explicit' },
  ],
]]);
const spawnedSessionAgentIds = new Map();
const observedChild = {
  sessionKey: childSessionKey,
  residentAgentId: 'main',
  actorId: 'qa_agent',
  label: 'qa-live-unknown-child-cluster-fix',
  task: 'qa child runtime prompt diverged but canonical actor proof is already known',
};

const feedBuf = [
  { ts: nowMs - 2600, kind: 'before_agent_start', sessionKey: childSessionKey, agentId: 'main', rawAgentId: 'main/subagent:qa-live-child' },
  { ts: nowMs - 1800, kind: 'before_tool_call', sessionKey: childSessionKey, agentId: 'main', rawAgentId: 'main/subagent:qa-live-child', toolName: 'browser' },
  { ts: nowMs - 700, kind: 'after_tool_call', sessionKey: childSessionKey, agentId: 'main', rawAgentId: 'main/subagent:qa-live-child', toolName: 'browser' },
];

assert.ok(feedBuf.every((item) => resolveVisibleFeedItemAgentId(item, spawnedSessionAgentIds, 'unknown') === UNKNOWN_CHILD_ACTOR_ID), 'exact live replay must start with child rows still visible as unknown');
assert.equal(latestVisibleFeedItemForAgent(feedBuf, 'qa_agent', nowMs, staleMs, spawnedSessionAgentIds), null, 'before promotion qa lane has no feed truth');
assert.equal(hasFreshCanonicalChildFeedCluster('qa_agent', null, feedBuf, nowMs, staleMs, spawnedSessionAgentIds), false, 'before promotion there is no canonical child cluster proof for Now');

const eligible = (pendingByResident.get('main') || []).filter((entry) => parseSessionIdentity(entry.parentSessionKey, entry.residentAgentId).lane !== 'cron');
const adopted = pickResidentAdoption(eligible, observedChild);
assert.equal(adopted && adopted.actorId, 'qa_agent', 'resident-scoped scored matcher must promote unknown child to canonical qa_agent even when other resident pending intents exist');
spawnedSessionAgentIds.set(childSessionKey, adopted.actorId);

const rows = feedBuf.map((item) => ({ sessionKey: item.sessionKey, agentId: resolveVisibleFeedItemAgentId(item, spawnedSessionAgentIds, 'unknown') }));
const latest = { sessionKey: feedBuf[feedBuf.length - 1].sessionKey, agentId: resolveVisibleFeedItemAgentId(feedBuf[feedBuf.length - 1], spawnedSessionAgentIds, 'unknown') };
const taskAgentId = resolveVisibleFeedItemAgentId(feedBuf[0], spawnedSessionAgentIds, 'unknown');
assert.ok(rows.every((row) => row.agentId === 'qa_agent'), 'rows must all promote from unknown to qa_agent');
assert.equal(taskAgentId, 'qa_agent', 'task actor must promote from unknown to qa_agent');
assert.equal(latest.agentId, 'qa_agent', 'latest must promote from unknown to qa_agent');

const feedTruth = latestVisibleFeedItemForAgent(feedBuf, 'qa_agent', nowMs, staleMs, spawnedSessionAgentIds);
assert.equal(feedTruth && feedTruth.sessionKey, childSessionKey, 'feedTruthSessionKey must point at the promoted child cluster');
assert.equal(hasFreshCanonicalChildFeedCluster('qa_agent', feedTruth, feedBuf, nowMs, staleMs, spawnedSessionAgentIds), true, 'freshCanonicalChildFeedCluster must flip true after promotion');

const allowIds = (() => {
  const ids = [];
  const seen = new Set();
  for (const visibleActorId of spawnedSessionAgentIds.values()) {
    const id = canonicalResidentAgentId(visibleActorId);
    if (id && !seen.has(id)) {
      ids.push(id);
      seen.add(id);
    }
  }
  if (!seen.has('main')) ids.push('main');
  return ids;
})();
assert.ok(allowIds.includes('qa_agent'), 'Now allowIds must include canonical actor lanes learned from spawnedSessionAgentIds');

console.log('feed-unknown-child-resident-matcher-now-replay: PASS');
