# Lobster Room 🦞

A “Lobster Room” dashboard that visualizes OpenClaw **resident agents** as lobsters
in a bird’s-eye room view, with status bubbles (replying / thinking / tool / idle / error).

This repo is **plugin-only**: Lobster Room is served directly by the OpenClaw
Gateway under `/lobster-room/`.

![Lobster Room main view](docs/screenshots/main-view.png)

- Portal: `https://<openclaw-host>/lobster-room/`
- API: `https://<openclaw-host>/lobster-room/api/lobster-room`

## Install / Update (one line)

### Ensure the plugin is enabled

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

```bash
curl -fsSL https://raw.githubusercontent.com/zacmoltbot/lobster-room/main/plugin/lobster-room/install.sh | bash
```

The installer:
- Installs into `~/.openclaw/extensions/lobster-room/`
- Copies the portal HTML to `~/.openclaw/extensions/lobster-room/assets/lobster-room.html`
- Seeds a **Default room** (background + manual walkable map) so the UI is usable immediately
- Attempts `openclaw gateway restart` (best-effort)

If restart fails (common in hosted containers without systemd), restart the **Gateway service/container** manually.

## Verify

- `https://<openclaw-host>/lobster-room/`
- `https://<openclaw-host>/lobster-room/api/lobster-room`

If you see the OpenClaw Control UI instead of Lobster Room, the plugin is not loaded/enabled.

### Important: updates require a Gateway restart

This is an OpenClaw **plugin**. After updating, you must restart/redeploy the OpenClaw Gateway so it reloads plugin assets. A browser refresh (even incognito) cannot pick up a new build unless the server is updated.

### UI version stamp

Open the Move Debug panel (Settings → *Show Move Debug panel*) and check the `ui=<hash>` stamp. It’s the fastest way to confirm which frontend build is being served.

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

### After uploading a new room background

After a successful upload, Settings stays open and the UI prompts you to paint the manual walkable map for the new room.

## License / Attribution

- Original project: `mudrii/openclaw-dashboard` (MIT License)
- This fork: still MIT (see `LICENSE`)
