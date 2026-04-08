const assert = require('assert');

const UNKNOWN_CHILD_ACTOR_ID = 'unknown';

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
  if (['subagent', 'spawn', 'cron', 'discord', 'unknown'].includes(lower)) return '';
  return canonical;
}

function normalizeSpawnText(value, maxLen = 240) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function uniqueVisibleAgentIds(values) {
  return [...new Set(values.filter(Boolean))];
}

function collectSpawnStringHints(value, out, seen = new Set()) {
  if (!value || seen.has(value) || out.length >= 24) return;
  if (typeof value === 'string') {
    const normalized = normalizeSpawnText(value, 400);
    if (normalized) out.push(normalized);
    return;
  }
  if (typeof value !== 'object') return;
  seen.add(value);
  for (const key of ['label', 'task', 'prompt', 'instructions', 'title', 'name', 'description', 'summary']) {
    collectSpawnStringHints(value[key], out, seen);
  }
  for (const nestedKey of ['payload', 'input', 'request', 'session', 'sessionOptions', 'meta', 'details', 'context', 'options']) {
    collectSpawnStringHints(value[nestedKey], out, seen);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSpawnStringHints(item, out, seen);
  }
}

function isSpawnPayloadLike(value) {
  if (!value || typeof value !== 'object') return false;
  return !!(value.spawnAgentId || value.requestedAgentId || value.actorId || value.toolName === 'sessions_spawn');
}

function collectSpawnActorCandidates(value, out, seen = new Set(), allowGenericAgentId = false) {
  if (!value || seen.has(value) || out.length >= 16) return;
  const visible = canonicalVisibleAgentId(value);
  if (visible) {
    out.push(visible);
    return;
  }
  if (typeof value !== 'object') return;
  seen.add(value);
  for (const key of ['spawnAgentId', 'requestedAgentId', 'actorId', 'actor']) {
    collectSpawnActorCandidates(value[key], out, seen, true);
  }
  if (allowGenericAgentId || isSpawnPayloadLike(value)) {
    collectSpawnActorCandidates(value.agentId, out, seen, true);
    collectSpawnActorCandidates(value.agent, out, seen, true);
  }
  for (const nestedKey of ['payload', 'input', 'request', 'sessionOptions', 'options', 'meta', 'details']) {
    collectSpawnActorCandidates(value[nestedKey], out, seen, true);
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSpawnActorCandidates(item, out, seen, allowGenericAgentId);
  }
}

function resolveExplicitSpawnAgentId(payload) {
  const candidates = [];
  collectSpawnActorCandidates(payload, candidates);
  const unique = uniqueVisibleAgentIds(candidates);
  return unique.length === 1 ? unique[0] : '';
}

function extractSpawnDirectiveActorIds(text) {
  const out = [];
  for (const pattern of [/\byou are\s+([a-z][a-z0-9_-]{1,63})\b/gi, /你是\s*([a-z][a-z0-9_-]{1,63})/giu, /角色\s*[:：]?\s*([a-z][a-z0-9_-]{1,63})/giu]) {
    for (const match of text.matchAll(pattern)) {
      const visible = canonicalVisibleAgentId(match && match[1]);
      if (visible) out.push(visible);
    }
  }
  return uniqueVisibleAgentIds(out);
}

function extractSpawnMentionActorIds(text) {
  const out = [];
  for (const pattern of [/\b([a-z][a-z0-9_-]*agent)\b/gi, /@([a-z][a-z0-9_-]{1,63})/gi]) {
    for (const match of text.matchAll(pattern)) {
      const visible = canonicalVisibleAgentId(match && match[1]);
      if (visible) out.push(visible);
    }
  }
  return uniqueVisibleAgentIds(out);
}

function inferSpawnActorId(payload) {
  const explicit = resolveExplicitSpawnAgentId(payload);
  if (explicit) return explicit;
  const hints = [];
  collectSpawnStringHints(payload, hints);
  const text = hints.join('\n');
  if (!text) return '';
  const directive = extractSpawnDirectiveActorIds(text);
  if (directive.length === 1) return directive[0];
  if (directive.length > 1) return '';
  const mentions = extractSpawnMentionActorIds(text);
  if (mentions.length === 1) return mentions[0];
  return '';
}

function extractSpawnMatcherHints(value) {
  return {
    actorId: inferSpawnActorId(value) || undefined,
    label: normalizeSpawnText(value?.label ?? value?.sessionLabel ?? value?.title ?? value?.name ?? value?.session?.label ?? value?.session?.title ?? value?.payload?.label ?? value?.request?.label, 120) || undefined,
    task: normalizeSpawnText(value?.task ?? value?.prompt ?? value?.instructions ?? value?.description ?? value?.session?.task ?? value?.session?.prompt ?? value?.payload?.task ?? value?.request?.task, 240) || undefined,
  };
}

