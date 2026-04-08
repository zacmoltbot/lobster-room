const assert = require('assert');

function canonicalResidentAgentId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const m = raw.match(/^agent:([^:]+):/i);
  if (m && m[1]) return m[1];
  const slash = raw.split('/')[0];
  return slash || raw;
}

function canonicalVisibleAgentId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (/^[a-z0-9_]+$/i.test(raw)) return raw;
  if (/^main(?:\/|$)/i.test(raw)) return 'main';
  return canonicalResidentAgentId(raw);
}

const pendingByParent = new Map();
const spawnedSessionAgents = new Map();

function resolveRequestedSpawnAgentId(payload) {
  for (const candidate of [payload?.spawnAgentId, payload?.agentId, payload?.label]) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible && visible !== 'main') return visible;
  }
  return '';
}

function rememberPendingSpawnAgent(parentSessionKey, agentId) {
  if (!parentSessionKey || !agentId) return;
  pendingByParent.set(parentSessionKey, (pendingByParent.get(parentSessionKey) || []).concat([agentId]));
}

function consumePendingSpawnAgent(parentSessionKey) {
  const queue = pendingByParent.get(parentSessionKey) || [];
  const next = queue.shift();
  if (queue.length) pendingByParent.set(parentSessionKey, queue);
  else pendingByParent.delete(parentSessionKey);
  return next;
}

function rememberSpawnedSessionAgent(sessionKey, agentId) {
  const visible = canonicalVisibleAgentId(agentId);
  if (sessionKey && visible) spawnedSessionAgents.set(sessionKey, visible);
}

function resolveFeedAgentIdentity(ctx) {
  const sessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey.trim() : '';
  const rawAgentId = typeof ctx?.agentId === 'string' && ctx.agentId.trim() ? ctx.agentId.trim() : canonicalResidentAgentId(sessionKey);
  const explicit = canonicalVisibleAgentId(rawAgentId);
  if (explicit && explicit !== 'main') return { agentId: explicit, rawAgentId };
  if (spawnedSessionAgents.has(sessionKey)) return { agentId: spawnedSessionAgents.get(sessionKey), rawAgentId };
  if (/subagent:/i.test(sessionKey)) {
    const adopted = consumePendingSpawnAgent('agent:main:main');
    if (adopted) {
      spawnedSessionAgents.set(sessionKey, adopted);
      return { agentId: adopted, rawAgentId };
    }
  }
  return { agentId: explicit || 'main', rawAgentId };
}

const TOOL_LABELS = {
  browser: 'Check live page',
  web_fetch: 'Check page',
  sessions_spawn: 'Start helper task',
  exec: 'Run command',
  read: 'Review files',
  write: 'Update files',
  edit: 'Update files',
  process: 'Check process',
  message: 'Prepare reply',
};

function genericToolLabel(toolName) {
  return TOOL_LABELS[String(toolName || '').trim()];
}

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

function extractTaskIntent(details) {
  for (const candidate of [details?.task, details?.label, details?.prompt, details?.goal, details?.summary, details?.title, details?.purpose, details?.name]) {
    const text = normalizeIntentText(candidate, 120);
    if (text) return text;
  }
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
  const tn = String(toolName || 'tool').trim();
  if (tn === 'read') return 'review files';
  if (tn === 'write' || tn === 'edit') return 'update files';
  if (tn === 'browser') return details?.url ? 'check live page' : 'check page';
  if (tn === 'web_fetch') return 'check page';
  if (tn === 'message') return 'prepare a reply';
  if (tn === 'exec' || tn === 'process') return inferCommandTaskIntent(details);
  return (genericToolLabel(tn) || '').toLowerCase();
}

