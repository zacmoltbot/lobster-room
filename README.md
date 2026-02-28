# Lobster Room (OpenClaw)

Lobster Room is a small, hosted-friendly monitoring portal that "game-ifies" OpenClaw agent status: agents are shown as lobsters in a top-down office room.

This repo is a fork of `mudrii/openclaw-dashboard` (MIT) and has been heavily simplified to keep only the Lobster Room portal.

## What It Shows (v1)

- One "resident" lobster per configured OpenClaw Gateway (to avoid noisy session lists)
- Activity status inferred from the most recent session `updatedAt` timestamp:
  - Active window (default 10s) => 🧠 (thinking)
  - Otherwise => ⏳ (waiting)

## How It Works

- Backend polls each gateway every `pollSeconds` via the OpenClaw Gateway Tools Invoke HTTP API:
  - `POST {baseUrl}/tools/invoke` with `{ "tool": "sessions_list", "action": "json", "args": {} }`
- Tokens are never stored in this repo; they are read from environment variables.

## Deploy (Zeabur / Docker)

This repo ships with a Dockerfile.

Required env vars:

- `LOBSTER_ROOM_GATEWAYS_JSON`
  - Supports object or array format.
  - Object format example:

```json
{
  "pollSeconds": 5,
  "activeWindowMs": 10000,
  "gateways": [
    {
      "id": "zacbot",
      "label": "Zacbot",
      "baseUrl": "https://zacbot.zeabur.app",
      "tokenEnv": "OPENCLAW_GATEWAY_TOKEN"
    }
  ]
}
```

- One token env var per gateway, referenced by `tokenEnv`.
  - Example: `OPENCLAW_GATEWAY_TOKEN`

Optional env vars:

- `LOBSTER_ROOM_ACTIVE_WINDOW_MS` (default: 10000)
- `LOBSTER_ROOM_POLL_SECONDS` (default: 2)

Healthcheck:

- `GET /healthz` -> `ok`

API:

- `GET /api/lobster-room` -> aggregated JSON used by the portal

Portal:

- `GET /` -> Lobster Room

## License / Attribution

- Original project: `mudrii/openclaw-dashboard` (MIT License)
- This fork: still MIT (see `LICENSE`)
- Changes in this fork:
  - Removed the original multi-panel dashboard and local filesystem refresh pipeline
  - Added the Lobster Room portal UI and a minimal HTTP backend
  - Uses Gateway HTTP Tools Invoke API (`/tools/invoke`) for cross-host aggregation
