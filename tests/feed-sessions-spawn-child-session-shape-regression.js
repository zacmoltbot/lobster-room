const assert = require('assert/strict');

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
  const id = typeof fallbackAgentId === 'string' ? String(fallbackAgentId).trim() : '';
  return { agentId: id || 'main', residentAgentId: id || 'main', lane: 'main' };
}

function resolveSpawnedChildSessionKey(event, ctx) {
  const parentSessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
  const candidates = [
    event?.result?.childSessionKey,
    event?.childSessionKey,
    event?.result?.sessionKey,
    event?.result?.session?.sessionKey,
    event?.result?.session?.key,
    event?.result?.session?.id,
    event?.result?.sessionId,
    event?.result?.session_id,
    event?.sessionKey,
  ];
  for (const candidate of candidates) {
    const sk = typeof candidate === 'string' ? candidate.trim() : '';
    if (!sk || sk === parentSessionKey) continue;
    const parsed = parseSessionIdentity(sk);
    if (parsed.lane === 'subagent' || parsed.lane === 'cron') return sk;
  }
  return '';
}

const parentCtx = { sessionKey: 'agent:main:discord:channel:1476111438186680416' };
const childSessionKey = 'agent:main:subagent:qa-live-uuid';

assert.equal(
  resolveSpawnedChildSessionKey({ result: { session: { key: childSessionKey } } }, parentCtx),
  childSessionKey,
  'nested result.session.key child session shape must resolve',
);
assert.equal(
  resolveSpawnedChildSessionKey({ result: { sessionId: childSessionKey } }, parentCtx),
  childSessionKey,
  'result.sessionId child session shape must resolve',
);
assert.equal(
  resolveSpawnedChildSessionKey({ result: { session: { id: childSessionKey } } }, parentCtx),
  childSessionKey,
  'result.session.id child session shape must resolve',
);
assert.equal(
  resolveSpawnedChildSessionKey({ result: { sessionKey: parentCtx.sessionKey } }, parentCtx),
  '',
  'parent session key must never be misread as child session key',
);

console.log('feed-sessions-spawn-child-session-shape-regression: PASS');
