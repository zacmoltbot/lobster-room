# Lobster Room critical root-cause report (2026-03-28)

## Preflight
- `pwd`: `/home/node/.openclaw/workspace-coding-agent/lobster-room`
- `git rev-parse --show-toplevel`: `/home/node/.openclaw/workspace-coding-agent/lobster-room`
- `git branch --show-current`: `feature/v0.3.0-feed-ux`
- `git status --short`: clean

## Scope
Live critical symptoms analyzed together:
1. child session visible actor often shows as `main`
2. feed keeps moving, but Now / room stay idle
3. `@qa_agent` filter collapses to helper-task wording and loses real work story
4. local tests passed while live QA still failed

## Single-truth conclusion
This is not four independent bugs. It is one pipeline inconsistency expressed in four places:

- **Actor attribution** was still able to collapse child-session events back to resident `main` when live ordering / isolate persistence raced.
- **Current-truth bucketing** still grouped live sessions by resident agent rather than visible actor, so fresh child work could not satisfy the “fresh session exists” gate for `qa_agent` / `coding_agent`.
- **Story derivation** still allowed cross-actor helper-start events to dominate recent activity labels, so the UI showed the helper-task opener instead of the actual child work.
- **Tests** mostly validated local pure-function happy paths, but did not model the live ordering gap: child hooks arriving before spawned attribution is available to the route that later computes feed / room truth.

## Failure matrix

### Symptom 1 — child session visible actor shown as `main`
- Raw path:
  - hook ctx arrives with child `sessionKey` like `agent:main:subagent:<uuid>`
  - `parseSessionIdentity()` -> raw session agent becomes `main/subagent:<uuid>`
  - `resolveFeedAgentIdentity()` must translate that child session into visible actor `qa_agent` / `coding_agent`
- Relevant code:
  - `parseSessionIdentity()` (`plugin/lobster-room/index.ts:1281`)
  - `rememberPendingSpawnAttribution()` / `consumePendingSpawnAttribution()` / `adoptPendingSpawnAttributionForSession()` (`1496-1561`)
  - `resolveFeedAgentIdentity()` (`1593-1639`)
  - `sanitizeFeedItemForApi()` / `groupFeedIntoTasks()` (`1189-1231`)
- Data sources:
  - parent `sessions_spawn` params (`label` / `task` / explicit agent id)
  - child `sessionKey`
  - `spawnedSessionAgentIds`
  - on-disk `spawn-attribution-state.json`
- Fallback path that causes failure:
  - if no spawned attribution is found yet, `resolveFeedAgentIdentity()` falls back to `canonicalVisibleAgentId(rawSessionAgentId)` or resident agent -> `main`
- Resulting visible corruption:
  - `feedBuf[*].agentId = main`
  - then `rows[*].agentId`, `tasks[*].agentId`, `latest.agentId` all sanitize to `main`
- Observable matrix:
  - raw `sessionKey`: `agent:main:subagent:<uuid>`
  - raw `rawAgentId`: `main/subagent:<uuid>`
  - visible `agentId`: **incorrectly becomes `main`** if spawned attribution not available in time
  - room current truth: later sees only `main` feed truth
  - feed rows/tasks/latest: all inherit wrong actor
  - filter path: `@qa_agent` can no longer see those rows because they were mis-bucketed as `main`

### Symptom 2 — feed moving, but Now / room idle
- Raw path:
  - feed rows can already contain fresh `qa_agent` / `coding_agent` activity
  - room current truth API later recomputes “who is active” using sessions + snapshot + feed
- Relevant code:
  - `skToAgentId()` (`2730-2741`)
  - `latestVisibleFeedItemForAgent()` (`2775-2783`)
  - current-truth decision block (`2858-2893`)
- Data sources:
  - `sessions_list`
  - `session_status`
  - snapshot disk state
  - `feedBuf`
- Failure path:
  - old resident-based session bucketing attaches child session `agent:main:subagent:<uuid>` to `main`, not `qa_agent`
  - then `qa_agent` has **feedTruth** but **no freshSessions**
  - `activityNeedsFreshSession(thinking/tool/reply)` requires a fresh session for feed truth to be usable
  - result: `feedTruthUsable = false` -> activity collapses to idle
- Observable matrix:
  - raw `sessionKey`: child key is fresh
  - visible `agentId` in feed may already be correct in some cases
  - room current truth: still becomes `idle` because fresh session got bucketed under the wrong resident
  - feed rows: fresh and visible
  - Now: idle
  - filter path: may show rows but Now still says idle

