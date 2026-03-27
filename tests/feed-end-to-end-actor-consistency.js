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

function visibleFeedAgentId(value, fallback = 'main') {
  return canonicalVisibleAgentId(value) || fallback;
}

function normalizeSpawnText(value, maxLen = 240) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function resolveExplicitSpawnAgentId(payload) {
  for (const candidate of [payload?.agentId, payload?.spawnAgentId, payload?.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  return '';
}

function inferSpawnActorId(payload) {
  const explicit = resolveExplicitSpawnAgentId(payload);
  if (explicit) return explicit;
  const text = [payload?.label, payload?.task, payload?.prompt, payload?.instructions]
    .map((part) => normalizeSpawnText(part, 400).toLowerCase())
    .filter(Boolean)
    .join('\n');
  if (!text) return '';
  const actorHints = [
    { actorId: 'qa_agent', patterns: [/\bqa[_ -]?agent\b/i, /\byou are\s+qa[_ -]?agent\b/i, /你是\s*qa[_ -]?agent/i, /角色[:：]?\s*qa[_ -]?agent/i] },
    { actorId: 'coding_agent', patterns: [/\bcoding[_ -]?agent\b/i, /\byou are\s+coding[_ -]?agent\b/i, /你是\s*coding[_ -]?agent/i, /角色[:：]?\s*coding[_ -]?agent/i] },
  ];
  for (const hint of actorHints) {
    if (hint.patterns.some((pattern) => pattern.test(text))) return hint.actorId;
  }
  return '';
}

function humanizedWorkDescription(toolName, details) {
  const tn = String(toolName || 'tool').trim();
  if (tn === 'sessions_spawn') {
    const task = typeof details?.task === 'string' ? details.task.trim() : '';
    const label = typeof details?.label === 'string' ? details.label.trim() : '';
    const spawnId = typeof details?.spawnAgentId === 'string' ? details.spawnAgentId.trim() : '';
    if (task) return `starting: ${task.length > 80 ? task.slice(0, 80) + '…' : task}`;
    if (label) return `starting ${label}`;
    if (spawnId) return `starting helper (${spawnId})`;
    return 'starting helper task';
  }
  if (tn === 'read') {
    const task = typeof details?.task === 'string' ? details.task.trim() : '';
    return task ? `reviewing: ${task}` : 'reviewing files';
  }
  if (tn === 'browser' || tn === 'web_fetch') return details?.url ? 'checking live page' : 'checking page';
  if (tn === 'write' || tn === 'edit') return 'updating files';
  return 'working';
}

function feedPreview(it) {
  const agent = `@${visibleFeedAgentId(it.agentId)}`;
  if (it.kind === 'before_agent_start') return `${agent} started`;
  if (it.kind === 'before_tool_call') return `${agent} ${humanizedWorkDescription(it.toolName, it.details || null)}`;
  if (it.kind === 'after_tool_call') return `${agent} ${humanizedWorkDescription(it.toolName, it.details || null).replace(/^starting:/, 'started:')} done`;
  return `${agent} working`;
}

function taskTitleFromItems(items) {
  for (const it of items) {
    if (it.kind === 'before_tool_call' && it.toolName === 'sessions_spawn') {
      const label = typeof it.details?.label === 'string' ? it.details.label : '';
      const task = typeof it.details?.task === 'string' ? it.details.task : '';
      const t = (label || '').trim() || (task || '').trim();
      if (t) return t.slice(0, 120);
      return 'Starting helper task';
    }
  }
  const firstTool = items.find((x) => x.kind === 'before_tool_call' && x.toolName)?.toolName;
  if (firstTool === 'browser') return 'Check live page';
  if (firstTool === 'read') return 'Review files';
  return 'Working';
}

function taskSummaryFromItems(items, status) {
  const toolCalls = items.filter((x) => x.kind === 'before_tool_call').length;
  if (status === 'running') return toolCalls ? `Working · ${toolCalls} steps` : 'Working';
  return toolCalls ? `Done · ${toolCalls} steps` : 'Done';
}

function sanitizeFeedItemForApi(it, includeRaw = false) {
  const base = includeRaw
    ? { ...it }
    : {
        ts: it.ts,
        kind: it.kind,
        agentId: it.agentId,
        sessionKey: it.sessionKey,
        toolName: it.toolName,
        durationMs: it.durationMs,
        details: it.details,
      };
  return { ...base, agentId: visibleFeedAgentId(it.agentId), preview: feedPreview(it) };
}

function groupFeedIntoTasks(items, includeRaw = false) {
  const byKey = new Map();
  for (const it of items) {
    const sk = it.sessionKey || '';
    byKey.set(sk, (byKey.get(sk) || []).concat([it]));
  }
  return [...byKey.entries()].map(([sessionKey, arr]) => {
    const sorted = arr.slice().sort((a, b) => a.ts - b.ts);
    const end = [...sorted].reverse().find((x) => x.kind === 'agent_end');
    const status = end ? 'done' : 'running';
    return {
      id: sessionKey,
      sessionKey,
      agentId: visibleFeedAgentId(sorted.find((x) => x.agentId)?.agentId, 'unknown'),
      startTs: sorted[0].ts,
      endTs: end?.ts,
      status,
      title: taskTitleFromItems(sorted),
      summary: taskSummaryFromItems(sorted, status),
      items: includeRaw ? sorted : undefined,
    };
  });
}

function createRuntime() {
  const state = {
    feedBuf: [],
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    pendingByResident: new Map(),
  };

  function enqueue(bucket, key, entry) {
    bucket.set(key, (bucket.get(key) || []).concat([entry]));
  }

  function rememberPendingSpawnAttribution(parentSessionKey, payload) {
    const sk = typeof parentSessionKey === 'string' ? parentSessionKey.trim() : '';
    const actorId = inferSpawnActorId(payload);
    const residentAgentId = canonicalResidentAgentId(sk);
    if (!sk || !actorId || !residentAgentId) return undefined;
    const entry = { actorId, parentSessionKey: sk, residentAgentId };
    enqueue(state.pendingByParent, sk, entry);
    enqueue(state.pendingByResident, residentAgentId, entry);
    return entry;
  }

  function adoptPendingSpawnAttributionForSession(sessionKey, residentAgentId) {
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    if (!sk) return undefined;
    const existing = state.spawnedSessionAgentIds.get(sk);
    if (existing) return { actorId: existing };
    const resident = canonicalVisibleAgentId(residentAgentId);
    const residentQueue = state.pendingByResident.get(resident) || [];
    const adopted = residentQueue.shift();
    if (residentQueue.length) state.pendingByResident.set(resident, residentQueue);
    else state.pendingByResident.delete(resident);
    if (!adopted) return undefined;
    state.spawnedSessionAgentIds.set(sk, adopted.actorId);
    const parentQueue = state.pendingByParent.get(adopted.parentSessionKey) || [];
    const filtered = parentQueue.filter((candidate) => candidate !== adopted);
    if (filtered.length) state.pendingByParent.set(adopted.parentSessionKey, filtered);
    else state.pendingByParent.delete(adopted.parentSessionKey);
    return adopted;
  }

  function rememberSpawnedSessionAgent(sessionKey, agentId) {
    const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
    const visible = canonicalVisibleAgentId(agentId);
    if (sk && visible) state.spawnedSessionAgentIds.set(sk, visible);
  }

  function resolveFeedAgentIdentity(ctx) {
    const parsed = parseSessionIdentity(ctx?.sessionKey, ctx?.agentId);
    const rawSessionAgentId = parsed.agentId;
    const childSessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
    const adopted = childSessionKey && parsed.lane !== 'main'
      ? adoptPendingSpawnAttributionForSession(childSessionKey, parsed.residentAgentId)
      : undefined;
    const visible = childSessionKey ? (state.spawnedSessionAgentIds.get(childSessionKey) || adopted?.actorId || '') : '';
    if (visible) return { agentId: visible, rawAgentId: rawSessionAgentId };
    return { agentId: canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || 'main', rawAgentId: rawSessionAgentId };
  }

  function pushFeed(item) {
    state.feedBuf.push(item);
  }

  function feedGet(includeRaw = false) {
    const items = state.feedBuf.slice();
    const tasks = groupFeedIntoTasks(items, includeRaw);
    const last = items.length ? items[items.length - 1] : null;
    return {
      rows: items.slice().reverse().map((it) => sanitizeFeedItemForApi(it, false)),
      tasks: tasks.map((t) => ({ ...t, agentId: visibleFeedAgentId(t.agentId, 'unknown'), items: t.items ? t.items.map((it) => sanitizeFeedItemForApi(it, includeRaw)) : undefined })),
      latest: last ? sanitizeFeedItemForApi(last, true) : null,
    };
  }

  return { state, rememberPendingSpawnAttribution, rememberSpawnedSessionAgent, resolveFeedAgentIdentity, pushFeed, feedGet };
}

const runtime = createRuntime();
const parentCtx = { sessionKey: 'agent:main:main', agentId: 'main' };
const childCtx = { sessionKey: 'agent:main:subagent:qa-child-actor-e2e', agentId: 'main' };
const spawnParams = {
  label: 'qa-feed-e2e-proof',
  task: '你是 qa_agent。請做整合型 actor consistency trace，確認 rows/tasks/latest 一致。',
};

runtime.rememberPendingSpawnAttribution(parentCtx.sessionKey, spawnParams);

const firstIdentity = runtime.resolveFeedAgentIdentity(childCtx);
runtime.pushFeed({
  ts: 1000,
  kind: 'before_agent_start',
  agentId: firstIdentity.agentId,
  rawAgentId: firstIdentity.rawAgentId,
  sessionKey: childCtx.sessionKey,
});

const beforeToolIdentity = runtime.resolveFeedAgentIdentity(childCtx);
runtime.pushFeed({
  ts: 1001,
  kind: 'before_tool_call',
  agentId: beforeToolIdentity.agentId,
  rawAgentId: beforeToolIdentity.rawAgentId,
  sessionKey: childCtx.sessionKey,
  toolName: 'browser',
  details: { url: 'https://example.com/lobster-room' },
});

const afterToolIdentity = runtime.resolveFeedAgentIdentity(childCtx);
runtime.pushFeed({
  ts: 1002,
  kind: 'after_tool_call',
  agentId: afterToolIdentity.agentId,
  rawAgentId: afterToolIdentity.rawAgentId,
  sessionKey: childCtx.sessionKey,
  toolName: 'browser',
  durationMs: 321,
  details: {},
});

runtime.rememberSpawnedSessionAgent(childCtx.sessionKey, 'qa_agent');

const feed = runtime.feedGet(true);
const childTask = feed.tasks.find((task) => task.sessionKey === childCtx.sessionKey);

assert.equal(firstIdentity.agentId, 'qa_agent', 'before_agent_start must resolve to qa_agent');
assert.equal(beforeToolIdentity.agentId, 'qa_agent', 'follow-up before_tool_call must stay on qa_agent');
assert.equal(afterToolIdentity.agentId, 'qa_agent', 'follow-up after_tool_call must stay on qa_agent');
assert.ok(feed.rows.every((row) => row.agentId === 'qa_agent'), 'feedGet.rows[].agentId must stay qa_agent for the child trace');
assert.equal(childTask?.agentId, 'qa_agent', 'feedGet.tasks[].agentId must stay qa_agent');
assert.equal(feed.latest?.agentId, 'qa_agent', 'feedGet.latest.agentId must stay qa_agent');
assert.ok(feed.rows[2].preview.startsWith('@qa_agent started'), `before_agent_start preview should humanize to qa_agent: ${feed.rows[2].preview}`);
assert.ok(feed.rows[1].preview.startsWith('@qa_agent checking live page'), `before_tool_call preview should humanize to qa_agent: ${feed.rows[1].preview}`);
assert.ok(feed.rows[0].preview.startsWith('@qa_agent checking page done'), `after_tool_call preview should humanize to qa_agent: ${feed.rows[0].preview}`);
const visiblePayload = JSON.stringify({
  rows: feed.rows.map((row) => ({ agentId: row.agentId, preview: row.preview })),
  tasks: feed.tasks.map((task) => ({ agentId: task.agentId, title: task.title, summary: task.summary, items: (task.items || []).map((item) => ({ agentId: item.agentId, preview: item.preview })) })),
  latest: feed.latest ? { agentId: feed.latest.agentId, preview: feed.latest.preview } : null,
});
assert.ok(!visiblePayload.match(/main\/subagent:|subagent:qa-child-actor-e2e|cron:/i), 'visible API payload must not leak internal descendant ids');
assert.ok(feed.latest.rawAgentId === 'main/subagent:qa-child-actor-e2e', 'debug rawAgentId may retain internal lineage');
assert.equal(canonicalResidentAgentId(childCtx.sessionKey), 'main', 'resident identity still collapses to main to avoid roster clone leakage');

console.log('feed-end-to-end-actor-consistency: PASS');
console.log(JSON.stringify({
  firstIdentity,
  beforeToolIdentity,
  afterToolIdentity,
  rows: feed.rows.map((row) => ({ kind: row.kind, agentId: row.agentId, preview: row.preview })),
  task: childTask && { sessionKey: childTask.sessionKey, agentId: childTask.agentId, title: childTask.title, summary: childTask.summary },
  latest: feed.latest && { kind: feed.latest.kind, agentId: feed.latest.agentId, preview: feed.latest.preview, rawAgentId: feed.latest.rawAgentId },
}, null, 2));
