# Lobster Room 🦞

A “Lobster Room” dashboard that visualizes OpenClaw **resident agents** as lobsters
in a bird’s-eye room view, with status bubbles (replying / thinking / tool / idle / error).

This repo is **plugin-only**: Lobster Room is served directly by the OpenClaw
Gateway under `/lobster-room/`.

- Portal: `https://<openclaw-host>/lobster-room/`
- API: `https://<openclaw-host>/lobster-room/api/lobster-room`

## Install (one line)

```bash
curl -fsSL https://raw.githubusercontent.com/zacmoltbot/lobster-room/main/plugin/lobster-room/install.sh | bash
```

The installer will attempt `openclaw gateway restart`.

If it cannot restart the gateway in your environment (common in hosted
containers), restart the Gateway service/container manually.

## Verify

- `https://<openclaw-host>/lobster-room/`
- `https://<openclaw-host>/lobster-room/api/lobster-room`

## How status works (truth + evidence)

This project monitors OpenClaw **in-process** via plugin lifecycle hooks.

- `thinking` comes from: `before_agent_start`
- `tool` comes from: `before_tool_call` (with `toolName`)
- Tool completion is inferred from: `tool_result_persist` and/or `after_tool_call`
- `idle` is entered after a short cooldown, and watchdogs prevent “stuck” states

### Replying

On OpenClaw `2026.2.2`, outbound message hooks (`message_sending/message_sent`)
are not wired in core, so `replying` is currently **synthetic**:

- When `agent_end.success=true`, we briefly show `replying` so the UI matches
  user-perceived behavior.

(Next step is a core PR to wire outbound send hooks so `replying` becomes real.)

## Debug

The API includes a ring buffer of recent hook events:

- `agents[0].debug.decision.recentEvents[]`

Each entry includes:

- `ts` (ms timestamp)
- `kind` (hook name)
- `agentId` (derived from `sessionKey` when available)
- `data` (best-effort; e.g. `toolName`, and for `exec` we include the command)

## License / Attribution

- Original project: `mudrii/openclaw-dashboard` (MIT License)
- This fork: still MIT (see `LICENSE`)
