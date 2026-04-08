const assert = require('assert');

function feedCanonicalAgentId(value) {
  let id0 = String(value || '').trim();
  if (!id0) return '';
  const m = id0.match(/^[^@]+@(.+)$/);
  if (m) id0 = String(m[1] || '').trim();
  if (!id0) return '';
  if (/^agent:/i.test(id0)) {
    const parts = id0.split(':').filter(Boolean);
    if (parts.length >= 2) id0 = String(parts[1] || '').trim();
  }
  id0 = id0.replace(/^resident@/i, '').trim();
  if (id0.includes('/')) id0 = id0.split('/')[0].trim();
  const lower = id0.toLowerCase();
  if (['subagent', 'spawn', 'cron', 'discord', 'helper', 'unknown'].includes(lower)) return '';
  return id0;
}

function feedNormalizeAgentId(value) {
  return feedCanonicalAgentId(value);
}

function inferActivityFromFeedItem(item) {
  if (!item) return null;
  if (item.kind === 'message_sending' || item.kind === 'message_sent') return 'reply';
  if (item.kind === 'before_tool_call') return 'tool';
  if (item.kind === 'agent_end') return item.success === false || !!item.error ? 'error' : 'idle';
  if (item.kind === 'before_agent_start' || item.kind === 'after_tool_call' || item.kind === 'tool_result_persist') return 'thinking';
  return null;
}

function mapActivityToUiState(state) {
  if (state === 'thinking') return 'think';
  if (state === 'idle') return 'wait';
  return state;
}

function inferTaskResidentState(task) {
  const items = Array.isArray(task && task.items) ? task.items : [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const uiState = inferActivityFromFeedItem(items[i]);
    if (uiState) return mapActivityToUiState(uiState);
  }
  return (task && task.status === 'running') ? 'think' : 'wait';
}

function currentResidents(modelAgents, feedTasks) {
  const byId = new Map();
  for (const raw of Array.isArray(modelAgents) ? modelAgents : []) {
    const canonicalId = feedNormalizeAgentId(raw && (raw.id || raw.rawId || raw.name || ''));
    if (!canonicalId) continue;
    byId.set(canonicalId, Object.assign({}, raw, { id: canonicalId, name: raw.name || canonicalId }));
  }
  for (const task of Array.isArray(feedTasks) ? feedTasks : []) {
    if (!task || task.status !== 'running') continue;
    const canonicalId = feedNormalizeAgentId(task.agentId || '');
    if (!canonicalId || byId.has(canonicalId)) continue;
    byId.set(canonicalId, {
      id: canonicalId,
      name: canonicalId,
      state: inferTaskResidentState(task),
      meta: { taskFallback: true },
    });
  }
  return Array.from(byId.values()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

{
  const modelAgents = [
    { id: 'resident@coding_agent', name: 'coding_agent', state: 'wait' },
  ];
  const feedTasks = [
    {
      id: 'task-main-live',
      agentId: 'main',
      status: 'running',
      items: [
        { kind: 'before_tool_call', agentId: 'main', toolName: 'browser' },
      ],
    },
  ];
  const residents = currentResidents(modelAgents, feedTasks);
  assert.deepEqual(residents.map((x) => x.id), ['coding_agent', 'main'], 'room/Now should keep main resident when current truth only arrives via running task fallback');
  const main = residents.find((x) => x.id === 'main');
  assert.ok(main, 'main resident must exist');
  assert.equal(main.state, 'tool', 'fallback resident should keep a meaningful non-idle state');
}

{
  const modelAgents = [
    { id: 'resident@main', name: 'main', state: 'think' },
  ];
  const feedTasks = [
    { id: 'task-main-live', agentId: 'main', status: 'running', items: [{ kind: 'before_tool_call', agentId: 'main' }] },
  ];
  const residents = currentResidents(modelAgents, feedTasks);
  assert.equal(residents.filter((x) => x.id === 'main').length, 1, 'canonical resident list must not duplicate main when both backend agents and feed tasks mention it');
}

console.log('room-current-residents-regression: PASS');