function createRuntime() {
  const state = { spawnedSessionAgentIds: new Map(), pendingByParent: new Map(), pendingByResident: new Map() };

  function isAdoptableChildLane(lane) { return String(lane || '').trim().toLowerCase() === 'subagent'; }
  function hasAdoptableChildProof(sessionKey, residentAgentId) {
    const parsed = parseSessionIdentity(sessionKey, residentAgentId);
    if (!isAdoptableChildLane(parsed.lane)) return false;
    const resident = canonicalResidentAgentId(residentAgentId ?? parsed.residentAgentId);
    return !!resident && resident === parsed.residentAgentId;
  }
  function merge(entry) {
    state.pendingByParent.set(entry.parentSessionKey, (state.pendingByParent.get(entry.parentSessionKey) || []).concat([entry]));
    state.pendingByResident.set(entry.residentAgentId, (state.pendingByResident.get(entry.residentAgentId) || []).concat([entry]));
  }
  function forgetResident(entry) {
    const q = state.pendingByResident.get(entry.residentAgentId) || [];
    const next = q.filter((candidate) => candidate !== entry);
    if (next.length) state.pendingByResident.set(entry.residentAgentId, next); else state.pendingByResident.delete(entry.residentAgentId);
  }
  function removeFromParent(entry) {
    const q = state.pendingByParent.get(entry.parentSessionKey) || [];
    const next = q.filter((candidate) => candidate !== entry);
    if (next.length) state.pendingByParent.set(entry.parentSessionKey, next); else state.pendingByParent.delete(entry.parentSessionKey);
  }
  function pick(bucket, key, matcher) {
    const queue = bucket.get(key) || [];
    if (!queue.length) return undefined;
    const actorId = canonicalVisibleAgentId(matcher?.actorId);
    const label = normalizeSpawnText(matcher?.label, 120);
    const task = normalizeSpawnText(matcher?.task, 240);
    const scored = queue.map((entry, index) => {
      let score = 0;
      if (actorId) { if (entry.actorId !== actorId) return { index, score: -1 }; score += 8; }
      if (label) { if (normalizeSpawnText(entry.label, 120) !== label) return { index, score: -1 }; score += 4; }
      if (task) { if (normalizeSpawnText(entry.task, 240) !== task) return { index, score: -1 }; score += 4; }
      if (!actorId && !label && !task) score = 1; else if (entry.source === 'explicit') score += 1;
      return { index, score };
    }).filter((x) => x.score >= 0);
    if (!scored.length) return undefined;
    const bestScore = Math.max(...scored.map((x) => x.score));
    const winners = scored.filter((x) => x.score === bestScore);
    if (bestScore <= 0 || winners.length !== 1) return undefined;
    const [picked] = queue.splice(winners[0].index, 1);
    if (queue.length) bucket.set(key, queue); else bucket.delete(key);
    return picked;
  }
  function rememberPending(parentSessionKey, payload) {
    const actorId = inferSpawnActorId(payload);
    const residentAgentId = canonicalResidentAgentId(parentSessionKey);
    if (!parentSessionKey || !actorId || !residentAgentId) return;
    merge({ actorId, parentSessionKey, residentAgentId, label: normalizeSpawnText(payload?.label, 120) || undefined, task: normalizeSpawnText(payload?.task, 240) || undefined, source: resolveExplicitSpawnAgentId(payload) ? 'explicit' : 'inferred' });
  }
  function resolveChildParentSessionKeys(ctx) {
    const candidates = [ctx?.parentSessionKey, ctx?.parent?.sessionKey, ctx?.session?.parentSessionKey, ctx?.session?.parentKey, ctx?.parent?.key];
    return [...new Set(candidates.map((x) => typeof x === 'string' ? x.trim() : '').filter(Boolean))];
  }
  function adoptPendingSpawnAttributionForSession(sessionKey, ctx) {
    const parsed = parseSessionIdentity(sessionKey, ctx?.agentId);
    if (!hasAdoptableChildProof(sessionKey, parsed.residentAgentId)) return undefined;
    if (state.spawnedSessionAgentIds.has(sessionKey)) return { actorId: state.spawnedSessionAgentIds.get(sessionKey) };
    const matcher = extractSpawnMatcherHints(ctx);
    for (const parentSessionKey of resolveChildParentSessionKeys(ctx)) {
      const adopted = pick(state.pendingByParent, parentSessionKey, matcher) || ((matcher.actorId || matcher.label || matcher.task) ? undefined : pick(state.pendingByParent, parentSessionKey, {}));
      if (!adopted) continue;
      forgetResident(adopted); state.spawnedSessionAgentIds.set(sessionKey, adopted.actorId); return adopted;
    }
    const resident = canonicalVisibleAgentId(parsed.residentAgentId);
    const eligible = (state.pendingByResident.get(resident) || []).filter(Boolean);
    state.pendingByResident.set(`resident:${resident}`, eligible.slice());
    const matched = pick(state.pendingByResident, `resident:${resident}`, matcher);
    state.pendingByResident.delete(`resident:${resident}`);
    const adopted = matched || (eligible.length === 1 && !(matcher.actorId || matcher.label || matcher.task) ? eligible[0] : undefined);
    if (!adopted) return undefined;
    forgetResident(adopted); removeFromParent(adopted); state.spawnedSessionAgentIds.set(sessionKey, adopted.actorId); return adopted;
  }
  function resolveFeedAgentIdentity(ctx) {
    const parsed = parseSessionIdentity(ctx?.sessionKey, ctx?.agentId);
    const childKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
    const adopted = childKey && isAdoptableChildLane(parsed.lane) ? adoptPendingSpawnAttributionForSession(childKey, ctx) : undefined;
    const visible = childKey ? (state.spawnedSessionAgentIds.get(childKey) || adopted?.actorId || '') : '';
    if (visible) return { agentId: visible, source: 'spawned' };
    const explicit = canonicalVisibleAgentId(ctx?.agentId) || canonicalVisibleAgentId(ctx?.agent?.id) || canonicalVisibleAgentId(ctx?.session?.agentId);
    if (explicit && !(isAdoptableChildLane(parsed.lane) && explicit === canonicalVisibleAgentId(parsed.residentAgentId) && parsed.agentId !== explicit)) return { agentId: explicit, source: 'explicit' };
    return { agentId: isAdoptableChildLane(parsed.lane) ? UNKNOWN_CHILD_ACTOR_ID : (canonicalVisibleAgentId(parsed.residentAgentId) || 'main'), source: 'fallback' };
  }
  return { state, rememberPending, resolveFeedAgentIdentity };
}

