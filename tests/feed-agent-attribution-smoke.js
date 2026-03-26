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

function rememberPendingSpawnAgent(parentSessionKey, agentId) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  const visible = canonicalVisibleAgentId(agentId);
  if (!sk || !visible) return;
  pendingSpawnAgentIds.set(sk, (pendingSpawnAgentIds.get(sk) || []).concat([visible]));
}

function consumePendingSpawnAgent(parentSessionKey) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  if (!sk) return '';
  const queue = pendingSpawnAgentIds.get(sk) || [];
  const next = queue.shift() || '';
  if (queue.length) pendingSpawnAgentIds.set(sk, queue);
  else pendingSpawnAgentIds.delete(sk);
  return next;
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
  const spawnedVisible = spawnedSessionAgentIds.get(typeof (ctx && ctx.sessionKey) === 'string' ? ctx.sessionKey.trim() : '');
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
rememberPendingSpawnAgent('agent:main:main', 'qa_agent');
rememberSpawnedSessionAgent('agent:main:subagent:qa-123', consumePendingSpawnAgent('agent:main:main'));
rememberPendingSpawnAgent('agent:main:main', 'coding_agent');
rememberSpawnedSessionAgent('agent:main:subagent:code-456', consumePendingSpawnAgent('agent:main:main'));

const qa = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:qa-123' });
const coding = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:code-456' });
const main = resolveFeedAgentIdentity({ sessionKey: 'agent:main:main' });
const explicitQa = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:anything', agentId: 'qa_agent' });

assert.equal(qa.agentId, 'qa_agent', 'qa_agent activity should stay attributed to qa_agent');
assert.equal(coding.agentId, 'coding_agent', 'coding_agent activity should stay attributed to coding_agent');
assert.equal(main.agentId, 'main', 'main activity should stay attributed to main');
assert.equal(explicitQa.agentId, 'qa_agent', 'explicit actual agent should override resident lineage');
assert.ok(!/subagent|cron/i.test(qa.agentId), 'visible feed actor must not expose descendant/internal ids');
assert.equal(qa.rawAgentId, 'main/subagent:qa-123', 'raw/debug path may retain internal lineage for debugging');
assert.equal(canonicalResidentAgentId('agent:main:subagent:qa-123'), 'main', 'resident roster still collapses descendants to resident owner');
assert.equal(canonicalVisibleAgentId('main/subagent:qa-123'), 'main', 'unmapped descendant lineage alone still normalizes to resident owner');

const source = fs.readFileSync(path.join(__dirname, '..', 'plugin', 'lobster-room', 'index.ts'), 'utf8');
assert.ok(source.includes('if (inHold && nextP < curP)'), 'sticky-state priority guard must remain present');
assert.ok(source.includes('pendingSpawnAgentIds') && source.includes('spawnedSessionAgentIds'), 'spawn mapping for actual agent attribution must be present');
assert.ok(source.includes('if (lower === "subagent" || lower === "spawn" || lower === "cron" || lower === "discord") return "";'), 'internal agent ids must stay suppressed');

console.log('feed-agent-attribution smoke: OK');
