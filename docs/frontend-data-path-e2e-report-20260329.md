# Lobster Room front-end data path E2E report — 2026-03-29

## Scope

Goal: prove the full user-facing path for the symptom cluster:

- child row exists
- actor stays `unknown`
- room / Now look idle or stale
- frontend cannot honestly reflect what the spawned agent is doing

This report treats the fix as a **front-end-facing data path problem**, not a single-function replay.

---

## 1) Front-end data path map

### A. Feed panel (`feedGet`)

Frontend caller:
- `plugin/lobster-room/assets/lobster-room.app.js`
- `feedPoll()` POSTs `./api/lobster-room` with:
  - `op: "feedGet"`
  - `limit`
  - `agentId`
  - `includeRaw`
  - `version: 3`

Backend route:
- `plugin/lobster-room/index.ts`
- multiplexed `/lobster-room/api/lobster-room` route, `op === "feedGet"`

Backend source chain:
1. hook events write into `feedBuf`
   - `before_agent_start`
   - `before_tool_call`
   - `after_tool_call`
   - `tool_result_persist`
   - `message_*`
2. `feedGet` reads `feedBuf`
3. `groupFeedIntoTasks(items)` groups rows by `sessionKey`
4. `resolveVisibleFeedItemAgentId()` decides the visible actor for rows/tasks/latest
5. `sanitizeFeedItemForApi()` shapes API fields returned to frontend

Frontend fields consumed:
- `data.rows[]`
- `data.tasks[]`
- `data.latest`
- displayed fields include `agentId`, `kind`, `toolName`, `details`, `preview`

### B. Room map + Now (`room/current-truth` payload)

Frontend caller:
- room polling path updates `MODEL.agents`
- `assets/lobster-room.app.js` renders:
  - room lobsters from `MODEL.agents`
  - Now panel from `MODEL.agents[*].state` and `debug.decision`

Backend route:
- `plugin/lobster-room/index.ts`
- `/lobster-room/api/lobster-room` room/current-truth builder

Backend source chain:
1. hook snapshot state (`setState`, snapshot disk)
2. `sessions_list` for fresh sessions
3. visible session bucketing via `resolveVisibleSessionBucket()` / `skToAgentId()`
4. latest visible feed lane via `latestVisibleFeedItemForAgent()`
5. recent actor-scoped events via `recentVisibleEventsForAgent()`
6. current-truth decision block emits `agentsPayload[]`

Frontend fields consumed:
- `agents[].id`
- `agents[].state`
- `agents[].meta`
- `agents[].debug.decision.details`
- `agents[].debug.decision.recentEvents`

### C. Child actor attribution path

For spawned child sessions, visible actor attribution flows through these nodes:

1. **raw parent hook**
   - `before_tool_call` on `sessions_spawn`
   - `rememberPendingSpawnAttribution(parentSessionKey, payload)`
2. **pending/observed state**
   - `pendingSpawnAttributionsByParent`
   - `pendingSpawnAttributionsByResident`
   - `observedChildSessions`
3. **canonical bind**
   - `adoptPendingSpawnAttributionForSession(childSessionKey, ctx)`
   - writes `spawnedSessionAgentIds[childSessionKey] = actorId`
4. **feed shaping**
   - `resolveFeedAgentIdentity()` writes rows into `feedBuf`
   - `resolveVisibleFeedItemAgentId()` maps child rows to visible actor for `feedGet`
5. **room/current-truth consumption**
   - `resolveVisibleSessionBucket()` must bucket the same child session under the same visible actor
   - `latestVisibleFeedItemForAgent()` and `recentVisibleEventsForAgent()` must see the same actor namespace
6. **frontend rendering**
   - feed rows/tasks/latest use `agentId`
   - room / Now use `agents[].state` + `debug.decision`

---

## 2) Exact live-style simulation

Added test:
- `tests/frontend-data-path-e2e-room-feed-simulation.js`

What it replays:
1. parent `sessions_spawn` hook exists
2. child session exists with subagent lane
3. parent pending attribution is inferred as `qa_agent`
4. child is observed before adoption
5. child emits feed-visible rows (`before_agent_start`, `before_tool_call`, `after_tool_call`)
6. frontend-facing outputs are sampled from:
   - `feedGet`
   - room/current-truth payload logic

The test contains **two modes in one fixture**:

### `buggy`
- writer-side state reload clears in-memory pending/observed state every time
- canonical spawned binding never sticks
- result:
  - feed row exists
  - feed actor is `unknown`
  - task actor is `unknown`
  - latest actor is `unknown`
  - room/current-truth for `qa_agent` becomes `idle`

### `fixed`
- state hydration only clears once, then merges
- adoption persists into `spawnedSessionAgentIds`
- same fixture now yields:
  - rows/tasks/latest all attribute `qa_agent`
  - room/current-truth for `qa_agent` becomes active (`thinking`, source=`feed`)
  - recent events are actor-scoped to `qa_agent`

---

## 3) Proven breakpoint

### Not the breakpoint

The new E2E fixture proves these layers already had the needed signal:

- raw/hook capture had the actor hint (`pending.actorId = qa_agent`)
- observed child state also had the actor hint before adoption

So the failure was **not** caused by missing raw hook capture.

### Actual breakpoint

The real break was **writer-side state retention / hydration semantics**:

- in buggy behavior, reload clears `pending*` + `observedChildSessions` + `spawnedSessionAgentIds` on each load
- at the race point, disk is still empty
- child adoption therefore loses the pending attribution even though raw capture already had it
- downstream effects:
  - `feedGet` can only render the child as `unknown`
  - room/current-truth cannot bucket the child session into the visible actor lane
  - frontend Now/room collapses to idle or stale

This is the single layer that explains both:
- `unknown` child feed rows
- room / Now idle

---

## 4) Fix layer

Fix layer: **writer-side state retention**, specifically the spawn-attribution hydration / merge behavior in `plugin/lobster-room/index.ts`.

Relevant functions in the live plugin:
- `loadSpawnAttributionState()`
- `mergePendingSpawnAttribution()`
- `adoptPendingSpawnAttributionForSession()`
- `rememberSpawnedSessionAgent()`

The new E2E fixture is written to prove that once canonical child binding survives hydration, the existing feed shaping and current-truth consumption become consistent.

---

## 5) Validation chain

The new fixture explicitly verifies, in order:

1. **raw/hook has data**
   - pending attribution says `qa_agent`
2. **canonical state correct**
   - fixed mode persists `spawnedSessionAgentIds[childSessionKey] = qa_agent`
3. **`feedGet` correct**
   - rows/tasks/latest all resolve to `qa_agent`
4. **room/current-truth correct**
   - `qa_agent` activity is non-idle
   - source is `feed`
   - session bucket contains the child session
5. **frontend would see the same story**
   - feed panel and Now/room read the same actor namespace and no longer disagree

---

## 6) Why confidence is higher this time

Because this is not an isolated helper-function replay.

The new test drives the exact user-facing chain:
- hook/raw
- canonical retention
- feedGet
- room/current-truth
- frontend-consumed fields

And it keeps a **buggy vs fixed A/B inside the same scenario**, so the failing symptom and the repaired result are both visible from one fixture.
