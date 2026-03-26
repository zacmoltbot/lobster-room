const fs = require('fs');
const os = require('os');
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
  if (['subagent', 'spawn', 'cron', 'discord'].includes(canonical.toLowerCase())) return '';
  return canonical;
}
function inferSpawnActorId(payload) {
  for (const candidate of [payload && payload.agentId, payload && payload.spawnAgentId, payload && payload.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  const text = [payload && payload.label, payload && payload.task, payload && payload.prompt, payload && payload.instructions]
    .filter((x) => typeof x === 'string')
    .join('\n');
  if (/coding[_ -]?agent/i.test(text)) return 'coding_agent';
  if (/qa[_ -]?agent/i.test(text)) return 'qa_agent';
  return '';
}

function createRuntime(statePath, persist) {
  const mem = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
  };
  const load = () => {
    mem.spawnedSessionAgentIds.clear();
    mem.pendingByParent.clear();
    mem.pendingByResident.clear();
    if (!persist) return;
    if (!fs.existsSync(statePath)) return;
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const [k, v] of Object.entries(data.spawnedSessionAgentIds || {})) mem.spawnedSessionAgentIds.set(k, v);
    for (const entry of data.pending || []) {
      mem.pendingByParent.set(entry.parentSessionKey, (mem.pendingByParent.get(entry.parentSessionKey) || []).concat([entry]));
      mem.pendingByResident.set(entry.residentAgentId, (mem.pendingByResident.get(entry.residentAgentId) || []).concat([entry]));
    }
  };
  const save = () => {
    if (!persist) return;
    const pending = [];
    for (const q of mem.pendingByParent.values()) for (const e of q) pending.push(e);
    fs.writeFileSync(statePath, JSON.stringify({ spawnedSessionAgentIds: Object.fromEntries(mem.spawnedSessionAgentIds), pending }, null, 2));
  };
  const rememberPendingSpawnAttribution = (parentSessionKey, payload) => {
    load();
    const actorId = inferSpawnActorId(payload);
    const residentAgentId = canonicalResidentAgentId(parentSessionKey);
    if (!actorId || !residentAgentId) return undefined;
    const entry = { actorId, parentSessionKey, residentAgentId };
    mem.pendingByParent.set(parentSessionKey, (mem.pendingByParent.get(parentSessionKey) || []).concat([entry]));
    mem.pendingByResident.set(residentAgentId, (mem.pendingByResident.get(residentAgentId) || []).concat([entry]));
    save();
    return entry;
  };
  const adoptPendingSpawnAttributionForSession = (sessionKey, residentAgentId) => {
    load();
    const existing = mem.spawnedSessionAgentIds.get(sessionKey);
    if (existing) return { actorId: existing, via: 'spawned' };
    const resident = canonicalVisibleAgentId(residentAgentId);
    const queue = mem.pendingByResident.get(resident) || [];
    const adopted = queue.shift();
    if (!adopted) return undefined;
    if (queue.length) mem.pendingByResident.set(resident, queue); else mem.pendingByResident.delete(resident);
    const pq = (mem.pendingByParent.get(adopted.parentSessionKey) || []).filter((x) => x !== adopted);
    if (pq.length) mem.pendingByParent.set(adopted.parentSessionKey, pq); else mem.pendingByParent.delete(adopted.parentSessionKey);
    mem.spawnedSessionAgentIds.set(sessionKey, adopted.actorId);
    save();
    return { ...adopted, via: 'pending' };
  };
  const rememberSpawnedSessionAgent = (sessionKey, agentId) => {
    load();
    if (sessionKey && agentId) mem.spawnedSessionAgentIds.set(sessionKey, agentId);
    save();
  };
  const resolveFeedAgentIdentity = (ctx) => {
    load();
    const parsed = parseSessionIdentity(ctx.sessionKey, ctx.agentId);
    const adopted = parsed.lane !== 'main' ? adoptPendingSpawnAttributionForSession(ctx.sessionKey, parsed.residentAgentId) : undefined;
    const visible = mem.spawnedSessionAgentIds.get(ctx.sessionKey) || (adopted && adopted.actorId) || '';
    return { parsed, adopted, visible: visible || 'main' };
  };
  return { mem, rememberPendingSpawnAttribution, adoptPendingSpawnAttributionForSession, rememberSpawnedSessionAgent, resolveFeedAgentIdentity };
}

const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-trace-')), 'spawn-state.json');
const parentCtx = { sessionKey: 'agent:main:discord:channel:1476111438186680416', agentId: 'main' };
const childCtx = { sessionKey: 'agent:main:subagent:child-live', agentId: 'main' };
const payload = {
  label: 'coding-lobster-trace-live-missed-linkage-slot-20260327',
  task: '你是 coding_agent。現在只做真實 live spawn flow trace。',
  spawnAgentId: 'coding_agent',
};

const parentNoShare = createRuntime(statePath + '.noshare', false);
const childNoShare = createRuntime(statePath + '.noshare', false);
const before = parentNoShare.rememberPendingSpawnAttribution(parentCtx.sessionKey, payload);
const noShareChild = childNoShare.resolveFeedAgentIdentity(childCtx);
assert.equal(before.actorId, 'coding_agent');
assert.equal(noShareChild.visible, 'main');

const parent = createRuntime(statePath, true);
const child = createRuntime(statePath, true);
const parentPending = parent.rememberPendingSpawnAttribution(parentCtx.sessionKey, payload);
const childFirst = child.resolveFeedAgentIdentity(childCtx);
parent.rememberSpawnedSessionAgent(childCtx.sessionKey, 'coding_agent');
const childFollowup = child.resolveFeedAgentIdentity(childCtx);

assert.equal(parentPending.actorId, 'coding_agent');
assert.equal(childFirst.adopted.actorId, 'coding_agent');
assert.equal(childFirst.visible, 'coding_agent');
assert.equal(childFollowup.visible, 'coding_agent');

console.log(JSON.stringify({
  withoutSharedState: {
    parentRememberPending: before,
    childResolve: noShareChild,
  },
  withSharedState: {
    parentRememberPending: parentPending,
    childFirst,
    childFollowup,
    persistedState: JSON.parse(fs.readFileSync(statePath, 'utf8')),
  },
}, null, 2));
console.log('feed-agent-attribution cross-isolate trace: PASS');
