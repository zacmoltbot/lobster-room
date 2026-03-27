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
  if (['subagent', 'spawn', 'cron', 'discord'].includes(lower)) return '';
  return canonical;
}

function isVisibleSnapshotAgentKey(value) {
  if (typeof value !== 'string') return false;
  const raw = String(value).trim();
  if (!raw) return false;
  const visible = canonicalVisibleAgentId(raw);
  return !!visible && raw === visible;
}

function pruneSnapshotAgents(agents) {
  const out = {};
  for (const [key, value] of Object.entries(agents || {})) {
    if (!isVisibleSnapshotAgentKey(key)) continue;
    out[key] = value;
  }
  return out;
}

function resolveSnapshotWriterAgentId(identity) {
  const visible = canonicalVisibleAgentId(identity && identity.agentId);
  if (!visible) return '';
  if (identity && identity.lane === 'main') return visible;
  if (identity && (identity.source === 'spawned' || identity.source === 'explicit')) return visible;
  return '';
}

// 1. descendant/internal low-signal activity must not promote resident main.
{
  const identity = {
    agentId: 'main',
    residentAgentId: 'main',
    lane: 'subagent',
    source: 'fallback',
  };
  assert.equal(resolveSnapshotWriterAgentId(identity), '', 'fallback descendant activity must not persist busy main snapshot');
}

// 2. stale descendant-scoped keys must be pruned during merge/write.
{
  const pruned = pruneSnapshotAgents({
    main: { state: 'idle' },
    qa_agent: { state: 'tool' },
    coding_agent: { state: 'thinking' },
    'main/subagent:abc': { state: 'tool' },
    'main/cron:nightly': { state: 'thinking' },
    'main/discord:channel:123': { state: 'reply' },
    'qa_agent/subagent:child': { state: 'tool' },
  });
  assert.deepStrictEqual(Object.keys(pruned).sort(), ['coding_agent', 'main', 'qa_agent']);
}

// 3. fresh visible actors still persist when spawned attribution resolves to qa/coding.
{
  const qaIdentity = {
    agentId: 'qa_agent',
    residentAgentId: 'main',
    lane: 'subagent',
    source: 'spawned',
  };
  const codingIdentity = {
    agentId: 'coding_agent',
    residentAgentId: 'main',
    lane: 'subagent',
    source: 'spawned',
  };
  assert.equal(resolveSnapshotWriterAgentId(qaIdentity), 'qa_agent');
  assert.equal(resolveSnapshotWriterAgentId(codingIdentity), 'coding_agent');
}

// 4. explicit visible actor truth still writes, fallback raw lineage stays hidden.
{
  const explicitQa = {
    agentId: 'qa_agent',
    residentAgentId: 'qa_agent',
    lane: 'cron',
    source: 'explicit',
  };
  const fallbackMainDiscord = {
    agentId: 'main',
    residentAgentId: 'main',
    lane: 'discord',
    source: 'fallback',
  };
  assert.equal(resolveSnapshotWriterAgentId(explicitQa), 'qa_agent');
  assert.equal(resolveSnapshotWriterAgentId(fallbackMainDiscord), '');
}

// 5. no clone / no leak invariant: pruned snapshot keeps only visible canonical keys.
{
  const merged = pruneSnapshotAgents({
    main: { state: 'tool' },
    'main/subagent:qa-proof': { state: 'thinking' },
    qa_agent: { state: 'reply' },
    'resident@qa_agent': { state: 'idle' },
    discord: { state: 'reply' },
  });
  assert.deepStrictEqual(merged, {
    main: { state: 'tool' },
    qa_agent: { state: 'reply' },
  });
}

console.log('writer-side-p0: PASS');