function humanizedWorkDescription(toolName, details, phase = 'active') {
  const tn = String(toolName || 'tool').trim();
  const intent = extractTaskIntent(details);
  if (tn === 'sessions_spawn') return intent ? `${phase === 'done' ? 'started' : 'starting'} helper task for ${intent}` : `${phase === 'done' ? 'started' : 'starting'} helper task`;
  if (tn === 'read') return intent ? `${phase === 'done' ? 'reviewed' : 'reviewing'} ${intent}` : `${phase === 'done' ? 'reviewed' : 'reviewing'} files`;
  if (tn === 'write' || tn === 'edit') return intent ? `${phase === 'done' ? 'updated' : 'updating'} ${intent}` : `${phase === 'done' ? 'updated' : 'updating'} files`;
  if (tn === 'browser' || tn === 'web_fetch') return intent ? `${phase === 'done' ? 'checked' : 'checking'} ${intent}` : (phase === 'done' ? (details?.url ? 'checked live page' : 'checked page') : (details?.url ? 'checking live page' : 'checking page'));
  if (tn === 'exec' || tn === 'process') {
    const fallbackIntent = inferCommandTaskIntent(details);
    return intent ? (phase === 'done' ? `finished ${intent}` : intent) : (phase === 'done' ? `finished ${fallbackIntent}` : fallbackIntent);
  }
  if (tn === 'message') return intent ? `${phase === 'done' ? 'prepared reply for' : 'preparing reply for'} ${intent}` : `${phase === 'done' ? 'prepared a reply' : 'preparing a reply'}`;
  if (intent) return phase === 'done' ? `finished ${intent}` : intent;
  const base = genericToolLabel(tn) || 'working';
  return phase === 'done' ? `finished ${base.toLowerCase()}` : base.toLowerCase();
}

function feedPreview(it, opts = {}) {
  const canonicalAgentId = it.agentId ? canonicalVisibleAgentId(it.agentId) || 'main' : '';
  const actorPrefix = opts.includeActor === false || !canonicalAgentId ? '' : `@${canonicalAgentId} `;
  const details = it.details || null;
  if (it.kind === 'before_agent_start') return `${actorPrefix}started`.trim();
  if (it.kind === 'before_tool_call') return `${actorPrefix}${humanizedWorkDescription(String(it.toolName || 'tool'), details, 'active')}`.trim();
  if (it.kind === 'after_tool_call') return `${actorPrefix}${humanizedWorkDescription(String(it.toolName || 'tool'), details, 'done')}`.trim();
  if (it.kind === 'tool_result_persist') {
    const intent = extractTaskIntent(details) || fallbackTaskIntentForTool(String(it.toolName || ''), details);
    return `${actorPrefix}${intent ? `continuing ${intent}` : 'continuing work'}`.trim();
  }
  if (it.kind === 'agent_end') return `${actorPrefix}${it.success === false ? 'ended (error)' : 'ended'}`.trim();
  return String(it.kind || 'event');
}

const qaSpawnParams = { spawnAgentId: 'qa_agent', label: 'qa', task: 'run final acceptance checks' };
rememberPendingSpawnAgent('agent:main:main', resolveRequestedSpawnAgentId(qaSpawnParams));
const qaEarly = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:qa-123', agentId: 'main' });
const qaEarlyFollowup = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:qa-123', agentId: 'main' });
rememberSpawnedSessionAgent('agent:main:subagent:qa-123', resolveRequestedSpawnAgentId(qaSpawnParams) || consumePendingSpawnAgent('agent:main:main'));
const codingSpawnParams = { agentId: 'coding_agent', label: 'coding', task: 'implement feature X' };
rememberPendingSpawnAgent('agent:main:main', resolveRequestedSpawnAgentId(codingSpawnParams));
rememberSpawnedSessionAgent('agent:main:subagent:code-456', resolveRequestedSpawnAgentId(codingSpawnParams) || consumePendingSpawnAgent('agent:main:main'));

const qa = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:qa-123', agentId: 'main' });
const coding = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:code-456' });
const main = resolveFeedAgentIdentity({ sessionKey: 'agent:main:main' });
const explicitQa = resolveFeedAgentIdentity({ sessionKey: 'agent:main:main', agentId: 'qa_agent' });

