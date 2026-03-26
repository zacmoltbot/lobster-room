const fs = require('fs');
const path = require('path');
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

const spawnedSessionAgentIds = new Map();
const pendingSpawnAgentIds = new Map();
const pendingSpawnAgentIdsByResident = new Map();

function enqueuePendingSpawnAgent(bucket, key, visible) {
  bucket.set(key, (bucket.get(key) || []).concat([visible]));
}

function dequeuePendingSpawnAgent(bucket, key) {
  const queue = bucket.get(key) || [];
  const next = queue.shift() || '';
  if (queue.length) bucket.set(key, queue);
  else bucket.delete(key);
  return next;
}

function rememberPendingSpawnAgent(parentSessionKey, agentId) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  const visible = canonicalVisibleAgentId(agentId);
  if (!sk || !visible) return;
  enqueuePendingSpawnAgent(pendingSpawnAgentIds, sk, visible);
  const resident = canonicalResidentAgentId(sk);
  if (resident) enqueuePendingSpawnAgent(pendingSpawnAgentIdsByResident, resident, visible);
}

function consumePendingSpawnAgent(parentSessionKey) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  if (!sk) return '';
  const next = dequeuePendingSpawnAgent(pendingSpawnAgentIds, sk);
  if (!next) return '';
  const resident = canonicalResidentAgentId(sk);
  if (resident) dequeuePendingSpawnAgent(pendingSpawnAgentIdsByResident, resident);
  return next;
}

function adoptPendingSpawnAgentForSession(sessionKey, residentAgentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
  if (!sk || spawnedSessionAgentIds.has(sk)) return spawnedSessionAgentIds.get(sk) || '';
  const resident = canonicalVisibleAgentId(residentAgentId);
  if (!resident) return '';
  const adopted = dequeuePendingSpawnAgent(pendingSpawnAgentIdsByResident, resident);
  if (!adopted) return '';
  spawnedSessionAgentIds.set(sk, adopted);
  return adopted;
}

function rememberSpawnedSessionAgent(sessionKey, agentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
  const visible = canonicalVisibleAgentId(agentId);
  if (!sk || !visible) return;
  spawnedSessionAgentIds.set(sk, visible);
}

function resolveFeedAgentIdentity(ctx) {
  const parsed = parseSessionIdentity(ctx && ctx.sessionKey, ctx && ctx.agentId);
  const rawSessionAgentId = parsed.agentId;
  const explicitCandidates = [
    ctx && ctx.agentId,
    ctx && ctx.agent && ctx.agent.id,
    ctx && ctx.agent && ctx.agent.agentId,
    ctx && ctx.session && ctx.session.agentId,
    ctx && ctx.residentAgentId,
  ];
  for (const candidate of explicitCandidates) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) {
      const raw = typeof candidate === 'string' ? String(candidate).trim() : '';
      return { agentId: visible, rawAgentId: raw && raw !== visible ? raw : rawSessionAgentId !== visible ? rawSessionAgentId : undefined };
    }
  }
  const childSessionKey = typeof (ctx && ctx.sessionKey) === 'string' ? ctx.sessionKey.trim() : '';
  const spawnedVisible = spawnedSessionAgentIds.get(childSessionKey)
    || (parsed.lane !== 'main' ? adoptPendingSpawnAgentForSession(childSessionKey, parsed.residentAgentId) : '');
  if (spawnedVisible) {
    return {
      agentId: spawnedVisible,
      rawAgentId: rawSessionAgentId && rawSessionAgentId !== spawnedVisible ? rawSessionAgentId : undefined,
    };
  }
  const fallback = canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || 'main';
  return { agentId: fallback, rawAgentId: rawSessionAgentId && rawSessionAgentId !== fallback ? rawSessionAgentId : undefined };
}

// Simulate parent main session spawning qa_agent and coding_agent descendants.
// First child hook may arrive before sessions_spawn returns childSessionKey.
rememberPendingSpawnAgent('agent:main:main', 'qa_agent');
const qaEarly = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:qa-123' });
rememberSpawnedSessionAgent('agent:main:subagent:qa-123', consumePendingSpawnAgent('agent:main:main'));
rememberPendingSpawnAgent('agent:main:main', 'coding_agent');
rememberSpawnedSessionAgent('agent:main:subagent:code-456', consumePendingSpawnAgent('agent:main:main'));

const qa = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:qa-123' });
const coding = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:code-456' });
const main = resolveFeedAgentIdentity({ sessionKey: 'agent:main:main' });
const explicitQa = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:anything', agentId: 'qa_agent' });

assert.equal(qaEarly.agentId, 'qa_agent', 'early child hook should adopt pending qa_agent attribution before spawn result lands');
assert.equal(qa.agentId, 'qa_agent', 'qa_agent activity should stay attributed to qa_agent');
assert.equal(coding.agentId, 'coding_agent', 'coding_agent activity should stay attributed to coding_agent');
assert.equal(main.agentId, 'main', 'main activity should stay attributed to main');
assert.equal(explicitQa.agentId, 'qa_agent', 'explicit actual agent should override resident lineage');
assert.ok(!/subagent|cron/i.test(qa.agentId), 'visible feed actor must not expose descendant/internal ids');
assert.ok(!/subagent|cron/i.test(coding.agentId), 'visible coding actor must not expose descendant/internal ids');
assert.equal(qa.rawAgentId, 'main/subagent:qa-123', 'raw/debug path may retain internal lineage for debugging');
assert.equal(canonicalResidentAgentId('agent:main:subagent:qa-123'), 'main', 'resident roster still collapses descendants to resident owner');
assert.equal(canonicalVisibleAgentId('main/subagent:qa-123'), 'main', 'unmapped descendant lineage alone still normalizes to resident owner');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'lobster-room', 'index.ts'), 'utf8');
assert.ok(source.includes('if (inHold && nextP < curP)'), 'sticky-state priority guard must remain present');
assert.ok(source.includes('pendingSpawnAgentIds') && source.includes('spawnedSessionAgentIds'), 'spawn mapping for actual agent attribution must be present');
assert.ok(source.includes('if (lower === "subagent" || lower === "spawn" || lower === "cron" || lower === "discord") return "";'), 'internal agent ids must stay suppressed');

console.log('feed-agent-attribution smoke: OK');
