const assert = require('assert');

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
  const canonical = canonicalResidentAgentId(value);
  if (!canonical) return '';
  return ['subagent', 'spawn', 'cron', 'discord'].includes(canonical.toLowerCase()) ? '' : canonical;
}

function normalize(value, max = 240) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function pick(bucket, key, matcher = {}) {
  const queue = bucket.get(key) || [];
  if (!queue.length) return undefined;
  const actorId = canonicalVisibleAgentId(matcher.actorId);
  const label = normalize(matcher.label, 120);
  const task = normalize(matcher.task, 240);
  const scored = queue.map((entry, index) => {
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
    if (!actorId && !label && !task) score = 1;
    else if (entry.source === 'explicit') score += 1;
    return { entry, index, score };
  }).filter((candidate) => candidate.score >= 0);
  if (!scored.length) return undefined;
  const bestScore = Math.max(...scored.map((candidate) => candidate.score));
  const winners = scored.filter((candidate) => candidate.score === bestScore);
  if (bestScore <= 0 || winners.length !== 1) return undefined;
  const [picked] = queue.splice(winners[0].index, 1);
  if (queue.length) bucket.set(key, queue); else bucket.delete(key);
  return picked;
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

function createRuntime({ mode }) {
  const state = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
    observedChildSessions: new Map(),
    feed: [],
  };

  function bind(sessionKey, actorId) {
    state.spawnedSessionAgentIds.set(sessionKey, actorId);
    state.observedChildSessions.delete(sessionKey);
  }

  function observeChild(sessionKey, ctx) {
    state.observedChildSessions.set(sessionKey, {
      sessionKey,
      residentAgentId: canonicalResidentAgentId(sessionKey),
      parentSessionKeys: ctx.parentSessionKeys || [],
      actorId: canonicalVisibleAgentId(ctx.actorId) || undefined,
      label: normalize(ctx.label, 120) || undefined,
      task: normalize(ctx.task, 240) || undefined,
    });
  }

  function rememberPending(parentSessionKey, payload) {
    const entry = {
      actorId: canonicalVisibleAgentId(payload.spawnAgentId),
      parentSessionKey,
      residentAgentId: canonicalResidentAgentId(parentSessionKey),
      label: normalize(payload.label, 120) || undefined,
      task: normalize(payload.task, 240) || undefined,
      source: 'explicit',
    };
    state.pendingByParent.set(parentSessionKey, [entry]);
    state.pendingByResident.set(entry.residentAgentId, [entry]);
    for (const observed of Array.from(state.observedChildSessions.values())) {
      if (observed.residentAgentId !== entry.residentAgentId) continue;
      adopt(observed.sessionKey, observed);
    }
  }

  function adopt(sessionKey, ctx = {}) {
    if (state.spawnedSessionAgentIds.has(sessionKey)) return state.spawnedSessionAgentIds.get(sessionKey);
    const observed = state.observedChildSessions.get(sessionKey) || {};
    const matcher = {
      actorId: ctx.actorId || observed.actorId,
      label: ctx.label || observed.label,
      task: ctx.task || observed.task,
    };
    const parentKeys = Array.from(new Set([...(ctx.parentSessionKeys || []), ...(observed.parentSessionKeys || [])].filter(Boolean)));
    for (const parentSessionKey of parentKeys) {
      let adopted;
      if (mode === 'fixed') {
        for (const variant of matcherVariants(matcher)) {
          adopted = pick(state.pendingByParent, parentSessionKey, variant);
          if (adopted) break;
        }
      } else {
        adopted = pick(state.pendingByParent, parentSessionKey, matcher);
      }
      if (!adopted) continue;
      bind(sessionKey, adopted.actorId);
      return adopted.actorId;
    }
    return undefined;
  }

  function visibleAgent(sessionKey, fallback = 'unknown') {
    return state.spawnedSessionAgentIds.get(sessionKey) || fallback;
  }

  return { state, observeChild, rememberPending, adopt, bind, visibleAgent };
}

const parentSessionKey = 'agent:main:main';
const childSessionKey = 'agent:main:subagent:qa-child-race';
const observedCtx = {
  parentSessionKeys: [parentSessionKey],
  actorId: 'qa_agent',
  task: 'qa child runtime prompt that is different from the original spawn task and should not block actor adoption',
};
const pendingPayload = {
  spawnAgentId: 'qa_agent',
  label: 'qa-lobster-narrow-live-feed-visible-20260329',
  task: '你是 qa_agent。請驗證 live feed child row actor attribution。',
};

const buggy = createRuntime({ mode: 'buggy' });
buggy.observeChild(childSessionKey, observedCtx);
buggy.rememberPending(parentSessionKey, pendingPayload);
assert.equal(buggy.state.spawnedSessionAgentIds.get(childSessionKey), undefined, 'legacy strict matcher reproduces the race: child stays unbound when observed task diverges');
assert.equal(buggy.visibleAgent(childSessionKey), 'unknown', 'legacy path leaves visible actor as unknown');

const fixed = createRuntime({ mode: 'fixed' });
fixed.observeChild(childSessionKey, observedCtx);
fixed.rememberPending(parentSessionKey, pendingPayload);
assert.equal(fixed.state.spawnedSessionAgentIds.get(childSessionKey), 'qa_agent', 'fixed matcher variants should bind canonical child actor after pending arrives');
assert.equal(fixed.visibleAgent(childSessionKey), 'qa_agent', 'visible child row should rebind from unknown to qa_agent');

console.log('PASS observed-child pending adoption race regression');
