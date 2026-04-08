# Agent Workflow Guardrails

Immediate execution rules for multi-step work.

## 1. Do first, then report
- Do not say “已派/已同步/已重載/已測” unless the matching tool/action has already completed.
- Prefer result-style updates over intent-style updates.

## 2. Mandatory checkpoint format for multi-step work
Use this structure when reporting progress:
- 已做：<completed step>
- 進行中：<current step>
- 下一步：<next step>
- 待確認：<only if approval is actually needed>

## 3. After gateway-affecting actions, mandatory follow-up
For gateway reload/restart/signal actions, always do in order:
1. verify live/local behavior
2. re-dispatch any interrupted subagent/QA work if needed
3. send a user checkpoint update

## 4. No promise without action
- Do not say “我現在去派/我先去做” unless the tool call follows immediately in the same turn.
- If the action is not yet executed, say only what is actually true.

## 5. Subagent visibility rule
When user is watching frontend behavior, do not claim a subagent was started unless `sessions_spawn` has succeeded.
When useful, include the actual label in the update.

## 6. Service-action wording rule
Differentiate clearly:
- gateway reload (signal-based reload)
- gateway restart (full service restart)
Never blur them in user updates.

## 7. Completion rule
If user authorized: “do it all and report back”, then complete the full chain yourself when safe:
- modify
- sync
- reload/restart if already approved
- verify
- QA if promised/needed
- report
Do not stop at an intermediate checkpoint unless blocked.
