import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import fs from "node:fs/promises";

type PluginApi = {
  id: string;
  config: any;
  logger: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
  registerHttpRoute: (params: {
    path: string;
    match?: "exact" | "prefix";
    auth?: "gateway" | "plugin";
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

const FEED_UI_VERSION = "feed-v3-20260327.1";

// Maps tool names to user-facing labels for feed preview filtering.
// Returns undefined for internal/noisy tools that should not appear in the feed label.
const TOOL_LABELS: Record<string, string | undefined> = {
  browser: "Check live page",
  web_fetch: "Check page",
  sessions_spawn: "Start helper task",
  exec: "Run command",
  read: "Review files",
  write: "Update files",
  edit: "Update files",
  image: "Inspect image",
  process: "Check process",
  summarize: "Summarize",
  weather: "Check weather",
  himalaya: "Handle email",
  message: "Prepare reply",
};

function genericToolLabel(toolName: string): string | undefined {
  return TOOL_LABELS[toolName];
}

const LOW_SIGNAL_OBSERVATION_TOOLS = new Set(["sessions_history", "sessions_list", "session_status"]);
function isLowSignalObservationTool(toolName: unknown): boolean {
  return typeof toolName === "string" && LOW_SIGNAL_OBSERVATION_TOOLS.has(toolName.trim());
}

const INTERNAL_OBSERVATION_HEADER = "x-lobster-room-internal-observation";

type PluginRoute = {
  path: string;
  auth?: "gateway" | "plugin";
  match?: "exact" | "prefix";
  replaceExisting?: boolean;
  handler: (req: IncomingMessage, res: ServerResponse) => boolean | void | Promise<boolean | void>;
};

function registerSafePluginRoute(api: PluginApi, route: PluginRoute) {
  try {
    api.registerHttpRoute({
      auth: route.auth ?? "plugin",
      ...route,
      handler: async (req, res) => {
        try {
          const handled = await route.handler(req, res);
          return handled !== false;
        } catch (err: any) {
          api.logger.warn("[lobster-room] route handler failed", {
            path: route.path,
            error: String(err?.message || err),
          });
          if (!res.headersSent) {
            sendJson(res, 500, { ok: false, error: "internal_error", path: route.path });
          } else if (!res.writableEnded) {
            res.end();
          }
          return true;
        }
      },
    });
  } catch (err: any) {
    api.logger.warn("[lobster-room] route registration skipped", {
      path: route.path,
      match: route.match ?? "exact",
      error: String(err?.message || err),
    });
  }
}

async function readBody(req: IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error("body_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseMultipartFile(body: Buffer, boundary: string): { filename: string; contentType: string; data: Buffer } {
  // Very small multipart parser for single file field.
  const b = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let idx = 0;
  while (idx < body.length) {
    const start = body.indexOf(b, idx);
    if (start === -1) break;
    const next = body.indexOf(b, start + b.length);
    if (next === -1) break;
    parts.push(body.slice(start + b.length, next));
    idx = next;
  }
  for (const raw of parts) {
    // trim leading CRLF
    let part = raw;
    if (part.slice(0, 2).toString() === "\r\n") part = part.slice(2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd).toString("utf8");
    const mFn = headerText.match(/filename="([^"]+)"/i);
    if (!mFn) continue;
    const mCt = headerText.match(/content-type:\s*([^\r\n]+)/i);
    const filename = mFn[1];
    const contentType = (mCt ? mCt[1].trim() : "application/octet-stream").toLowerCase();
    let data = part.slice(headerEnd + 4);
    // remove trailing CRLF
    if (data.slice(-2).toString() === "\r\n") data = data.slice(0, -2);
    return { filename, contentType, data };
  }
  throw new Error("multipart_no_file");
}

function extFromContentType(ct: string): string | null {
  if (ct.includes("image/png")) return ".png";
  if (ct.includes("image/jpeg") || ct.includes("image/jpg")) return ".jpg";
  if (ct.includes("image/webp")) return ".webp";
  return null;
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

function maxNum(a: any, b: any): number {
  const na = (typeof a === "number" && Number.isFinite(a)) ? a : 0;
  const nb = (typeof b === "number" && Number.isFinite(b)) ? b : 0;
  return Math.max(na, nb);
}

function readRequestUrl(req: IncomingMessage): URL {
  // Respect reverse proxies when present.
  const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim();
  const host = (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim() || req.headers.host;
  return new URL(req.url ?? "/", `${proto || "http"}://${host || "localhost"}`);
}

function mapActivityToUiState(s: ActivityState): "think" | "wait" | "tool" | "reply" | "error" {
  if (s === "thinking") return "think";
  if (s === "idle") return "wait";
  return s;
}

function contentTypeByExt(ext: string): string | null {
  const e = ext.toLowerCase();
  if (e === ".svg") return "image/svg+xml; charset=utf-8";
  if (e === ".png") return "image/png";
  if (e === ".jpg" || e === ".jpeg") return "image/jpeg";
  if (e === ".webp") return "image/webp";
  if (e === ".gif") return "image/gif";
  if (e === ".html") return "text/html; charset=utf-8";
  if (e === ".css") return "text/css; charset=utf-8";
  if (e === ".js") return "text/javascript; charset=utf-8";
  if (e === ".json") return "application/json; charset=utf-8";
  if (e === ".txt") return "text/plain; charset=utf-8";
  return null;
}

const BUILD_TAG = "2026-03-08-debug-hooks-1";

export default {
  id: "lobster-room",
  register(api: PluginApi) {
    // api.logger.info("[lobster-room] register", { buildTag: BUILD_TAG });
    // Resolve asset path relative to this plugin module (NOT the gateway cwd).
    const pluginDir = dirname(fileURLToPath(import.meta.url));
    const portalHtmlPath = join(pluginDir, "assets", "lobster-room.html");

    // --- Rooms (multi-background profiles) ---
    const rootUserDir = join(pluginDir, "assets", "user");
    const roomsDir = join(rootUserDir, "rooms");
    const roomsIndexPath = join(roomsDir, "index.json");

    type RoomsIndex = {
      activeRoomId: string;
      rooms: Array<{ id: string; name: string; createdAt: number; updatedAt: number }>;
    };

    const defaultRoomId = "default";

    const safeRoomId = (s: string) => /^[a-z0-9][a-z0-9_-]{0,40}$/i.test(s);

    const readRoomsIndex = async (): Promise<RoomsIndex | null> => {
      try {
        const txt = await fs.readFile(roomsIndexPath, "utf8");
        const obj = JSON.parse(txt);
        if (!obj || typeof obj !== "object") return null;
        const activeRoomId = typeof (obj as any).activeRoomId === "string" ? (obj as any).activeRoomId : defaultRoomId;
        const rooms = Array.isArray((obj as any).rooms) ? (obj as any).rooms : [];
        return { activeRoomId, rooms };
      } catch {
        return null;
      }
    };

    const writeRoomsIndex = async (idx: RoomsIndex) => {
      await fs.mkdir(roomsDir, { recursive: true });
      await fs.writeFile(roomsIndexPath, JSON.stringify(idx, null, 2));
    };

    const roomPath = (roomId: string, rel: string) => join(roomsDir, roomId, rel);

    const ensureDefaultRoomInitialized = async () => {
      // Initialize a usable default room.
      // Priority order for seeding content:
      // 1) Legacy single-file storage under assets/user (migration)
      // 2) Bundled defaults shipped with the plugin (assets/default-room.jpg + assets/default-manual-map.json)
      // 3) Empty map fallback
      await fs.mkdir(roomPath(defaultRoomId, ""), { recursive: true });

      const t = Date.now();
      const dstImg = roomPath(defaultRoomId, "room.jpg");
      const dstMap = roomPath(defaultRoomId, "manual-map.json");

      const fileExists = async (p: string) => {
        try {
          await fs.stat(p);
          return true;
        } catch {
          return false;
        }
      };

      // --- Background image seed ---
      // Prefer legacy user room image if present.
      const legacyMetaPath = join(rootUserDir, "room-meta.json");
      let legacyFile: string | null = null;
      try {
        const metaTxt = await fs.readFile(legacyMetaPath, "utf8");
        const meta = JSON.parse(metaTxt);
        legacyFile = typeof meta?.file === "string" ? meta.file : null;
      } catch {
        legacyFile = null;
      }

      const srcLegacyImg = legacyFile ? join(rootUserDir, legacyFile) : null;
      const srcBundledImg = join(pluginDir, "assets", "default-room.jpg");

      if (!(await fileExists(dstImg))) {
        let seeded = false;
        if (srcLegacyImg) {
          try {
            const buf = await fs.readFile(srcLegacyImg);
            await fs.writeFile(dstImg, buf);
            seeded = true;
          } catch {}
        }
        if (!seeded) {
          try {
            const buf = await fs.readFile(srcBundledImg);
            await fs.writeFile(dstImg, buf);
            seeded = true;
          } catch {}
        }
      }

      // --- Manual map seed ---
      // Prefer legacy server manual-map.json if present.
      const legacyMapPath = join(rootUserDir, "manual-map.json");
      const srcBundledMap = join(pluginDir, "assets", "default-manual-map.json");
      if (!(await fileExists(dstMap))) {
        let seeded = false;
        try {
          const txt = await fs.readFile(legacyMapPath, "utf8");
          await fs.writeFile(dstMap, txt);
          seeded = true;
        } catch {}
        if (!seeded) {
          try {
            const txt = await fs.readFile(srcBundledMap, "utf8");
            await fs.writeFile(dstMap, txt);
            seeded = true;
          } catch {}
        }
        if (!seeded) {
          const empty = { version: 1, tx: 32, ty: 20, cells: new Array(32 * 20).fill(null), updatedAt: null };
          await fs.writeFile(dstMap, JSON.stringify(empty, null, 2));
        }
      }

      // --- Rooms index ---
      const idxExisting = await readRoomsIndex();
      if (idxExisting && Array.isArray(idxExisting.rooms) && idxExisting.rooms.find((r) => r.id === defaultRoomId)) {
        // Keep existing index; do not override activeRoomId.
        return;
      }

      const idx: RoomsIndex = {
        activeRoomId: defaultRoomId,
        rooms: [{ id: defaultRoomId, name: "Default", createdAt: t, updatedAt: t }],
      };
      await writeRoomsIndex(idx);
    };

    // Kick migration/initialization (best-effort, no throw)
    ensureDefaultRoomInitialized().catch(() => undefined);

    const getActiveRoomId = async (): Promise<string> => {
      const idx = await readRoomsIndex();
      const id = idx?.activeRoomId || defaultRoomId;
      return safeRoomId(id) ? id : defaultRoomId;
    };

    // --- Retention (per-active-room) ---
    const RETENTION_DEFAULT_MS = 604800000; // 7 days

    const readRetention = async (roomId: string): Promise<number> => {
      try {
        const txt = await fs.readFile(roomPath(roomId, "retention.json"), "utf8");
        const obj = JSON.parse(txt);
        if (typeof (obj as any).retentionMs === "number" && (obj as any).retentionMs > 0) {
          return (obj as any).retentionMs;
        }
      } catch {}
      return RETENTION_DEFAULT_MS;
    };

    const writeRetention = async (roomId: string, retentionMs: number) => {
      await fs.mkdir(roomPath(roomId, ""), { recursive: true });
      await fs.writeFile(roomPath(roomId, "retention.json"), JSON.stringify({ retentionMs }, null, 2));
    };

    // --- Static assets: /lobster-room/assets/** → <pluginDir>/assets/** ---
    registerSafePluginRoute(api, {
      path: "/lobster-room/assets/",
      match: "prefix",
      handler: async (req, res) => {
        const url = readRequestUrl(req);
        let rel = url.pathname?.slice("/lobster-room/assets/".length) || "";
        try { rel = decodeURIComponent(rel); } catch {}
        rel = rel.replace(/^\/+/, "");
        if (!rel || rel.includes("..") || rel.includes("\\")) {
          res.statusCode = 400;
          res.end("bad_request");
          return true;
        }
        const ct = contentTypeByExt(extname(rel));
        if (!ct) {
          res.statusCode = 415;
          res.end("unsupported_media_type");
          return true;
        }
        try {
          const buf = await fs.readFile(join(pluginDir, "assets", rel));
          res.statusCode = 200;
          res.setHeader("content-type", ct);
          res.setHeader("cache-control", "no-store");
          res.end(buf);
        } catch {
          res.statusCode = 404;
          res.end("not_found");
        }
        return true;
      },
    });

    // --- Agent labels API ---
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/agent-labels",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() === "GET") {
          const m = await readAgentLabels();
          sendJson(res, 200, { ok: true, labels: m });
          return true;
        }
        if ((req.method || "GET").toUpperCase() === "POST") {
          try {
            const buf = await readBody(req, 128 * 1024);
            const obj = JSON.parse(buf.toString("utf8"));
            const labelsRaw = obj?.labels;
            if (!labelsRaw || typeof labelsRaw !== "object" || Array.isArray(labelsRaw)) throw new Error("bad_labels");
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(labelsRaw)) {
              if (typeof k !== "string" || typeof v !== "string") continue;
              const kk = k.trim();
              const vv = v.trim();
              if (!kk || !vv) continue;
              if (kk.length > 64 || vv.length > 64) continue;
              out[kk] = vv;
            }
            await writeAgentLabels(out);
            sendJson(res, 200, { ok: true, labels: out });
          } catch (err: any) {
            sendJson(res, 400, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }
        res.statusCode = 405;
        res.end("method_not_allowed");
        return true;
      },
    });

    // --- Rooms API ---
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/rooms",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() === "GET") {
          const idx = (await readRoomsIndex()) || { activeRoomId: defaultRoomId, rooms: [{ id: defaultRoomId, name: "Default", createdAt: 0, updatedAt: 0 }] };
          sendJson(res, 200, { ok: true, ...idx });
          return true;
        }
        res.statusCode = 405;
        res.end("method_not_allowed");
        return true;
      },
    });

    registerSafePluginRoute(api, {
      path: "/lobster-room/api/rooms/active",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() === "POST") {
          try {
            const buf = await readBody(req, 128 * 1024);
            const obj = JSON.parse(buf.toString("utf8"));
            const roomId = String(obj?.roomId || "").trim();
            if (!safeRoomId(roomId)) throw new Error("bad_room_id");
            const idx = (await readRoomsIndex()) || { activeRoomId: defaultRoomId, rooms: [{ id: defaultRoomId, name: "Default", createdAt: 0, updatedAt: 0 }] };
            if (!idx.rooms.find((r) => r.id === roomId)) throw new Error("room_not_found");
            idx.activeRoomId = roomId;
            await writeRoomsIndex(idx);
            sendJson(res, 200, { ok: true, activeRoomId: roomId });
          } catch (err: any) {
            sendJson(res, 400, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }
        res.statusCode = 405;
        res.end("method_not_allowed");
        return true;
      },
    });

    registerSafePluginRoute(api, {
      path: "/lobster-room/api/rooms/delete",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() === "POST") {
          try {
            const buf = await readBody(req, 128 * 1024);
            const obj = JSON.parse(buf.toString("utf8"));
            const roomId = String(obj?.roomId || "").trim();
            if (!safeRoomId(roomId)) throw new Error("bad_room_id");
            if (roomId === defaultRoomId) throw new Error("cannot_delete_default");
            const idx = (await readRoomsIndex()) || { activeRoomId: defaultRoomId, rooms: [{ id: defaultRoomId, name: "Default", createdAt: 0, updatedAt: 0 }] };
            if (!idx.rooms.find((r) => r.id === roomId)) throw new Error("room_not_found");
            idx.rooms = idx.rooms.filter((r) => r.id !== roomId);
            if (idx.activeRoomId === roomId) idx.activeRoomId = defaultRoomId;
            await writeRoomsIndex(idx);
            try {
              await fs.rm(roomPath(roomId, ""), { recursive: true, force: true });
            } catch {}
            sendJson(res, 200, { ok: true, activeRoomId: idx.activeRoomId });
          } catch (err: any) {
            sendJson(res, 400, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }
        res.statusCode = 405;
        res.end("method_not_allowed");
        return true;
      },
    });

    // --- Retention API ---
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/retention",
      handler: async (req, res) => {
        const roomId = await getActiveRoomId();
        if ((req.method || "GET").toUpperCase() === "GET") {
          const retentionMs = await readRetention(roomId);
          sendJson(res, 200, { ok: true, retentionMs });
          return true;
        }
        if ((req.method || "GET").toUpperCase() === "POST") {
          try {
            const buf = await readBody(req, 128 * 1024);
            const obj = JSON.parse(buf.toString("utf8"));
            const retentionMs = Number(obj?.retentionMs);
            if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new Error("bad_retention_ms");
            await writeRetention(roomId, retentionMs);
            sendJson(res, 200, { ok: true, retentionMs });
          } catch (err: any) {
            sendJson(res, 400, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }
        res.statusCode = 405;
        res.end("method_not_allowed");
        return true;
      },
    });

    // --- Manual map API ---
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/manual-map/reset",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() !== "POST") {
          res.statusCode = 405;
          res.end("method_not_allowed");
          return true;
        }
        const roomId = await getActiveRoomId();
        const mapPath = roomPath(roomId, "manual-map.json");
        try {
          await fs.unlink(mapPath).catch(() => undefined);
          sendJson(res, 200, { ok: true });
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
        return true;
      },
    });

    registerSafePluginRoute(api, {
      path: "/lobster-room/api/manual-map",
      handler: async (req, res) => {
        const roomId = await getActiveRoomId();
        const mapPath = roomPath(roomId, "manual-map.json");
        if ((req.method || "GET").toUpperCase() === "GET") {
          try {
            const txt = await fs.readFile(mapPath, "utf8");
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.setHeader("cache-control", "no-store");
            res.end(txt);
          } catch {
            res.statusCode = 404;
            res.end("not_found");
          }
          return true;
        }
        if ((req.method || "GET").toUpperCase() === "POST") {
          try {
            await fs.mkdir(dirname(mapPath), { recursive: true });
            const buf = await readBody(req, 512 * 1024);
            const txt = buf.toString("utf8");
            const obj = JSON.parse(txt);
            if (!obj || typeof obj !== "object") throw new Error("bad_json");
            if (typeof (obj as any).tx !== "number" || typeof (obj as any).ty !== "number" || !Array.isArray((obj as any).cells)) {
              throw new Error("bad_shape");
            }
            await fs.writeFile(mapPath, JSON.stringify(obj, null, 2));
            const idx = await readRoomsIndex();
            if (idx) {
              const r = idx.rooms.find((x) => x.id === roomId);
              if (r) r.updatedAt = Date.now();
              await writeRoomsIndex(idx);
            }
            sendJson(res, 200, { ok: true });
          } catch (err: any) {
            sendJson(res, 400, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }
        res.statusCode = 405;
        res.end("method_not_allowed");
        return true;
      },
    });

    // --- Room layout API ---
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/room-layout/reset",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() !== "POST") {
          res.statusCode = 405;
          res.end("method_not_allowed");
          return true;
        }
        const layoutPath = join(rootUserDir, "room-layout.json");
        try {
          await fs.unlink(layoutPath).catch(() => undefined);
          sendJson(res, 200, { ok: true });
        } catch (err: any) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) });
        }
        return true;
      },
    });

    registerSafePluginRoute(api, {
      path: "/lobster-room/api/room-layout",
      handler: async (req, res) => {
        const layoutPath = join(rootUserDir, "room-layout.json");
        if ((req.method || "GET").toUpperCase() === "GET") {
          try {
            const txt = await fs.readFile(layoutPath, "utf8");
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.setHeader("cache-control", "no-store");
            res.end(txt);
          } catch {
            res.statusCode = 404;
            res.end("not_found");
          }
          return true;
        }
        if ((req.method || "GET").toUpperCase() === "POST") {
          try {
            await fs.mkdir(rootUserDir, { recursive: true });
            const buf = await readBody(req, 512 * 1024);
            const txt = buf.toString("utf8");
            const obj = JSON.parse(txt);
            if (!obj || typeof obj !== "object") throw new Error("bad_json");
            await fs.writeFile(layoutPath, JSON.stringify(obj, null, 2));
            sendJson(res, 200, { ok: true });
          } catch (err: any) {
            sendJson(res, 400, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }
        res.statusCode = 405;
        res.end("method_not_allowed");
        return true;
      },
    });

    // --- Room image API ---
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/room-image/info",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() === "GET") {
          const roomId = await getActiveRoomId();
          const idx = await readRoomsIndex();
          const room = idx?.rooms?.find((r) => r.id === roomId) || { id: roomId, name: roomId, createdAt: 0, updatedAt: 0 };
          sendJson(res, 200, { ok: true, exists: true, roomId, roomName: room.name, updatedAt: room.updatedAt || null });
          return true;
        }
        res.statusCode = 405;
        res.end("method_not_allowed");
        return true;
      },
    });

    registerSafePluginRoute(api, {
      path: "/lobster-room/api/room-image/reset",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() !== "POST") {
          res.statusCode = 405;
          res.end("method_not_allowed");
          return true;
        }
        const roomId = await getActiveRoomId();
        if (roomId !== defaultRoomId) {
          try {
            const idx = (await readRoomsIndex()) || { activeRoomId: defaultRoomId, rooms: [{ id: defaultRoomId, name: "Default", createdAt: 0, updatedAt: 0 }] };
            idx.activeRoomId = defaultRoomId;
            await writeRoomsIndex(idx);
            sendJson(res, 200, { ok: true, activeRoomId: defaultRoomId });
          } catch (err: any) {
            sendJson(res, 500, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }
        sendJson(res, 200, { ok: true, activeRoomId: defaultRoomId });
        return true;
      },
    });

    registerSafePluginRoute(api, {
      path: "/lobster-room/api/room-image",
      handler: async (req, res) => {
        const roomId = await getActiveRoomId();
        const imgPath = roomPath(roomId, "room.jpg");
        // GET image bytes
        if ((req.method || "GET").toUpperCase() === "GET") {
          try {
            const st = await fs.stat(imgPath);
            const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;
            res.setHeader("content-type", "image/jpeg");
            res.setHeader("cache-control", "public, max-age=31536000, immutable");
            res.setHeader("etag", etag);
            res.setHeader("last-modified", st.mtime.toUTCString());
            const inm = String(req.headers["if-none-match"] || "");
            if (inm && inm === etag) {
              res.statusCode = 304;
              res.end();
              return true;
            }
            const buf = await fs.readFile(imgPath);
            res.statusCode = 200;
            res.end(buf);
          } catch {
            res.statusCode = 404;
            res.end("not_found");
          }
          return true;
        }
        // POST upload multipart: create new room, set active, create empty manual map
        if ((req.method || "GET").toUpperCase() === "POST") {
          const ct = String(req.headers["content-type"] || "");
          const m = ct.match(/multipart\/form-data;\s*boundary=([^;]+)/i);
          if (!m) {
            sendJson(res, 400, { ok: false, error: "expected_multipart" });
            return true;
          }
          const boundary = m[1];
          try {
            const body = await readBody(req, 12 * 1024 * 1024);
            const filePart = parseMultipartFile(body, boundary);
            const ext = extFromContentType(filePart.contentType) || extname(filePart.filename).toLowerCase();
            if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
              sendJson(res, 415, { ok: false, error: "unsupported_image_type", contentType: filePart.contentType });
              return true;
            }
            const id = `room-${Date.now()}`;
            await fs.mkdir(roomPath(id, ""), { recursive: true });
            await fs.writeFile(roomPath(id, "room.jpg"), filePart.data);
            const empty = { version: 1, tx: 32, ty: 20, cells: new Array(32 * 20).fill(null), updatedAt: Date.now() };
            await fs.writeFile(roomPath(id, "manual-map.json"), JSON.stringify(empty, null, 2));
            const idx = (await readRoomsIndex()) || { activeRoomId: defaultRoomId, rooms: [{ id: defaultRoomId, name: "Default", createdAt: 0, updatedAt: 0 }] };
            idx.rooms.push({ id, name: filePart.filename?.slice(0, 32) || id, createdAt: Date.now(), updatedAt: Date.now() });
            idx.activeRoomId = id;
            await writeRoomsIndex(idx);
            sendJson(res, 200, { ok: true, roomId: id, activeRoomId: id });
          } catch (err: any) {
            sendJson(res, 500, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }
        res.statusCode = 405;
        res.end("method_not_allowed");
        return true;
      },
    });

    const cooldownMs = Number.parseInt((process.env.LOBSTER_ROOM_IDLE_COOLDOWN_MS || "1500").trim(), 10) || 1500;
    const replyCooldownMs = Number.parseInt((process.env.LOBSTER_ROOM_REPLY_COOLDOWN_MS || "2500").trim(), 10) || 2500;
    const minDwellMs = Number.parseInt((process.env.LOBSTER_ROOM_MIN_DWELL_MS || "900").trim(), 10) || 900;

    // Persisted agent display-name overrides (shared across browsers).
    const agentLabelsPath = join(rootUserDir, "agent-labels.json");

    const readAgentLabels = async (): Promise<Record<string, string>> => {
      try {
        const txt = await fs.readFile(agentLabelsPath, "utf8");
        const obj = JSON.parse(txt);
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj as any)) {
          if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) out[k.trim()] = v.trim();
        }
        return out;
      } catch {
        return {};
      }
    };

    const writeAgentLabels = async (m: Record<string, string>) => {
      await fs.mkdir(dirname(agentLabelsPath), { recursive: true });
      await fs.writeFile(agentLabelsPath, JSON.stringify(m, null, 2));
    };
    const staleMs = Number.parseInt((process.env.LOBSTER_ROOM_STALE_MS || "15000").trim(), 10) || 15000;
    const toolMaxMs = Number.parseInt((process.env.LOBSTER_ROOM_TOOL_MAX_MS || "12000").trim(), 10) || 12000;
    const pollSeconds = Number.parseInt((process.env.LOBSTER_ROOM_POLL_SECONDS || "1").trim(), 10) || 1;

    const activity = new Map<string, AgentActivity>();

    // Ring buffer of recent hook events for self-debug (no secrets; truncate content).
    // IMPORTANT: In some deployments the HTTP route handler may not share memory with hook handlers.
    // We therefore also persist a small snapshot to disk and the HTTP API reads from that snapshot.
    const eventBuf: Array<{ ts: number; kind: string; agentId?: string; data?: any }> = [];

    const snapshotPath = join(rootUserDir, "agent-activity.json");
    type ActivitySnapshot = {
      buildTag: string;
      updatedAtMs: number;
      agents: Record<string, { state: ActivityState; sinceMs: number; lastEventMs: number; details?: any }>;
      events: Array<{ ts: number; kind: string; agentId?: string; data?: any }>;
    };
    let snap: ActivitySnapshot = {
      buildTag: BUILD_TAG,
      updatedAtMs: nowMs(),
      agents: {},
      events: [],
    };

    // Best-effort: load existing snapshot from disk so multiple isolates can converge.
    // NOTE: Avoid top-level `await` in case the plugin loader parses register() as sync.
    fs
      .readFile(snapshotPath, "utf8")
      .then((txt) => {
        const obj = JSON.parse(txt);
        if (obj && typeof obj === "object") {
          if (obj.agents && typeof obj.agents === "object") snap.agents = obj.agents;
          if (Array.isArray(obj.events)) snap.events = obj.events;
          if (typeof obj.updatedAtMs === "number") snap.updatedAtMs = obj.updatedAtMs;
        }
      })
      .catch(() => {});

    const mergeAndWriteSnapshot = async () => {
      try {
        await fs.mkdir(rootUserDir, { recursive: true });
      } catch {}
      try {
        // Merge with existing on-disk snapshot to avoid isolate overwrites.
        let disk: any = null;
        try {
          const txt = await fs.readFile(snapshotPath, "utf8");
          disk = JSON.parse(txt);
        } catch {
          disk = null;
        }
        const merged: ActivitySnapshot = {
          buildTag: BUILD_TAG,
          updatedAtMs: snap.updatedAtMs,
          agents: { ...(disk?.agents || {}), ...(snap.agents || {}) },
          events: Array.isArray(disk?.events) ? disk.events.slice(-30) : [],
        };
        // Prefer the most recent events we have.
        if (Array.isArray(snap.events) && snap.events.length) {
          merged.events = [...merged.events, ...snap.events].slice(-30);
        }
        merged.updatedAtMs = maxNum(disk?.updatedAtMs, snap.updatedAtMs);
        await fs.writeFile(snapshotPath, JSON.stringify(merged, null, 2));
      } catch {}
    };

    let _snapWriteTimer: any = null;
    const writeSnapshotSoon = () => {
      try {
        if (_snapWriteTimer) return;
        _snapWriteTimer = setTimeout(async () => {
          _snapWriteTimer = null;
          await mergeAndWriteSnapshot();
        }, 50);
      } catch {}
    };

    const pushEvent = (kind: string, params: { agentId?: string; data?: any }) => {
      const ev = { ts: nowMs(), kind, agentId: params.agentId, data: params.data };
      eventBuf.push(ev);
      if (eventBuf.length > 30) eventBuf.splice(0, eventBuf.length - 30);

      snap.updatedAtMs = ev.ts;
      snap.events.push(ev);
      if (snap.events.length > 30) snap.events.splice(0, snap.events.length - 30);
      writeSnapshotSoon();
    };

    // --- Message Feed (recent events; ring buffer) ---
    type FeedKind =
      | "before_agent_start"
      | "before_tool_call"
      | "after_tool_call"
      | "tool_result_persist"
      | "message_sending"
      | "message_sent"
      | "agent_end";

    type FeedItem = {
      ts: number;
      kind: FeedKind;
      agentId?: string;
      rawAgentId?: string;
      sessionKey?: string;
      channelId?: string;
      to?: string;
      toolName?: string;
      durationMs?: number;
      success?: boolean;
      error?: string;
      // Optional extra fields; keep small and sanitized.
      details?: Record<string, unknown>;
    };

    const FEED_MAX = Math.max(500, Number(api.config?.feedMaxItems) || 0, 600);
    const feedBuf: FeedItem[] = [];

    const redactSecretsInText = (s: string): string => {
      let out = String(s || "");

      // URLs can leak tokens/hostnames; replace with a placeholder.
      out = out.replace(/\bhttps?:\/\/[^\s)\]]+/gi, "[URL]");

      // Common header-ish secrets
      out = out.replace(/\b(authorization|cookie)\b\s*[:=]\s*([^\s'\"]+)/gi, "$1:[REDACTED]");

      // token/apiKey style key-value pairs
      out = out.replace(
        /\b(token|api[-_]?key|apikey|access[_-]?token|id[_-]?token|refresh[_-]?token)\b\s*[:=]\s*([^\s'\"]+)/gi,
        "$1=[REDACTED]",
      );

      // URL query params (when URL stripping didn't catch)
      out = out.replace(/([?&])(token|api_key|apikey|apiKey|access_token|auth|authorization)=([^&#]+)/g, "$1$2=[REDACTED]");

      // Long hex strings (often keys/hashes)
      out = out.replace(/\b[a-f0-9]{32,}\b/gi, "[HEX_REDACTED]");

      // Shell-ish patterns that often contain secrets
      out = out.replace(/\b(BEARER|TOKEN)=([^\s]+)/gi, "$1=[REDACTED]");

      return out;
    };

    const coerceStr = (v: any, maxLen = 400): string | undefined => {
      if (typeof v !== "string") return undefined;
      const t = v.length > maxLen ? v.slice(0, maxLen) + "…" : v;
      return redactSecretsInText(t);
    };

    // Build a natural-language fragment describing what the agent is doing,
    // driven by tool intent (not raw tool names). Safe details (task label,
    // url, spawnAgentId) are used to add context without exposing internals.
    const humanizedWorkDescription = (toolName: string, details: Record<string, unknown> | null): string => {
      const tn = String(toolName || "tool").trim();

      // sessions_spawn: show the actual task the helper will run
      if (tn === "sessions_spawn") {
        const task = typeof details?.task === "string" ? details.task.trim() : "";
        const label = typeof details?.label === "string" ? details.label.trim() : "";
        const spawnId = typeof details?.spawnAgentId === "string" ? details.spawnAgentId.trim() : "";
        if (task) {
          const preview = task.length > 80 ? task.slice(0, 80) + "…" : task;
          return `starting: ${preview}`;
        }
        if (label) return `starting ${label}`;
        if (spawnId) return `starting helper (${spawnId})`;
        return "starting helper task";
      }

      // File operations: show what kind of review/update is happening
      if (tn === "read") {
        const task = typeof details?.task === "string" ? details.task.trim() : "";
        return task ? `reviewing: ${task}` : "reviewing files";
      }
      if (tn === "write") return "updating files";
      if (tn === "edit") return "updating files";

      // Browser / web: show checking live content
      if (tn === "browser" || tn === "web_fetch") {
        const url = typeof details?.url === "string" ? details.url.trim() : "";
        return url ? "checking live page" : "checking page";
      }

      // Fallback: use the generic tool label in natural form
      const base = genericToolLabel(tn) || "working";
      return base.toLowerCase();
    };

    const feedPreview = (it: FeedItem): string => {
      // Always canonicalize agentId so internal descendant ids never leak into visible feed.
      const canonicalAgentId = it.agentId ? canonicalVisibleAgentId(it.agentId) || "main" : "";
      const agent = canonicalAgentId ? `@${canonicalAgentId}` : "";
      const details = it.details as Record<string, unknown> | null;

      if (it.kind === "before_agent_start") {
        // No task context in before_agent_start details today; keep it simple.
        return `${agent} started`;
      }
      if (it.kind === "before_tool_call") {
        const tn = it.toolName || "tool";
        const desc = humanizedWorkDescription(String(tn), details);
        return `${agent} ${desc}`.trim();
      }
      if (it.kind === "after_tool_call") {
        const tn = it.toolName || "tool";
        const desc = humanizedWorkDescription(String(tn), details).replace(/^starting:/, "started:");
        const d = typeof it.durationMs === "number" ? ` (${Math.round(it.durationMs)}ms)` : "";
        return `${agent} ${desc} done${d}`.trim();
      }
      if (it.kind === "tool_result_persist") return `${agent} working`;
      if (it.kind === "message_sending") {
        const to = it.to ? redactSecretsInText(it.to) : "(unknown)";
        return `sending message → ${to}`;
      }
      if (it.kind === "message_sent") {
        const to = it.to ? redactSecretsInText(it.to) : "(unknown)";
        const ok = it.success === false ? "failed" : "sent";
        return `message ${ok} → ${to}`;
      }
      if (it.kind === "agent_end") {
        if (it.success === false) return `${agent} ended (error)`;
        return `${agent} ended`;
      }
      return it.kind;
    };

    const pushFeed = (item: FeedItem) => {
      feedBuf.push(item);
      if (feedBuf.length > FEED_MAX) feedBuf.splice(0, feedBuf.length - FEED_MAX);
    };

    type FeedTaskStatus = "running" | "done" | "error";

    type FeedTask = {
      id: string;
      sessionKey?: string;
      agentId: string;
      startTs: number;
      endTs?: number;
      status: FeedTaskStatus;
      title: string;
      summary: string;
      // Optional raw events for debug UI.
      items?: FeedItem[];
    };

    const taskTitleFromItems = (items: FeedItem[]): string => {
      // Prefer sessions_spawn label/task if present.
      for (const it of items) {
        if (it.kind === "before_tool_call" && it.toolName === "sessions_spawn") {
          const label = typeof (it.details as any)?.label === "string" ? String((it.details as any).label) : "";
          const task = typeof (it.details as any)?.task === "string" ? String((it.details as any).task) : "";
          const t = (label || "").trim() || (task || "").trim();
          if (t) return redactSecretsInText(t).slice(0, 120);
          return "Starting helper task";
        }
      }

      // Otherwise, use the first meaningful user-facing tool label.
      const firstTool = items.find((x) => {
        if (x.kind !== "before_tool_call" || !x.toolName) return false;
        return !!genericToolLabel(String(x.toolName).trim());
      })?.toolName;
      if (firstTool) return genericToolLabel(String(firstTool).trim()) || "Working";

      return "Working";
    };

    const taskSummaryFromItems = (items: FeedItem[], status: FeedTaskStatus): string => {
      const toolCalls = items.filter((x) => x.kind === "before_tool_call").length;
      const msgSent = items.filter((x) => x.kind === "message_sent" && x.success !== false).length;
      const msgFail = items.filter((x) => x.kind === "message_sent" && x.success === false).length;
      const errors = items.map((x) => (x.error ? String(x.error) : "")).filter(Boolean);
      const firstTool = items.find((x) => x.kind === "before_tool_call" && x.toolName)?.toolName;
      const firstLabel = firstTool ? genericToolLabel(String(firstTool).trim()) : undefined;

      const bits: string[] = [];
      if (firstLabel) bits.push(firstLabel.toLowerCase());
      if (toolCalls) bits.push(String(toolCalls) + " step" + (toolCalls === 1 ? "" : "s"));
      if (msgSent) bits.push(String(msgSent) + " reply" + (msgSent === 1 ? "" : "ies") + " sent");
      if (msgFail) bits.push(String(msgFail) + " reply" + (msgFail === 1 ? "" : "ies") + " failed");

      if (status === "running") return bits.length ? "Working · " + bits.join(" · ") : "Working";

      if (status === "error") {
        const e = errors[0] ? "Error: " + redactSecretsInText(errors[0]).slice(0, 160) : "Error";
        return bits.length ? e + " · " + bits.join(" · ") : e;
      }

      return bits.length ? "Done · " + bits.join(" · ") : "Done";
    };

    const visibleFeedAgentId = (value: unknown, fallback = "main"): string => {
      const visible = canonicalVisibleAgentId(value);
      return visible || fallback;
    };

    const sanitizeFeedItemForApi = (it: FeedItem, includeRaw = false) => {
      const base = includeRaw
        ? { ...it }
        : {
            ts: it.ts,
            kind: it.kind,
            agentId: it.agentId,
            sessionKey: it.sessionKey,
            channelId: it.channelId,
            to: it.to,
            toolName: it.toolName,
            durationMs: it.durationMs,
            success: it.success,
            error: it.error,
            details: it.details,
          };
      return {
        ...base,
        agentId: visibleFeedAgentId(it.agentId),
        preview: feedPreview(it),
      };
    };

    const groupFeedIntoTasks = (items: FeedItem[], opts?: { includeRaw?: boolean }): FeedTask[] => {
      const includeRaw = !!opts?.includeRaw;
      const byKey = new Map<string, FeedItem[]>();
      const noKey: FeedItem[] = [];

      for (const it of items) {
        const sk = typeof it.sessionKey === "string" && it.sessionKey.trim() ? it.sessionKey.trim() : "";
        if (sk) byKey.set(sk, (byKey.get(sk) || []).concat([it]));
        else noKey.push(it);
      }

      const tasks: FeedTask[] = [];

      for (const [sk, arr] of byKey.entries()) {
        const sorted = arr.slice().sort((a, b) => a.ts - b.ts);
        const agentId = visibleFeedAgentId(sorted.find((x) => x.agentId)?.agentId, "unknown");
        const startTs = sorted[0]?.ts || nowMs();
        const end = [...sorted].reverse().find((x) => x.kind === "agent_end");
        const status: FeedTaskStatus = end ? (end.success === false || end.error ? "error" : "done") : "running";
        const title = taskTitleFromItems(sorted);
        const summary = taskSummaryFromItems(sorted, status);
        tasks.push({ id: sk, sessionKey: sk, agentId, startTs, endTs: end?.ts, status, title, summary, items: includeRaw ? sorted : undefined });
      }

      if (noKey.length) {
        const byAgent = new Map<string, FeedItem[]>();
        for (const it of noKey) {
          const a = visibleFeedAgentId(it.agentId, "unknown");
          byAgent.set(a, (byAgent.get(a) || []).concat([it]));
        }
        for (const [agentId, arr] of byAgent.entries()) {
          const sorted = arr.slice().sort((a, b) => a.ts - b.ts);
          const startTs = sorted[0]?.ts || nowMs();
          const end = [...sorted].reverse().find((x) => x.kind === "agent_end");
          const status: FeedTaskStatus = end ? (end.success === false || end.error ? "error" : "done") : "running";
          const title = taskTitleFromItems(sorted);
          const summary = taskSummaryFromItems(sorted, status);
          const id = "adhoc:" + agentId + ":" + String(startTs);
          tasks.push({ id, agentId, startTs, endTs: end?.ts, status, title, summary, items: includeRaw ? sorted : undefined });
        }
      }

      return tasks.sort((a, b) => b.startTs - a.startTs);
    };

    const priority: Record<ActivityState, number> = {
      idle: 0,
      thinking: 1,
      reply: 2,
      tool: 3,
      error: 4,
    };

    const internalObservationDepth = new Map<string, number>();
    const beginInternalObservation = (toolName: string) => {
      internalObservationDepth.set(toolName, (internalObservationDepth.get(toolName) || 0) + 1);
    };
    const endInternalObservation = (toolName: string) => {
      const cur = internalObservationDepth.get(toolName) || 0;
      if (cur <= 1) internalObservationDepth.delete(toolName);
      else internalObservationDepth.set(toolName, cur - 1);
    };
    const isInternalObservationToolCall = (toolName: unknown, ctx: any): boolean => {
      if (!isLowSignalObservationTool(toolName)) return false;
      const headerValue = ctx?.request?.headers?.[INTERNAL_OBSERVATION_HEADER]
        ?? ctx?.headers?.[INTERNAL_OBSERVATION_HEADER]
        ?? ctx?.req?.headers?.[INTERNAL_OBSERVATION_HEADER];
      if (headerValue === "1" || headerValue === 1 || headerValue === true) return true;
      return typeof toolName === "string" && (internalObservationDepth.get(toolName) || 0) > 0;
    };

    const parseSessionIdentity = (sessionKey: unknown, fallbackAgentId?: unknown): { agentId: string; residentAgentId: string; lane: string } => {
      const sk = typeof sessionKey === "string" ? String(sessionKey) : "";
      const parts = sk ? sk.split(":") : [];
      if (parts.length >= 3 && parts[0] === "agent") {
        const residentAgentId = parts[1] || "main";
        const lane = parts[2] || "main";
        if (lane === "main") return { agentId: residentAgentId, residentAgentId, lane };
        const tail = parts.slice(3).filter(Boolean).join(":");
        const scoped = tail ? `${residentAgentId}/${lane}:${tail}` : `${residentAgentId}/${lane}`;
        return { agentId: scoped, residentAgentId, lane };
      }
      const id = typeof fallbackAgentId === "string" ? String(fallbackAgentId).trim() : "";
      return { agentId: id || "main", residentAgentId: id || "main", lane: "main" };
    };

    const canonicalResidentAgentId = (value: unknown): string => {
      if (typeof value !== "string") return "";
      const raw = String(value).trim();
      if (!raw) return "";
      if (raw.startsWith("agent:")) return parseSessionIdentity(raw).residentAgentId;
      const stripped = raw.replace(/^resident@/, "");
      const slash = stripped.indexOf("/");
      return (slash >= 0 ? stripped.slice(0, slash) : stripped).trim();
    };

    const canonicalVisibleAgentId = (value: unknown): string => {
      if (typeof value !== "string") return "";
      const raw = String(value).trim();
      if (!raw) return "";
      const canonical = canonicalResidentAgentId(raw);
      if (!canonical) return "";
      const lower = canonical.toLowerCase();
      if (lower === "subagent" || lower === "spawn" || lower === "cron" || lower === "discord") return "";
      return canonical;
    };

    type PendingSpawnAttribution = {
      actorId: string;
      parentSessionKey: string;
      residentAgentId: string;
      label?: string;
      task?: string;
      source: "explicit" | "inferred";
      createdAt: number;
    };

    const spawnedSessionAgentIds = new Map<string, string>();
    const pendingSpawnAttributionsByParent = new Map<string, PendingSpawnAttribution[]>();
    const pendingSpawnAttributionsByResident = new Map<string, PendingSpawnAttribution[]>();
    const spawnAttributionStatePath = join(rootUserDir, "spawn-attribution-state.json");

    const loadSpawnAttributionState = async () => {
      try {
        const txt = await fs.readFile(spawnAttributionStatePath, "utf8");
        const data: any = JSON.parse(txt);
        spawnedSessionAgentIds.clear();
        pendingSpawnAttributionsByParent.clear();
        pendingSpawnAttributionsByResident.clear();

        const spawned = data?.spawnedSessionAgentIds;
        if (spawned && typeof spawned === "object") {
          for (const [key, value] of Object.entries(spawned)) {
            const sk = typeof key === "string" ? key.trim() : "";
            const agentId = canonicalVisibleAgentId(value);
            if (sk && agentId) spawnedSessionAgentIds.set(sk, agentId);
          }
        }

        const pending = Array.isArray(data?.pending) ? data.pending : [];
        for (const raw of pending) {
          const parentSessionKey = typeof raw?.parentSessionKey === "string" ? raw.parentSessionKey.trim() : "";
          const residentAgentId = canonicalResidentAgentId(raw?.residentAgentId || parentSessionKey);
          const actorId = canonicalVisibleAgentId(raw?.actorId);
          if (!parentSessionKey || !residentAgentId || !actorId) continue;
          const entry: PendingSpawnAttribution = {
            actorId,
            parentSessionKey,
            residentAgentId,
            label: normalizeSpawnText(raw?.label, 120) || undefined,
            task: normalizeSpawnText(raw?.task, 240) || undefined,
            source: raw?.source === "explicit" ? "explicit" : "inferred",
            createdAt: typeof raw?.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : nowMs(),
          };
          enqueuePendingSpawnAttribution(pendingSpawnAttributionsByParent, parentSessionKey, entry);
          enqueuePendingSpawnAttribution(pendingSpawnAttributionsByResident, residentAgentId, entry);
        }
      } catch {}
    };

    const persistSpawnAttributionState = async () => {
      try {
        const pending: PendingSpawnAttribution[] = [];
        for (const queue of pendingSpawnAttributionsByParent.values()) {
          for (const entry of queue) pending.push(entry);
        }
        await fs.writeFile(spawnAttributionStatePath, JSON.stringify({
          spawnedSessionAgentIds: Object.fromEntries(spawnedSessionAgentIds.entries()),
          pending,
        }, null, 2));
      } catch {}
    };

    const normalizeSpawnText = (value: unknown, maxLen = 240): string => {
      if (typeof value !== "string") return "";
      return value.replace(/\s+/g, " ").trim().slice(0, maxLen);
    };

    const resolveExplicitSpawnAgentId = (payload: any): string => {
      const explicitCandidates = [
        payload?.agentId,
        payload?.spawnAgentId,
        payload?.requestedAgentId,
      ];
      for (const candidate of explicitCandidates) {
        const visible = canonicalVisibleAgentId(candidate);
        if (visible) return visible;
      }
      return "";
    };

    const inferSpawnActorId = (payload: any): string => {
      const explicit = resolveExplicitSpawnAgentId(payload);
      if (explicit) return explicit;
      const text = [payload?.label, payload?.task, payload?.prompt, payload?.instructions]
        .map((part) => normalizeSpawnText(part, 400).toLowerCase())
        .filter(Boolean)
        .join("\n");
      if (!text) return "";
      const actorHints: Array<{ actorId: string; patterns: RegExp[] }> = [
        {
          actorId: "qa_agent",
          patterns: [
            /\bqa[_ -]?agent\b/i,
            /\byou are\s+qa[_ -]?agent\b/i,
            /你是\s*qa[_ -]?agent/i,
            /角色[:：]?\s*qa[_ -]?agent/i,
          ],
        },
        {
          actorId: "coding_agent",
          patterns: [
            /\bcoding[_ -]?agent\b/i,
            /\byou are\s+coding[_ -]?agent\b/i,
            /你是\s*coding[_ -]?agent/i,
            /角色[:：]?\s*coding[_ -]?agent/i,
          ],
        },
      ];
      for (const hint of actorHints) {
        if (hint.patterns.some((pattern) => pattern.test(text))) return hint.actorId;
      }
      return "";
    };

    const resolveRequestedSpawnAgentId = (payload: any): string => inferSpawnActorId(payload);

    const enqueuePendingSpawnAttribution = (bucket: Map<string, PendingSpawnAttribution[]>, key: string, entry: PendingSpawnAttribution) => {
      bucket.set(key, (bucket.get(key) || []).concat([entry]));
    };

    const dequeuePendingSpawnAttribution = (bucket: Map<string, PendingSpawnAttribution[]>, key: string): PendingSpawnAttribution | undefined => {
      const queue = bucket.get(key) || [];
      const next = queue.shift();
      if (queue.length) bucket.set(key, queue);
      else bucket.delete(key);
      return next;
    };

    const forgetPendingSpawnAttributionFromResident = (residentAgentId: string, entry: PendingSpawnAttribution) => {
      const queue = pendingSpawnAttributionsByResident.get(residentAgentId) || [];
      const next = queue.filter((candidate) => candidate !== entry);
      if (next.length) pendingSpawnAttributionsByResident.set(residentAgentId, next);
      else pendingSpawnAttributionsByResident.delete(residentAgentId);
    };

    const rememberPendingSpawnAttribution = async (parentSessionKey: unknown, payload: any): Promise<PendingSpawnAttribution | undefined> => {
      await loadSpawnAttributionState();
      const sk = typeof parentSessionKey === "string" ? String(parentSessionKey).trim() : "";
      if (!sk) return undefined;
      const actorId = inferSpawnActorId(payload);
      if (!actorId) return undefined;
      const residentAgentId = canonicalResidentAgentId(sk);
      if (!residentAgentId) return undefined;
      const explicit = resolveExplicitSpawnAgentId(payload);
      const entry: PendingSpawnAttribution = {
        actorId,
        parentSessionKey: sk,
        residentAgentId,
        label: normalizeSpawnText(payload?.label, 120) || undefined,
        task: normalizeSpawnText(payload?.task, 240) || undefined,
        source: explicit ? "explicit" : "inferred",
        createdAt: nowMs(),
      };
      enqueuePendingSpawnAttribution(pendingSpawnAttributionsByParent, sk, entry);
      enqueuePendingSpawnAttribution(pendingSpawnAttributionsByResident, residentAgentId, entry);
      await persistSpawnAttributionState();
      return entry;
    };

    const consumePendingSpawnAttribution = async (parentSessionKey: unknown): Promise<PendingSpawnAttribution | undefined> => {
      await loadSpawnAttributionState();
      const sk = typeof parentSessionKey === "string" ? String(parentSessionKey).trim() : "";
      if (!sk) return undefined;
      const next = dequeuePendingSpawnAttribution(pendingSpawnAttributionsByParent, sk);
      if (!next) return undefined;
      forgetPendingSpawnAttributionFromResident(next.residentAgentId, next);
      await persistSpawnAttributionState();
      return next;
    };

    const adoptPendingSpawnAttributionForSession = async (sessionKey: unknown, residentAgentId: unknown): Promise<PendingSpawnAttribution | undefined> => {
      await loadSpawnAttributionState();
      const sk = typeof sessionKey === "string" ? String(sessionKey).trim() : "";
      if (!sk) return undefined;
      const existingActorId = spawnedSessionAgentIds.get(sk);
      if (existingActorId) {
        return {
          actorId: existingActorId,
          parentSessionKey: "",
          residentAgentId: canonicalResidentAgentId(residentAgentId),
          source: "explicit",
          createdAt: 0,
        };
      }
      const resident = canonicalVisibleAgentId(residentAgentId);
      if (!resident) return undefined;
      const adopted = dequeuePendingSpawnAttribution(pendingSpawnAttributionsByResident, resident);
      if (!adopted) return undefined;
      spawnedSessionAgentIds.set(sk, adopted.actorId);
      const parentQueue = pendingSpawnAttributionsByParent.get(adopted.parentSessionKey) || [];
      const nextParentQueue = parentQueue.filter((candidate) => candidate !== adopted);
      if (nextParentQueue.length) pendingSpawnAttributionsByParent.set(adopted.parentSessionKey, nextParentQueue);
      else pendingSpawnAttributionsByParent.delete(adopted.parentSessionKey);
      await persistSpawnAttributionState();
      return adopted;
    };

    const rememberSpawnedSessionAgent = async (sessionKey: unknown, agentId: unknown) => {
      await loadSpawnAttributionState();
      const sk = typeof sessionKey === "string" ? String(sessionKey).trim() : "";
      const visible = canonicalVisibleAgentId(agentId);
      if (!sk || !visible) return;
      spawnedSessionAgentIds.set(sk, visible);
      await persistSpawnAttributionState();
    };

    const resolveSpawnedChildSessionKey = (event: any, ctx: any): string => {
      const parentSessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
      const candidates = [
        event?.result?.childSessionKey,
        event?.childSessionKey,
        event?.result?.sessionKey,
      ];
      for (const candidate of candidates) {
        const sk = typeof candidate === "string" ? candidate.trim() : "";
        if (!sk || sk === parentSessionKey) continue;
        const parsed = parseSessionIdentity(sk);
        if (parsed.lane === "subagent" || parsed.lane === "cron") return sk;
      }
      return "";
    };

    const resolveFeedAgentIdentity = async (ctx: any): Promise<{ agentId: string; rawAgentId?: string }> => {
      const parsed = parseSessionIdentity(ctx?.sessionKey, ctx?.agentId);
      const rawSessionAgentId = parsed.agentId;
      const childSessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
      const adoptedAttribution = childSessionKey && parsed.lane !== "main"
        ? await adoptPendingSpawnAttributionForSession(childSessionKey, parsed.residentAgentId)
        : undefined;
      const spawnedVisible = childSessionKey
        ? (spawnedSessionAgentIds.get(childSessionKey) || adoptedAttribution?.actorId || "")
        : "";
      if (spawnedVisible) {
        return {
          agentId: spawnedVisible,
          rawAgentId: rawSessionAgentId && rawSessionAgentId !== spawnedVisible ? rawSessionAgentId : undefined,
        };
      }
      const explicitCandidates = [
        ctx?.agentId,
        ctx?.agent?.id,
        ctx?.agent?.agentId,
        ctx?.session?.agentId,
        ctx?.residentAgentId,
      ];
      for (const candidate of explicitCandidates) {
        const visible = canonicalVisibleAgentId(candidate);
        if (visible) {
          const raw = typeof candidate === "string" ? String(candidate).trim() : "";
          return { agentId: visible, rawAgentId: raw && raw !== visible ? raw : rawSessionAgentId !== visible ? rawSessionAgentId : undefined };
        }
      }
      const fallback = canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || "main";
      return { agentId: fallback, rawAgentId: rawSessionAgentId && rawSessionAgentId !== fallback ? rawSessionAgentId : undefined };
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

      // Persist to snapshot for API consumers.
      try {
        const prev = snap.agents[agentId];
        if (!prev || prev.state !== next) {
          snap.agents[agentId] = { state: next, sinceMs: t, lastEventMs: t, details: details ?? null };
        } else {
          snap.agents[agentId] = { ...prev, lastEventMs: t, details: details ?? prev.details };
        }
        snap.updatedAtMs = t;
        writeSnapshotSoon();
      } catch {}

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

    const setIdleWithCooldown = (agentId: string, overrideMs?: number) => {
      const row = ensure(agentId);
      const seq = row.seq + 1;
      row.seq = seq;
      const scheduledAt = nowMs();
      const waitMs = (typeof overrideMs === "number" && Number.isFinite(overrideMs)) ? Math.max(0, overrideMs) : cooldownMs;
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
        try {
          const prev = snap.agents[agentId];
          snap.agents[agentId] = {
            ...(prev || {}),
            state: "idle",
            sinceMs: t,
            lastEventMs: t,
            details: null,
          };
          snap.updatedAtMs = t;
          writeSnapshotSoon();
        } catch {}
      }, waitMs);
      // Update lastEvent so API knows something just happened.
      row.lastEventMs = scheduledAt;
    };

    // Hooks → real runtime state
    const resolveAgentId = async (ctx: any): Promise<string> => {
      const identity = await resolveFeedAgentIdentity(ctx);
      return identity.agentId;
    };

    api.on("before_agent_start", async (_event, ctx) => {
      const agentIdentity = await resolveFeedAgentIdentity(ctx);
      const agentId = agentIdentity.agentId;
      // api.logger.info("[lobster-room] hook before_agent_start", { buildTag: BUILD_TAG, agentId, sessionKey: ctx?.sessionKey });
      pushEvent("before_agent_start", { agentId, data: { sessionKey: ctx?.sessionKey, messageProvider: ctx?.messageProvider } });
      pushFeed({ ts: nowMs(), kind: "before_agent_start", agentId, rawAgentId: agentIdentity.rawAgentId, sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined });
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, messageProvider: ctx?.messageProvider });
    });

    api.on("before_tool_call", async (event, ctx) => {
      const toolName = event?.toolName || event?.tool || event?.name;
      const p = event?.params || null;
      const pendingAttribution = toolName === "sessions_spawn"
        ? await rememberPendingSpawnAttribution(ctx?.sessionKey, p)
        : undefined;
      const agentIdentity = await resolveFeedAgentIdentity(ctx);
      const agentId = agentIdentity.agentId;
      const internalObservation = isInternalObservationToolCall(toolName, ctx);
      // api.logger.info("[lobster-room] hook before_tool_call", { buildTag: BUILD_TAG, agentId, toolName, sessionKey: ctx?.sessionKey });

      // Capture high-value params for debugging (truncate aggressively).
      let toolData: any = { toolName, sessionKey: ctx?.sessionKey };

      if (toolName === "exec") {
        const cmd = (p && (p.command || p.cmd || p.args)) || null;
        toolData.command = cmd;
      }

      // Show what spawned the subagent.
      if (toolName === "sessions_spawn") {
        const requestedSpawnAgentId = pendingAttribution?.actorId || resolveRequestedSpawnAgentId(p);
        toolData.spawnAgentId = requestedSpawnAgentId || p?.agentId || p?.spawnAgentId;
        toolData.label = p?.label;
        const task = typeof p?.task === "string" ? p.task : "";
        toolData.task = task ? task.slice(0, 160) : undefined;
        if (!toolData.task && pendingAttribution?.task) toolData.task = pendingAttribution.task;
      }

      // Show message preview when using the message tool.
      if (toolName === "message") {
        toolData.channel = p?.channel;
        toolData.target = p?.to || p?.target;
        const msg = typeof p?.message === "string" ? p.message : "";
        toolData.message = msg ? msg.slice(0, 160) : undefined;
      }

      if (toolName === "web_fetch") {
        toolData.url = p?.url;
      }

      if (!internalObservation) {
        pushEvent("before_tool_call", { agentId, data: toolData });
      }
      if (!isLowSignalObservationTool(toolName) && !internalObservation) {
        pushFeed({
          ts: nowMs(),
          kind: "before_tool_call",
          agentId,
          rawAgentId: agentIdentity.rawAgentId,
          sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
          toolName: typeof toolName === "string" ? toolName : undefined,
          details: {
            command: toolName === "exec" ? coerceStr(toolData.command, 240) : undefined,
            url: toolName === "web_fetch" ? coerceStr(toolData.url, 240) : undefined,
            label: toolName === "sessions_spawn" ? coerceStr(toolData.label, 120) : undefined,
            task: toolName === "sessions_spawn" ? coerceStr(toolData.task, 180) : undefined,
            spawnAgentId: toolName === "sessions_spawn" ? coerceStr(toolData.spawnAgentId, 80) : undefined,
          },
        });
      }
      if (internalObservation) return;
      if (isLowSignalObservationTool(toolName)) {
        setState(agentId, "thinking", { toolName, sessionKey: ctx?.sessionKey, lowSignal: true });
        return;
      }
      setState(agentId, "tool", { toolName, sessionKey: ctx?.sessionKey });
    });

    api.on("after_tool_call", async (event, ctx) => {
      const agentIdentity = await resolveFeedAgentIdentity(ctx);
      const agentId = agentIdentity.agentId;
      const toolName = event?.toolName;
      const internalObservation = isInternalObservationToolCall(toolName, ctx);
      if (!internalObservation) {
        pushEvent("after_tool_call", { agentId, data: { toolName, durationMs: event?.durationMs } });
      }

      // Best-effort: capture a safe preview of sessions_spawn final assistant output (if the runtime provides it).
      // This helps surface sub-agent completions even when no message_sent hook is emitted.
      let outputPreview: string | undefined = undefined;
      if (toolName === "sessions_spawn") {
        const childSessionKey = resolveSpawnedChildSessionKey(event, ctx);
        if (childSessionKey) {
          const pendingAttribution = await consumePendingSpawnAttribution(ctx?.sessionKey);
          const requestedSpawnAgentId = resolveRequestedSpawnAgentId(event?.params)
            || resolveRequestedSpawnAgentId(event?.result)
            || resolveRequestedSpawnAgentId(event)
            || pendingAttribution?.actorId;
          await rememberSpawnedSessionAgent(childSessionKey, requestedSpawnAgentId);
        }
        const candidates = [
          event?.result?.message,
          event?.result?.content,
          event?.result?.output,
          event?.result?.final,
          event?.result?.text,
          event?.output,
        ];
        for (const c of candidates) {
          if (typeof c === "string" && c.trim()) {
            outputPreview = redactSecretsInText(c.trim()).slice(0, 220);
            break;
          }
        }
      }

      if (!isLowSignalObservationTool(toolName) && !internalObservation) {
        pushFeed({
          ts: nowMs(),
          kind: "after_tool_call",
          agentId,
          rawAgentId: agentIdentity.rawAgentId,
          sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
          toolName: typeof toolName === "string" ? toolName : undefined,
          durationMs: typeof event?.durationMs === "number" ? event.durationMs : undefined,
          details: outputPreview ? { outputPreview } : undefined,
        });
      }
      if (internalObservation) return;
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, lowSignal: isLowSignalObservationTool(toolName) || undefined });
    });

    // Some tools may not reliably fire after_tool_call in all paths; use persist as a backup.
    api.on("tool_result_persist", async (event, ctx) => {
      const agentIdentity = await resolveFeedAgentIdentity(ctx);
      const agentId = agentIdentity.agentId;
      const toolName = event?.toolName;
      const internalObservation = isInternalObservationToolCall(toolName, ctx);
      if (!internalObservation) {
        pushEvent("tool_result_persist", {
          agentId,
          data: { toolName, toolCallId: event?.toolCallId, isSynthetic: event?.isSynthetic },
        });
        pushFeed({
          ts: nowMs(),
          kind: "tool_result_persist",
          agentId,
          rawAgentId: agentIdentity.rawAgentId,
          sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
          toolName: typeof toolName === "string" ? toolName : undefined,
          details: {
            toolCallId: typeof event?.toolCallId === "string" ? event?.toolCallId : undefined,
            isSynthetic: !!event?.isSynthetic,
          },
        });
      }
      if (internalObservation) return;
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, persisted: true, lowSignal: isLowSignalObservationTool(toolName) || undefined });
    });

    api.on("message_sending", (event, ctx) => {
      // Message hooks do not carry agentId in the event/ctx today.
      const agentId = "main";

      const capturePreview = !!api.config?.debugCaptureMessagePreview;
      const data: any = { to: event?.to, channelId: ctx?.channelId };
      if (capturePreview) {
        data.contentPreview = String(event?.content || "").slice(0, 80);
      }

      pushEvent("message_sending", { agentId, data });
      pushFeed({
        ts: nowMs(),
        kind: "message_sending",
        agentId,
        channelId: typeof ctx?.channelId === "string" ? ctx.channelId : undefined,
        to: typeof event?.to === "string" ? redactSecretsInText(event.to) : undefined,
      });
      setState(agentId, "reply", { to: event?.to, channelId: ctx?.channelId, conversationId: ctx?.conversationId });
    });

    api.on("message_sent", (event, ctx) => {
      const agentId = "main";
      pushEvent("message_sent", { agentId, data: { to: event?.to, success: event?.success, channelId: ctx?.channelId } });
      pushFeed({
        ts: nowMs(),
        kind: "message_sent",
        agentId,
        channelId: typeof ctx?.channelId === "string" ? ctx.channelId : undefined,
        to: typeof event?.to === "string" ? redactSecretsInText(event.to) : undefined,
        success: typeof event?.success === "boolean" ? event.success : undefined,
        error: typeof event?.error === "string" ? redactSecretsInText(event.error) : undefined,
      });
      if (event?.success === false) {
        setState(agentId, "error", { error: event?.error || "message_sent failed", to: event?.to, channelId: ctx?.channelId });
      }
      setIdleWithCooldown(agentId);
    });

    api.on("agent_end", async (event, ctx) => {
      const agentIdentity = await resolveFeedAgentIdentity(ctx);
      const agentId = agentIdentity.agentId;
      pushEvent("agent_end", { agentId, data: { success: event?.success, error: event?.error, sessionKey: ctx?.sessionKey } });
      pushFeed({
        ts: nowMs(),
        kind: "agent_end",
        agentId,
        rawAgentId: agentIdentity.rawAgentId,
        sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
        success: typeof event?.success === "boolean" ? event.success : undefined,
        error: typeof event?.error === "string" ? redactSecretsInText(event.error) : undefined,
      });

      if (event?.success === false) {
        setState(agentId, "error", { error: event?.error || "agent_end: unsuccessful" });
        setTimeout(() => setIdleWithCooldown(agentId), cooldownMs);
        return;
      }

      setState(agentId, "reply", { synthetic: true });
      setIdleWithCooldown(agentId, replyCooldownMs);
    });

    // --- Local assets via API (most reliable across gateway routers) ---
    // Usage: /lobster-room/api/asset?path=furniture/sofa.svg
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/asset",
      handler: async (req, res) => {
        const url = readRequestUrl(req);
        let rel = (url.searchParams.get("path") || "").trim();
        try {
          rel = decodeURIComponent(rel);
        } catch {}
        rel = rel.replace(/^\/+/, "");
        if (!rel || rel.includes("..") || rel.includes("\\")) {
          res.statusCode = 400;
          res.end("bad_request");
          return true;
        }
        if (!rel.startsWith("furniture/")) {
          res.statusCode = 403;
          res.end("forbidden");
          return true;
        }
        const ct = contentTypeByExt(extname(rel));
        if (!ct) {
          res.statusCode = 415;
          res.end("unsupported_media_type");
          return true;
        }
        try {
          const buf = await fs.readFile(join(pluginDir, "assets", rel));
          res.statusCode = 200;
          res.setHeader("content-type", ct);
          res.setHeader("cache-control", "no-store");
          res.end(buf);
        } catch {
          res.statusCode = 404;
          res.end("not_found");
        }
        return true;
      },
    });

    // HTTP: portal
    registerSafePluginRoute(api, {
      path: "/lobster-room/",
      match: "prefix",
      handler: async (_req, res) => {
        try {
          const html = await fs.readFile(portalHtmlPath, "utf8");
          const hydratedHtml = html
            .replaceAll("__LOBSTER_ROOM_UI_VERSION__", FEED_UI_VERSION)
            .replaceAll("__LOBSTER_ROOM_API_BASE__", "/lobster-room/");
          res.statusCode = 200;
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(hydratedHtml);
        } catch (err: any) {
          sendJson(res, 500, {
            ok: false,
            error: { type: "asset_read_failed", message: String(err?.message || err) },
          });
        }
        return true;
      },
    });

    // NOTE: Message Feed API is multiplexed via /lobster-room/api/lobster-room (op=feedGet/feedSummarize)
    // because some gateway/proxy setups only reliably route this single plugin API endpoint.

    registerSafePluginRoute(api, {
      path: "/lobster-room/api/feed/summarize",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() !== "POST") {
          sendJson(res, 405, { ok: false, error: "method_not_allowed" });
          return true;
        }

        // Resolve an auth token for calling the local gateway LLM endpoint.
        // Experience-first fallback order:
        // 1) api.config.llmToken (explicit override)
        // 2) api.config.llmTokenEnv (explicit env)
        // 3) process.env.OPENCLAW_GATEWAY_TOKEN / OPENCLAW_TOKEN (if present)
        // 4) ~/.openclaw/openclaw.json gateway.auth.token (best-effort)
        const readGatewayTokenFromConfigFile = async (): Promise<string> => {
          try {
            const home = (process.env.HOME || "").trim() || "/home/node";
            const p = join(home, ".openclaw", "openclaw.json");
            const txt = await fs.readFile(p, "utf8");
            const obj: any = JSON.parse(txt);
            const tok = obj?.gateway?.auth?.token;
            return (typeof tok === "string" ? tok.trim() : "");
          } catch {
            return "";
          }
        };

        let llmToken =
          (typeof api.config?.llmToken === "string" && api.config.llmToken.trim())
            ? api.config.llmToken.trim()
            : (typeof api.config?.llmTokenEnv === "string" && api.config.llmTokenEnv.trim())
              ? (process.env[api.config.llmTokenEnv.trim()] || "").trim()
              : (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN || "").trim();

        if (!llmToken) {
          llmToken = await readGatewayTokenFromConfigFile();
        }

        if (!llmToken) {
          sendJson(res, 200, { ok: false, error: "llm_not_configured" });
          return true;
        }

        let payload: any = null;
        try {
          payload = JSON.parse((await readBody(req, 512 * 1024)).toString("utf8"));
        } catch {
          payload = null;
        }

        const sessionKey = typeof payload?.sessionKey === "string" ? payload.sessionKey.trim() : "";
        const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
        const maxItems = Math.max(10, Math.min(500, Number(payload?.maxItems) || 200));
        const windowMs = Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Number(payload?.timeWindowMs) || 60 * 60 * 1000));
        const sinceMs = typeof payload?.sinceMs === "number" && Number.isFinite(payload.sinceMs)
          ? payload.sinceMs
          : (nowMs() - windowMs);

        let items = feedBuf.slice();
        if (sessionKey) items = items.filter((x) => x.sessionKey === sessionKey);
        else {
          if (agentId) items = items.filter((x) => x.agentId === agentId);
          items = items.filter((x) => x.ts >= sinceMs);
        }
        items = items.slice(-maxItems);

        const lines = items
          .sort((a, b) => a.ts - b.ts)
          .map((it) => {
            const iso = new Date(it.ts).toISOString();
            const agent = it.agentId ? `@${it.agentId}` : "";
            const extra: string[] = [];
            if (it.toolName) extra.push(`tool=${it.toolName}`);
            if (typeof it.durationMs === "number") extra.push(`durMs=${Math.round(it.durationMs)}`);
            if (typeof it.success === "boolean") extra.push(`ok=${it.success}`);
            if (it.error) extra.push(`err=${redactSecretsInText(it.error)}`);
            return `${iso} ${agent} [${it.kind}] ${feedPreview(it)}${extra.length ? ` (${extra.join(", ")})` : ""}`.trim();
          });

        const model = (typeof api.config?.llmModel === "string" && api.config.llmModel.trim()) ? api.config.llmModel.trim() : "gpt-4o-mini";

        // Call local gateway OpenAI-compatible endpoint.
        const origin = readRequestUrl(req);
        const llmUrl = new URL("/v1/chat/completions", origin);

        try {
          const r = await fetch(llmUrl.toString(), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${llmToken}`,
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              messages: [
                {
                  role: "system",
                  content:
                    "Summarize an internal agent event feed in plain language for a human. Be concise and factual; do not invent details. Include: what happened, outcome, any errors, and suggested next actions. Output plain text.",
                },
                {
                  role: "user",
                  content:
                    `Summarize the following event timeline.\n\n${sessionKey ? `Session: ${sessionKey}\n` : agentId ? `Agent: ${agentId}\n` : ""}Items: ${lines.length}\n\n` +
                    lines.join("\n"),
                },
              ],
            }),
          });

          if (!r.ok) {
            const txt = await r.text().catch(() => "");
            sendJson(res, 200, { ok: false, error: "llm_failed", status: r.status, detail: txt.slice(0, 400) });
            return true;
          }

          const data: any = await r.json().catch(() => null);
          const summary = data?.choices?.[0]?.message?.content;
          if (typeof summary !== "string" || !summary.trim()) {
            sendJson(res, 200, { ok: false, error: "llm_no_summary" });
            return true;
          }

          sendJson(res, 200, { ok: true, summary: summary.trim(), model });
        } catch (err: any) {
          sendJson(res, 200, { ok: false, error: "llm_unreachable", detail: String(err?.message || err) });
        }
        return true;
      },
    });

    // HTTP: API
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/lobster-room",
      handler: async (req, res) => {
        const url = readRequestUrl(req);

        // NOTE: In this deployment, only this exact /api/lobster-room route reliably matches.
        // Some proxies strip querystrings before reaching plugin routes, so we multiplex via POST body/content-type.
        const roomMetaPath = join(rootUserDir, "room-meta.json");
        const readRoomMeta = async (): Promise<{ file?: string; updatedAt?: number } | null> => {
          try {
            const txt = await fs.readFile(roomMetaPath, "utf8");
            const obj = JSON.parse(txt);
            if (!obj || typeof obj !== "object") return null;
            return {
              file: typeof (obj as any).file === "string" ? (obj as any).file : undefined,
              updatedAt: typeof (obj as any).updatedAt === "number" ? (obj as any).updatedAt : undefined,
            };
          } catch {
            return null;
          }
        };

        // (1) Upload: POST multipart/form-data
        if ((req.method || "GET").toUpperCase() === "POST") {
          const ctype = String(req.headers["content-type"] || "");
          if (/multipart\/form-data/i.test(ctype)) {
            const m = ctype.match(/multipart\/form-data;\s*boundary=([^;]+)/i);
            if (!m) {
              sendJson(res, 400, { ok: false, error: "expected_multipart" });
              return true;
            }
            const boundary = m[1];
            try {
              await fs.mkdir(rootUserDir, { recursive: true });
              const body = await readBody(req, 12 * 1024 * 1024);
              const filePart = parseMultipartFile(body, boundary);
              const ext = extFromContentType(filePart.contentType) || extname(filePart.filename).toLowerCase();
              if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
                sendJson(res, 415, { ok: false, error: "unsupported_image_type", contentType: filePart.contentType });
                return true;
              }
              const outExt = ext === ".jpeg" ? ".jpg" : ext;
              const outFile = `room${outExt}`;
              await fs.writeFile(join(rootUserDir, outFile), filePart.data);
              await fs.writeFile(roomMetaPath, JSON.stringify({ file: outFile, updatedAt: Date.now() }, null, 2));
              sendJson(res, 200, { ok: true, file: outFile });
            } catch (err: any) {
              sendJson(res, 500, { ok: false, error: String(err?.message || err) });
            }
            return true;
          }

          // (2) Control ops: POST application/json
          if (/application\/json/i.test(ctype)) {
            let payload: any = null;
            try {
              payload = JSON.parse((await readBody(req, 512 * 1024)).toString("utf8"));
            } catch {
              payload = null;
            }
            const op = String(payload?.op || "").trim();

            // --- Message Feed ops (multiplexed) ---
            if (op === "feedGet") {
              // api.logger.info("[lobster-room] feedGet ENTERED", { op, payload });
              try {
              const limit = Math.max(1, Math.min(500, Number(payload?.limit) || 120));
              const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
              const kind = typeof payload?.kind === "string" ? payload.kind.trim() : "";
              const includeRaw = !!payload?.includeRaw;

              let items = feedBuf.slice();
              if (agentId) items = items.filter((x) => x.agentId === agentId);
              if (kind) items = items.filter((x) => x.kind === (kind as any));
              items = items.slice(-limit);

              // Apply retention filter
              const activeRoomId = await getActiveRoomId();
              const retentionMs = await readRetention(activeRoomId);
              if (retentionMs > 0) {
                const cutoff = Date.now() - retentionMs;
                items = items.filter((x) => x.ts >= cutoff);
              }

              const tasks = groupFeedIntoTasks(items, { includeRaw });

              // Latest preview = most recent event.
              const last = items.length ? items[items.length - 1] : null;

              // api.logger.info("[lobster-room] feedGet before sendJson", { itemsLen: items.length, tasksLen: tasks.length });
              sendJson(res, 200, {
                ok: true,
                buildTagFeed: FEED_UI_VERSION,
                latest: last ? sanitizeFeedItemForApi(last, true) : null,
                tasks: tasks.map((t) => ({
                  id: t.id,
                  sessionKey: t.sessionKey,
                  agentId: visibleFeedAgentId(t.agentId, "unknown"),
                  startTs: t.startTs,
                  endTs: t.endTs,
                  status: t.status,
                  title: t.title,
                  summary: t.summary,
                  items: t.items ? t.items.map((it) => sanitizeFeedItemForApi(it, includeRaw)) : undefined,
                })),
                rows: items.slice().reverse().map((it) => sanitizeFeedItemForApi(it, false)),
                items: includeRaw ? items.slice().reverse().map((it) => sanitizeFeedItemForApi(it, true)) : undefined,
              });
              // api.logger.info("[lobster-room] feedGet sent", { itemsLen: items.length, tasksLen: tasks.length });
              } catch (err: any) {
                api.logger.warn("[lobster-room] feedGet failed", { error: String(err?.message || err), stack: err?.stack });
                sendJson(res, 500, { ok: false, error: "feedGet_failed: " + String(err?.message || err), path: "/lobster-room/api/lobster-room" });
              }
              return true;
            }

            if (op === "feedSummarize") {
              // NOTE: We re-use the same logic as /lobster-room/api/feed/summarize,
              // but route reliability is better here.

              // Resolve an auth token for calling the local gateway LLM endpoint.
              // Experience-first fallback order:
              // 1) api.config.llmToken (explicit override)
              // 2) api.config.llmTokenEnv (explicit env)
              // 3) process.env.OPENCLAW_GATEWAY_TOKEN / OPENCLAW_TOKEN (if present)
              // 4) ~/.openclaw/openclaw.json gateway.auth.token (best-effort)
              const readGatewayTokenFromConfigFile = async (): Promise<string> => {
                try {
                  const home = (process.env.HOME || "").trim() || "/home/node";
                  const p = join(home, ".openclaw", "openclaw.json");
                  const txt = await fs.readFile(p, "utf8");
                  const obj: any = JSON.parse(txt);
                  const tok = obj?.gateway?.auth?.token;
                  return (typeof tok === "string" ? tok.trim() : "");
                } catch {
                  return "";
                }
              };

              let llmToken =
                (typeof api.config?.llmToken === "string" && api.config.llmToken.trim())
                  ? api.config.llmToken.trim()
                  : (typeof api.config?.llmTokenEnv === "string" && api.config.llmTokenEnv.trim())
                    ? (process.env[api.config.llmTokenEnv.trim()] || "").trim()
                    : (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN || "").trim();

              if (!llmToken) {
                llmToken = await readGatewayTokenFromConfigFile();
              }

              if (!llmToken) {
                sendJson(res, 200, { ok: false, error: "llm_not_configured" });
                return true;
              }

              const sessionKey = typeof payload?.sessionKey === "string" ? payload.sessionKey.trim() : "";
              const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
              const maxItems = Math.max(10, Math.min(500, Number(payload?.maxItems) || 200));
              const windowMs = Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Number(payload?.timeWindowMs) || 60 * 60 * 1000));
              const sinceMs = typeof payload?.sinceMs === "number" && Number.isFinite(payload.sinceMs)
                ? payload.sinceMs
                : (nowMs() - windowMs);

              let items = feedBuf.slice();
              if (sessionKey) items = items.filter((x) => x.sessionKey === sessionKey);
              else {
                if (agentId) items = items.filter((x) => x.agentId === agentId);
                items = items.filter((x) => x.ts >= sinceMs);
              }
              items = items.slice(-maxItems);

              const lines = items
                .sort((a, b) => a.ts - b.ts)
                .map((it) => {
                  const iso = new Date(it.ts).toISOString();
                  const agent = it.agentId ? `@${it.agentId}` : "";
                  const extra: string[] = [];
                  if (it.toolName) extra.push(`tool=${it.toolName}`);
                  if (typeof it.durationMs === "number") extra.push(`durMs=${Math.round(it.durationMs)}`);
                  if (typeof it.success === "boolean") extra.push(`ok=${it.success}`);
                  if (it.error) extra.push(`err=${redactSecretsInText(it.error)}`);
                  return `${iso} ${agent} [${it.kind}] ${feedPreview(it)}${extra.length ? ` (${extra.join(", ")})` : ""}`.trim();
                });

              const model = (typeof api.config?.llmModel === "string" && api.config.llmModel.trim()) ? api.config.llmModel.trim() : "gpt-4o-mini";

              // Call local gateway OpenAI-compatible endpoint.
              const origin = readRequestUrl(req);
              const llmUrl = new URL("/v1/chat/completions", origin);

              try {
                const r = await fetch(llmUrl.toString(), {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${llmToken}`,
                  },
                  body: JSON.stringify({
                    model,
                    temperature: 0.2,
                    messages: [
                      {
                        role: "system",
                        content:
                          "Summarize an internal agent event feed in plain language for a human. Be concise and factual; do not invent details. Include: what happened, outcome, any errors, and suggested next actions. Output plain text.",
                      },
                      {
                        role: "user",
                        content:
                          `Summarize the following event timeline.\n\n${sessionKey ? `Session: ${sessionKey}\n` : agentId ? `Agent: ${agentId}\n` : ""}Items: ${lines.length}\n\n` +
                          lines.join("\n"),
                      },
                    ],
                  }),
                });

                if (!r.ok) {
                  const txt = await r.text().catch(() => "");
                  sendJson(res, 200, { ok: false, error: "llm_failed", status: r.status, detail: txt.slice(0, 400) });
                  return true;
                }

                const data: any = await r.json().catch(() => null);
                const summary = data?.choices?.[0]?.message?.content;
                if (typeof summary !== "string" || !summary.trim()) {
                  sendJson(res, 200, { ok: false, error: "llm_no_summary" });
                  return true;
                }

                sendJson(res, 200, { ok: true, summary: summary.trim(), model });
              } catch (err: any) {
                sendJson(res, 200, { ok: false, error: "llm_unreachable", detail: String(err?.message || err) });
              }
              return true;
            }

            if (op === "feedDevSpawn") {
              // Dev-only helper: spawn a non-main agent session so QA can validate multi-agent feed grouping.
              const spawnAgentId = typeof payload?.spawnAgentId === "string" ? payload.spawnAgentId.trim() : "coding_agent";
              const label = typeof payload?.label === "string" ? payload.label.trim().slice(0, 120) : "QA: multi-agent validation";
              const task = typeof payload?.task === "string" ? payload.task.trim().slice(0, 400) : "Quick QA test task: respond with a short message and then finish.";

              // Resolve a gateway token (best-effort). Some QA envs don't have api.config.gateway.auth.token wired.
              const readGatewayTokenFromConfigFile = async (): Promise<string> => {
                try {
                  const home = (process.env.HOME || "").trim() || "/home/node";
                  const p = join(home, ".openclaw", "openclaw.json");
                  const txt = await fs.readFile(p, "utf8");
                  const obj: any = JSON.parse(txt);
                  const tok = obj?.gateway?.auth?.token;
                  return (typeof tok === "string" ? tok.trim() : "");
                } catch {
                  return "";
                }
              };

              let gatewayToken =
                (typeof api.config?.gateway?.auth?.token === "string" && api.config.gateway.auth.token.trim())
                  ? api.config.gateway.auth.token.trim()
                  : (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.OPENCLAW_TOKEN || "").trim();

              if (!gatewayToken) {
                gatewayToken = await readGatewayTokenFromConfigFile();
              }

              // Prefer loopback to avoid any external proxy auth/header rewriting.
              // Keep request-origin as a fallback for setups where the gateway isn't bound to 18789.
              const origin = readRequestUrl(req);
              const invokeCandidates = ["http://127.0.0.1:18789/tools/invoke", new URL("/tools/invoke", origin).toString()];

              const invokeOnce = async (invokeUrl: string) => {
                const headers: Record<string, string> = { "content-type": "application/json" };
                // /tools/invoke expects Authorization: Bearer <gateway token>
                if (gatewayToken) headers["Authorization"] = `Bearer ${gatewayToken}`;

                const resp = await fetch(invokeUrl, {
                  method: "POST",
                  headers,
                  body: JSON.stringify({
                    tool: "sessions_spawn",
                    // Be liberal in what we send: different runtimes have used different arg names.
                    args: { spawnAgentId, agentId: spawnAgentId, label, task },
                  }),
                });

                const txt = await resp.text().catch(() => "");
                let data: any = null;
                try {
                  data = txt ? JSON.parse(txt) : null;
                } catch {
                  data = null;
                }

                if (!resp.ok || !data?.ok) {
                  let detail = "";
                  if (data && typeof data === "object") {
                    if (typeof (data as any).detail === "string") detail = (data as any).detail;
                    else if (typeof (data as any).message === "string") detail = (data as any).message;
                    else if (typeof (data as any).error === "string") detail = (data as any).error;
                    else {
                      try { detail = JSON.stringify(data); } catch { detail = ""; }
                    }
                  }
                  if (!detail) detail = txt || "";

                  return {
                    ok: false,
                    status: resp.status,
                    error: String(data?.error || (resp.ok ? "invoke_failed" : "invoke_http_error")),
                    detail: (String(detail).trim() || "").slice(0, 800),
                  };
                }

                return { ok: true, result: data.result || null };
              };

              try {
                let lastErr: any = null;
                for (const invokeUrl of invokeCandidates) {
                  try {
                    const r = await invokeOnce(invokeUrl);
                    if (r.ok) {
                      sendJson(res, 200, { ok: true, result: r.result || null });
                      return true;
                    }
                    lastErr = { invokeUrl, ...r };
                  } catch (err: any) {
                    lastErr = { invokeUrl, ok: false, error: "spawn_unreachable", detail: String(err?.message || err) };
                  }
                }

                sendJson(res, 200, {
                  ok: false,
                  error: "spawn_failed",
                  detail: (lastErr && lastErr.detail) ? String(lastErr.detail) : "invoke_failed",
                  status: (lastErr && typeof lastErr.status === "number") ? lastErr.status : undefined,
                });
              } catch (err: any) {
                sendJson(res, 200, { ok: false, error: "spawn_unreachable", detail: String(err?.message || err) });
              }
              return true;
            }

            if (op === "roomImageInfo") {
              const meta = await readRoomMeta();
              sendJson(res, 200, { ok: true, exists: !!meta?.file, file: meta?.file || null, updatedAt: meta?.updatedAt || null });
              return true;
            }

            if (op === "roomImageGet") {
              const meta = await readRoomMeta();
              const file = meta?.file;
              if (!file) {
                sendJson(res, 200, { ok: true, exists: false });
                return true;
              }
              const rel = file.replace(/^\/+/, "");
              if (rel.includes("..") || rel.includes("\\")) {
                sendJson(res, 400, { ok: false, error: "bad_request" });
                return true;
              }
              const ct = contentTypeByExt(extname(rel));
              if (!ct || !ct.startsWith("image/")) {
                sendJson(res, 415, { ok: false, error: "unsupported_media_type" });
                return true;
              }
              const buf = await fs.readFile(join(rootUserDir, rel));
              const b64 = buf.toString("base64");
              sendJson(res, 200, { ok: true, exists: true, contentType: ct.split(";")[0], dataUrl: `data:${ct.split(";")[0]};base64,${b64}`, updatedAt: meta?.updatedAt || null });
              return true;
            }

            if (op === "roomImageReset") {
              try {
                const meta = await readRoomMeta();
                if (meta?.file) {
                  try { await fs.unlink(join(rootUserDir, meta.file)); } catch {}
                }
                try { await fs.unlink(roomMetaPath); } catch {}
                sendJson(res, 200, { ok: true, debug: { opReceived: op } });
              } catch (err: any) {
                sendJson(res, 500, { ok: false, error: String(err?.message || err), debug: { opReceived: op } });
              }
              return true;
            }
            // Debug support: echo opReceived for unknown POST+JSON payloads.
            if (op) {
              sendJson(res, 400, { ok: false, error: "unknown_op", debug: { opReceived: op } });
              return true;
            }
          }
        }

        const t = nowMs();

        // Load last known activity snapshot written by hook handlers.
        // This avoids relying on in-memory sharing between hook callbacks and HTTP routes.
        let snapDisk: ActivitySnapshot | null = null;
        try {
          const txt = await fs.readFile(snapshotPath, "utf8");
          const obj = JSON.parse(txt);
          if (obj && typeof obj === "object" && typeof (obj as any).buildTag === "string") snapDisk = obj as any;
        } catch {
          snapDisk = null;
        }

        const agentIdAllowRaw = (process.env.LOBSTER_ROOM_AGENT_IDS || "").trim();
        let allowIds: string[] = [];
        if (agentIdAllowRaw) {
          const seen = new Set<string>();
          allowIds = agentIdAllowRaw
            .split(",")
            .map((s) => canonicalResidentAgentId(s))
            .filter((s) => !!s && !seen.has(s) && (seen.add(s), true));
        } else {
          const ids: string[] = [];
          const seen = new Set<string>();
          const agentListRaw = Array.isArray(api.config?.agents?.list) ? api.config.agents.list : [];
          for (const a of agentListRaw) {
            const id = a?.id;
            if (typeof id === "string" && id.trim() && !seen.has(id.trim())) {
              ids.push(id.trim());
              seen.add(id.trim());
            }
          }
          for (const rawId of activity.keys()) {
            const id = canonicalResidentAgentId(rawId);
            if (id && !seen.has(id)) {
              ids.push(id);
              seen.add(id);
            }
          }
          // IMPORTANT: hook handlers may run in a different isolate; in that case this HTTP handler
          // won't see hook-updated in-memory `activity`, but it *will* see the on-disk snapshot.
          const snapAgentIds = snapDisk && snapDisk.agents ? Object.keys(snapDisk.agents) : [];
          for (const rawId of snapAgentIds) {
            const id = canonicalResidentAgentId(rawId);
            if (id && !seen.has(id)) {
              ids.push(id);
              seen.add(id);
            }
          }
          if (!seen.has("main")) {
            ids.push("main");
            seen.add("main");
          }
          allowIds = ids.length ? ids : ["main"];
        }

        for (const id of allowIds) ensure(id);

        const agentNameOverridesFromEnv: Record<string, string> = (() => {
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

        const agentNameOverridesFromFile = await readAgentLabels();
        const agentNameOverrides: Record<string, string> = {
          ...agentNameOverridesFromFile,
          ...agentNameOverridesFromEnv, // env wins
        };

        const identityNameByAgentId = new Map<string, string>();
        const agentList = Array.isArray(api.config?.agents?.list) ? api.config.agents.list : [];
        for (const a of agentList) {
          const id = a?.id;
          const nm = a?.identity?.name;
          if (typeof id === "string" && id.trim() && typeof nm === "string" && nm.trim()) {
            identityNameByAgentId.set(id.trim(), nm.trim());
          }
        }

        // Derive activity by polling gateway session stores.
        // (Hook-based signals are unreliable in some deployments / behind proxies.)
        const gatewayToken: string | null = typeof api.config?.gateway?.auth?.token === "string" ? api.config.gateway.auth.token : null;
        const invokeUrl = "http://127.0.0.1:18789/tools/invoke";
        const invoke = async (tool: string, args: any) => {
          const headers: Record<string, string> = { "content-type": "application/json" };
          if (gatewayToken) headers.authorization = `Bearer ${gatewayToken}`;
          const markInternalObservation = isLowSignalObservationTool(tool);
          if (markInternalObservation) {
            headers[INTERNAL_OBSERVATION_HEADER] = "1";
            beginInternalObservation(tool);
          }
          try {
            const resp = await fetch(invokeUrl, { method: "POST", headers, body: JSON.stringify({ tool, args }) });
            const data = await resp.json();
            if (!data?.ok) throw new Error(String(data?.error || "invoke_failed"));
            return data;
          } finally {
            if (markInternalObservation) endInternalObservation(tool);
          }
        };

        const skToAgentId = (sk: unknown): string | null => {
          if (typeof sk !== "string") return null;
          const m = sk.match(/^agent:([^:]+):/);
          return m && m[1] ? m[1] : null;
        };

        let sessions: any[] = [];
        try {
          const r = await invoke("sessions_list", {});
          const details = r?.result?.details || {};
          sessions = Array.isArray(details.sessions) ? details.sessions : [];
        } catch {
          sessions = [];
        }

        const sessionsByAgent = new Map<string, any[]>();
        for (const s of sessions) {
          const aid = skToAgentId(s?.key);
          if (!aid) continue;
          const arr = sessionsByAgent.get(aid) || [];
          arr.push(s);
          sessionsByAgent.set(aid, arr);
        }

        const agentsPayload = [] as any[];
        for (const agentId of allowIds) {
          const displayName = agentNameOverrides[agentId] || identityNameByAgentId.get(agentId) || agentId;
          const list = (sessionsByAgent.get(agentId) || []).filter((s) => typeof s?.key === "string");
          list.sort((a, b) => (Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0)));

          const maxUpdatedAt = list.length ? Number(list[0]?.updatedAt || 0) : 0;
          const recent = !!(maxUpdatedAt && (t - maxUpdatedAt) <= staleMs);

          // session_status on the most recent session (best-effort)
          let queueDepth: number | null = null;
          let statusText: string | null = null;
          if (list.length) {
            try {
              const r2 = await invoke("session_status", { sessionKey: String(list[0].key) });
              const det2 = r2?.result?.details || {};
              const qd = det2.queueDepth ?? det2?.queue?.depth;
              if (Number.isFinite(Number(qd))) queueDepth = Number(qd);
              if (typeof det2.statusText === "string") statusText = det2.statusText;
            } catch {}
          }

          // sessions_history for last message type (best-effort)
          let lastType: string | null = null;
          let lastRole: string | null = null;
          let historyTypes: string[] = [];
          if (list.length) {
            try {
              const r3 = await invoke("sessions_history", { sessionKey: String(list[0].key), limit: 8 });
              const msgs = r3?.result?.details?.messages || [];
              const last = Array.isArray(msgs) && msgs.length ? msgs[0] : null;
              lastRole = typeof last?.role === "string" ? last.role : null;
              const c = last?.content;
              if (Array.isArray(c)) {
                for (const part of c) {
                  if (part && typeof part === "object" && typeof part.type === "string") historyTypes.push(part.type);
                }
                lastType = historyTypes[0] || null;
              }
            } catch {}
          }

          let activityState: ActivityState = "idle";
          let uiState: "think" | "wait" | "tool" | "reply" | "error" = "wait";

          // Prefer hook-derived snapshot (more real-time, no polling lag).
          const snapRow = snapDisk?.agents?.[agentId];
          const snapFresh = !!(snapRow && typeof snapRow.lastEventMs === "number" && (t - snapRow.lastEventMs) <= staleMs);
          if (snapFresh) {
            activityState = snapRow.state as ActivityState;
            uiState = mapActivityToUiState(activityState);
          } else if (typeof queueDepth === "number" && queueDepth > 0) {
            activityState = "thinking";
            uiState = "think";
          } else if (recent && lastType === "toolCall") {
            activityState = "tool";
            uiState = "tool";
          } else if (recent && lastType === "text" && lastRole === "assistant") {
            activityState = "reply";
            uiState = "reply";
          } else {
            activityState = "idle";
            uiState = "wait";
          }

          const sinceOut = snapFresh ? (snapRow?.sinceMs || null) : (maxUpdatedAt || null);
          const lastOut = snapFresh ? (snapRow?.lastEventMs || null) : (maxUpdatedAt || null);
          agentsPayload.push({
            id: `resident@${agentId}`,
            hostId: "local",
            hostLabel: "OpenClaw",
            name: displayName,
            state: uiState,
            meta: {
              active: uiState !== "wait",
              sinceMs: sinceOut,
              maxUpdatedAt: maxUpdatedAt || null,
              queueDepth,
              statusText,
            },
            debug: {
              decision: {
                agentId,
                displayName,
                activityState,
                sinceMs: sinceOut,
                lastEventMs: lastOut,
                cooldownMs,
                staleMs,
                toolMaxMs,
                finalState: uiState,
                details: {
                  queueDepth,
                  statusText,
                  historyTypes,
                  lastRole,
                  lastType,
                  snapFresh,
                  snapState: snapRow?.state || null,
                } as any,
                recentEvents: (snapDisk?.events || eventBuf),
              },
            },
          });
        }

        sendJson(res, 200, {
          ok: true,
          buildTag: BUILD_TAG,
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

    // Debug: manually ping an agent state (for UI testing without running the real agent)
    // GET /lobster-room/api/debug/ping?agentId=coding_agent&state=tool
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/debug/ping",
      handler: async (req, res) => {
        const url = readRequestUrl(req);
        const agentId = String(url.searchParams.get("agentId") || "").trim() || "main";
        const state = String(url.searchParams.get("state") || "tool").trim().toLowerCase();
        const allowed: ActivityState[] = ["idle", "thinking", "tool", "reply", "error"];
        const next: ActivityState = (allowed as string[]).includes(state) ? (state as ActivityState) : "tool";
        try {
          pushEvent("debug_ping", { agentId, data: { next } });
          setState(agentId, next, { debug: true });
          // Force a snapshot flush so the next /api/lobster-room poll can see it immediately.
          try {
            await mergeAndWriteSnapshot();
          } catch {}
          // Auto return to idle after a short delay.
          setTimeout(() => {
            try { setIdleWithCooldown(agentId, cooldownMs); } catch {}
          }, 600);
        } catch {}
        sendJson(res, 200, { ok: true, buildTag: BUILD_TAG, agentId, state: next });
        return true;
      },
    });

    // NOTE: no redirect from /lobster-room → /lobster-room/ needed;
    // the prefix match on /lobster-room/ handles both /lobster-room and /lobster-room/
    // to avoid redirect loop when gateway route ordering causes exact /lobster-room to shadow prefix /lobster-room/

    api.logger.info("[lobster-room] plugin routes registered", {
      portalHtmlPath,
      cooldownMs,
      minDwellMs,
      pollSeconds,
      staleMs,
      toolMaxMs,
    });
  },
};
