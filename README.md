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

## Deploy (hosted) and Install (same host as OpenClaw)

This repo ships with a Dockerfile for hosted deployments, and also includes a
"skill-style" installer to run Lobster Room on the *same host* as OpenClaw and
mount it under the same domain:

- `https://<openclaw-host>/lobster-room`

### Option 1: Hosted (Docker platform)

Set env vars (tokens via env only):

- `LOBSTER_ROOM_GATEWAYS_JSON` (object or array format)
- token env vars referenced by `tokenEnv` (e.g. `OPENCLAW_GATEWAY_TOKEN`)

Object format example:

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

Optional env vars:

- `LOBSTER_ROOM_ACTIVE_WINDOW_MS` (default: 10000)
- `LOBSTER_ROOM_POLL_SECONDS` (default: 2)
- `LOBSTER_ROOM_TOOL_TTL_MS` (default: 8000)
- `LOBSTER_ROOM_CACHE_TTL_MS` (default: 5000)
- `LOBSTER_ROOM_DEBUG` (default: 0)

Healthcheck:

- `GET /healthz` -> `ok`

API:

- `GET /api/lobster-room`

### Option 2: Same host as OpenClaw (recommended for "one URL")

#### 2.0 Plugin install (recommended)

This is the most "native" experience: Lobster Room is served directly by the
OpenClaw Gateway under:

- `https://<openclaw-host>/lobster-room/`

Install (shared on the machine):

```bash
curl -fsSL https://raw.githubusercontent.com/zacmoltbot/lobster-room/main/plugin/lobster-room/install.sh | bash
```

The installer will **try** to run `openclaw gateway restart`. If it fails,
restart the gateway manually, then verify:

- `https://<openclaw-host>/lobster-room/`
- `https://<openclaw-host>/lobster-room/api/lobster-room`

Notes:

- The plugin calls `POST /tools/invoke` internally via loopback, so you must set
  `OPENCLAW_GATEWAY_TOKEN` (or `gateway.auth.token`) on the gateway.

#### 2.1 Fallback: systemd / docker install

This repo also contains fallback install assets under:

- `skill/lobster-room/`

#### 2A) systemd install

On your OpenClaw host (Linux):

**One-line install (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/zacmoltbot/lobster-room/main/skill/lobster-room/install.sh | sudo bash
```

Or, from the repo directory:

```bash
sudo ./skill/lobster-room/systemd/install-systemd.sh
```

This starts Lobster Room on:

- `http://127.0.0.1:18080/`

Environment example:

- `skill/lobster-room/examples/default.env` -> `/etc/default/lobster-room`

Quick self-check (before proxy):

```bash
curl -fsS http://127.0.0.1:18080/healthz && echo
curl -fsS http://127.0.0.1:18080/api/lobster-room | head
```

After proxy, verify:

- `https://<openclaw-host>/lobster-room/`
- `https://<openclaw-host>/lobster-room/api/lobster-room`

Then mount it under your OpenClaw domain using a reverse proxy.

**Important (path mounting):** serve it at **`/lobster-room/` (with trailing slash)**.
The proxy templates include a redirect from `/lobster-room` -> `/lobster-room/` so
relative URLs (like `./api/...`) work correctly.

Templates:

- Nginx: `skill/lobster-room/proxy/nginx.conf`
- Caddy: `skill/lobster-room/proxy/Caddyfile`

#### 2B) docker compose install

Use:

- `skill/lobster-room/docker/docker-compose.yml`
- env example: `skill/lobster-room/docker/.env.example`

Bind is localhost-only by default (`127.0.0.1:18080`) for safety; use a reverse
proxy to expose `/lobster-room`.

## License / Attribution

- Original project: `mudrii/openclaw-dashboard` (MIT License)
- This fork: still MIT (see `LICENSE`)
- Changes in this fork:
  - Removed the original multi-panel dashboard and local filesystem refresh pipeline
  - Added the Lobster Room portal UI and a minimal HTTP backend
  - Uses Gateway HTTP Tools Invoke API (`/tools/invoke`) for cross-host aggregation