### Symptom 3 — `@qa_agent` filter only shows helper-task opener, not real work story
- Raw path:
  - UI state text for Now / room / filter summary is derived from `details` + `recentEvents`
  - helper-start events (`sessions_spawn`) are emitted by `main`
  - real work events are emitted by child visible actor
- Relevant code:
  - server-side per-agent event selection `recentVisibleEventsForAgent()` (`2743-2754`, `2901`)
  - client wording functions `feedDetailTaskLabel()`, `feedInferRecentActivity()`, `feedHumanState()` (`2526-2647` in app.js)
- Data sources:
  - `recentEvents` carried in room payload
  - details from snapshot/feed truth
- Failure path:
  - if recent-events source is global / resident-mixed instead of actor-scoped, the latest event can be `main`’s `sessions_spawn`
  - wording falls back to `starting a helper task — ...`
  - actual qa work (`browser`, `read`, etc.) is present but loses the label race
- Observable matrix:
  - raw `sessionKey`: main session for helper-start + child session for real work
  - raw `rawAgentId`: main for helper start, child lineage for qa work
  - visible `agentId`: if mixed or normalized by resident, story becomes contaminated
  - room current truth / Now: wording says helper-task opener
  - feed rows: may still include true child rows, but UI summary label stays on helper-start
  - tasks/latest/filter path: summary/title may overfit the first helper-start event instead of actor-scoped actual work

### Symptom 4 — local tests PASS but live QA FAIL
- Existing tests that pass:
  - `tests/feed-live-failing-fixture-replay.js`
  - `tests/current-truth-p0.js`
  - `tests/feed-room-now-consistency-final-critical.js`
- Why live still failed previously:
  - older tests validated pieces in isolation after state was already aligned
  - they did not force the live race where:
    1. parent `sessions_spawn` records intent
    2. child `before_agent_start` fires in another isolate / timing window
    3. route-side state load does not yet contain spawned mapping
    4. fallback path silently normalizes child activity back to `main`
  - they also did not combine actor attribution + fresh-session bucketing + per-agent recent-events wording into one end-to-end scenario

## Truth pipeline map

### Child session pipeline
1. **Parent hook** — `before_tool_call` on `sessions_spawn`
   - source: main session
   - extracts intended child actor from explicit params or prompt text
   - stores pending attribution in memory + `spawn-attribution-state.json`

2. **Child hook arrival** — `before_agent_start` / `before_tool_call` / `after_tool_call`
   - source: child `sessionKey = agent:main:subagent:<uuid>`
   - `parseSessionIdentity()` produces raw lineage `main/subagent:<uuid>`
   - `resolveFeedAgentIdentity()` tries, in order:
     - existing `spawnedSessionAgentIds[childSessionKey]`
     - adopt pending attribution for this child session
     - explicit ctx agent ids
     - fallback to resident (`main`)
   - **This is the first layer that can still collapse child -> `main` if attribution is missing/racing**

3. **Snapshot writer**
   - `resolveSnapshotWriterAgentId()` writes snapshot only when identity is visible and safe
   - `setState()` persists `snap.agents[snapshotAgentId]`
   - if identity was already collapsed earlier, snapshot gets written under `main` or not written for the child visible actor

4. **Feed rows**
   - hooks call `pushFeed({ agentId, rawAgentId, sessionKey, ... })`
   - API later uses `sanitizeFeedItemForApi()`
   - visible `rows[*].agentId` is derived from stored feed item agentId
   - **If wrong at step 2, rows are permanently wrong for that event**

5. **Tasks**
   - `groupFeedIntoTasks()` groups by `sessionKey`
   - task actor becomes the first visible agent id inside that session
   - **If early items in that session were stored as `main`, whole task is labeled `main`**
   - task title/summary use the first meaningful `before_tool_call`; if that is helper-start, story wording also skews toward helper-task

6. **Latest**
   - `feedGet` picks most recent visible row (or raw fallback)
   - latest inherits the same wrong stored actor label

7. **Room current truth**
   - room API recomputes live truth from snapshot > feed > session_status
   - fresh sessions are bucketed via `skToAgentId()`
   - **This is the second layer that can still lose child work** if child session is bucketed under resident `main`, because `qa_agent` feed truth then fails the fresh-session requirement

8. **Now**
   - client renders per-agent lines from room payload
   - state text comes from `feedHumanState(state, toolName, details, recentEvents)`
   - **This is where work story is lost** if `recentEvents` is not actor-scoped

