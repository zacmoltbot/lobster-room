const assert = require('assert');

// ─── Identity resolution (mirrors index.ts logic) ─────────────────────────────────

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

const spawnedSessionAgentIds = new Map();
const pendingSpawnAgentIds = new Map();
const pendingSpawnAgentIdsByResident = new Map();

function enqueuePendingSpawnAgent(bucket, key, visible) {
  bucket.set(key, (bucket.get(key) || []).concat([visible]));
}

function dequeuePendingSpawnAgent(bucket, key) {
  const queue = bucket.get(key) || [];
  const next = queue.shift() || '';
  if (queue.length) bucket.set(key, queue);
  else bucket.delete(key);
  return next;
}

function rememberPendingSpawnAgent(parentSessionKey, agentId) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  const visible = canonicalVisibleAgentId(agentId);
  if (!sk || !visible) return;
  enqueuePendingSpawnAgent(pendingSpawnAgentIds, sk, visible);
  const resident = canonicalResidentAgentId(sk);
  if (resident) enqueuePendingSpawnAgent(pendingSpawnAgentIdsByResident, resident, visible);
}

function consumePendingSpawnAgent(parentSessionKey) {
  const sk = typeof parentSessionKey === 'string' ? String(parentSessionKey).trim() : '';
  if (!sk) return '';
  const next = dequeuePendingSpawnAgent(pendingSpawnAgentIds, sk);
  if (!next) return '';
  const resident = canonicalResidentAgentId(sk);
  if (resident) dequeuePendingSpawnAgent(pendingSpawnAgentIdsByResident, resident);
  return next;
}

function adoptPendingSpawnAgentForSession(sessionKey, residentAgentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
  if (!sk || spawnedSessionAgentIds.has(sk)) return spawnedSessionAgentIds.get(sk) || '';
  const resident = canonicalVisibleAgentId(residentAgentId);
  if (!resident) return '';
  const adopted = dequeuePendingSpawnAgent(pendingSpawnAgentIdsByResident, resident);
  if (!adopted) return '';
  spawnedSessionAgentIds.set(sk, adopted);
  return adopted;
}

function rememberSpawnedSessionAgent(sessionKey, agentId) {
  const sk = typeof sessionKey === 'string' ? String(sessionKey).trim() : '';
  const visible = canonicalVisibleAgentId(agentId);
  if (!sk || !visible) return;
  spawnedSessionAgentIds.set(sk, visible);
}

function resolveFeedAgentIdentity(ctx) {
  const parsed = parseSessionIdentity(ctx && ctx.sessionKey, ctx && ctx.agentId);
  const rawSessionAgentId = parsed.agentId;
  const childSessionKey = typeof (ctx && ctx.sessionKey) === 'string' ? ctx.sessionKey.trim() : '';
  const spawnedVisible = childSessionKey
    ? (spawnedSessionAgentIds.get(childSessionKey)
      || (parsed.lane !== 'main' ? adoptPendingSpawnAgentForSession(childSessionKey, parsed.residentAgentId) : ''))
    : '';
  if (spawnedVisible) {
    return {
      agentId: spawnedVisible,
      rawAgentId: rawSessionAgentId && rawSessionAgentId !== spawnedVisible ? rawSessionAgentId : undefined,
    };
  }
  const explicitCandidates = [
    ctx && ctx.agentId,
    ctx && ctx.agent && ctx.agent.id,
    ctx && ctx.agent && ctx.agent.agentId,
    ctx && ctx.session && ctx.session.agentId,
    ctx && ctx.residentAgentId,
  ];
  for (const candidate of explicitCandidates) {
    const visible = canonicalVisibleAgentId(candidate);
    if (visible) {
      const raw = typeof candidate === 'string' ? String(candidate).trim() : '';
      return { agentId: visible, rawAgentId: raw && raw !== visible ? raw : rawSessionAgentId !== visible ? rawSessionAgentId : undefined };
    }
  }
  const fallback = canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || 'main';
  return { agentId: fallback, rawAgentId: rawSessionAgentId && rawSessionAgentId !== fallback ? rawSessionAgentId : undefined };
}

