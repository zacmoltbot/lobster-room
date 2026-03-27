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

function extractTaskIntent(details) {
  for (const candidate of [details?.task, details?.label, details?.prompt, details?.goal, details?.summary]) {
    const text = normalizeIntentText(candidate, 120);
    if (text) return text;
  }
  return '';
}

function inferTaskIntentFromItems(items) {
  for (const it of items) {
    if (it.kind !== 'before_tool_call') continue;
    const intent = extractTaskIntent(it.details || null);
    if (intent) return intent;
  }
  const firstTool = items.find((x) => x.kind === 'before_tool_call' && x.toolName)?.toolName;
  if (firstTool === 'read') return 'review files';
  if (firstTool === 'browser') return 'check live page';
  return '';
}

function taskTitleFromItems(items) {
  const intent = inferTaskIntentFromItems(items);
  return intent ? sentenceCase(intent) : 'Working';
}

function taskSummaryFromItems(items, status) {
  const toolCalls = items.filter((x) => x.kind === 'before_tool_call').length;
  const msgSent = items.filter((x) => x.kind === 'message_sent' && x.success !== false).length;
  const intent = inferTaskIntentFromItems(items);
  if (status === 'running') return intent ? `Now ${intent}${toolCalls > 1 ? ` · ${toolCalls} steps` : ''}` : (toolCalls ? `In progress · ${toolCalls} steps` : 'In progress');
  return intent ? `Done · ${intent}${toolCalls > 1 ? ` · ${toolCalls} steps` : ''}${msgSent ? ` · ${msgSent} reply sent` : ''}` : 'Done';
}

const taskItems = [
  { kind: 'before_tool_call', toolName: 'read', details: { task: 'review room/feed consistency for P1 handoff' } },
  { kind: 'before_tool_call', toolName: 'edit', details: { task: 'review room/feed consistency for P1 handoff' } },
  { kind: 'message_sent', success: true },
];

const title = taskTitleFromItems(taskItems);
const runningSummary = taskSummaryFromItems(taskItems, 'running');
const doneSummary = taskSummaryFromItems(taskItems, 'done');

assert.equal(title, 'Review room/feed consistency for P1 handoff');
assert.equal(runningSummary, 'Now review room/feed consistency for P1 handoff · 2 steps');
assert.equal(doneSummary, 'Done · review room/feed consistency for P1 handoff · 2 steps · 1 reply sent');
assert.ok(!/^Working ·/i.test(runningSummary), `running summary should not look like old machine summary: ${runningSummary}`);
assert.ok(!/^Working$/i.test(title), `title should not collapse to Working: ${title}`);
assert.ok(!/^run command$/i.test(title), `title should not collapse to tool name: ${title}`);

console.log('feed-task-humanization: PASS');
