import type { IncomingMessage, ServerResponse } from "node:http";

type PluginApi = {
  id: string;
  config: any;
  logger: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
  registerHttpRoute: (params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }) => void;
  on: (hookName: string, handler: (event: any, ctx: any) => any, opts?: { priority?: number }) => void;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

type ActivityState = "idle" | "thinking" | "tool" | "reply" | "error";

type AgentActivity = {
  agentId: string;
  state: ActivityState;
  sinceMs: number;
  lastEventMs: number;
  details?: Record<string, unknown> | null;
  seq: number; // monotonic to guard async timers
  holdUntilMs?: number; // min-dwell for non-idle states
};

function nowMs() {
  return Date.now();
}

function readRequestUrl(req: IncomingMessage): URL {
  // Respect reverse proxies when present.
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.headers.host;
  return new URL(req.url ?? "/", `${proto || "http"}://${host || "localhost"}`);
}

function resolveGatewayPort(cfg: any): number {
  const envRaw = (process.env.OPENCLAW_GATEWAY_PORT || process.env.CLAWDBOT_GATEWAY_PORT || "").trim();
  if (envRaw) {
    const n = Number.parseInt(envRaw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const configPort = cfg?.gateway?.port;
  if (typeof configPort === "number" && Number.isFinite(configPort) && configPort > 0) return configPort;
  return 18789;
}

function resolveGatewayToken(cfg: any): string | null {
  const envTok = (process.env.OPENCLAW_GATEWAY_TOKEN || "").trim();
  if (envTok) return envTok;
  const cfgTok = (cfg?.gateway?.auth?.token || "").trim();
  if (cfgTok) return cfgTok;
  return null;
}

async function toolsInvoke(params: {
  port: number;
  token: string;
  tool: string;
  args?: Record<string, unknown>;
  sessionKey?: string;
}): Promise<any> {
  const url = `http://127.0.0.1:${params.port}/tools/invoke`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tool: params.tool, args: params.args ?? {}, sessionKey: params.sessionKey }),
  });
  const txt = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(txt);
  } catch {
    json = { ok: false, error: { type: "invalid_json", message: txt.slice(0, 500) } };
  }
  if (!res.ok) {
    return { ok: false, error: { type: "http_error", status: res.status, body: json } };
  }
  return json;
}

function mapActivityToUiState(s: ActivityState): "think" | "wait" | "tool" | "reply" | "error" {
  if (s === "thinking") return "think";
  if (s === "idle") return "wait";
  return s;
}

