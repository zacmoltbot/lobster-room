const assert = require('assert');

function normalizeIntentText(value, maxLen = 120) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (!text) return '';
  text = text.replace(/^you are\s+[^。.!?\n]+[。.!?]?\s*/i, '');
  text = text.replace(/^你是\s*[^。.!?\n]+[。.!?]?\s*/u, '');
  text = text.replace(/^(please|pls|kindly)\s+/i, '');
  text = text.replace(/^(請|麻煩)\s*/u, '');
  text = text.replace(/^(task|label|prompt)\s*[:：-]\s*/i, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) text = text.slice(0, maxLen).trimEnd() + '…';
  return text;
}

function sentenceCase(value) {
  const text = value.trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function cronJobLabelFromSessionKey(sessionKey) {
  const sk = typeof sessionKey === 'string' ? sessionKey.trim() : '';
  const match = sk.match(/^agent:([^:]+):cron:([^:]+)$/i);
  if (!match) return '';
  const rawJobId = String(match[2] || '').trim();
  if (!rawJobId) return '';
  const named = new Map([
    ['8267978b-1135-4736-973b-ed370beec448', 'Gmail Checker (pre-gate)'],
    ['807dbcb2-16df-4eef-b2ec-a74fdce0ed96', 'AI News Digest'],
  ]).get(rawJobId);
  if (named) return named;
  return rawJobId.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cronFriendlyIntent(sessionKey, toolName, phase = 'active', opts) {
  const label = cronJobLabelFromSessionKey(sessionKey);
  if (!label) return '';
  const verb = (() => {
    const tn = String(toolName || '').trim();
    if (tn === 'message') return phase === 'done' ? 'posted' : 'posting';
    if (tn === 'browser' || tn === 'web_fetch') return phase === 'done' ? 'checked' : 'checking';
    return phase === 'done' ? 'ran' : 'running';
  })();
  return `${verb} ${label}`.trim();
}

function extractTaskIntent(details) {
  for (const candidate of [details?.task, details?.label, details?.prompt, details?.goal, details?.summary, details?.title, details?.purpose, details?.name]) {
    const text = normalizeIntentText(candidate, 120);
    if (text) return text;
  }
  const cronIntent = cronFriendlyIntent(details?.sessionKey, details?.toolName, 'active', { includeActor: false });
  if (cronIntent) return cronIntent;
  return '';
}

function inferCommandTaskIntent(details) {
  const raw = [details?.command, details?.cmd, details?.args, details?.action, details?.toolName].find((value) => typeof value === 'string' && value.trim());
  const text = normalizeIntentText(raw, 160).toLowerCase();
  if (!text) return 'inspect runtime';
  if (/\b(npm|pnpm|yarn|bun)\s+(test|vitest|jest)\b|\bpytest\b|\bgo test\b|\bcargo test\b/.test(text)) return 'run tests';
  if (/\b(build|compile|tsc|vite build|webpack)\b/.test(text)) return 'build the project';
  if (/\blint\b|eslint|ruff|flake8/.test(text)) return 'run lint checks';
  if (/\bgit\s+status\b/.test(text)) return 'check git status';
  if (/\bgit\s+diff\b/.test(text)) return 'review git diff';
  if (/\b(session_status|sessions_history|sessions_list)\b/.test(text)) return 'inspect session status';
  if (/\b(ps|top|htop|pgrep|process)\b/.test(text)) return 'inspect process status';
  if (/\bcurl\b|\bwget\b/.test(text)) return 'check a live endpoint';
  return 'inspect runtime';
}

function fallbackTaskIntentForTool(toolName, details) {
  const tn = String(toolName || '').trim();
  if (tn === 'read') return 'review files';
  if (tn === 'write' || tn === 'edit') return 'update files';
  if (tn === 'browser') return details?.url ? 'check live page' : 'check page';
  if (tn === 'web_fetch') return 'check page';
  if (tn === 'message') return 'prepare a reply';
  if (tn === 'exec' || tn === 'process') return inferCommandTaskIntent(details);
  return '';
}

function inferTaskIntentFromItems(items) {
  for (const it of items) {
    if (it.kind !== 'before_tool_call') continue;
    const intent = extractTaskIntent(it.details || null);
    if (intent) return intent;
  }
  const firstToolItem = items.find((x) => x.kind === 'before_tool_call' && x.toolName);
  return firstToolItem ? fallbackTaskIntentForTool(firstToolItem.toolName, firstToolItem.details || null) : '';
}

function inferTaskTitleIntentFromItems(items) {
  for (const it of items) {
    if (it.kind !== 'before_tool_call') continue;
    const cronLabel = cronJobLabelFromSessionKey(it.details?.sessionKey);
    if (cronLabel) return cronLabel;
    const intent = extractTaskIntent(it.details || null);
    if (intent) return intent;
  }
  const firstToolItem = items.find((x) => x.kind === 'before_tool_call' && x.toolName);
  return firstToolItem ? fallbackTaskIntentForTool(firstToolItem.toolName, firstToolItem.details || null) : '';
}

const GENERIC_TASK_TITLE_RE = /^(working|in progress|run command|check process|summarize)$/i;
function taskTitleFromIntent(intent) {
  const clean = normalizeIntentText(intent, 120);
  if (!clean) return 'Active task';
  if (GENERIC_TASK_TITLE_RE.test(clean)) return sentenceCase(clean.toLowerCase() === 'run command' ? 'Run a check' : clean);
  return sentenceCase(clean);
}

function taskSummaryFromIntent(intent, status, steps = 0, msgSent = 0, msgFail = 0, errorText = '') {
  const clean = normalizeIntentText(intent, 120);
  const stableIntent = clean || 'run a check';
  const stepBit = steps > 1 ? ` · ${steps} steps` : '';
  const sentBit = msgSent ? ` · ${msgSent} reply sent` : '';
  const failBit = msgFail ? ` · ${msgFail} reply failed` : '';
  if (status === 'running') return `Now ${stableIntent}${stepBit}${sentBit}${failBit}`;
  if (status === 'error') return `Blocked · while trying to ${stableIntent}${sentBit}${failBit}${errorText ? ` · ${errorText}` : ''}`;
  return `Done · ${stableIntent}${stepBit}${sentBit}${failBit}`;
}

function taskTitleFromItems(items) {
  return taskTitleFromIntent(inferTaskTitleIntentFromItems(items));
}

function taskSummaryFromItems(items, status) {
  const toolCalls = items.filter((x) => x.kind === 'before_tool_call').length;
  const msgSent = items.filter((x) => x.kind === 'message_sent' && x.success !== false).length;
  const msgFail = items.filter((x) => x.kind === 'message_sent' && x.success === false).length;
  const errorText = items.find((x) => x.error)?.error || '';
  return taskSummaryFromIntent(inferTaskIntentFromItems(items), status, toolCalls, msgSent, msgFail, errorText);
}

const taskItems = [
  { kind: 'before_tool_call', toolName: 'read', details: { task: 'review room/feed consistency for P1 handoff' } },
  { kind: 'before_tool_call', toolName: 'edit', details: { task: 'review room/feed consistency for P1 handoff' } },
  { kind: 'message_sent', success: true },
];

assert.equal(taskTitleFromItems(taskItems), 'Review room/feed consistency for P1 handoff');
assert.equal(taskSummaryFromItems(taskItems, 'running'), 'Now review room/feed consistency for P1 handoff · 2 steps · 1 reply sent');
assert.equal(taskSummaryFromItems(taskItems, 'done'), 'Done · review room/feed consistency for P1 handoff · 2 steps · 1 reply sent');
assert.ok(!/^Working$/i.test(taskTitleFromItems(taskItems)));
assert.ok(!/^Run command$/i.test(taskTitleFromItems(taskItems)));

const genericExecItems = [
  { kind: 'before_tool_call', toolName: 'exec', details: { command: 'npm test' } },
];
assert.equal(taskTitleFromItems(genericExecItems), 'Run tests');
assert.equal(taskSummaryFromItems(genericExecItems, 'running'), 'Now run tests');
assert.ok(!/^Now run a check/i.test(taskSummaryFromItems(genericExecItems, 'running')));
assert.ok(!/^In progress/i.test(taskSummaryFromItems(genericExecItems, 'running')));
assert.ok(!/^Working$/i.test(taskTitleFromItems(genericExecItems)));

const genericUnknownItems = [
  { kind: 'before_tool_call', toolName: 'exec', details: {} },
];
assert.equal(taskTitleFromItems(genericUnknownItems), 'Inspect runtime');
assert.equal(taskSummaryFromItems(genericUnknownItems, 'running'), 'Now inspect runtime');
assert.ok(!/Active task|run a check/i.test(`${taskTitleFromItems(genericUnknownItems)} :: ${taskSummaryFromItems(genericUnknownItems, 'running')}`));

const cronNamedItems = [
  {
    kind: 'before_tool_call',
    toolName: 'browser',
    details: {
      toolName: 'browser',
      sessionKey: 'agent:main:cron:8267978b-1135-4736-973b-ed370beec448',
    },
  },
];
assert.equal(taskTitleFromItems(cronNamedItems), 'Gmail Checker (pre-gate)');
assert.equal(taskSummaryFromItems(cronNamedItems, 'running'), 'Now checking Gmail Checker (pre-gate)');
assert.ok(!/^Checking Gmail Checker/i.test(taskTitleFromItems(cronNamedItems)));

console.log('feed-task-humanization: PASS');