assert.equal(qaEarly.agentId, 'qa_agent');
assert.equal(qaEarlyFollowup.agentId, 'qa_agent');
assert.equal(qa.agentId, 'qa_agent');
assert.equal(coding.agentId, 'coding_agent');
assert.equal(main.agentId, 'main');
assert.equal(explicitQa.agentId, 'qa_agent');
assert.ok(!/subagent|cron/i.test(qa.agentId));
assert.ok(!/subagent|cron/i.test(coding.agentId));
assert.equal(qa.rawAgentId, 'main');
assert.equal(canonicalResidentAgentId('agent:main:subagent:qa-123'), 'main');
assert.equal(canonicalVisibleAgentId('main/subagent:qa-123'), 'main');

const RAW_SHELL_RE = /\$\{.*?\}|`.*?`|\bnpm test\b/i;
const INTERNAL_ID_RE = /main\/subagent:|subagent:|cron:/i;
function assertFeedOk(label, preview) {
  assert.ok(preview && preview.length > 0, `${label}: preview must not be empty`);
  assert.ok(!RAW_SHELL_RE.test(preview), `${label}: must not contain raw shell commands: ${preview}`);
  assert.ok(!INTERNAL_ID_RE.test(preview), `${label}: must not expose internal descendant ids: ${preview}`);
}

const qaBeforeTool = { kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'browser', details: { url: 'https://example.com/results' } };
const qaPreview = feedPreview(qaBeforeTool);
const qaCellPreview = feedPreview(qaBeforeTool, { includeActor: false });
assert.ok(qaPreview.startsWith('@qa_agent '));
assert.ok(/checking/.test(qaPreview), `qa actor preview should stay humanized: ${qaPreview}`);
assert.equal(qaCellPreview, 'checking live page');
assertFeedOk('qa_agent tool', qaCellPreview);

const qaSpawn = { kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'sessions_spawn', details: { task: 'run final acceptance checks', spawnAgentId: 'qa_agent' } };
assert.equal(feedPreview(qaSpawn, { includeActor: false }), 'starting helper task for run final acceptance checks');

const codingBeforeTool = { kind: 'before_tool_call', agentId: 'coding_agent', toolName: 'read', details: { task: 'index.ts for refactoring plan' } };
assert.equal(feedPreview(codingBeforeTool, { includeActor: false }), 'reviewing index.ts for refactoring plan');

const mainBeforeTool = { kind: 'before_tool_call', agentId: 'main', toolName: 'write', details: { task: 'update config' } };
assert.equal(feedPreview(mainBeforeTool, { includeActor: false }), 'updating update config');

const execTool = { kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'exec', details: { command: 'npm test -- --coverage' } };
const execPreview = feedPreview(execTool, { includeActor: false });
assert.equal(execPreview, 'run tests');
assert.ok(!/run a check/i.test(execPreview));
assertFeedOk('exec tool', execPreview);

const badItem = { kind: 'before_tool_call', agentId: 'main/subagent:qa-123', toolName: 'read', details: {} };
const badPreview = feedPreview(badItem);
assert.ok(!/subagent/.test(badPreview));
assert.ok(badPreview.startsWith('@main reviewing files'));

const afterQaTool = { kind: 'after_tool_call', agentId: 'qa_agent', toolName: 'browser', durationMs: 1234, details: {} };
assert.equal(feedPreview(afterQaTool, { includeActor: false }), 'checked page');

const progressPreview = feedPreview({ kind: 'tool_result_persist', agentId: 'qa_agent', details: { task: 'review room/feed consistency' } }, { includeActor: false });
assert.equal(progressPreview, 'continuing review room/feed consistency');
assert.ok(!/making progress/i.test(progressPreview));

const qaEnd = { kind: 'agent_end', agentId: 'qa_agent', success: true };
assert.equal(feedPreview(qaEnd, { includeActor: false }), 'ended');
const qaEndError = { kind: 'agent_end', agentId: 'qa_agent', success: false };
assert.equal(feedPreview(qaEndError, { includeActor: false }), 'ended (error)');

console.log('feed-agent-attribution smoke: ALL PASSED');