export default {
  id: "lobster-room",
  async register(api: PluginApi) {
    // Resolve asset path relative to this plugin module (NOT the gateway cwd).
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const pluginDir = dirname(fileURLToPath(import.meta.url));
    const assetPath = `${pluginDir}/assets/lobster-room.html`;

    const cooldownMs = Number.parseInt((process.env.LOBSTER_ROOM_IDLE_COOLDOWN_MS || "1500").trim(), 10) || 1500;
    const minDwellMs = Number.parseInt((process.env.LOBSTER_ROOM_MIN_DWELL_MS || "900").trim(), 10) || 900;
    const staleMs = Number.parseInt((process.env.LOBSTER_ROOM_STALE_MS || "15000").trim(), 10) || 15000;
    const toolMaxMs = Number.parseInt((process.env.LOBSTER_ROOM_TOOL_MAX_MS || "12000").trim(), 10) || 12000;
    const pollSeconds = Number.parseInt((process.env.LOBSTER_ROOM_POLL_SECONDS || "1").trim(), 10) || 1;
    // Default to only showing the primary agent.
    process.env.LOBSTER_ROOM_AGENT_IDS = process.env.LOBSTER_ROOM_AGENT_IDS || "main";

    const activity = new Map<string, AgentActivity>();

    // Ring buffer of recent hook events for self-debug (no secrets; truncate content).
    const eventBuf: Array<{ ts: number; kind: string; agentId?: string; data?: any }> = [];
    const pushEvent = (kind: string, params: { agentId?: string; data?: any }) => {
      eventBuf.push({ ts: nowMs(), kind, agentId: params.agentId, data: params.data });
      if (eventBuf.length > 30) eventBuf.splice(0, eventBuf.length - 30);
    };

    const priority: Record<ActivityState, number> = {
      idle: 0,
      thinking: 1,
      reply: 2,
      tool: 3,
      error: 4,
    };

    const ensure = (agentId: string): AgentActivity => {
      const existing = activity.get(agentId);
      if (existing) return existing;
      const init: AgentActivity = {
        agentId,
        state: "idle",
        sinceMs: nowMs(),
        lastEventMs: nowMs(),
        details: null,
        seq: 0,
      };
      activity.set(agentId, init);
      return init;
    };

    const scheduleWatchdog = (agentId: string, seq: number) => {
      // Generic stale watchdog: if we stop receiving hooks, don't stick forever.
      setTimeout(() => {
        const cur = activity.get(agentId);
        if (!cur) return;
        if (cur.seq !== seq) return;
        const t = nowMs();
        if (t - cur.lastEventMs < staleMs) return;
        cur.state = "idle";
        cur.sinceMs = t;
        cur.lastEventMs = t;
        cur.details = { stale: true };
      }, staleMs + 50);

      // Tool-specific max duration: demote tool -> thinking -> (later) idle.
      setTimeout(() => {
        const cur = activity.get(agentId);
        if (!cur) return;
        if (cur.seq !== seq) return;
        if (cur.state !== "tool") return;
        const t = nowMs();
        // If tool hasn't progressed, demote.
        cur.state = "thinking";
        cur.sinceMs = t;
        cur.lastEventMs = t;
        cur.details = { ...(cur.details || {}), toolMax: true };
        setIdleWithCooldown(agentId);
      }, toolMaxMs);
    };

    const setState = (agentId: string, next: ActivityState, details?: Record<string, unknown> | null) => {
      const row = ensure(agentId);
      const t = nowMs();

      // Min-dwell: don't let fast transitions to idle hide states between polls.
      // Also enforce priority so high-signal states override lower ones.
      const curHold = row.holdUntilMs || 0;
      const inHold = t < curHold;
      const curP = priority[row.state];
      const nextP = priority[next];

      if (inHold && nextP < curP) {
        // Ignore downgrade during hold.
        return row.seq;
      }

      row.seq += 1;
      const seq = row.seq;
      row.lastEventMs = t;

      if (row.state !== next) {
        row.state = next;
        row.sinceMs = t;
      }

      if (next !== "idle") {
        row.holdUntilMs = t + minDwellMs;
      }

      row.details = details ?? row.details ?? null;
      scheduleWatchdog(agentId, seq);
      return seq;
    };

    const setIdleWithCooldown = (agentId: string) => {
      const row = ensure(agentId);
      const seq = row.seq + 1;
      row.seq = seq;
      const scheduledAt = nowMs();
      // Keep current state for a short cooldown to reduce UI flicker.
      setTimeout(() => {
        const cur = activity.get(agentId);
        if (!cur) return;
        if (cur.seq !== seq) return; // superseded
        const t = nowMs();
        cur.state = "idle";
        cur.sinceMs = t;
        cur.lastEventMs = t;
        cur.details = null;
      }, cooldownMs);
      // Update lastEvent so API knows something just happened.
      row.lastEventMs = scheduledAt;
    };

    // Hooks → real runtime state
    const resolveAgentId = (ctx: any): string => {
      const sk = typeof ctx?.sessionKey === "string" ? String(ctx.sessionKey) : "";
      // Prefer sessionKey: "agent:<agentId>:..." is canonical even when ctx.agentId is inconsistent.
      const m = sk.match(/^agent:([^:]+):/);
      if (m && m[1]) return m[1];
      const id = typeof ctx?.agentId === "string" ? String(ctx.agentId).trim() : "";
      return id || "main";
    };

    api.on("before_agent_start", (_event, ctx) => {
      const agentId = resolveAgentId(ctx);
      pushEvent("before_agent_start", { agentId, data: { sessionKey: ctx?.sessionKey, messageProvider: ctx?.messageProvider } });
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, messageProvider: ctx?.messageProvider });
    });

    api.on("before_tool_call", (event, ctx) => {
      const agentId = resolveAgentId(ctx);
      const toolName = event?.toolName || event?.tool || event?.name;

      // Capture high-value params for debugging (truncate aggressively).
      let toolData: any = { toolName, sessionKey: ctx?.sessionKey };
      if (toolName === "exec") {
        const cmd = (event?.params && (event.params.command || event.params.cmd || event.params.args)) || null;
        toolData.command = cmd;
      }

      pushEvent("before_tool_call", { agentId, data: toolData });
      setState(agentId, "tool", { toolName, sessionKey: ctx?.sessionKey });
    });

    api.on("after_tool_call", (event, ctx) => {
      const agentId = resolveAgentId(ctx);
      pushEvent("after_tool_call", { agentId, data: { toolName: event?.toolName, durationMs: event?.durationMs } });
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey });
    });

    // Some tools may not reliably fire after_tool_call in all paths; use persist as a backup.
    api.on("tool_result_persist", (event, ctx) => {
      const agentId = resolveAgentId(ctx);
      pushEvent("tool_result_persist", {
        agentId,
        data: { toolName: event?.toolName, toolCallId: event?.toolCallId, isSynthetic: event?.isSynthetic },
      });
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, persisted: true });
    });

    api.on("message_sending", (event, ctx) => {
      // Message hooks do not carry agentId in the event/ctx today.
      // In plugin UX we default to the primary agent (main), unless later we add routing.
      const agentId = "main";
      pushEvent("message_sending", {
        agentId,
        data: { to: event?.to, contentPreview: String(event?.content || "").slice(0, 80), channelId: ctx?.channelId },
      });
      setState(agentId, "reply", { to: event?.to, channelId: ctx?.channelId, conversationId: ctx?.conversationId });
    });

    api.on("message_sent", (event, ctx) => {
      const agentId = "main";
      pushEvent("message_sent", { agentId, data: { to: event?.to, success: event?.success, channelId: ctx?.channelId } });
      // Mark errors explicitly so UI can surface it.
      if (event?.success === false) {
        setState(agentId, "error", { error: event?.error || "message_sent failed", to: event?.to, channelId: ctx?.channelId });
      }
      setIdleWithCooldown(agentId);
    });

    api.on("agent_end", (event, ctx) => {
      const agentId = resolveAgentId(ctx);
      pushEvent("agent_end", { agentId, data: { success: event?.success, error: event?.error, sessionKey: ctx?.sessionKey } });

      // NOTE: message_sending/message_sent hooks are not currently wired by the gateway
      // in this OpenClaw version, so we synthesize a short-lived "reply" phase at the
      // end of a successful run to reflect that an outbound reply likely occurred.
      if (event?.success === false) {
        setState(agentId, "error", { error: event?.error || "agent_end: unsuccessful" });
        setTimeout(() => setIdleWithCooldown(agentId), cooldownMs);
        return;
      }

      setState(agentId, "reply", { synthetic: true });
      setIdleWithCooldown(agentId);
    });

    // HTTP: portal
    api.registerHttpRoute({
      path: "/lobster-room/",
      handler: async (_req, res) => {
        const fs = await import("node:fs/promises");
        try {
          const html = await fs.readFile(assetPath, "utf8");
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(html);
        } catch (err: any) {
          sendJson(res, 500, {
            ok: false,
            error: { type: "asset_read_failed", message: String(err?.message || err) },
          });
        }
      },
    });

    // HTTP: API (plugin-native)
    api.registerHttpRoute({
      path: "/lobster-room/api/lobster-room",
      handler: async (req, res) => {
        const url = readRequestUrl(req);
        const t = nowMs();

        // Ensure at least configured agents exist.
        const agentIdByDefault = "main";

        const agentIdAllowRaw = (process.env.LOBSTER_ROOM_AGENT_IDS || "").trim();
        const allowIds = agentIdAllowRaw
          ? agentIdAllowRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [agentIdByDefault];

        // Bootstrap configured agents so they appear even before any events.
        for (const id of allowIds) ensure(id);

        const agentNameOverrides: Record<string, string> = (() => {
          try {
            const raw = (process.env.LOBSTER_ROOM_AGENT_NAME_MAP_JSON || "").trim();
            if (!raw) return {};
            const obj = JSON.parse(raw);
            if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(obj)) {
              if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) out[k.trim()] = v.trim();
            }
            return out;
          } catch {
            return {};
          }
        })();

        const identityNameByAgentId = new Map<string, string>();
        const agentList = Array.isArray(api.config?.agents?.list) ? api.config.agents.list : [];
        for (const a of agentList) {
          const id = a?.id;
          const nm = a?.identity?.name;
          if (typeof id === "string" && id.trim() && typeof nm === "string" && nm.trim()) {
            identityNameByAgentId.set(id.trim(), nm.trim());
          }
        }

        const agentsPayload = allowIds
          .map((agentId) => activity.get(agentId) || ensure(agentId))
          .map((row) => {
            const uiState = mapActivityToUiState(row.state);
            const displayName =
              agentNameOverrides[row.agentId] || identityNameByAgentId.get(row.agentId) || row.agentId;
            return {
              id: `resident@${row.agentId}`,
              hostId: "local",
              hostLabel: "OpenClaw",
              name: displayName,
              state: uiState,
              meta: {
                active: row.state !== "idle",
                sinceMs: row.sinceMs,
              },
              debug: {
                decision: {
                  agentId: row.agentId,
                  displayName,
                  activityState: row.state,
                  sinceMs: row.sinceMs,
                  lastEventMs: row.lastEventMs,
                  cooldownMs,
                  staleMs,
                  toolMaxMs,
                  finalState: uiState,
                  details: row.details ?? null,
                  recentEvents: eventBuf,
                },
              },
            };
          });

        sendJson(res, 200, {
          ok: true,
          generatedAt: Math.floor(t / 1000),
          pollSeconds,
          gateways: [
            {
              id: "local",
              label: "OpenClaw",
              baseUrl: url.origin,
              status: "ok",
              sessionCount: null,
              maxUpdatedAt: null,
            },
          ],
          agents: agentsPayload,
          errors: [],
        });
      },
    });

    // Convenience redirect
    api.registerHttpRoute({
      path: "/lobster-room",
      handler: async (_req, res) => {
        res.statusCode = 301;
        res.setHeader("location", "/lobster-room/");
        res.end();
      },
    });

    api.logger.info("[lobster-room] plugin routes registered", {
      assetPath,
      cooldownMs,
      minDwellMs,
      pollSeconds,
      staleMs,
      toolMaxMs,
    });
  },
};
