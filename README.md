# Lobster Room 🦞

A cute, practical dashboard that visualizes your OpenClaw **agents & sessions** as lobsters in a bird’s‑eye room view, with live status bubbles (replying / thinking / tool / idle / error).

> Served as an **OpenClaw Gateway plugin** at: `https://<openclaw-host>/lobster-room/`

![Demo (animated)](docs/screenshots/demo.gif)

**Links**
- Portal: `https://<openclaw-host>/lobster-room/`
- API: `https://<openclaw-host>/lobster-room/api/lobster-room`

## Install / Update

### Option A (recommended): Install via “OpenClaw prompt”

Copy/paste this into your OpenClaw agent:

> Please install (or update) the `zacmoltbot/lobster-room` OpenClaw Gateway plugin for me.
>
> Do the following and tell me what you changed:
> 1) Install the plugin by running: `bash -c "$(curl -fsSL https://raw.githubusercontent.com/zacmoltbot/lobster-room/main/plugin/lobster-room/install.sh)"`.
> 2) Ensure `~/.openclaw/openclaw.json` enables plugin id `lobster-room`.
> 3) Restart the OpenClaw Gateway (if you cannot restart it, tell me exactly what I should restart).
> 4) Verify `https://<openclaw-host>/lobster-room/`.
>
> Optional: if I ask for a pinned install, use `VERSION=vX.Y.Z` when running the installer.

### Option B: Manual install (advanced)

#### 1) Install (latest release)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/zacmoltbot/lobster-room/main/plugin/lobster-room/install.sh)"
```

#### 2) Enable the plugin

In `~/.openclaw/openclaw.json`, enable the plugin:

```json
{
  "plugins": {
    "entries": {
      "lobster-room": { "enabled": true }
    }
  }
}
```

#### 3) Restart OpenClaw Gateway

This is an OpenClaw **plugin**. After installing/updating, you must restart/redeploy the OpenClaw Gateway so it reloads plugin assets.

> Note on ordering: enabling and installing can be done in either order; what matters is that **both are done before the Gateway restart**.

### Security + exposure notes

- This is an **OpenClaw Gateway plugin**. Anyone who can access your OpenClaw HTTP endpoint can potentially access this dashboard/API.
- **Do not expose OpenClaw (and thus `/lobster-room/`) to the public internet** without an auth layer (VPN / reverse proxy auth / private network).
- Prefer pinned versions (a release tag) instead of installing from `main`.

## Verify

- `https://<openclaw-host>/lobster-room/`
- `https://<openclaw-host>/lobster-room/api/lobster-room`

If you see the OpenClaw Control UI instead of Lobster Room, the plugin is not loaded/enabled.

### Important: updates require a Gateway restart

This is an OpenClaw **plugin**. After updating, you must restart/redeploy the OpenClaw Gateway so it reloads plugin assets. A browser refresh (even incognito) cannot pick up a new build unless the server is updated.

(Install section already mentions this; repeating here for emphasis.)

### UI version stamp

Open the Move Debug panel (Settings → *Show Move Debug panel*) and check the `ui=<hash>` stamp. It’s the fastest way to confirm which frontend build is being served.

## How status works (truth + evidence)

This project monitors OpenClaw **in-process** via plugin lifecycle hooks.

- `thinking` comes from: `before_agent_start`
- `tool` comes from: `before_tool_call` (with `toolName`)
- Tool completion is inferred from: `tool_result_persist` and/or `after_tool_call`
- `idle` is entered after a short cooldown, and watchdogs prevent “stuck” states

### Replying

`replying` is driven by outbound message hooks (`message_sending` / `message_sent`) **when available**.

Some OpenClaw builds/environments may not emit these hooks; in that case we fall back to a **synthetic** `replying` blip on successful `agent_end` so the UI matches user-perceived behavior.

Privacy note: by default we **do not** store outbound message previews in debug traces. If you really need that for debugging, set plugin config `debugCaptureMessagePreview=true`.

## Settings (features)

Lobster Room ships with a small Settings UI so you can tweak behavior without redeploying.

### Agent names (agentId → display name)

- Edit in Settings → **Agent names**
- Stored server-side (not just localStorage)

### Rooms (background + manual walkable map)

- Settings → **Room**
- Create/switch rooms
- Upload a background image
- Reset back to Default room

### Manual map editor

- Settings → **Room** → open the editor
- Paint/erase the walkable area used for roaming
- Includes a **Validate map** action (useful to spot disconnected islands)

### HUD / debug

- **Move Debug panel** (HUD + log) for screenshots and collaboration
- Options like **Freeze roaming** (only move on zone change)
- Optional overlays/debug toggles

### Background opacity

- Slider to adjust background visibility

## Debug

### Move Debug panel

The Move Debug panel is **hidden by default**. Enable it in Settings when needed.

### Activity traces

The backend exposes a small ring buffer of recent events per agent in:

- `agents[].debug.decision.recentEvents[]`

Each entry includes:

- `ts` (ms timestamp)
- `kind` (hook name)
- `agentId` (derived from `sessionKey` when available)
- `data` (best-effort; e.g. `toolName`, and for `exec` we include the command)

### Message Feed (new)

The UI includes a **Message Feed** panel (📰 Feed) that shows a scrollable list of recent runtime events (agent start/end, tool calls, outbound message send events).

API endpoints:

- `GET /lobster-room/api/feed?limit=120&agentId=...&kind=...`
- `POST /lobster-room/api/feed/summarize` (optional; requires LLM config)

### After uploading a new room background

After a successful upload, Settings stays open and the UI prompts you to paint the manual walkable map for the new room.

## License / Attribution

- Original project: `mudrii/openclaw-dashboard` (MIT License)
- This fork: still MIT (see `LICENSE`)