9. **Filter**
   - feed rows filter uses `row.agentId`
   - if rows were written as `main`, `@qa_agent` filter loses them entirely
   - even when rows survive, summary wording can still show helper-task opener if recent-events / title inference are cross-actor

## Live-vs-test gap analysis

### Gap 1 — isolate persistence / ordering race not modeled
Most earlier tests assumed `spawnedSessionAgentIds` or adopted pending attribution was already available by the time child hooks were resolved. Live behavior has a real race between:
- parent `sessions_spawn`
- child hook firing
- disk hydration of spawn-attribution state
- route-side read of state in another isolate

### Gap 2 — resident-vs-visible bucketing not modeled together with current-truth gate
Passing actor-attribution tests were not enough. Room/Now has a second gate:
- active feed truth (`thinking/tool/reply`) is only usable if that same visible actor also has a fresh session
- if sessions are bucketed by resident, UI still idles even when feed rows look correct

### Gap 3 — recent-event story contamination not modeled
Tests often validated row actor ids or isolated wording helpers, but not this exact live chain:
- main emits helper-start event
- child emits real work event
- summary/Now chooses latest recent event from a mixed pool
- UI text regresses to helper-task opener

### Gap 4 — route-level single-truth integration not asserted
Earlier tests let feed, tasks, latest, room, and Now be validated separately. Live QA sees all of them simultaneously, so a fix is only real if **all outputs agree on the same visible actor and same work story**.

## Proposed fix set (minimum-change, highest leverage)

### P0 — lock actor attribution at the earliest hook boundary
Must all move together:
- keep `resolveFeedAgentIdentity()` using child-session adoption before any resident fallback
- persist adopted mapping immediately to `spawnedSessionAgentIds` + disk
- preserve `rawAgentId` for debug, but never let visible API outputs derive actor from raw lineage

Why: this removes symptom 1 and prevents downstream corruption of rows/tasks/latest.

### P0 — use visible-actor session bucketing for current truth
Must all move together:
- `skToAgentId()` must consult `spawnedSessionAgentIds` first
- for non-main lanes, visible actor may differ from resident; bucket by visible actor
- current-truth freshness gate must evaluate against the same actor namespace feed uses

Why: this removes symptom 2 and aligns room/Now with feed.

### P0 — actor-scope recent events before generating human wording
Must all move together:
- server should only send per-agent `recentEvents`
- client wording helpers should prefer actor-scoped work events over generic helper-start events
- task/story inference must avoid letting a `main` helper-start overwrite the child’s actual work story

Why: this removes symptom 3 without requiring a large UI rewrite.

### P1 — add integrated liveish fixtures, not only unit checks
Needed tests:
1. **cold-start / race fixture**
   - parent spawn intent exists
   - child hook resolves before spawned-session map is hydrated
   - expected: rows/tasks/latest still attribute visible actor correctly via adopted pending attribution
2. **visible-session bucketing fixture**
   - feed has fresh `qa_agent` activity
   - child session is fresh but resident is `main`
   - expected: room current truth = active for `qa_agent`, not idle
3. **cross-actor story contamination fixture**
   - recent events include `main:sessions_spawn` after `qa_agent:browser`
   - expected: `qa_agent` Now/filter wording still says actual qa work, not helper-start
4. **single-truth end-to-end assertion**
   - assert same actor across raw feed rows, sanitized rows, tasks, latest, room current truth, and Now wording inputs

### P1 — add explicit invariants / instrumentation for future debugging
Small, safe additions only:
- include debug fields in route payloads when available:
  - `rawAgentId`
  - `currentTruthSource`
  - `feedTruthSessionKey`
  - whether session bucketing came from `spawnedSessionAgentIds` or resident fallback
- these should remain debug-only and not change user-facing UI logic

Why: next live QA failure will then show exactly which layer diverged.

## Minimal additions made in this pass
- Added report file:
  - `docs/root-cause-report-20260328.md`
  - purpose: single-truth root-cause map + coordinated fix plan for next coding round

## Evidence run in this pass
- `node tests/feed-live-failing-fixture-replay.js` -> PASS
- `node tests/current-truth-p0.js` -> PASS
- `node tests/feed-room-now-consistency-final-critical.js` -> PASS

## Interpretation of the passing tests
These passing tests indicate the repo already contains pieces of the intended fix logic, but the critical lesson is structural:
- actor attribution,
- current-truth bucketing,
- and story derivation
must be treated as one coupled pipeline.

If live QA still reports failures after these tests pass, the next suspect is not “same bug still unfixed” but **another live path that bypasses one of the three corrected layers**.