// ─── Humanized work description (mirrors index.ts logic) ─────────────────────────────────

const TOOL_LABELS = {
  browser: "Check live page",
  web_fetch: "Check page",
  sessions_spawn: "Start helper task",
  exec: "Run command",
  read: "Review files",
  write: "Update files",
  edit: "Update files",
  image: "Inspect image",
  process: "Check process",
  summarize: "Summarize",
  weather: "Check weather",
  himalaya: "Handle email",
  message: "Prepare reply",
};

function genericToolLabel(toolName) {
  return TOOL_LABELS[String(toolName).trim()];
}

function humanizedWorkDescription(toolName, details) {
  const tn = String(toolName || 'tool').trim();

  if (tn === 'sessions_spawn') {
    const task = typeof details?.task === 'string' ? details.task.trim() : '';
    const label = typeof details?.label === 'string' ? details.label.trim() : '';
    const spawnId = typeof details?.spawnAgentId === 'string' ? details.spawnAgentId.trim() : '';
    if (task) {
      const preview = task.length > 80 ? task.slice(0, 80) + '…' : task;
      return `starting: ${preview}`;
    }
    if (label) return `starting ${label}`;
    if (spawnId) return `starting helper (${spawnId})`;
    return 'starting helper task';
  }

  if (tn === 'read') {
    const task = typeof details?.task === 'string' ? details.task.trim() : '';
    return task ? `reviewing: ${task}` : 'reviewing files';
  }
  if (tn === 'write') return 'updating files';
  if (tn === 'edit') return 'updating files';

  if (tn === 'browser' || tn === 'web_fetch') {
    const url = typeof details?.url === 'string' ? details.url.trim() : '';
    return url ? 'checking live page' : 'checking page';
  }

  const base = genericToolLabel(tn) || 'working';
  return base.toLowerCase();
}

