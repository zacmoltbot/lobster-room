import type { IncomingMessage, ServerResponse } from "node:http";

type PluginApi = {
  id: string;
  config: any;
  logger: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
  resolvePath: (p: string) => string;
  registerHttpRoute: (params: {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }) => void;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

function readRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
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

function inferStateFromSessions(params: { nowMs: number; maxUpdatedAtMs: number; activeWindowMs: number }): {
  state: "think" | "wait";
  active: boolean;
} {
  const recent = params.nowMs - params.maxUpdatedAtMs <= params.activeWindowMs;
  return { state: recent ? "think" : "wait", active: recent };
}

export default {
  id: "lobster-room",
  async register(api: PluginApi) {
    // Resolve asset path relative to this plugin module (NOT the gateway cwd).
    const { fileURLToPath } = await import("node:url");
    const { dirname } = await import("node:path");
    const pluginDir = dirname(fileURLToPath(import.meta.url));
    const assetPath = `${pluginDir}/assets/lobster-room.html`;

    api.registerHttpRoute({
      path: "/lobster-room/",
      handler: async (_req, res) => {
        // Lazy-read each time to keep it simple; can cache later.
        const fs = await import("node:fs/promises");
        try {
          const html = await fs.readFile(assetPath, "utf8");
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(html);
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: { type: "asset_read_failed", message: String(err?.message || err) } });
        }
      },
    });

    api.registerHttpRoute({
      path: "/lobster-room/api/lobster-room",
      handler: async (req, res) => {
        const url = readRequestUrl(req);
        const nowMs = Date.now();

        const cfg = api.config;
        const port = resolveGatewayPort(cfg);
        const token = resolveGatewayToken(cfg);
        if (!token) {
          sendJson(res, 500, {
            ok: false,
            error: {
              type: "missing_gateway_token",
              message:
                "Missing gateway token. Set OPENCLAW_GATEWAY_TOKEN (recommended) or gateway.auth.token so the plugin can call /tools/invoke.",
            },
          });
          return;
        }

        const pollSeconds = Number.parseInt((process.env.LOBSTER_ROOM_POLL_SECONDS || "2").trim(), 10) || 2;
        const activeWindowMs = Number.parseInt((process.env.LOBSTER_ROOM_ACTIVE_WINDOW_MS || "10000").trim(), 10) || 10000;

        // Minimal single-gateway aggregation (self).
        const sessions = await toolsInvoke({ port, token, tool: "sessions_list", args: { limit: 50, activeMinutes: 60 } });
        if (!sessions?.ok) {
          sendJson(res, 502, { ok: false, error: { type: "sessions_list_failed", detail: sessions } });
          return;
        }

        const list = Array.isArray(sessions.sessions) ? sessions.sessions : [];
        const updatedAtList = list
          .map((s: any) => (typeof s.updatedAt === "number" ? s.updatedAt : 0))
          .filter((n: number) => n > 0);
        const maxUpdatedAt = updatedAtList.length ? Math.max(...updatedAtList) : 0;

        const { state, active } = inferStateFromSessions({ nowMs, maxUpdatedAtMs: maxUpdatedAt, activeWindowMs });

        // For compatibility with existing frontend expectations.
        const payload = {
          ok: true,
          generatedAt: Math.floor(nowMs / 1000),
          pollSeconds,
          gateways: [
            {
              id: "local",
              label: "OpenClaw",
              baseUrl: url.origin,
              status: "ok",
              sessionCount: list.length,
              maxUpdatedAt,
            },
          ],
          agents: [
            {
              id: "resident@local",
              hostId: "local",
              hostLabel: "OpenClaw",
              name: "OpenClaw",
              state,
              meta: {
                active,
                activeWindowMs,
                maxUpdatedAt,
                sessionCount: list.length,
              },
              debug: {
                timingsMs: {},
                decision: { nowMs, activeWindowMs, maxUpdatedAt, finalState: state },
              },
            },
          ],
          errors: [],
        };

        sendJson(res, 200, payload);
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

    api.logger.info("[lobster-room] plugin routes registered", { assetPath });
  },
};
