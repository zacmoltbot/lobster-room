const assert = require('assert');

function canonicalVisibleAgentId(value) {
  if (typeof value !== 'string') return '';
  const raw = String(value).trim();
  if (!raw) return '';
  if (['subagent', 'spawn', 'cron', 'discord'].includes(raw.toLowerCase())) return '';
  return raw;
}

function normalizeSpawnText(value, maxLen = 240) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function resolveExplicitSpawnAgentId(payload) {
  for (const candidate of [payload && payload.agentId, payload && payload.spawnAgentId, payload && payload.requestedAgentId]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) return visible;
  }
  return '';
}

function inferSpawnActorId(payload) {
  const explicit = resolveExplicitSpawnAgentId(payload);
  if (explicit) return explicit;
  const text = [payload && payload.label, payload && payload.task, payload && payload.prompt, payload && payload.instructions]
    .map((part) => normalizeSpawnText(part, 400))
    .filter(Boolean)
    .join('\n');
  if (!text) return '';
  if (/\byou are\s+qa[_ -]?agent\b/i.test(text) || /你是\s*qa[_ -]?agent/i.test(text) || /\bqa[_ -]?agent\b/i.test(text)) return 'qa_agent';
  if (/\byou are\s+coding[_ -]?agent\b/i.test(text) || /你是\s*coding[_ -]?agent/i.test(text) || /\bcoding[_ -]?agent\b/i.test(text)) return 'coding_agent';
  return '';
}

function createRuntime() {
  const state = {
    spawnedSessionAgentIds: new Map(),
    pendingByParent: new Map(),
    warnings: [],
  };

  function rememberPendingSpawnAttribution(parentSessionKey, payload) {
    const actorId = inferSpawnActorId(payload);
    if (!actorId) return undefined;
    const entry = { actorId, parentSessionKey };
    state.pendingByParent.set(parentSessionKey, (state.pendingByParent.get(parentSessionKey) || []).concat([entry]));
    return entry;
  }

  function consumePendingSpawnAttribution(parentSessionKey) {
    const queue = state.pendingByParent.get(parentSessionKey) || [];
    const next = queue.shift();
    if (queue.length) state.pendingByParent.set(parentSessionKey, queue);
    else state.pendingByParent.delete(parentSessionKey);
    return next;
  }

  function rememberSpawnedSessionAgent(sessionKey, agentId, options = {}) {
    const visible = canonicalVisibleAgentId(agentId);
    if (!sessionKey || !visible) return;
    const existing = state.spawnedSessionAgentIds.get(sessionKey);
    if (existing && existing !== visible && !options.allowOverwrite) {
      state.warnings.push({ type: 'mismatch_keep_existing', sessionKey, existingActorId: existing, inferredActorId: visible, reason: options.reason || 'unspecified' });
      return;
    }
    state.spawnedSessionAgentIds.set(sessionKey, visible);
  }

  function afterToolCall(event, ctx) {
    if ((event && event.toolName) !== 'sessions_spawn') return;
    const childSessionKey = event && event.result && event.result.childSessionKey;
    const pending = consumePendingSpawnAttribution(ctx && ctx.sessionKey);
    const requestedSpawnAgentId = inferSpawnActorId((event && event.params) || {}) || (pending && pending.actorId) || '';
    const noisyInferredAgentId = inferSpawnActorId((event && event.result) || {}) || inferSpawnActorId(event || {});
    rememberSpawnedSessionAgent(childSessionKey, requestedSpawnAgentId || noisyInferredAgentId, {
      allowOverwrite: false,
      reason: requestedSpawnAgentId ? 'sessions_spawn:payload_or_pending' : 'sessions_spawn:fallback_result_inference',
    });
    if (requestedSpawnAgentId && noisyInferredAgentId && noisyInferredAgentId !== requestedSpawnAgentId) {
      state.warnings.push({ type: 'payload_result_mismatch', sessionKey: childSessionKey, requestedSpawnAgentId, noisyInferredAgentId });
    }
  }

  return { state, rememberPendingSpawnAttribution, afterToolCall };
}

const runtime = createRuntime();
const parentSessionKey = 'agent:main:discord:channel:1476111438186680416';
const childSessionKey = 'agent:main:subagent:coding-lobster-cron-shape-fix-20260328';

runtime.rememberPendingSpawnAttribution(parentSessionKey, {
  label: 'coding-lobster-cron-shape-fix-20260328',
  task: 'You are coding_agent. Directly fix the visible mislabel bug.',
});
runtime.afterToolCall({
  toolName: 'sessions_spawn',
  params: {
    label: 'coding-lobster-cron-shape-fix-20260328',
    task: 'You are coding_agent. Directly fix the visible mislabel bug.',
  },
  result: {
    childSessionKey,
    task: 'You are qa_agent. Please verify afterwards.',
    message: 'Spawned helper successfully.',
  },
}, { sessionKey: parentSessionKey });

assert.equal(runtime.state.spawnedSessionAgentIds.get(childSessionKey), 'coding_agent', 'sessions_spawn payload/pending actor must win over noisy result inference');
assert.deepEqual(
  runtime.state.warnings,
  [
    {
      type: 'payload_result_mismatch',
      sessionKey: childSessionKey,
      requestedSpawnAgentId: 'coding_agent',
      noisyInferredAgentId: 'qa_agent',
    },
  ],
  'mismatch should be recorded as warning/debug instead of overwriting persisted mapping',
);

console.log('feed-sessions-spawn-payload-precedence regression: PASS');