function feedPreview(it) {
  // Always canonicalize agentId so internal descendant ids never leak into visible feed.
  const canonicalAgentId = it.agentId ? canonicalVisibleAgentId(it.agentId) || 'main' : '';
  const agent = canonicalAgentId ? `@${canonicalAgentId}` : '';
  const details = it.details || null;

  if (it.kind === 'before_agent_start') return `${agent} started`;
  if (it.kind === 'before_tool_call') {
    const tn = it.toolName || 'tool';
    const desc = humanizedWorkDescription(String(tn), details);
    return `${agent} ${desc}`.trim();
  }
  if (it.kind === 'after_tool_call') {
    const tn = it.toolName || 'tool';
    const desc = humanizedWorkDescription(String(tn), details).replace(/^starting:/, 'started:');
    const d = typeof it.durationMs === 'number' ? ` (${Math.round(it.durationMs)}ms)` : '';
    return `${agent} ${desc} done${d}`.trim();
  }
  if (it.kind === 'tool_result_persist') return `${agent} working`;
  if (it.kind === 'agent_end') {
    if (it.success === false) return `${agent} ended (error)`;
    return `${agent} ended`;
  }
  return it.kind;
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

// Simulate parent main session spawning qa_agent and coding_agent descendants.
rememberPendingSpawnAgent('agent:main:main', 'qa_agent');
const qaEarly = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:qa-123', agentId: 'main' });
const qaEarlyFollowup = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:qa-123', agentId: 'main' });
rememberSpawnedSessionAgent('agent:main:subagent:qa-123', consumePendingSpawnAgent('agent:main:main'));
rememberPendingSpawnAgent('agent:main:main', 'coding_agent');
rememberSpawnedSessionAgent('agent:main:subagent:code-456', consumePendingSpawnAgent('agent:main:main'));

// Identity resolution tests
const qa = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:qa-123', agentId: 'main' });
const coding = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:code-456' });
const main = resolveFeedAgentIdentity({ sessionKey: 'agent:main:main' });
const explicitQa = resolveFeedAgentIdentity({ sessionKey: 'agent:main:subagent:anything', agentId: 'qa_agent' });

assert.equal(qaEarly.agentId, 'qa_agent', 'early child hook should adopt pending qa_agent attribution before spawn result lands even if ctx.agentId still says main');
assert.equal(qaEarlyFollowup.agentId, 'qa_agent', 'subsequent child event should keep adopted qa_agent attribution before spawn result lands');
assert.equal(qa.agentId, 'qa_agent', 'qa_agent activity should stay attributed to qa_agent after spawn result lands');
assert.equal(coding.agentId, 'coding_agent', 'coding_agent activity should stay attributed to coding_agent');
assert.equal(main.agentId, 'main', 'main activity should stay attributed to main');
assert.equal(explicitQa.agentId, 'qa_agent', 'explicit actual agent should override resident lineage');
assert.ok(!/subagent|cron/i.test(qa.agentId), 'visible feed actor must not expose descendant/internal ids');
assert.ok(!/subagent|cron/i.test(coding.agentId), 'visible coding actor must not expose descendant/internal ids');
assert.equal(qa.rawAgentId, 'main/subagent:qa-123', 'raw/debug path may retain internal lineage for debugging');
assert.equal(canonicalResidentAgentId('agent:main:subagent:qa-123'), 'main', 'resident roster still collapses descendants to resident owner');
assert.equal(canonicalVisibleAgentId('main/subagent:qa-123'), 'main', 'unmapped descendant lineage alone still normalizes to resident owner');

// ─── feedPreview humanization tests ─────────────────────────────────────────────────

const RAW_SHELL_RE = /\$\{.*?\}|`.*?`|\bexec\b.*\bcommand\b/i;
const INTERNAL_ID_RE = /main\/subagent:|subagent:|cron:/i;

function assertFeedOk(label, preview) {
  assert.ok(preview && preview.length > 0, `${label}: preview must not be empty`);
  assert.ok(!RAW_SHELL_RE.test(preview), `${label}: must not contain raw shell commands: ${preview}`);
  assert.ok(!INTERNAL_ID_RE.test(preview), `${label}: must not expose internal descendant ids: ${preview}`);
}

// 1. qa_agent activity → feed row shows qa_agent (not main)
const qaBeforeTool = { kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'browser', details: { url: 'https://example.com/results' } };
const qaPreview = feedPreview(qaBeforeTool);
assert.ok(qaPreview.startsWith('@qa_agent'), `qa_agent activity must show @qa_agent prefix: ${qaPreview}`);
assertFeedOk('qa_agent tool', qaPreview);
assert.ok(/checking/.test(qaPreview), `qa_agent browser call should say 'checking': ${qaPreview}`);

// qa_agent sessions_spawn → shows the task
const qaSpawn = { kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'sessions_spawn', details: { task: 'run final acceptance checks', spawnAgentId: 'qa_agent' } };
const qaSpawnPreview = feedPreview(qaSpawn);
assert.ok(qaSpawnPreview.startsWith('@qa_agent'), `qa_agent spawn must show @qa_agent: ${qaSpawnPreview}`);
assert.ok(/starting:/.test(qaSpawnPreview), `qa_agent spawn should show 'starting:' with task: ${qaSpawnPreview}`);
assert.ok(!/subagent/i.test(qaSpawnPreview), `qa_agent spawn must not show 'subagent': ${qaSpawnPreview}`);
assertFeedOk('qa_agent spawn', qaSpawnPreview);

// 2. coding_agent activity → feed row shows coding_agent (not main)
const codingBeforeTool = { kind: 'before_tool_call', agentId: 'coding_agent', toolName: 'read', details: { task: 'index.ts for refactoring plan' } };
const codingPreview = feedPreview(codingBeforeTool);
assert.ok(codingPreview.startsWith('@coding_agent'), `coding_agent activity must show @coding_agent prefix: ${codingPreview}`);
assertFeedOk('coding_agent tool', codingPreview);
assert.ok(/reviewing/.test(codingPreview), `coding_agent read should say 'reviewing': ${codingPreview}`);

// coding_agent sessions_spawn
const codingSpawn = { kind: 'before_tool_call', agentId: 'coding_agent', toolName: 'sessions_spawn', details: { task: 'implement feature X', spawnAgentId: 'coding_agent' } };
const codingSpawnPreview = feedPreview(codingSpawn);
assert.ok(codingSpawnPreview.startsWith('@coding_agent'), `coding_agent spawn must show @coding_agent: ${codingSpawnPreview}`);
assert.ok(/starting:/.test(codingSpawnPreview), `coding_agent spawn should show 'starting:' with task: ${codingSpawnPreview}`);
assertFeedOk('coding_agent spawn', codingSpawnPreview);

// 3. main activity → feed row shows main
const mainBeforeTool = { kind: 'before_tool_call', agentId: 'main', toolName: 'write', details: { task: 'update config' } };
const mainPreview = feedPreview(mainBeforeTool);
assert.ok(mainPreview.startsWith('@main'), `main activity must show @main prefix: ${mainPreview}`);
assert.ok(/updating/.test(mainPreview), `main write should say 'updating': ${mainPreview}`);
assertFeedOk('main tool', mainPreview);

// 4. feed row must not contain raw shell commands
const execTool = { kind: 'before_tool_call', agentId: 'qa_agent', toolName: 'exec', details: { command: 'npm test -- --coverage' } };
const execPreview = feedPreview(execTool);
assertFeedOk('exec tool (no raw command)', execPreview);
assert.ok(!/npm test/.test(execPreview), `exec preview must not expose raw command: ${execPreview}`);

// 5. internal descendant ids must not appear in visible feed
// FeedItems should always have canonical agentId (from resolveFeedAgentIdentity),
// but canonicalization in feedPreview guards against any leakage.
const badItem = { kind: 'before_tool_call', agentId: 'main/subagent:qa-123', toolName: 'read', details: {} };
const badPreview = feedPreview(badItem);
// canonicalVisibleAgentId('main/subagent:qa-123') → 'main', so it shows @main not @main/subagent:qa-123
assert.ok(!/subagent/.test(badPreview), `internal id must not appear in preview: ${badPreview}`);
assert.ok(badPreview.startsWith('@main'), `internal id should canonicalize to @main: ${badPreview}`);

// 6. after_tool_call humanization
const afterQaTool = { kind: 'after_tool_call', agentId: 'qa_agent', toolName: 'browser', durationMs: 1234, details: {} };
const afterQaPreview = feedPreview(afterQaTool);
assert.ok(afterQaPreview.startsWith('@qa_agent'), `after_tool_call must show correct agent: ${afterQaPreview}`);
assert.ok(/done/.test(afterQaPreview), `after_tool_call should say 'done': ${afterQaPreview}`);
assert.ok(/1234ms/.test(afterQaPreview), `after_tool_call should show duration: ${afterQaPreview}`);
assertFeedOk('after_tool_call', afterQaPreview);

// 7. agent_end
const qaEnd = { kind: 'agent_end', agentId: 'qa_agent', success: true };
const qaEndPreview = feedPreview(qaEnd);
assert.equal(qaEndPreview, '@qa_agent ended', `agent_end: ${qaEndPreview}`);

const qaEndError = { kind: 'agent_end', agentId: 'qa_agent', success: false };
const qaEndErrorPreview = feedPreview(qaEndError);
assert.equal(qaEndErrorPreview, '@qa_agent ended (error)', `agent_end error: ${qaEndErrorPreview}`);

console.log('feed-agent-attribution smoke: ALL PASSED');