const parent = 'agent:main:discord:channel:1476111438186680416';

// explicit payload actor should bind even when nested/structured.
assert.equal(resolveExplicitSpawnAgentId({ request: { agentId: 'qa_agent' } }), 'qa_agent');
assert.equal(inferSpawnActorId({ session: { prompt: 'You are coding_agent. Fix it.' } }), 'coding_agent');

const runtime = createRuntime();
runtime.rememberPending(parent, { request: { agentId: 'qa_agent' }, label: 'qa child', task: 'Validate feed order.' });
runtime.rememberPending(parent, { task: 'You are research_agent. Gather docs.', label: 'research child' });

const researchIdentity = runtime.resolveFeedAgentIdentity({
  sessionKey: 'agent:main:subagent:child-research',
  agentId: 'main',
  parentSessionKey: parent,
  label: 'research child',
  task: 'You are research_agent. Gather docs.',
  session: { label: 'research child', task: 'You are research_agent. Gather docs.' },
});
assert.equal(researchIdentity.agentId, 'research_agent', 'payload+label/task hints should bind the correct sibling child');

const qaIdentity = runtime.resolveFeedAgentIdentity({
  sessionKey: 'agent:main:subagent:child-qa',
  agentId: 'main',
  parentSessionKey: parent,
  label: 'qa child',
  task: 'Validate feed order.',
  session: { label: 'qa child', task: 'Validate feed order.' },
});
assert.equal(qaIdentity.agentId, 'qa_agent', 'same-parent multi child should still bind deterministically');

// reordered result / later noisy ctx.agentId must not overwrite canonical binding.
const qaFollowup = runtime.resolveFeedAgentIdentity({
  sessionKey: 'agent:main:subagent:child-qa',
  agentId: 'coding_agent',
  parentSessionKey: parent,
});
assert.equal(qaFollowup.agentId, 'qa_agent', 'persisted child binding must win over later noisy ctx.agentId');

// unresolved really stays unknown.
const unresolvedRuntime = createRuntime();
unresolvedRuntime.rememberPending(parent, { task: 'You are qa_agent. Validate.' , label: 'shared label' });
unresolvedRuntime.rememberPending(parent, { task: 'You are research_agent. Validate.' , label: 'shared label' });
const unresolved = unresolvedRuntime.resolveFeedAgentIdentity({
  sessionKey: 'agent:main:subagent:child-unknown',
  agentId: 'main',
  parentSessionKey: parent,
  session: { label: 'shared label' },
});
assert.equal(unresolved.agentId, UNKNOWN_CHILD_ACTOR_ID, 'truly unresolved sibling child should remain unknown instead of pretending to be main');

console.log('feed-child-binding-robustness-pass: PASS');
