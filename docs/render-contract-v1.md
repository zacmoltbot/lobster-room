# Render Contract v1 — Lobster Room Now + Feed

Goal: show real agent activity truthfully, immediately, and in plain language. Prefer omission over fake certainty.

## 1) Now = current activity snapshot

Now is driven from the latest agent activity state, not from feed rows.

### Raw → Now
- `before_agent_start` → `thinking`
- `before_tool_call`
  - low-signal observation tools (`sessions_history`, `sessions_list`, `session_status`) → stay `thinking`
  - other tools → `tool`
- `after_tool_call` / `tool_result_persist`
  - low-signal observation tools → return toward `idle`
  - other tools → `thinking`
- `message_sending` → `reply`
- `message_sent` → `idle` on success, `error` on failure
- `agent_end` → short `reply` dwell then `idle` on success, `error` on failure

### Now wording priority
1. Explicit safe reply target / preview
2. Helper / scheduled task label
3. Tool-specific plain language (`exec`, `read`, `write`, `edit`, `browser`, `web_fetch`, `sessions_spawn`)
4. Recent real activity inferred from nearby events
5. Honest fallback: `Thinking`, `Replying`, `Working`, `Idle`, `Error`

## 2) Feed = recent meaningful timeline

Feed should represent meaningful recent activity, not every internal hook.

### Raw → Feed
- `presence`
  - show for meaningful state changes: `thinking`, `tool`, `reply`, `idle`, `error`
  - but only when wording is meaningful and not immediately duplicated by a stronger nearby row
- `before_tool_call` / `after_tool_call`
  - show only for human-meaningful tools: `browser`, `exec`, `read`, `write`, `edit`, `sessions_spawn`
- `message_sending` → show as reply-in-progress
- `message_sent` → show success / failure
- `before_agent_start` / `agent_end`
  - show only for helper tasks, scheduled tasks, labeled tasks, or failures

### Suppress from Feed
- `tool_result_persist`
- low-signal observation tools as standalone feed rows (`sessions_history`, `sessions_list`, `session_status`)
- generic unlabeled main-task boundaries (`Starting task`, `Task finished`)
- raw/internal ids, secrets, opaque refs, literal URLs
- heartbeat-only presence rows when they do not add meaning
- unknown raw events without a safe human translation

## 3) Wording rules
- Prefer concrete plain language over raw tool/event names.
- If safe target/preview exists, include it.
- If a task label is specific and safe, include it.
- If not safely translatable, use a neutral fallback; do not guess intent.
- Completion wording should say what finished, not restate internal mechanics.

## 4) Conservative dedupe / aggregation
- Never merge across errors.
- Never merge away `message_sent`.
- Short identical-row dedupe is allowed.
- Short-window aggregation is allowed only within the same agent/task and only when the newer row is at least as meaningful as the older one.
- Prefer the strongest nearby row:
  - explicit reply/tool row beats generic presence
  - meaningful presence beats idle
  - failure beats success/neutral

## 5) Special-case rules
- Reply:
  - Now: `Replying to X — "preview"` when safe
  - Feed: show `message_sending` and `message_sent`
- Command (`exec`):
  - Now: describe intent in plain language when recognizable; else `Running a command`
  - Feed: show start + completion if meaningful
- Helper task (`sessions_spawn` / spawned session):
  - Now: `Working on helper task — label`
  - Feed: show helper start/end when label/context exists; child activity may appear
- Scheduled task:
  - Now: `Running scheduled task — label`
  - Feed: show scheduled start/end when detectable
- Thinking:
  - Now: show task label or recent meaningful activity; else `Thinking`
  - Feed: only when it conveys real context, not empty churn
- Idle:
  - Now: `Idle`
  - Feed: only as a meaningful transition, not as spam

## 6) Minimal implementation steps
1. Keep this contract as the single source of truth for expected behavior.
2. Extract shared classification helpers for `Now` and `Feed` so frontend/backend stop drifting.
3. Centralize allow/suppress lists for feed-visible tool/event types.
4. Keep tool-specific wording tables small and explicit.
5. Add snapshot/feed fixtures for: reply, exec, helper, scheduled, thinking fallback, idle, failure.

## 7) Safe first implementation in this branch
- Suppressed generic unlabeled task boundary rows from Feed.
- Kept helper/scheduled/labeled/failure boundaries visible.
