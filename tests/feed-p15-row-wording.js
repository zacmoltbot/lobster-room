const assert = require('assert');

function normalizeIntentText(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

function extractTaskIntent(details) {
  for (const candidate of [details?.task, details?.label, details?.prompt, details?.goal, details?.summary, details?.title, details?.purpose, details?.name]) {
    const text = normalizeIntentText(candidate);
    if (text) return text;
  }
  return '';
}

function inferCommandTaskIntent(details) {
  const raw = [details?.command, details?.cmd, details?.args, details?.action, details?.toolName].find((value) => typeof value === 'string' && value.trim());
  const text = normalizeIntentText(raw).toLowerCase();
  if (!text) return 'inspect runtime';
  if (/\b(npm|pnpm|yarn|bun)\s+(test|vitest|jest)\b|\bpytest\b|\bgo test\b|\bcargo test\b/.test(text)) return 'run tests';
  if (/\b(session_status|sessions_history|sessions_list)\b/.test(text)) return 'inspect session status';
  if (/\b(ps|top|htop|pgrep|process)\b/.test(text)) return 'inspect process status';
  return 'inspect runtime';
}

function fallbackTaskIntentForTool(toolName, details) {
  const tn = String(toolName || '').trim();
  if (tn === 'browser') return details?.url ? 'check live page' : 'check page';
  if (tn === 'read') return 'review files';
  if (tn === 'exec' || tn === 'process') return inferCommandTaskIntent(details);
  return '';
}

function humanizedWorkDescription(toolName, details, phase = 'active') {
  const tn = String(toolName || '').trim();
  const intent = extractTaskIntent(details);
  if (tn === 'browser') return intent ? `${phase === 'done' ? 'checked' : 'checking'} ${intent}` : (phase === 'done' ? (details?.url ? 'checked live page' : 'checked page') : (details?.url ? 'checking live page' : 'checking page'));
  if (tn === 'read') return intent ? `${phase === 'done' ? 'reviewed' : 'reviewing'} ${intent}` : `${phase === 'done' ? 'reviewed' : 'reviewing'} files`;
  if (tn === 'exec' || tn === 'process') return intent ? (phase === 'done' ? `finished ${intent}` : intent) : (phase === 'done' ? 'finished a check' : 'running a check');
  return intent || 'working';
}

function feedPreview(it, includeActor = false) {
  const actor = includeActor ? `@${it.agentId} ` : '';
  if (it.kind === 'before_agent_start') return `${actor}started`.trim();
  if (it.kind === 'before_tool_call') return `${actor}${humanizedWorkDescription(it.toolName, it.details || null, 'active')}`.trim();
  if (it.kind === 'after_tool_call') return `${actor}${humanizedWorkDescription(it.toolName, it.details || null, 'done')}`.trim();
  if (it.kind === 'tool_result_persist') {
    const intent = extractTaskIntent(it.details || null) || fallbackTaskIntentForTool(it.toolName, it.details || null);
    return `${actor}${intent ? `continuing ${intent}` : 'continuing work'}`.trim();
  }
  if (it.kind === 'agent_end') return `${actor}${it.success === false ? 'ended (error)' : 'ended'}`.trim();
  return it.kind;
}

function shouldSuppressFeedItem(it, allItems) {
  if (it.kind === 'tool_result_persist') {
    const intent = extractTaskIntent(it.details || null) || fallbackTaskIntentForTool(it.toolName, it.details || null);
    return !intent;
  }
  if (it.kind === 'agent_end' && it.success !== false) {
    const sameSession = allItems.filter((candidate) => candidate.sessionKey === it.sessionKey);
    return sameSession.some((candidate) => candidate !== it && ['before_agent_start', 'before_tool_call', 'after_tool_call', 'message_sent'].includes(candidate.kind));
  }
  return false;
}

const items = [
  { ts: 1, sessionKey: 's1', kind: 'before_agent_start', agentId: 'qa_agent' },
  { ts: 2, sessionKey: 's1', kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'browser', details: { url: 'https://example.com' } },
  { ts: 3, sessionKey: 's1', kind: 'tool_result_persist', agentId: 'qa_agent', details: {} },
  { ts: 4, sessionKey: 's1', kind: 'after_tool_call', agentId: 'qa_agent', toolName: 'browser', details: {} },
  { ts: 5, sessionKey: 's1', kind: 'agent_end', agentId: 'qa_agent', success: true },
];

const visible = items.filter((it) => !shouldSuppressFeedItem(it, items));
const previews = visible.map((it) => feedPreview(it, false));

assert.deepEqual(previews, ['started', 'checking live page', 'checked page']);
assert.ok(previews.every((preview) => !preview.includes('@qa_agent')), '3rd column preview should not repeat actor prefix');
assert.ok(previews.every((preview) => !/making progress/i.test(preview)), 'generic making progress wording should be gone');
assert.ok(!visible.some((it) => it.kind === 'agent_end' && it.success === true), 'low-signal success end row should be suppressed when the story already exists');

console.log('feed-p15-row-wording: PASS');
