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

const FEED_UI_VERSION = "feed-v3-20260329.1";

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

const BUILD_TAG = "2026-04-08-reset-identity-state-1";

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

    // --- Bundled rooms (ships with plugin) ---
    const bundledRoomsDir = join(pluginDir, "assets", "bundled-rooms");
    const seedBundledRooms = async (): Promise<void> => {
      let bundledEntries: string[] = [];
      try {
        const ents = await fs.readdir(bundledRoomsDir);
        bundledEntries = ents.filter((e) => /^room-\d+$/.test(e));
      } catch {
        return;
      }
      if (!bundledEntries.length) return;

      const idx = await readRoomsIndex();
      const existingIds = new Set((idx?.rooms || []).map((r) => r.id));

      for (const roomId of bundledEntries) {
        if (existingIds.has(roomId)) continue;
        const srcRoom = join(bundledRoomsDir, roomId);
        const dstRoom = roomPath(roomId, "");
        await fs.mkdir(dstRoom, { recursive: true });
        const srcImg = join(srcRoom, "room.jpg");
        const srcMap = join(srcRoom, "manual-map.json");
        const dstImg = join(dstRoom, "room.jpg");
        const dstMap = join(dstRoom, "manual-map.json");
        try {
          const imgBuf = await fs.readFile(srcImg);
          await fs.writeFile(dstImg, imgBuf);
        } catch {}
        try {
          const mapBuf = await fs.readFile(srcMap);
          await fs.writeFile(dstMap, mapBuf);
        } catch {}

        // Derive display name from the bundled image filename (e.g. "Creative_color_loft.jpg" → "Creative_color_loft")
        let displayName = roomId;
        try {
          const files = await fs.readdir(srcRoom);
          const imgFile = files.find((f) => f.endsWith(".jpg") || f.endsWith(".png") || f.endsWith(".jpeg"));
          if (imgFile) displayName = imgFile.replace(/\.(jpg|png|jpeg)$/i, "");
        } catch {}

        const newIdx = await readRoomsIndex();
        const rooms = newIdx ? [...newIdx.rooms] : [];
        rooms.push({ id: roomId, name: displayName, createdAt: t, updatedAt: t });
        await writeRoomsIndex({ activeRoomId: newIdx?.activeRoomId || defaultRoomId, rooms });
      }
    };

    // Kick migration/initialization (best-effort, no throw)
    ensureDefaultRoomInitialized().catch(() => undefined);
    seedBundledRooms().catch(() => undefined);

    const getActiveRoomId = async (): Promise<string> => {
      const idx = await readRoomsIndex();
      const id = idx?.activeRoomId || defaultRoomId;
      return safeRoomId(id) ? id : defaultRoomId;
    };

    // --- Retention (per-active-room) ---
    const RETENTION_DEFAULT_MS = 3 * 60 * 60 * 1000; // 3 hours

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
    const emptyActivitySnapshot = (): ActivitySnapshot => ({
      buildTag: BUILD_TAG,
      updatedAtMs: nowMs(),
      agents: {},
      events: [],
    });
    let snap: ActivitySnapshot = emptyActivitySnapshot();

    const mergeAndWriteSnapshot = async () => {
      await identityPersistenceResetReady;
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
          agents: {
            ...pruneSnapshotAgents(disk?.agents || {}),
            ...pruneSnapshotAgents(snap.agents || {}),
          },
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

    const normalizeIntentText = (value: unknown, maxLen = 120): string => {
      if (typeof value !== "string") return "";
      let text = redactSecretsInText(value).trim();
      if (!text) return "";
      text = text.replace(/^you are\s+[^。.!?\n]+[。.!?]?\s*/i, "");
      text = text.replace(/^你是\s*[^。.!?\n]+[。.!?]?\s*/u, "");
      text = text.replace(/^(please|pls|kindly)\s+/i, "");
      text = text.replace(/^(請|麻煩)\s*/u, "");
      text = text.replace(/^(task|label|prompt)\s*[:：-]\s*/i, "");
      text = text.replace(/\s+/g, " ").trim();
      if (!text) return "";
      if (text.length > maxLen) text = text.slice(0, maxLen).trimEnd() + "…";
      return text;
    };

    const sentenceCase = (value: string): string => {
      const text = value.trim();
      if (!text) return "";
      return text.charAt(0).toUpperCase() + text.slice(1);
    };

    const titleCaseCronLabel = (value: string): string => {
      const clean = normalizeIntentText(value, 120);
      if (!clean) return "";
      return clean
        .split(/\s+/)
        .map((part) => {
          if (!part) return "";
          if (/^AI$/i.test(part)) return "AI";
          if (/^RSS$/i.test(part)) return "RSS";
          if (/^gmail$/i.test(part)) return "Gmail";
          if (/^github$/i.test(part)) return "GitHub";
          if (/^youtube$/i.test(part)) return "YouTube";
          if (/^notion$/i.test(part)) return "Notion";
          if (/^discord$/i.test(part)) return "Discord";
          if (/^[A-Z0-9]+$/.test(part)) return part;
          return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join(" ")
        .trim();
    };

    const CRON_JOB_STORE_CANDIDATES = [
      "/home/node/.openclaw/cron/jobs.json",
      "/root/.openclaw/cron/jobs.json",
      join(process.env.HOME || "/home/node", ".openclaw", "cron", "jobs.json"),
    ];
    let cronJobNameCache = new Map<string, string>();
    let cronJobNameCacheMtimeMs = -1;
    let cronJobNameCacheLoadedAt = 0;
    let cronJobNameCacheInFlight: Promise<void> | null = null;

    const cronStoreJobName = (rawJob: any): string => {
      const candidate = [rawJob?.name, rawJob?.label, rawJob?.title].find((value) => typeof value === "string" && value.trim());
      return normalizeIntentText(candidate, 120);
    };

    const refreshCronJobNameCache = async (force = false): Promise<void> => {
      if (!force && cronJobNameCacheInFlight) {
        await cronJobNameCacheInFlight;
        return;
      }
      const now = Date.now();
      if (!force && cronJobNameCacheLoadedAt && (now - cronJobNameCacheLoadedAt) < 15_000) return;
      cronJobNameCacheInFlight = (async () => {
        let chosenPath = "";
        let chosenMtimeMs = -1;
        for (const candidate of CRON_JOB_STORE_CANDIDATES) {
          try {
            const stat = await fs.stat(candidate);
            if (stat.isFile()) {
              chosenPath = candidate;
              chosenMtimeMs = Number(stat.mtimeMs || 0);
              break;
            }
          } catch {}
        }
        if (!chosenPath) {
          cronJobNameCacheLoadedAt = now;
          return;
        }
        if (!force && chosenMtimeMs >= 0 && chosenMtimeMs === cronJobNameCacheMtimeMs && cronJobNameCache.size) {
          cronJobNameCacheLoadedAt = now;
          return;
        }
        try {
          const raw = await fs.readFile(chosenPath, "utf8");
          const parsed = JSON.parse(raw);
          const jobs = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed?.jobs) ? parsed.jobs : []);
          const next = new Map<string, string>();
          for (const job of jobs) {
            const jobId = typeof job?.id === "string" && job.id.trim()
              ? job.id.trim()
              : (typeof job?.jobId === "string" && job.jobId.trim() ? job.jobId.trim() : "");
            const name = cronStoreJobName(job);
            if (!jobId || !name) continue;
            next.set(jobId, name);
          }
          if (next.size) cronJobNameCache = next;
          cronJobNameCacheMtimeMs = chosenMtimeMs;
          cronJobNameCacheLoadedAt = now;
        } catch (err: any) {
          cronJobNameCacheLoadedAt = now;
          api.logger.warn("[lobster-room] cron job cache refresh failed", {
            error: String(err?.message || err),
            path: chosenPath,
          });
        }
      })();
      try {
        await cronJobNameCacheInFlight;
      } finally {
        cronJobNameCacheInFlight = null;
      }
    };

    const cronJobLabelFromSessionKey = (sessionKey: unknown): string => {
      const sk = typeof sessionKey === "string" ? sessionKey.trim() : "";
      const match = sk.match(/^agent:([^:]+):cron:([^:]+)$/i);
      if (!match) return "";
      const rawJobId = String(match[2] || "").trim();
      if (!rawJobId) return "";
      const named = cronJobNameCache.get(rawJobId);
      if (named) return named;
      const label = rawJobId
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return titleCaseCronLabel(label);
    };

    const cronActorPrefix = (sessionKey: unknown): string => {
      const sk = typeof sessionKey === "string" ? sessionKey.trim() : "";
      const match = sk.match(/^agent:([^:]+):cron:([^:]+)$/i);
      if (!match) return "";
      const actor = canonicalVisibleAgentId(String(match[1] || "").trim(), "");
      return actor ? `@${actor}` : "";
    };

    const cronFriendlyIntent = (
      sessionKey: unknown,
      toolName?: unknown,
      phase: "active" | "done" = "active",
      opts?: { includeActor?: boolean },
    ): string => {
      const label = cronJobLabelFromSessionKey(sessionKey);
      if (!label) return "";
      const actor = opts?.includeActor === false ? "" : cronActorPrefix(sessionKey);
      const verb = (() => {
        const tn = String(toolName || "").trim();
        if (tn === "message") return phase === "done" ? "posted" : "posting";
        if (tn === "browser" || tn === "web_fetch") return phase === "done" ? "checked" : "checking";
        return phase === "done" ? "ran" : "running";
      })();
      return `${actor ? actor + " " : ""}${verb} ${label}`.trim();
    };

    const cronStoryLabel = (details: Record<string, unknown> | null): string => cronJobLabelFromSessionKey(details?.sessionKey);

    const extractExplicitTaskIntent = (details: Record<string, unknown> | null): string => {
      const candidates = [details?.task, details?.label, details?.prompt, details?.goal, details?.summary, details?.title, details?.purpose, details?.name];
      for (const candidate of candidates) {
        const text = normalizeIntentText(candidate, 120);
        if (text) return text;
      }
      return "";
    };

    const extractTaskIntent = (details: Record<string, unknown> | null): string => {
      const explicitIntent = extractExplicitTaskIntent(details);
      if (explicitIntent) return explicitIntent;
      const cronIntent = cronFriendlyIntent(details?.sessionKey, details?.toolName, "active", { includeActor: false });
      if (cronIntent) return cronIntent;
      return "";
    };

    const inferCommandTaskIntent = (details: Record<string, unknown> | null): string => {
      const commandCandidates = [details?.command, details?.cmd, details?.args, details?.action, details?.toolName];
      const raw = commandCandidates.find((value) => typeof value === "string" && value.trim());
      const text = normalizeIntentText(raw, 160).toLowerCase();
      if (!text) return "inspect runtime";
      if (/\b(npm|pnpm|yarn|bun)\s+(test|vitest|jest)\b|\bpytest\b|\bgo test\b|\bcargo test\b/.test(text)) return "run tests";
      if (/\b(build|compile|tsc|vite build|webpack)\b/.test(text)) return "build the project";
      if (/\blint\b|eslint|ruff|flake8/.test(text)) return "run lint checks";
      if (/\bgit\s+status\b/.test(text)) return "check git status";
      if (/\bgit\s+diff\b/.test(text)) return "review git diff";
      if (/\b(session_status|sessions_history|sessions_list)\b/.test(text)) return "inspect session status";
      if (/\b(ps|top|htop|pgrep|process)\b/.test(text)) return "inspect process status";
      if (/\bcurl\b|\bwget\b/.test(text)) return "check a live endpoint";
      return "inspect runtime";
    };

    const fallbackTaskIntentForTool = (toolName: string, details: Record<string, unknown> | null): string => {
      const tn = String(toolName || "tool").trim();
      if (tn === "read") return "review files";
      if (tn === "write" || tn === "edit") return "update files";
      if (tn === "browser") return typeof details?.url === "string" && details.url.trim() ? "check live page" : "check page";
      if (tn === "web_fetch") return "check page";
      if (tn === "message") return "prepare a reply";
      if (tn === "exec" || tn === "process") return inferCommandTaskIntent(details);
      const base = genericToolLabel(tn) || "";
      return normalizeIntentText(base, 120).toLowerCase();
    };

    const humanizedWorkDescription = (
      toolName: string,
      details: Record<string, unknown> | null,
      phase: "active" | "done" = "active",
    ): string => {
      const tn = String(toolName || "tool").trim();
      const intent = extractTaskIntent(details);

      if (tn === "sessions_spawn") {
        if (intent) return phase === "done" ? `started helper task for ${intent}` : `starting helper task for ${intent}`;
        return phase === "done" ? "started helper task" : "starting helper task";
      }

      if (tn === "read") {
        if (intent) return phase === "done" ? `reviewed ${intent}` : `reviewing ${intent}`;
        return phase === "done" ? "reviewed files" : "reviewing files";
      }
      if (tn === "write" || tn === "edit") {
        if (intent) return phase === "done" ? `updated ${intent}` : `updating ${intent}`;
        return phase === "done" ? "updated files" : "updating files";
      }
      if (tn === "browser" || tn === "web_fetch") {
        if (intent) return phase === "done" ? `checked ${intent}` : `checking ${intent}`;
        const url = typeof details?.url === "string" ? details.url.trim() : "";
        return phase === "done" ? (url ? "checked live page" : "checked page") : (url ? "checking live page" : "checking page");
      }
      if (tn === "exec" || tn === "process") {
        const cronLabel = cronStoryLabel(details);
        if (cronLabel) return phase === "done" ? `finished ${cronLabel}` : `running ${cronLabel}`;
        if (intent) return phase === "done" ? `finished ${intent}` : `${intent}`;
        const cronIntent = cronFriendlyIntent(details?.sessionKey, tn, phase, { includeActor: false });
        if (cronIntent) return cronIntent;
        return phase === "done" ? "finished a check" : "running a check";
      }
      if (tn === "message") {
        const explicitIntent = extractExplicitTaskIntent(details);
        if (explicitIntent) return phase === "done" ? `prepared reply for ${explicitIntent}` : `preparing reply for ${explicitIntent}`;
        const cronIntent = cronFriendlyIntent(details?.sessionKey, tn, phase, { includeActor: false });
        if (cronIntent) return cronIntent;
        return phase === "done" ? "prepared a reply" : "preparing a reply";
      }

      if (intent) return phase === "done" ? `finished ${intent}` : intent;

      const base = genericToolLabel(tn) || "working";
      if (phase === "done") {
        if (/^check/i.test(base)) return base.replace(/^Check/i, "Checked").toLowerCase();
        if (/^review/i.test(base)) return base.replace(/^Review/i, "Reviewed").toLowerCase();
        if (/^update/i.test(base)) return base.replace(/^Update/i, "Updated").toLowerCase();
        if (/^prepare/i.test(base)) return base.replace(/^Prepare/i, "Prepared").toLowerCase();
        return `finished ${base.toLowerCase()}`;
      }
      return base.toLowerCase();
    };

    const inferTaskIntentFromItems = (items: FeedItem[]): string => {
      for (const it of items) {
        if (it.kind !== "before_tool_call") continue;
        const intent = extractTaskIntent((it.details as Record<string, unknown> | null) || null);
        if (intent) return intent;
      }
      const firstToolItem = items.find((x) => x.kind === "before_tool_call" && x.toolName);
      return firstToolItem ? fallbackTaskIntentForTool(String(firstToolItem.toolName || ""), (firstToolItem.details as Record<string, unknown> | null) || null) : "";
    };

    const inferTaskTitleIntentFromItems = (items: FeedItem[]): string => {
      for (const it of items) {
        if (it.kind !== "before_tool_call") continue;
        const details = (it.details as Record<string, unknown> | null) || null;
        const cronLabel = cronJobLabelFromSessionKey(details?.sessionKey);
        if (cronLabel) return cronLabel;
        const intent = extractTaskIntent(details);
        if (intent) return intent;
      }
      const firstToolItem = items.find((x) => x.kind === "before_tool_call" && x.toolName);
      return firstToolItem ? fallbackTaskIntentForTool(String(firstToolItem.toolName || ""), (firstToolItem.details as Record<string, unknown> | null) || null) : "";
    };

    const GENERIC_TASK_TITLE_RE = /^(working|in progress|run command|check process|summarize)$/i;

    const taskTitleFromIntent = (intent: string): string => {
      const clean = normalizeIntentText(intent, 120);
      if (!clean) return "Ongoing work";
      if (GENERIC_TASK_TITLE_RE.test(clean)) {
        const normalized = clean.toLowerCase() === "run command"
          ? "Inspect runtime"
          : clean.toLowerCase() === "check process"
            ? "Inspect process status"
            : clean;
        return sentenceCase(normalized);
      }
      return sentenceCase(clean);
    };

    const taskSummaryFromIntent = (intent: string, status: FeedTaskStatus, steps = 0, msgSent = 0, msgFail = 0, errorText = ""): string => {
      const clean = normalizeIntentText(intent, 120);
      const stableIntent = clean || "keep work moving";
      const stepBit = steps > 1 ? ` · ${steps} steps` : "";
      const sentBit = msgSent ? ` · ${msgSent} repl${msgSent === 1 ? "y" : "ies"} sent` : "";
      const failBit = msgFail ? ` · ${msgFail} repl${msgFail === 1 ? "y" : "ies"} failed` : "";
      if (status === "running") return `Now ${stableIntent}${stepBit}${sentBit}${failBit}`;
      if (status === "error") {
        const prefix = errorText ? `Blocked · ${redactSecretsInText(errorText).slice(0, 160)}` : "Blocked";
        return `${prefix} · while trying to ${stableIntent}${sentBit}${failBit}`;
      }
      return `Done · ${stableIntent}${stepBit}${sentBit}${failBit}`;
    };

    const feedPreview = (it: FeedItem, opts?: { includeActor?: boolean }): string => {
      // Always canonicalize agentId so internal descendant ids never leak into visible feed.
      const canonicalAgentId = resolveVisibleFeedItemAgentId(it, "");
      const actorPrefix = opts?.includeActor !== false && canonicalAgentId && canonicalAgentId !== UNKNOWN_CHILD_ACTOR_ID ? `@${canonicalAgentId} ` : "";
      const details = it.details as Record<string, unknown> | null;
      const detailsWithSessionKey: Record<string, unknown> | null = details
        ? { ...details, sessionKey: details.sessionKey ?? it.sessionKey }
        : (it.sessionKey ? { sessionKey: it.sessionKey } : null);

      if (it.kind === "before_agent_start") {
        const cronStart = cronFriendlyIntent(it.sessionKey, undefined, "active", { includeActor: false });
        if (cronStart) return `${actorPrefix}${cronStart}`.trim();
        return `${actorPrefix}started`.trim();
      }
      if (it.kind === "before_tool_call") {
        const tn = it.toolName || "tool";
        const desc = humanizedWorkDescription(String(tn), detailsWithSessionKey, "active");
        return `${actorPrefix}${desc}`.trim();
      }
      if (it.kind === "after_tool_call") {
        const tn = it.toolName || "tool";
        const desc = humanizedWorkDescription(String(tn), detailsWithSessionKey, "done");
        return `${actorPrefix}${desc}`.trim();
      }
      if (it.kind === "tool_result_persist") {
        const cronLabel = cronStoryLabel(detailsWithSessionKey);
        if (cronLabel) return `${actorPrefix}continuing ${cronLabel}`.trim();
        const intent = extractTaskIntent(detailsWithSessionKey) || fallbackTaskIntentForTool(String(it.toolName || ""), detailsWithSessionKey);
        return `${actorPrefix}${intent ? `continuing ${intent}` : "continuing work"}`.trim();
      }
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
        if (it.success === false) return `${actorPrefix}ended (error)`.trim();
        return `${actorPrefix}ended`.trim();
      }
      return String(it.kind || "event");
    };

    const shouldSuppressFeedItem = (it: FeedItem, allItems: FeedItem[]): boolean => {
      if (it.kind === "tool_result_persist") {
        const details = (it.details as Record<string, unknown> | null) || null;
        const intent = extractTaskIntent(details) || fallbackTaskIntentForTool(String(it.toolName || ""), details);
        if (intent) return false;
        const resolvedAgentId = resolveVisibleFeedItemAgentId(it, "");
        if (resolvedAgentId === UNKNOWN_CHILD_ACTOR_ID) return false;
        const sessionKey = typeof it.sessionKey === "string" ? it.sessionKey.trim() : "";
        if (!sessionKey) return false;
        const sameSessionVisible = allItems.filter((candidate) => candidate !== it && candidate.sessionKey === sessionKey && isUserVisibleFeedItem(candidate));
        const hasStory = sameSessionVisible.some((candidate) => candidate.kind === "before_agent_start" || candidate.kind === "before_tool_call" || candidate.kind === "after_tool_call" || candidate.kind === "message_sent");
        return hasStory;
      }
      if (it.kind === "agent_end" && it.success !== false) {
        const sameSession = allItems.filter((candidate) => candidate.sessionKey && candidate.sessionKey === it.sessionKey);
        const hasStory = sameSession.some((candidate) => candidate !== it && (candidate.kind === "before_agent_start" || candidate.kind === "before_tool_call" || candidate.kind === "after_tool_call" || candidate.kind === "message_sent"));
        return hasStory;
      }
      return false;
    };

    const feedItemLatestPriority = (it: FeedItem): number => {
      const resolvedAgentId = resolveVisibleFeedItemAgentId(it, "");
      const sessionKey = typeof it.sessionKey === "string" ? it.sessionKey.trim() : "";
      const parsed = sessionKey ? parseSessionIdentity(sessionKey, it.agentId) : { lane: "main" };
      const isChildLane = isAdoptableChildLane(parsed.lane);
      const details = (it.details as Record<string, unknown> | null) || null;
      const hasIntent = !!(extractTaskIntent(details) || fallbackTaskIntentForTool(String(it.toolName || ""), details));
      switch (it.kind) {
        case "message_sent":
        case "message_sending":
          return 90;
        case "after_tool_call":
          return isChildLane ? 82 : 74;
        case "before_tool_call":
          if (String(it.toolName || "") === "sessions_spawn") return isChildLane ? 64 : 28;
          return isChildLane ? 78 : 70;
        case "tool_result_persist":
          if (resolvedAgentId === UNKNOWN_CHILD_ACTOR_ID) return 76;
          return hasIntent ? (isChildLane ? 80 : 72) : (isChildLane ? 68 : 40);
        case "before_agent_start":
          return isChildLane ? 62 : 52;
        case "agent_end":
          return it.success === false || !!it.error ? 85 : 18;
        default:
          return isChildLane ? 60 : 50;
      }
    };

    const pickLatestVisibleFeedItem = (items: FeedItem[]): FeedItem | null => {
      let best: FeedItem | null = null;
      let bestScore = -Infinity;
      for (const it of items) {
        const score = feedItemLatestPriority(it);
        if (!best || score > bestScore || (score === bestScore && Number(it.ts || 0) >= Number(best.ts || 0))) {
          best = it;
          bestScore = score;
        }
      }
      return best;
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
      const intent = inferTaskTitleIntentFromItems(items);
      return taskTitleFromIntent(intent);
    };

    const taskSummaryFromItems = (items: FeedItem[], status: FeedTaskStatus): string => {
      const toolCalls = items.filter((x) => x.kind === "before_tool_call").length;
      const msgSent = items.filter((x) => x.kind === "message_sent" && x.success !== false).length;
      const msgFail = items.filter((x) => x.kind === "message_sent" && x.success === false).length;
      const errors = items.map((x) => (x.error ? String(x.error) : "")).filter(Boolean);
      const intent = inferTaskIntentFromItems(items);
      return taskSummaryFromIntent(intent, status, toolCalls, msgSent, msgFail, errors[0] || "");
    };

    const visibleFeedAgentId = (value: unknown, fallback = "main"): string => {
      if (value === UNKNOWN_CHILD_ACTOR_ID) return UNKNOWN_CHILD_ACTOR_ID;
      const visible = canonicalVisibleAgentId(value);
      return visible || fallback;
    };

    const isUnknownChildActor = (value: unknown): boolean => value === UNKNOWN_CHILD_ACTOR_ID;

    const resolveVisibleFeedItemAgentId = (it: FeedItem | null | undefined, fallback = "main"): string => {
      if (!it) return fallback;
      // Check sessionKey-based lookup FIRST — the adoption pipeline may have
      // corrected spawnedSessionAgentIds after the FeedItem was written with
      // a stale/unknown agentId. This must run before the "unknown" early return.
      const sessionKey = typeof it.sessionKey === "string" ? it.sessionKey.trim() : "";
      if (sessionKey) {
        const parsed = parseSessionIdentity(sessionKey, it.agentId);
        if (isAdoptableChildLane(parsed.lane)) {
          const bound = spawnedSessionAgentIds.get(sessionKey);
          // Use canonicalResidentAgentId (NOT canonicalVisibleAgentId) to get the parent agent.
          // canonicalResidentAgentId("main") = "main" (correct key for lookup)
          // canonicalVisibleAgentId("main") = "" (wrong - returns empty string)
          const resident = canonicalResidentAgentId(parsed.residentAgentId);
          // Trust the binding only if it's a real child agent (not unknown, not generic 'main' parent).
          if (bound && bound !== UNKNOWN_CHILD_ACTOR_ID && bound !== "main") return bound;
          // No valid binding — check explicit agentId on the item itself.
          const explicit = canonicalVisibleAgentId(it.agentId);
          if (explicit && explicit !== "main" && parsed.agentId !== explicit) return explicit;
          // Canonical child identity comes from the parent embedded in the session key.
          if (resident) return resident;
          return UNKNOWN_CHILD_ACTOR_ID;
        }
      }
      // Non-child session: use stored agentId directly.
      if (isUnknownChildActor(it.agentId)) return UNKNOWN_CHILD_ACTOR_ID;
      return visibleFeedAgentId(it.agentId, fallback);
    };

    const isUserVisibleActorId = (value: unknown): boolean => {
      if (isUnknownChildActor(value)) return false;
      return !!canonicalVisibleAgentId(value);
    };

    const isFeedVisibleActorId = (value: unknown): boolean => isUnknownChildActor(value) || !!canonicalVisibleAgentId(value);

    const isUserVisibleFeedItem = (it: FeedItem | null | undefined): boolean => !!it && isFeedVisibleActorId(resolveVisibleFeedItemAgentId(it, ""));

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
        agentId: resolveVisibleFeedItemAgentId(it),
        preview: feedPreview(it, { includeActor: false }),
        previewWithActor: feedPreview(it, { includeActor: true }),
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
        const agentId = resolveVisibleFeedItemAgentId(sorted.find((x) => !!x), "unknown");
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
          const a = resolveVisibleFeedItemAgentId(it, "unknown");
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

    const RUNTIME_AGENT_ALIASES: Record<string, string> = {
      helper: "",
      unknown: "",
      "workspace-main": "main",
      "workspace-main-agent": "main",
      "workspace-coding-agent": "coding_agent",
      "workspace-qa-agent": "qa_agent",
    };

    const canonicalizeRuntimeAgentToken = (value: unknown): string => {
      if (typeof value !== "string") return "";
      let raw = String(value).trim();
      if (!raw) return "";
      raw = raw.replace(/^resident@/i, "").trim();
      const atMatch = raw.match(/^[^@]+@(.+)$/);
      if (atMatch) raw = String(atMatch[1] || "").trim();
      if (!raw) return "";
      if (/^agent:/i.test(raw)) return canonicalizeRuntimeAgentToken(parseSessionIdentity(raw).residentAgentId);
      const slash = raw.indexOf("/");
      if (slash >= 0) raw = raw.slice(0, slash).trim();
      const lower = raw.toLowerCase();
      if (!lower) return "";
      if (Object.prototype.hasOwnProperty.call(RUNTIME_AGENT_ALIASES, lower)) {
        return RUNTIME_AGENT_ALIASES[lower] || "";
      }
      if (lower === "subagent" || lower === "spawn" || lower === "cron" || lower === "discord") return "";
      return raw;
    };

    const canonicalResidentAgentId = (value: unknown): string => {
      if (typeof value !== "string") return "";
      const raw = String(value).trim();
      if (!raw) return "";
      if (raw.startsWith("agent:")) return canonicalizeRuntimeAgentToken(parseSessionIdentity(raw).residentAgentId);
      return canonicalizeRuntimeAgentToken(raw);
    };

    const canonicalVisibleAgentId = (value: unknown): string => canonicalizeRuntimeAgentToken(value);

    const PERSISTED_AGENT_ID_STOPWORDS = new Set([
      "a",
      "an",
      "the",
      "this",
      "that",
      "these",
      "those",
      "someone",
      "somebody",
      "anyone",
      "anybody",
      "everyone",
      "everybody",
      "nobody",
      "agent",
      "subagent",
      "assistant",
      "helper",
      "worker",
      "coder",
      "writer",
      "reviewer",
      "researcher",
      "runtime",
      "system",
      "resident",
      "spawn",
      "cron",
      "discord",
      "unknown",
    ]);

    const isPersistedPollutedAgentId = (value: unknown): boolean => {
      const visible = canonicalVisibleAgentId(value);
      if (!visible) return true;
      return PERSISTED_AGENT_ID_STOPWORDS.has(visible.toLowerCase());
    };

    const lineageCanonicalAgentIds = (extra?: { sessionKeys?: Array<unknown>; residentAgentIds?: Array<unknown>; parentSessionKeys?: Array<unknown>; actorIds?: Array<unknown> }): Set<string> => {
      const out = new Set<string>();
      const addId = (raw: unknown) => {
        const id = canonicalResidentAgentId(raw);
        if (id && !isPersistedPollutedAgentId(id)) out.add(id);
      };
      const addSessionKey = (raw: unknown) => {
        if (typeof raw !== "string") return;
        const sk = String(raw).trim();
        if (!sk) return;
        const parsed = parseSessionIdentity(sk);
        addId(parsed.residentAgentId);
      };
      const envRaw = (process.env.LOBSTER_ROOM_AGENT_IDS || "").trim();
      if (envRaw) {
        for (const raw of envRaw.split(",")) addId(raw);
      }
      const agentListRaw = Array.isArray(api.config?.agents?.list) ? api.config.agents.list : [];
      for (const agent of agentListRaw) addId(agent?.id);
      for (const rawId of activity.keys()) addId(rawId);
      const snapAgentIds = snap && snap.agents ? Object.keys(snap.agents) : [];
      for (const rawId of snapAgentIds) addId(rawId);
      for (const rawId of spawnedSessionAgentIds.values()) addId(rawId);
      for (const sessionKey of spawnedSessionAgentIds.keys()) addSessionKey(sessionKey);
      for (const entry of observedChildSessions.values()) {
        addId(entry.residentAgentId);
        addId(entry.actorId);
        addSessionKey(entry.sessionKey);
        for (const parentSessionKey of entry.parentSessionKeys || []) addSessionKey(parentSessionKey);
      }
      for (const queue of pendingSpawnAttributionsByParent.values()) {
        for (const entry of queue) {
          addId(entry.residentAgentId);
          addId(entry.actorId);
          addSessionKey(entry.parentSessionKey);
          addSessionKey(entry.childSessionKey);
        }
      }
      for (const raw of extra?.residentAgentIds || []) addId(raw);
      for (const raw of extra?.actorIds || []) addId(raw);
      for (const raw of extra?.sessionKeys || []) addSessionKey(raw);
      for (const raw of extra?.parentSessionKeys || []) addSessionKey(raw);
      out.add("main");
      return out;
    };

    const canonicalPersistedActorId = (value: unknown, extra?: { sessionKeys?: Array<unknown>; residentAgentIds?: Array<unknown>; parentSessionKeys?: Array<unknown>; actorIds?: Array<unknown> }): string => {
      const visible = canonicalVisibleAgentId(value);
      if (!visible || isPersistedPollutedAgentId(visible)) return "";
      const lineageIds = lineageCanonicalAgentIds({
        sessionKeys: extra?.sessionKeys || [],
        residentAgentIds: extra?.residentAgentIds || [],
        parentSessionKeys: extra?.parentSessionKeys || [],
        actorIds: [],
      });
      if (lineageIds.has(visible)) return visible;
      return "";
    };

    const isVisibleSnapshotAgentKey = (value: unknown): boolean => {
      if (typeof value !== "string") return false;
      const raw = String(value).trim();
      if (!raw) return false;
      const visible = canonicalPersistedActorId(raw);
      return !!visible && raw === visible;
    };

    const pruneSnapshotAgents = (agents: Record<string, { state: ActivityState; sinceMs: number; lastEventMs: number; details?: any }> | null | undefined) => {
      const out: Record<string, { state: ActivityState; sinceMs: number; lastEventMs: number; details?: any }> = {};
      if (!agents || typeof agents !== "object") return out;
      for (const [key, value] of Object.entries(agents)) {
        const visible = canonicalPersistedActorId(key);
        if (!visible || visible !== key) continue;
        out[visible] = value as { state: ActivityState; sinceMs: number; lastEventMs: number; details?: any };
      }
      return out;
    };

    type PendingSpawnAttribution = {
      intentId: string;
      actorId: string;
      parentSessionKey: string;
      residentAgentId: string;
      label?: string;
      task?: string;
      source: "explicit" | "inferred";
      createdAt: number;
      childSessionKey?: string;
      boundAt?: number;
    };

    type ObservedChildSession = {
      sessionKey: string;
      residentAgentId: string;
      parentSessionKeys: string[];
      actorId?: string;
      label?: string;
      task?: string;
      observedAt: number;
    };

    const UNKNOWN_CHILD_ACTOR_ID = "unknown";

    const spawnedSessionAgentIds = new Map<string, string>();
    const pendingSpawnAttributionsByParent = new Map<string, PendingSpawnAttribution[]>();
    const pendingSpawnAttributionsByResident = new Map<string, PendingSpawnAttribution[]>();
    const observedChildSessions = new Map<string, ObservedChildSession>();
    const spawnAttributionStatePath = join(rootUserDir, "spawn-attribution-state.json");
    let spawnAttributionStateHydrated = false;

    const resetIdentityPersistenceOnInit = async () => {
      snap = emptyActivitySnapshot();
      activity.clear();
      eventBuf.splice(0, eventBuf.length);
      feedBuf.splice(0, feedBuf.length);
      spawnedSessionAgentIds.clear();
      pendingSpawnAttributionsByParent.clear();
      pendingSpawnAttributionsByResident.clear();
      observedChildSessions.clear();
      spawnAttributionStateHydrated = true;
      try {
        await fs.mkdir(rootUserDir, { recursive: true });
      } catch {}
      await Promise.allSettled([
        fs.rm(snapshotPath, { force: true }),
        fs.rm(spawnAttributionStatePath, { force: true }),
      ]);
    };
    const identityPersistenceResetReady = resetIdentityPersistenceOnInit();

    const PENDING_SPAWN_ATTRIBUTION_TTL_MS = 30 * 60 * 1000;
    let spawnIntentSeq = 0;

    const nextSpawnIntentId = (): string => `spawn-intent:${Date.now()}:${process.pid}:${spawnIntentSeq += 1}`;

    const pendingSpawnAttributionIdentityKey = (entry: PendingSpawnAttribution): string => String(entry.intentId || "").trim();

    const pendingSpawnAttributionKey = (entry: PendingSpawnAttribution): string => String(entry.intentId || "").trim();

    const isAdoptableChildLane = (lane: unknown): boolean => String(lane || "").trim().toLowerCase() === "subagent";

    const hasAdoptableChildProof = (sessionKey: unknown, residentAgentId?: unknown): boolean => {
      const parsed = parseSessionIdentity(sessionKey, residentAgentId);
      if (!isAdoptableChildLane(parsed.lane)) return false;
      const resident = canonicalResidentAgentId(residentAgentId ?? parsed.residentAgentId);
      return !!resident && resident === parsed.residentAgentId;
    };

    const shouldPersistSpawnedSessionAgent = (sessionKey: unknown, agentId: unknown): boolean => {
      const visible = canonicalVisibleAgentId(agentId);
      if (!visible) return false;
      return hasAdoptableChildProof(sessionKey, parseSessionIdentity(sessionKey).residentAgentId);
    };

    const prunePendingSpawnAttributions = (referenceNow = nowMs()) => {
      const keep = new Map<string, PendingSpawnAttribution>();
      const maxAgeMs = PENDING_SPAWN_ATTRIBUTION_TTL_MS;
      const collect = (entry: PendingSpawnAttribution | null | undefined) => {
        if (!entry) return;
        const createdAt = typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0;
        if (createdAt > 0 && referenceNow - createdAt > maxAgeMs) return;
        const identityKey = pendingSpawnAttributionIdentityKey(entry);
        const existing = keep.get(identityKey);
        if (!existing || (existing.createdAt || 0) <= (createdAt || 0)) keep.set(identityKey, entry);
      };
      for (const queue of pendingSpawnAttributionsByParent.values()) {
        for (const entry of queue) collect(entry);
      }
      for (const queue of pendingSpawnAttributionsByResident.values()) {
        for (const entry of queue) collect(entry);
      }
      pendingSpawnAttributionsByParent.clear();
      pendingSpawnAttributionsByResident.clear();
      for (const entry of keep.values()) {
        pendingSpawnAttributionsByParent.set(entry.parentSessionKey, (pendingSpawnAttributionsByParent.get(entry.parentSessionKey) || []).concat([entry]));
        pendingSpawnAttributionsByResident.set(entry.residentAgentId, (pendingSpawnAttributionsByResident.get(entry.residentAgentId) || []).concat([entry]));
      }
    };

    const mergePendingSpawnAttribution = (entry: PendingSpawnAttribution) => {
      prunePendingSpawnAttributions(entry.createdAt || nowMs());
      const identityKey = pendingSpawnAttributionIdentityKey(entry);
      const mergeIntoBucket = (bucket: Map<string, PendingSpawnAttribution[]>, key: string) => {
        const queue = bucket.get(key) || [];
        const next = queue.filter((candidate) => pendingSpawnAttributionIdentityKey(candidate) !== identityKey);
        bucket.set(key, next.concat([entry]).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
      };
      mergeIntoBucket(pendingSpawnAttributionsByParent, entry.parentSessionKey);
      mergeIntoBucket(pendingSpawnAttributionsByResident, entry.residentAgentId);
    };

    const loadSpawnAttributionState = async () => {
      await identityPersistenceResetReady;
      if (spawnAttributionStateHydrated) return;
      try {
        const txt = await fs.readFile(spawnAttributionStatePath, "utf8");
        const data: any = JSON.parse(txt);
        if (!spawnAttributionStateHydrated) {
          spawnedSessionAgentIds.clear();
          pendingSpawnAttributionsByParent.clear();
          pendingSpawnAttributionsByResident.clear();
          observedChildSessions.clear();
          spawnAttributionStateHydrated = true;
        }

        const referenceNow = nowMs();
        const spawned = data?.spawnedSessionAgentIds;
        let shouldRewritePersistedState = false;
        if (spawned && typeof spawned === "object") {
          for (const [key, value] of Object.entries(spawned)) {
            const sk = typeof key === "string" ? key.trim() : "";
            const agentId = canonicalPersistedActorId(value, { sessionKeys: [sk] });
            if (!sk || !shouldPersistSpawnedSessionAgent(sk, agentId)) {
              shouldRewritePersistedState = true;
              continue;
            }
            if (!spawnedSessionAgentIds.has(sk)) spawnedSessionAgentIds.set(sk, agentId);
          }
        }

        const pending = Array.isArray(data?.pending) ? data.pending : [];
        for (const raw of pending) {
          const parentSessionKey = typeof raw?.parentSessionKey === "string" ? raw.parentSessionKey.trim() : "";
          const residentAgentId = canonicalResidentAgentId(raw?.residentAgentId || parentSessionKey);
          const actorId = canonicalPersistedActorId(raw?.actorId, {
            sessionKeys: [raw?.childSessionKey],
            residentAgentIds: [residentAgentId],
            parentSessionKeys: [parentSessionKey],
          });
          if (!parentSessionKey || !residentAgentId || !actorId) {
            shouldRewritePersistedState = true;
            continue;
          }
          const entry: PendingSpawnAttribution = {
            actorId,
            parentSessionKey,
            residentAgentId,
            label: normalizeSpawnText(raw?.label, 120) || undefined,
            task: normalizeSpawnText(raw?.task, 240) || undefined,
            source: raw?.source === "explicit" ? "explicit" : "inferred",
            createdAt: typeof raw?.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : referenceNow,
            intentId: typeof raw?.intentId === "string" && raw.intentId.trim() ? raw.intentId.trim() : nextSpawnIntentId(),
            childSessionKey: typeof raw?.childSessionKey === "string" && raw.childSessionKey.trim() ? raw.childSessionKey.trim() : undefined,
            boundAt: typeof raw?.boundAt === "number" && Number.isFinite(raw.boundAt) ? raw.boundAt : undefined,
          };
          mergePendingSpawnAttribution(entry);
        }
        prunePendingSpawnAttributions(referenceNow);

        const observed = Array.isArray(data?.observedChildSessions) ? data.observedChildSessions : [];
        for (const raw of observed) {
          const sessionKey = typeof raw?.sessionKey === "string" ? raw.sessionKey.trim() : "";
          if (!sessionKey || spawnedSessionAgentIds.has(sessionKey) || !hasAdoptableChildProof(sessionKey, raw?.residentAgentId)) continue;
          const residentAgentId = canonicalResidentAgentId(raw?.residentAgentId || sessionKey);
          if (!residentAgentId) {
            shouldRewritePersistedState = true;
            continue;
          }
          const matcher = extractSpawnMatcherHints(raw);
          const parentSessionKeys = Array.isArray(raw?.parentSessionKeys)
            ? raw.parentSessionKeys.map((value: any) => typeof value === "string" ? value.trim() : "").filter(Boolean)
            : [];
          const actorId = canonicalPersistedActorId(matcher.actorId, {
            sessionKeys: [sessionKey],
            residentAgentIds: [residentAgentId],
            parentSessionKeys,
          }) || undefined;
          if (matcher.actorId && !actorId) shouldRewritePersistedState = true;
          observedChildSessions.set(sessionKey, {
            sessionKey,
            residentAgentId,
            parentSessionKeys: Array.from(new Set(parentSessionKeys)),
            actorId,
            label: matcher.label || undefined,
            task: matcher.task || undefined,
            observedAt: typeof raw?.observedAt === "number" && Number.isFinite(raw.observedAt) ? raw.observedAt : referenceNow,
          });
        }
        if (shouldRewritePersistedState) await persistSpawnAttributionState();
      } catch {
        if (!spawnAttributionStateHydrated) spawnAttributionStateHydrated = true;
      }
    };

    const persistSpawnAttributionState = async () => {
      await identityPersistenceResetReady;
      try {
        prunePendingSpawnAttributions();
        const pending = new Map<string, PendingSpawnAttribution>();
        for (const queue of pendingSpawnAttributionsByParent.values()) {
          for (const entry of queue) pending.set(pendingSpawnAttributionKey(entry), entry);
        }
        await fs.writeFile(spawnAttributionStatePath, JSON.stringify({
          spawnedSessionAgentIds: Object.fromEntries(spawnedSessionAgentIds.entries()),
          pending: Array.from(pending.values()),
          observedChildSessions: Array.from(observedChildSessions.values()),
        }, null, 2));
      } catch {}
    };

    const normalizeSpawnText = (value: unknown, maxLen = 240): string => {
      if (typeof value !== "string") return "";
      return value.replace(/\s+/g, " ").trim().slice(0, maxLen);
    };

    const collectSpawnStringHints = (value: any, out: string[], seen = new Set<any>()) => {
      if (!value || seen.has(value) || out.length >= 24) return;
      if (typeof value === "string") {
        const normalized = normalizeSpawnText(value, 400);
        if (normalized) out.push(normalized);
        return;
      }
      if (typeof value !== "object") return;
      seen.add(value);
      const preferredKeys = ["label", "task", "prompt", "instructions", "title", "name", "description", "summary"];
      for (const key of preferredKeys) collectSpawnStringHints(value?.[key], out, seen);
      for (const nestedKey of ["payload", "input", "request", "session", "sessionOptions", "meta", "details", "context", "options"]) {
        collectSpawnStringHints(value?.[nestedKey], out, seen);
      }
      if (Array.isArray(value)) {
        for (const item of value) collectSpawnStringHints(item, out, seen);
      }
    };

    const isSpawnPayloadLike = (value: any): boolean => {
      if (!value || typeof value !== "object") return false;
      return !!(
        value?.spawnAgentId
        || value?.requestedAgentId
        || value?.actorId
        || value?.toolName === "sessions_spawn"
      );
    };

    const collectSpawnActorCandidates = (value: any, out: string[], seen = new Set<any>(), allowGenericAgentId = false) => {
      if (!value || seen.has(value) || out.length >= 16) return;
      const visible = canonicalVisibleAgentId(value);
      if (visible) {
        out.push(visible);
        return;
      }
      if (typeof value !== "object") return;
      seen.add(value);
      for (const key of ["spawnAgentId", "requestedAgentId", "actorId", "actor"]) {
        collectSpawnActorCandidates(value?.[key], out, seen, true);
      }
      if (allowGenericAgentId || isSpawnPayloadLike(value)) {
        collectSpawnActorCandidates(value?.agentId, out, seen, true);
        collectSpawnActorCandidates(value?.agent, out, seen, true);
      }
      for (const nestedKey of ["payload", "input", "request", "sessionOptions", "options", "meta", "details"]) {
        collectSpawnActorCandidates(value?.[nestedKey], out, seen, true);
      }
      if (Array.isArray(value)) {
        for (const item of value) collectSpawnActorCandidates(item, out, seen, allowGenericAgentId);
      }
    };

    const resolveExplicitSpawnAgentId = (payload: any): string => {
      const explicitCandidates: string[] = [];
      collectSpawnActorCandidates(payload, explicitCandidates, new Set(), true);
      const unique = uniqueVisibleAgentIds(explicitCandidates.map((value) => normalizeKnownSpawnActorId(value, { requireKnown: false })));
      return unique.length === 1 ? (unique[0] || "") : "";
    };

    const uniqueVisibleAgentIds = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

    const SPAWN_AGENT_ID_STOPWORDS = new Set([
      "a",
      "an",
      "the",
      "this",
      "that",
      "these",
      "those",
      "only",
      "one",
      "someone",
      "somebody",
      "anyone",
      "anybody",
      "everyone",
      "everybody",
      "nobody",
      "agent",
      "subagent",
      "assistant",
      "helper",
      "worker",
      "coder",
      "writer",
      "reviewer",
      "researcher",
      "main",
      "you",
      "yourself",
      "me",
      "myself",
      "him",
      "her",
      "them",
      "it",
    ]);

    const knownCanonicalSpawnAgentIds = (): Set<string> => lineageCanonicalAgentIds();

    const normalizeKnownSpawnActorId = (value: unknown, options?: { requireKnown?: boolean }): string => {
      const visible = canonicalVisibleAgentId(value);
      if (!visible) return "";
      const lower = visible.toLowerCase();
      if (SPAWN_AGENT_ID_STOPWORDS.has(lower)) return "";
      if (options?.requireKnown === false) return visible;
      return knownCanonicalSpawnAgentIds().has(visible) ? visible : "";
    };

    const extractSpawnDirectiveActorIds = (text: string): string[] => {
      const out: string[] = [];
      const directivePatterns = [
        /(?:^|[\s([{"'`])you are\s+([a-z][a-z0-9_-]{1,63})(?=$|[\s)\]}",.!?:;]|(?:\s+(?:agent|assistant|subagent))\b)/gim,
        /(?:^|[\s([{"'`])你是\s*([a-z][a-z0-9_-]{1,63})(?=$|[\s)\]}",.!?:;])/gimu,
        /(?:^|[\s([{"'`])角色\s*[:：]?\s*([a-z][a-z0-9_-]{1,63})(?=$|[\s)\]}",.!?:;])/gimu,
      ];
      for (const pattern of directivePatterns) {
        for (const match of text.matchAll(pattern)) {
          const visible = normalizeKnownSpawnActorId(match?.[1]);
          if (visible) out.push(visible);
        }
      }
      return uniqueVisibleAgentIds(out);
    };

    const extractSpawnMentionActorIds = (text: string): string[] => {
      const out: string[] = [];
      const mentionPatterns = [
        /\b([a-z][a-z0-9_-]*agent)\b/gi,
        /@([a-z][a-z0-9_-]{1,63})/gi,
      ];
      for (const pattern of mentionPatterns) {
        for (const match of text.matchAll(pattern)) {
          const visible = normalizeKnownSpawnActorId(match?.[1]);
          if (visible) out.push(visible);
        }
      }
      return uniqueVisibleAgentIds(out);
    };

    const inferSpawnActorId = (payload: any): string => {
      const explicit = resolveExplicitSpawnAgentId(payload);
      if (explicit) return explicit;
      const stringHints: string[] = [];
      collectSpawnStringHints(payload, stringHints);
      const text = stringHints.filter(Boolean).join("\n");
      if (!text) return "";
      const directiveMatches = extractSpawnDirectiveActorIds(text);
      if (directiveMatches.length === 1) return directiveMatches[0] || "";
      if (directiveMatches.length > 1) return "";
      const mentionMatches = extractSpawnMentionActorIds(text);
      if (mentionMatches.length === 1) return mentionMatches[0] || "";
      return "";
    };

    const extractSpawnMatcherHints = (value: any): { actorId?: string; label?: string; task?: string } => {
      const actorId = resolveRequestedSpawnAgentId(value) || undefined;
      const label = normalizeSpawnText(
        value?.label
        ?? value?.sessionLabel
        ?? value?.title
        ?? value?.name
        ?? value?.session?.label
        ?? value?.session?.title
        ?? value?.payload?.label
        ?? value?.request?.label,
        120,
      ) || undefined;
      const task = normalizeSpawnText(
        value?.task
        ?? value?.prompt
        ?? value?.instructions
        ?? value?.description
        ?? value?.session?.task
        ?? value?.session?.prompt
        ?? value?.payload?.task
        ?? value?.request?.task,
        240,
      ) || undefined;
      return { actorId, label, task };
    };

    const resolveRequestedSpawnAgentId = (payload: any): string => inferSpawnActorId(payload);

    const bindSpawnedSessionAgent = (sessionKey: unknown, agentId: unknown, options?: { allowOverwrite?: boolean; reason?: string }): boolean => {
      const sk = typeof sessionKey === "string" ? String(sessionKey).trim() : "";
      const visible = canonicalVisibleAgentId(agentId);
      if (!sk || !visible || !shouldPersistSpawnedSessionAgent(sk, visible)) return false;
      const existing = spawnedSessionAgentIds.get(sk);
      if (existing === visible) return true;
      if (existing && existing !== visible && !options?.allowOverwrite && existing !== UNKNOWN_CHILD_ACTOR_ID) {
        api.logger.warn("[lobster-room] spawned session actor mismatch; keeping original attribution", {
          sessionKey: sk,
          existingActorId: existing,
          inferredActorId: visible,
          reason: options?.reason || "unspecified",
        });
        return false;
      }
      
      // Retrospective Upgrade: If we just discovered the true identity of a session that
      // booted concurrently and received the 'unknown' tracking label, patch its UI history instantly.
      if (existing === UNKNOWN_CHILD_ACTOR_ID && visible !== UNKNOWN_CHILD_ACTOR_ID) {
        for (let i = 0; i < feedBuf.length; i += 1) {
          const item = feedBuf[i];
          if (item?.sessionKey === sk && item?.agentId === UNKNOWN_CHILD_ACTOR_ID) {
            item.agentId = visible;
          }
        }
        const unknownState = activity.get(UNKNOWN_CHILD_ACTOR_ID);
        if (unknownState && unknownState.details?.sessionKey === sk) {
          unknownState.agentId = visible;
          activity.set(visible, unknownState);
          activity.delete(UNKNOWN_CHILD_ACTOR_ID);
          try {
            const snapPrev = snap?.agents?.[UNKNOWN_CHILD_ACTOR_ID];
            if (snapPrev && snapPrev.details?.sessionKey === sk) {
              snap.agents[visible] = snapPrev;
              delete snap.agents[UNKNOWN_CHILD_ACTOR_ID];
              snap.updatedAtMs = nowMs();
              writeSnapshotSoon();
            }
          } catch {}
        }
      }

      spawnedSessionAgentIds.set(sk, visible);
      observedChildSessions.delete(sk);
      return true;
    };

    const mergeObservedChildSession = (entry: ObservedChildSession) => {
      const existing = observedChildSessions.get(entry.sessionKey);
      const parentSessionKeys = Array.from(new Set([...(existing?.parentSessionKeys || []), ...(entry.parentSessionKeys || [])].filter(Boolean)));
      observedChildSessions.set(entry.sessionKey, {
        sessionKey: entry.sessionKey,
        residentAgentId: entry.residentAgentId,
        parentSessionKeys,
        actorId: entry.actorId || existing?.actorId,
        label: entry.label || existing?.label,
        task: entry.task || existing?.task,
        observedAt: Math.max(existing?.observedAt || 0, entry.observedAt || 0),
      });
    };

    const childAdoptionMatcherFromSources = (...sources: any[]): { actorId?: string; label?: string; task?: string } => {
      for (const source of sources) {
        const hints = extractSpawnMatcherHints(source);
        if (hints.actorId || hints.label || hints.task) return hints;
      }
      return {};
    };

    const childAdoptionMatcherVariants = (matcher?: { actorId?: string; label?: string; task?: string }): Array<{ actorId?: string; label?: string; task?: string }> => {
      const normalized = {
        actorId: canonicalVisibleAgentId(matcher?.actorId) || undefined,
        label: normalizeSpawnText(matcher?.label, 120) || undefined,
        task: normalizeSpawnText(matcher?.task, 240) || undefined,
      };
      const variants = [
        normalized,
        normalized.actorId ? { actorId: normalized.actorId } : undefined,
        normalized.label ? { label: normalized.label } : undefined,
        normalized.task ? { task: normalized.task } : undefined,
        (!normalized.actorId && !normalized.label && !normalized.task) ? {} : undefined,
      ].filter(Boolean) as Array<{ actorId?: string; label?: string; task?: string }>;
      const seen = new Set<string>();
      return variants.filter((variant) => {
        const key = JSON.stringify(variant);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const childParentSessionKeysFromSources = (...sources: any[]): string[] => {
      const out: string[] = [];
      for (const source of sources) {
        for (const candidate of resolveChildParentSessionKeys(source)) {
          if (!candidate || out.includes(candidate)) continue;
          out.push(candidate);
        }
      }
      return out;
    };

    const observeChildSessionForSpawnAdoption = async (sessionKey: unknown, ctx?: any): Promise<ObservedChildSession | undefined> => {
      await loadSpawnAttributionState();
      const sk = typeof sessionKey === "string" ? String(sessionKey).trim() : "";
      if (!sk || spawnedSessionAgentIds.has(sk)) return undefined;
      const parsed = parseSessionIdentity(sk, ctx?.agentId);
      if (!hasAdoptableChildProof(sk, parsed.residentAgentId)) return undefined;
      const observed: ObservedChildSession = {
        sessionKey: sk,
        residentAgentId: canonicalResidentAgentId(parsed.residentAgentId),
        parentSessionKeys: childParentSessionKeysFromSources(ctx),
        observedAt: nowMs(),
        ...childAdoptionMatcherFromSources(ctx),
      };
      mergeObservedChildSession(observed);
      await persistSpawnAttributionState();
      return observedChildSessions.get(sk);
    };

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

    const pickPendingSpawnAttribution = (
      bucket: Map<string, PendingSpawnAttribution[]>,
      key: string,
      matcher?: { actorId?: string; label?: string; task?: string },
    ): PendingSpawnAttribution | undefined => {
      const queue = bucket.get(key) || [];
      if (!queue.length) return undefined;
      const actorId = canonicalVisibleAgentId(matcher?.actorId);
      const label = normalizeSpawnText(matcher?.label, 120);
      const task = normalizeSpawnText(matcher?.task, 240);
      const scored = queue.map((entry, index) => {
        let score = 0;
        if (actorId) {
          if (entry.actorId !== actorId && entry.actorId !== UNKNOWN_CHILD_ACTOR_ID) return { entry, index, score: -1 };
          if (entry.actorId === actorId) score += 8;
        }
        if (label) {
          if (normalizeSpawnText(entry.label, 120) !== label) return { entry, index, score: -1 };
          score += 4;
        }
        if (task) {
          if (normalizeSpawnText(entry.task, 240) !== task) return { entry, index, score: -1 };
          score += 4;
        }
        if (!actorId && !label && !task) score = 1;
        else if (entry.source === "explicit") score += 1;
        
        // Add a wildcard baseline so completely anonymous intents don't get rejected (score 0)
        // when an agent connects with an identity and is the only candidate available.
        if (entry.actorId === UNKNOWN_CHILD_ACTOR_ID && !entry.label && !entry.task) {
          score += 1;
        }
        
        // If the actor matches explicitly, give it a tiny bump to break ties vs "unknown" entry
        if (actorId && entry.actorId === actorId && entry.actorId !== UNKNOWN_CHILD_ACTOR_ID) score += 2;
        
        return { entry, index, score };
      }).filter((candidate) => candidate.score >= 0);
      if (!scored.length) return undefined;
      const bestScore = Math.max(...scored.map((candidate) => candidate.score));
      const winners = scored.filter((candidate) => candidate.score === bestScore);
      if (bestScore <= 0 || winners.length !== 1) return undefined;
      const [picked] = queue.splice(winners[0].index, 1);
      if (queue.length) bucket.set(key, queue);
      else bucket.delete(key);
      return picked;
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
      const explicit = resolveExplicitSpawnAgentId(payload);
      const actorId = inferSpawnActorId(payload) || UNKNOWN_CHILD_ACTOR_ID;
      const residentAgentId = canonicalResidentAgentId(sk);
      if (!residentAgentId) return undefined;
      const entry: PendingSpawnAttribution = {
        intentId: nextSpawnIntentId(),
        actorId,
        parentSessionKey: sk,
        residentAgentId,
        label: normalizeSpawnText(payload?.label, 120) || undefined,
        task: normalizeSpawnText(payload?.task, 240) || undefined,
        source: explicit ? "explicit" : "inferred",
        createdAt: nowMs(),
      };
      mergePendingSpawnAttribution(entry);
      for (const observed of Array.from(observedChildSessions.values())) {
        if (observed.residentAgentId !== residentAgentId) continue;
        await adoptPendingSpawnAttributionForSession(observed.sessionKey, observed);
      }
      await persistSpawnAttributionState();
      return entry;
    };

    const pendingSpawnMatcherFromPayload = (payload: any): { actorId?: string; label?: string; task?: string } => extractSpawnMatcherHints(payload);

    const consumePendingSpawnAttribution = async (
      parentSessionKey: unknown,
      matcher?: { actorId?: string; label?: string; task?: string },
    ): Promise<PendingSpawnAttribution | undefined> => {
      await loadSpawnAttributionState();
      const sk = typeof parentSessionKey === "string" ? String(parentSessionKey).trim() : "";
      if (!sk) return undefined;
      const next = matcher
        ? pickPendingSpawnAttribution(pendingSpawnAttributionsByParent, sk, matcher)
        : dequeuePendingSpawnAttribution(pendingSpawnAttributionsByParent, sk);
      if (!next) return undefined;
      forgetPendingSpawnAttributionFromResident(next.residentAgentId, next);
      await persistSpawnAttributionState();
      return next;
    };

    const resolveChildParentSessionKeys = (ctx: any): string[] => {
      const candidates = [
        ctx?.parentSessionKey,
        ctx?.parent?.sessionKey,
        ctx?.session?.parentSessionKey,
        ctx?.session?.parentKey,
        ctx?.parent?.key,
        ctx?.details?.parentSessionKey,
        ctx?.details?.parent?.sessionKey,
        ctx?.details?.session?.parentSessionKey,
        ctx?.data?.parentSessionKey,
        ctx?.payload?.parentSessionKey,
        ctx?.event?.parentSessionKey,
        ctx?.event?.details?.parentSessionKey,
      ];
      const out: string[] = [];
      for (const candidate of candidates) {
        const sk = typeof candidate === "string" ? candidate.trim() : "";
        if (!sk || out.includes(sk)) continue;
        out.push(sk);
      }
      return out;
    };

    const traceSpawnAttributionChain = (params: {
      childSessionKey?: unknown;
      agentId?: unknown;
      residentAgentId?: unknown;
      feedTruth?: FeedItem | null;
      nowState?: { details?: any } | null;
    }) => {
      const childSessionKey = typeof params?.childSessionKey === "string" ? params.childSessionKey.trim() : "";
      const visibleAgentId = canonicalVisibleAgentId(params?.agentId || params?.residentAgentId || "") || "";
      const observed = childSessionKey ? observedChildSessions.get(childSessionKey) : undefined;
      const parentSessionKeys = Array.isArray(observed?.parentSessionKeys) ? observed.parentSessionKeys.filter(Boolean) : [];
      const pendingMatches = parentSessionKeys.flatMap((parentSessionKey) => (pendingSpawnAttributionsByParent.get(parentSessionKey) || []).filter((entry) => {
        if (!entry) return false;
        if (!visibleAgentId) return true;
        return canonicalVisibleAgentId(entry.actorId) === visibleAgentId;
      }));
      const spawnedActorId = childSessionKey ? (spawnedSessionAgentIds.get(childSessionKey) || null) : null;
      const feedTruth = params?.feedTruth || null;
      const nowDetails = params?.nowState?.details || null;
      return {
        childSessionKey: childSessionKey || null,
        observedChildExists: !!observed,
        observedParentSessionKeys: parentSessionKeys,
        pendingParentIntentCount: pendingMatches.length,
        pendingParentIntents: pendingMatches.map((entry) => ({
          intentId: entry.intentId,
          actorId: entry.actorId,
          parentSessionKey: entry.parentSessionKey,
          residentAgentId: entry.residentAgentId,
          label: entry.label || null,
          task: entry.task || null,
        })),
        spawnedSessionAgentId: spawnedActorId,
        feedTruthAgentId: feedTruth ? resolveVisibleFeedItemAgentId(feedTruth, "") : null,
        feedTruthSessionKey: feedTruth?.sessionKey || null,
        nowFeedTruthSessionKey: nowDetails?.feedTruthSessionKey || null,
        freshCanonicalChildFeedCluster: nowDetails?.freshCanonicalChildFeedCluster ?? null,
      };
    };

    const adoptPendingSpawnAttributionForSession = async (sessionKey: unknown, ctx: any): Promise<PendingSpawnAttribution | undefined> => {
      await loadSpawnAttributionState();
      const sk = typeof sessionKey === "string" ? String(sessionKey).trim() : "";
      if (!sk) return undefined;
      const parsed = parseSessionIdentity(sk, ctx?.agentId);
      if (!hasAdoptableChildProof(sk, parsed.residentAgentId)) return undefined;
      const existingActorId = spawnedSessionAgentIds.get(sk);
      if (existingActorId && existingActorId !== "helper" && existingActorId !== UNKNOWN_CHILD_ACTOR_ID) {
        observedChildSessions.delete(sk);
        return {
          intentId: `bound:${sk}`,
          actorId: existingActorId,
          parentSessionKey: "",
          residentAgentId: canonicalResidentAgentId(parsed.residentAgentId),
          source: "explicit",
          createdAt: 0,
          childSessionKey: sk,
          boundAt: nowMs(),
        };
      }

      const observed = observedChildSessions.get(sk);
      const childMatcher = childAdoptionMatcherFromSources(ctx, observed);
      for (const parentSessionKey of childParentSessionKeysFromSources(ctx, observed)) {
        let adopted: PendingSpawnAttribution | undefined;
        for (const variant of childAdoptionMatcherVariants(childMatcher)) {
          adopted = pickPendingSpawnAttribution(pendingSpawnAttributionsByParent, parentSessionKey, variant);
          if (adopted) break;
        }
        if (!adopted) continue;
        forgetPendingSpawnAttributionFromResident(adopted.residentAgentId, adopted);
        adopted.childSessionKey = sk;
        adopted.boundAt = nowMs();
        bindSpawnedSessionAgent(sk, adopted.actorId, { reason: "pending_adoption:parent_intent" });
        await persistSpawnAttributionState();
        return adopted;
      }

      const resident = canonicalResidentAgentId(parsed.residentAgentId);
      if (!resident) return undefined;
      const eligible = (pendingSpawnAttributionsByResident.get(resident) || []).filter((candidate) => {
        if (!candidate) return false;
        const parentParsed = parseSessionIdentity(candidate.parentSessionKey, candidate.residentAgentId);
        return parentParsed.residentAgentId === resident && parentParsed.lane !== "cron";
      });
      if (!eligible.length) return undefined;
      let adopted: PendingSpawnAttribution | undefined;
      const residentMatcherVariants = childAdoptionMatcherVariants(childMatcher);
      for (const variant of residentMatcherVariants) {
        const actorId = canonicalVisibleAgentId(variant.actorId);
        const label = normalizeSpawnText(variant.label, 120);
        const task = normalizeSpawnText(variant.task, 240);
        const scored = eligible.map((entry, index) => {
          let score = 0;
          if (actorId) {
            if (entry.actorId !== actorId) return { entry, index, score: -1 };
            score += 8;
          }
          if (label) {
            if (normalizeSpawnText(entry.label, 120) !== label) return { entry, index, score: -1 };
            score += 4;
          }
          if (task) {
            if (normalizeSpawnText(entry.task, 240) !== task) return { entry, index, score: -1 };
            score += 4;
          }
          if (!actorId && !label && !task) {
            if (eligible.length !== 1) return { entry, index, score: -1 };
            score = 1;
          } else if (entry.source === "explicit") {
            score += 1;
          }
          return { entry, index, score };
        }).filter((candidate) => candidate.score >= 0);
        if (!scored.length) continue;
        const bestScore = Math.max(...scored.map((candidate) => candidate.score));
        const winners = scored.filter((candidate) => candidate.score === bestScore);
        if (bestScore <= 0 || winners.length !== 1) continue;
        adopted = winners[0]?.entry;
        if (adopted) break;
      }
      if (!adopted) return undefined;
      forgetPendingSpawnAttributionFromResident(resident, adopted);
      const parentQueue = pendingSpawnAttributionsByParent.get(adopted.parentSessionKey) || [];
      const nextParentQueue = parentQueue.filter((candidate) => candidate !== adopted);
      if (nextParentQueue.length) pendingSpawnAttributionsByParent.set(adopted.parentSessionKey, nextParentQueue);
      else pendingSpawnAttributionsByParent.delete(adopted.parentSessionKey);
      adopted.childSessionKey = sk;
      adopted.boundAt = nowMs();
      bindSpawnedSessionAgent(sk, adopted.actorId, { reason: "pending_adoption:resident_scored_match" });
      await persistSpawnAttributionState();
      return adopted;
    };

    const rememberSpawnedSessionAgent = async (sessionKey: unknown, agentId: unknown, options?: { allowOverwrite?: boolean; reason?: string }) => {
      await loadSpawnAttributionState();
      if (!bindSpawnedSessionAgent(sessionKey, agentId, options)) return;
      await persistSpawnAttributionState();
    };

    const resolveSpawnedChildSessionKey = (event: any, ctx: any): string => {
      const parentSessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
      const candidates = [
        event?.result?.childSessionKey,
        event?.childSessionKey,
        event?.result?.sessionKey,
        event?.result?.session?.sessionKey,
        event?.result?.session?.key,
        event?.result?.session?.id,
        event?.result?.sessionId,
        event?.result?.session_id,
        event?.sessionKey,
      ];
      for (const candidate of candidates) {
        const sk = typeof candidate === "string" ? candidate.trim() : "";
        if (!sk || sk === parentSessionKey) continue;
        const parsed = parseSessionIdentity(sk);
        if (parsed.lane === "subagent" || parsed.lane === "cron") return sk;
      }
      return "";
    };

    const resolveFeedAgentIdentity = async (ctx: any): Promise<{
      agentId: string;
      rawAgentId?: string;
      residentAgentId: string;
      lane: string;
      source: "spawned" | "explicit" | "fallback";
    }> => {
      const parsed = parseSessionIdentity(ctx?.sessionKey, ctx?.agentId);
      const rawSessionAgentId = parsed.agentId;
      const childSessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
      if (childSessionKey && isAdoptableChildLane(parsed.lane) && !spawnedSessionAgentIds.get(childSessionKey)) {
        await observeChildSessionForSpawnAdoption(childSessionKey, ctx);
      }
      const adoptedAttribution = childSessionKey && isAdoptableChildLane(parsed.lane)
        ? await adoptPendingSpawnAttributionForSession(childSessionKey, ctx)
        : undefined;
      const spawnedFromMap = spawnedSessionAgentIds.get(childSessionKey);
      api.logger.info("[lobster-room] resolveFeedAgentIdentity spawned check", {
        childSessionKey,
        hasAdopted: !!adoptedAttribution,
        adoptedActorId: adoptedAttribution?.actorId,
        spawnedFromMap,
        parsedLane: parsed.lane,
        parsedResident: parsed.residentAgentId,
      });
      const spawnedVisible = childSessionKey
        ? (adoptedAttribution?.actorId || spawnedFromMap || "")
        : "";
      if (spawnedVisible) {
        return {
          agentId: spawnedVisible,
          rawAgentId: rawSessionAgentId && rawSessionAgentId !== spawnedVisible ? rawSessionAgentId : undefined,
          residentAgentId: parsed.residentAgentId,
          lane: parsed.lane,
          source: "spawned",
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
          // Child session explicitly carrying the name 'main' is usually due to hook context bleed.
          // However, if the resident is explicitly 'qa_agent', we MUST accept it. 
          if (isAdoptableChildLane(parsed.lane) && visible === "main" && rawSessionAgentId !== visible) {
            continue;
          }
          return {
            agentId: visible,
            rawAgentId: raw && raw !== visible ? raw : rawSessionAgentId !== visible ? rawSessionAgentId : undefined,
            residentAgentId: parsed.residentAgentId,
            lane: parsed.lane,
            source: "explicit",
          };
        }
      }
      // For child (subagent) lanes: the canonical display identity is always the parent agent
      // embedded in the session key: agent:{parentAgentId}:subagent:{uuid} -> {parentAgentId}.
      let fallback: string;
      if (isAdoptableChildLane(parsed.lane)) {
        const residentVisible = canonicalVisibleAgentId(parsed.residentAgentId);
        fallback = residentVisible || "main";
      } else {
        fallback = canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || "main";
      }
      return {
        agentId: fallback,
        rawAgentId: rawSessionAgentId && rawSessionAgentId !== fallback ? rawSessionAgentId : undefined,
        residentAgentId: parsed.residentAgentId,
        lane: parsed.lane,
        source: "fallback",
      };
    };

    const resolveSnapshotWriterAgentId = (identity: {
      agentId: string;
      residentAgentId: string;
      lane: string;
      source: "spawned" | "explicit" | "fallback";
    }): string => {
      if (identity?.agentId === UNKNOWN_CHILD_ACTOR_ID) return "";
      const visible = canonicalVisibleAgentId(identity?.agentId);
      if (!visible) return "";
      if (identity?.lane === "main") return visible;
      if (identity?.source === "spawned" || identity?.source === "explicit") return visible;
      return "";
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
        setIdleWithCooldown(agentId, undefined, cur.details || undefined);
      }, toolMaxMs);
    };

    const setState = (agentId: string, next: ActivityState, details?: Record<string, unknown> | null) => {
      const row = ensure(agentId);
      const t = nowMs();
      const snapshotAgentId = typeof details?.snapshotAgentId === "string" ? canonicalVisibleAgentId(details.snapshotAgentId) : canonicalVisibleAgentId(agentId);

      // Persist to snapshot for API consumers.
      try {
        if (snapshotAgentId) {
          const prev = snap.agents[snapshotAgentId];
          if (!prev || prev.state !== next) {
            snap.agents[snapshotAgentId] = { state: next, sinceMs: t, lastEventMs: t, details: details ?? null };
          } else {
            snap.agents[snapshotAgentId] = { ...prev, lastEventMs: t, details: details ?? prev.details };
          }
          snap.agents = pruneSnapshotAgents(snap.agents);
          snap.updatedAtMs = t;
          writeSnapshotSoon();
        }
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

    const setIdleWithCooldown = (agentId: string, overrideMs?: number, details?: Record<string, unknown> | null) => {
      const row = ensure(agentId);
      const seq = row.seq + 1;
      row.seq = seq;
      const scheduledAt = nowMs();
      const snapshotAgentId = typeof details?.snapshotAgentId === "string" ? canonicalVisibleAgentId(details.snapshotAgentId) : canonicalVisibleAgentId(agentId);
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
          if (snapshotAgentId) {
            const prev = snap.agents[snapshotAgentId];
            snap.agents[snapshotAgentId] = {
              ...(prev || {}),
              state: "idle",
              sinceMs: t,
              lastEventMs: t,
              details: null,
            };
            snap.agents = pruneSnapshotAgents(snap.agents);
            snap.updatedAtMs = t;
            writeSnapshotSoon();
          }
        } catch {}
      }, waitMs);
      // Update lastEvent so API knows something just happened.
      row.lastEventMs = scheduledAt;
    };

    // Hooks → real runtime state
    const buildHookAttributionContext = (event: any, ctx: any): any => {
      const merged = ctx && typeof ctx === "object" ? { ...ctx } : {};
      if (event !== undefined && merged.event === undefined) merged.event = event;
      if (merged.payload === undefined) merged.payload = event?.params ?? event?.payload;
      if (merged.data === undefined) merged.data = event?.data;
      if (merged.details === undefined) merged.details = event?.details ?? event?.result?.details;
      if (!merged.agentId && ctx?.session?.agentId) merged.agentId = ctx.session.agentId;
      return merged;
    };

    const resolveAgentId = async (ctx: any, event?: any): Promise<string> => {
      const identity = await resolveFeedAgentIdentity(buildHookAttributionContext(event, ctx), ctx?.session?.agentId);
      return identity.agentId;
    };

    api.on("before_agent_start", async (event, ctx) => {
      // DEBUG: log full ctx keys to diagnose what OpenClaw provides
      api.logger.info("[lobster-room] before_agent_start ctx keys", {
        sessionKey: ctx?.sessionKey,
        "ctx.agentId": ctx?.agentId,
        "ctx.session?.agentId": ctx?.session?.agentId,
        "ctx.session?.sessionKey": ctx?.session?.sessionKey,
        "ctx.agent?.id": ctx?.agent?.id,
        "ctx.agent?.agentId": ctx?.agent?.agentId,
        "ctx.residentAgentId": ctx?.residentAgentId,
        allKeys: ctx ? Object.keys(ctx).join(", ") : "null",
      });
      const hookCtx = buildHookAttributionContext(event, ctx);

      // Option A (DISABLED): DO NOT write the parent's agentId as placeholder here.
      // Writing the parent agentId as a placeholder causes child events to be
      // attributed to the parent instead of the child. Let the adoption pipeline
      // set the correct value. If adoption hasn't completed,
      // resolveVisibleFeedItemAgentId will return UNKNOWN_CHILD_ACTOR_ID.
      // (Previously this wrote parentAgentId into spawnedSessionAgentIds, which
      // caused child tool_result_persist events to be misattributed to the parent.)
      // const childSessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
      // const parentSessionKey = hookCtx?.parentSessionKey || (ctx as any)?.parentSessionKey;
      // if (childSessionKey && parentSessionKey && isAdoptableChildLane(parseSessionIdentity(childSessionKey).lane)) {
      //   const parentAgentId = hookCtx?.residentAgentId || (ctx as any)?.residentAgentId;
      //   if (parentAgentId && String(parentAgentId).trim()) {
      //     spawnedSessionAgentIds.set(childSessionKey, String(parentAgentId).trim());
      //   }
      // }

      const agentIdentity = await resolveFeedAgentIdentity(hookCtx, ctx?.session?.agentId);
      const agentId = agentIdentity.agentId;
      const snapshotAgentId = resolveSnapshotWriterAgentId(agentIdentity);
      // api.logger.info("[lobster-room] hook before_agent_start", { buildTag: BUILD_TAG, agentId, sessionKey: ctx?.sessionKey });
      pushEvent("before_agent_start", { agentId, data: { sessionKey: ctx?.sessionKey, messageProvider: ctx?.messageProvider } });
      pushFeed({ ts: nowMs(), kind: "before_agent_start", agentId, rawAgentId: agentIdentity.rawAgentId, sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined });
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, messageProvider: ctx?.messageProvider, snapshotAgentId: snapshotAgentId || undefined });
    });

    api.on("before_tool_call", async (event, ctx) => {
      const hookCtx = buildHookAttributionContext(event, ctx);
      const toolName = event?.toolName || event?.tool || event?.name;
      const p = event?.params || null;
      const pendingAttribution = toolName === "sessions_spawn"
        ? await rememberPendingSpawnAttribution(ctx?.sessionKey, p)
        : undefined;
      const agentIdentity = await resolveFeedAgentIdentity(hookCtx, ctx?.session?.agentId);
      const agentId = agentIdentity.agentId;
      const snapshotAgentId = resolveSnapshotWriterAgentId(agentIdentity);
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
        setState(agentId, "thinking", { toolName, sessionKey: ctx?.sessionKey, lowSignal: true, snapshotAgentId: snapshotAgentId || undefined });
        return;
      }
      setState(agentId, "tool", { toolName, sessionKey: ctx?.sessionKey, snapshotAgentId: snapshotAgentId || undefined });
    });

    api.on("after_tool_call", async (event, ctx) => {
      const hookCtx = buildHookAttributionContext(event, ctx);
      const agentIdentity = await resolveFeedAgentIdentity(hookCtx, ctx?.session?.agentId);
      const agentId = agentIdentity.agentId;
      const snapshotAgentId = resolveSnapshotWriterAgentId(agentIdentity);
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
          const spawnMatcher = pendingSpawnMatcherFromPayload(event?.params);
          const pendingAttribution = await consumePendingSpawnAttribution(ctx?.sessionKey, spawnMatcher);
          const requestedSpawnAgentId = resolveRequestedSpawnAgentId(event?.params)
            || pendingAttribution?.actorId;
          const noisyInferredAgentId = resolveRequestedSpawnAgentId(event?.result)
            || resolveRequestedSpawnAgentId(event);
          const resolvedAgentId = requestedSpawnAgentId || noisyInferredAgentId;
          // Plan A fix: synchronously write to spawnedSessionAgentIds BEFORE the async adoption.
          // This ensures the child's first tool_result_persist can read the attribution
          // even if the child's hooks fire during the sessions_spawn execution.
          if (resolvedAgentId) {
            const visible = canonicalVisibleAgentId(resolvedAgentId);
            spawnedSessionAgentIds.set(childSessionKey, visible);
          } else {
            // Fallback: try to find pending attribution by resident agent ID
            // This helps when child session hooks fire before parent's sessions_spawn returns
            // IMPORTANT: use canonicalResidentAgentId(sessionKey), NOT canonicalVisibleAgentId(agentId)
            // canonicalVisibleAgentId("main") = "" (empty, wrong key)
            // canonicalResidentAgentId(sessionKey) = "main" (correct key)
            await loadSpawnAttributionState();
            const parentSessionKey = ctx?.session?.sessionKey || ctx?.sessionKey;
            const residentKey = parentSessionKey
              ? canonicalResidentAgentId(parentSessionKey)
              : (ctx?.agentId || ctx?.session?.agentId || "");
            const residentPending = pendingSpawnAttributionsByResident.get(residentKey) || [];
            if (residentPending.length > 0) {
              const pending = residentPending[0]; // Use first pending
              if (pending?.actorId) {
                const fallbackVisible = canonicalVisibleAgentId(pending.actorId);
                spawnedSessionAgentIds.set(childSessionKey, fallbackVisible);
              }
            }
          }
          await rememberSpawnedSessionAgent(childSessionKey, resolvedAgentId, {
            allowOverwrite: false,
            reason: requestedSpawnAgentId ? "sessions_spawn:payload_or_pending" : "sessions_spawn:fallback_result_inference",
          });
          if (requestedSpawnAgentId && noisyInferredAgentId && noisyInferredAgentId !== requestedSpawnAgentId) {
            api.logger.warn("[lobster-room] sessions_spawn actor inference mismatch; keeping payload/pending attribution", {
              sessionKey: childSessionKey,
              requestedSpawnAgentId,
              noisyInferredAgentId,
            });
          }
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
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, lowSignal: isLowSignalObservationTool(toolName) || undefined, snapshotAgentId: snapshotAgentId || undefined });
    });

    // Some tools may not reliably fire after_tool_call in all paths; use persist as a backup.
    // NOTE: this hook is intentionally synchronous (no async/await at top level) because the
    // OpenClaw plugin hook system registers it as a synchronous handler and ignores any
    // returned Promise.  When the handler was `async`, the await on resolveFeedAgentIdentity
    // suspended and returned a Promise immediately, causing agentId to be a Promise<string>
    // instead of a string at the setState call below — which meant canonical attribution state
    // was never written.  The async child-session adoption work is handled via a fire-and-forget
    // .then() that runs after the synchronous part completes.
    api.on("tool_result_persist", (event, ctx) => {
      const hookCtx = buildHookAttributionContext(event, ctx);
      const childSessionKey = typeof hookCtx?.sessionKey === "string" ? hookCtx.sessionKey.trim() : "";
      const parsed = parseSessionIdentity(childSessionKey, hookCtx?.agentId);

      // Synchronous path: resolve agentId from in-memory state without awaiting async I/O.
      // This mirrors resolveFeedAgentIdentity but skips the async observe/adopt calls.
      let agentId: string;
      let rawAgentId: string | undefined;
      let identitySource: "spawned" | "explicit" | "fallback" = "fallback";

      if (childSessionKey && isAdoptableChildLane(parsed.lane)) {
        const spawnedVisible = spawnedSessionAgentIds.get(childSessionKey) || "";
        if (spawnedVisible) {
          agentId = spawnedVisible;
          rawAgentId = parsed.agentId && parsed.agentId !== spawnedVisible ? parsed.agentId : undefined;
          identitySource = "spawned";
        }
      }

      if (identitySource === "fallback") {
        const rawSessionAgentId = parsed.agentId;
        const explicitCandidates = [
          hookCtx?.agentId,
          hookCtx?.agent?.id,
          hookCtx?.agent?.agentId,
          hookCtx?.session?.agentId,
          hookCtx?.residentAgentId,
        ];
        let found = false;
        for (const candidate of explicitCandidates) {
          const visible = canonicalVisibleAgentId(candidate);
          if (visible) {
            const raw = typeof candidate === "string" ? String(candidate).trim() : "";
            if (isAdoptableChildLane(parsed.lane) && visible === canonicalVisibleAgentId(parsed.residentAgentId) && rawSessionAgentId !== visible) {
              continue;
            }
            agentId = visible;
            rawAgentId = raw && raw !== visible ? raw : (rawSessionAgentId !== visible ? rawSessionAgentId : undefined);
            identitySource = "explicit";
            found = true;
            break;
          }
        }
        if (!found) {
          // Option B: for subagent lanes, don't fall back to resident — that causes
          // child events to be attributed to the parent. Return UNKNOWN_CHILD_ACTOR_ID
          // and let the async adoption pipeline fix the binding later.
          const fallback = isAdoptableChildLane(parsed.lane)
            ? UNKNOWN_CHILD_ACTOR_ID
            : (canonicalVisibleAgentId(rawSessionAgentId) || canonicalVisibleAgentId(parsed.residentAgentId) || "main");
          agentId = fallback;
          rawAgentId = rawSessionAgentId && rawSessionAgentId !== fallback ? rawSessionAgentId : undefined;
          identitySource = "fallback";
        }
      }

      const snapshotAgentId = (identitySource === "spawned" || identitySource === "explicit" || parsed.lane === "main")
        ? canonicalVisibleAgentId(agentId)
        : (agentId === UNKNOWN_CHILD_ACTOR_ID ? "" : "");

      const toolName = event?.toolName;
      const internalObservation = isInternalObservationToolCall(toolName, ctx);

      // Kick off async child-session adoption in the background (fire-and-forget).
      // This does not block the synchronous state write below.
      if (childSessionKey && isAdoptableChildLane(parsed.lane) && identitySource !== "spawned") {
        resolveFeedAgentIdentity(hookCtx, ctx?.session?.agentId).catch(() => {/* intentionally ignored */});
      }

      if (!internalObservation) {
        pushEvent("tool_result_persist", {
          agentId,
          data: { toolName, toolCallId: event?.toolCallId, isSynthetic: event?.isSynthetic },
        });
        pushFeed({
          ts: nowMs(),
          kind: "tool_result_persist",
          agentId,
          rawAgentId,
          sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
          toolName: typeof toolName === "string" ? toolName : undefined,
          details: {
            toolCallId: typeof event?.toolCallId === "string" ? event?.toolCallId : undefined,
            isSynthetic: !!event?.isSynthetic,
          },
        });
      }
      if (internalObservation) return;
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, persisted: true, lowSignal: isLowSignalObservationTool(toolName) || undefined, snapshotAgentId: snapshotAgentId || undefined });
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
      const agentIdentity = await resolveFeedAgentIdentity(buildHookAttributionContext(event, ctx), ctx?.session?.agentId);
      const agentId = agentIdentity.agentId;
      const snapshotAgentId = resolveSnapshotWriterAgentId(agentIdentity);
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
        setState(agentId, "error", { error: event?.error || "agent_end: unsuccessful", snapshotAgentId: snapshotAgentId || undefined });
        setTimeout(() => setIdleWithCooldown(agentId, cooldownMs, { snapshotAgentId: snapshotAgentId || undefined }), cooldownMs);
        return;
      }

      setState(agentId, "reply", { synthetic: true, snapshotAgentId: snapshotAgentId || undefined });
      setIdleWithCooldown(agentId, replyCooldownMs, { snapshotAgentId: snapshotAgentId || undefined });
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
              await refreshCronJobNameCache();
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
              const visibleItems = items.filter((it) => isUserVisibleFeedItem(it) && !shouldSuppressFeedItem(it, items));
              const visibleTasks = tasks
                .filter((task) => isFeedVisibleActorId(task.agentId))
                .map((t) => ({
                  id: t.id,
                  sessionKey: t.sessionKey,
                  agentId: visibleFeedAgentId(t.agentId, "unknown"),
                  startTs: t.startTs,
                  endTs: t.endTs,
                  status: t.status,
                  title: t.title,
                  summary: t.summary,
                  items: t.items ? t.items.filter((it) => isUserVisibleFeedItem(it)).map((it) => sanitizeFeedItemForApi(it, includeRaw)) : undefined,
                }));

              // Latest preview should reflect the most meaningful currently-visible work,
              // not merely the most recent orchestration/helper bookkeeping row.
              // Keep unresolved child work visible as @unknown until canonical proof arrives.
              const last = pickLatestVisibleFeedItem(visibleItems);

              // api.logger.info("[lobster-room] feedGet before sendJson", { itemsLen: items.length, tasksLen: tasks.length });
              sendJson(res, 200, {
                ok: true,
                buildTagFeed: FEED_UI_VERSION,
                latest: last ? sanitizeFeedItemForApi(last, true) : null,
                tasks: visibleTasks,
                rows: visibleItems.slice().reverse().map((it) => sanitizeFeedItemForApi(it, false)),
                items: includeRaw ? items.slice().reverse().map((it) => sanitizeFeedItemForApi(it, true)) : undefined,
              });
              // api.logger.info("[lobster-room] feedGet sent", { itemsLen: items.length, tasksLen: tasks.length });
              } catch (err: any) {
                api.logger.warn("[lobster-room] feedGet failed", { error: String(err?.message || err), stack: err?.stack });
                sendJson(res, 500, { ok: false, error: "feedGet_failed: " + String(err?.message || err), path: "/lobster-room/api/lobster-room" });
              }
              return true;
            }

            if (op === "debugSpawnTrace") {
              try {
                await loadSpawnAttributionState();
                const childSessionKey = typeof payload?.childSessionKey === "string" ? payload.childSessionKey.trim() : "";
                const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
                const visibleItems = feedBuf.filter((it) => isUserVisibleFeedItem(it) && !shouldSuppressFeedItem(it, feedBuf));
                const feedTruth = agentId ? latestVisibleFeedItemForAgent(agentId) : visibleItems.find((it) => String(it.sessionKey || "").trim() === childSessionKey) || null;
                sendJson(res, 200, {
                  ok: true,
                  buildTag: BUILD_TAG,
                  trace: traceSpawnAttributionChain({ childSessionKey, agentId, feedTruth }),
                });
              } catch (err: any) {
                sendJson(res, 500, { ok: false, error: "debugSpawnTrace_failed: " + String(err?.message || err) });
              }
              return true;
            }

            if (op === "feedSummarize") {
              // NOTE: We re-use the same logic as /lobster-room/api/feed/summarize,
              await refreshCronJobNameCache();
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
              // IMPORTANT: sessions_spawn uses 'agentId' parameter (not 'spawnAgentId') to set the child
              // session's resident agent. Using 'spawnAgentId' causes the child session to be attributed
              // to 'main' instead. Verified 2026-03-31: agentId="qa_agent" → sk="agent:qa_agent:subagent:..."
              const spawnAgentId = typeof payload?.agentId === "string" ? payload.agentId.trim()
                : (typeof payload?.spawnAgentId === "string" ? payload.spawnAgentId.trim() : "coding_agent");
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
                    args: { agentId: spawnAgentId, label, task },
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

        await identityPersistenceResetReady;
        const t = nowMs();

        // Load last known activity snapshot written by hook handlers.
        // This avoids relying on in-memory sharing between hook callbacks and HTTP routes.
        let snapDisk: ActivitySnapshot | null = null;
        try {
          const txt = await fs.readFile(snapshotPath, "utf8");
          const obj = JSON.parse(txt);
          if (obj && typeof obj === "object" && typeof (obj as any).buildTag === "string") {
            snapDisk = {
              ...(obj as any),
              agents: pruneSnapshotAgents((obj as any).agents),
            } as any;
          }
        } catch {
          snapDisk = null;
        }

        await loadSpawnAttributionState();

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
            if (rawId === UNKNOWN_CHILD_ACTOR_ID) continue;
            const id = canonicalResidentAgentId(rawId);
            if (id && id !== UNKNOWN_CHILD_ACTOR_ID && !seen.has(id)) {
              ids.push(id);
              seen.add(id);
            }
          }
          for (const visibleActorId of spawnedSessionAgentIds.values()) {
            if (visibleActorId === UNKNOWN_CHILD_ACTOR_ID) continue;
            const id = canonicalResidentAgentId(visibleActorId);
            if (id && id !== UNKNOWN_CHILD_ACTOR_ID && !seen.has(id)) {
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

        await refreshCronJobNameCache();
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

        const resolveVisibleSessionBucket = (sk: unknown): { agentId: string | null; source: "spawned" | "resident" | "none" } => {
          if (typeof sk !== "string") return { agentId: null, source: "none" };
          const raw = String(sk).trim();
          if (!raw) return { agentId: null, source: "none" };
          const spawnedVisible = spawnedSessionAgentIds.get(raw);
          if (spawnedVisible && spawnedVisible !== UNKNOWN_CHILD_ACTOR_ID) return { agentId: spawnedVisible, source: "spawned" };
          const parsed = parseSessionIdentity(raw);
          if (isAdoptableChildLane(parsed.lane)) return { agentId: null, source: "none" };
          const resident = canonicalVisibleAgentId(parsed.residentAgentId);
          return { agentId: resident || null, source: resident ? "resident" : "none" };
        };

        const skToAgentId = (sk: unknown): string | null => resolveVisibleSessionBucket(sk).agentId;

        const recentVisibleEventsForAgent = (agentId: string, limit = 24) => {
          const out: Array<{ ts: number; kind: string; agentId?: string; data?: any }> = [];
          const source = Array.isArray(snapDisk?.events) && snapDisk?.events?.length ? snapDisk.events : eventBuf;
          for (let i = source.length - 1; i >= 0; i -= 1) {
            const item = source[i];
            if (!item) continue;
            const visibleAgentId = resolveVisibleFeedItemAgentId(item, "");
            if (!visibleAgentId || visibleAgentId !== agentId) continue;
            out.push(item);
            if (out.length >= limit) break;
          }
          return out.reverse();
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
        const sessionBucketDebug = new Map<string, { key: string; source: "spawned" | "resident" | "none" }[]>();
        for (const s of sessions) {
          const bucket = resolveVisibleSessionBucket(s?.key);
          const aid = bucket.agentId;
          if (!aid) continue;
          const arr = sessionsByAgent.get(aid) || [];
          arr.push(s);
          sessionsByAgent.set(aid, arr);
          const debugArr = sessionBucketDebug.get(aid) || [];
          debugArr.push({ key: String(s?.key || ""), source: bucket.source });
          sessionBucketDebug.set(aid, debugArr);
        }

        const latestVisibleFeedItemForAgent = (agentId: string): FeedItem | null => {
          for (let i = feedBuf.length - 1; i >= 0; i -= 1) {
            const item = feedBuf[i];
            if (!item || resolveVisibleFeedItemAgentId(item, "") !== agentId) continue;
            if (!Number.isFinite(Number(item.ts))) continue;
            if ((t - Number(item.ts)) > staleMs) continue;
            return item;
          }
          return null;
        };

        const inferActivityFromFeedItem = (item: FeedItem | null): ActivityState | null => {
          if (!item) return null;
          if (item.kind === "message_sending" || item.kind === "message_sent") return "reply";
          if (item.kind === "before_tool_call") return "tool";
          if (item.kind === "agent_end") return item.success === false || !!item.error ? "error" : "idle";
          if (item.kind === "before_agent_start" || item.kind === "after_tool_call" || item.kind === "tool_result_persist") return "thinking";
          return null;
        };

        const activityNeedsFreshSession = (state: ActivityState | null | undefined): boolean => (
          state === "thinking" || state === "tool" || state === "reply"
        );

        const hasFreshCanonicalChildFeedCluster = (agentId: string, feedTruth: FeedItem | null): boolean => {
          if (!feedTruth || !activityNeedsFreshSession(inferActivityFromFeedItem(feedTruth))) return false;
          const sessionKey = typeof feedTruth.sessionKey === "string" ? feedTruth.sessionKey.trim() : "";
          if (!sessionKey) return false;
          if (spawnedSessionAgentIds.get(sessionKey) !== agentId) return false;
          const parsed = parseSessionIdentity(sessionKey, agentId);
          if (!isAdoptableChildLane(parsed.lane)) return false;
          let hits = 0;
          for (let i = feedBuf.length - 1; i >= 0; i -= 1) {
            const item = feedBuf[i];
            if (!item) continue;
            if ((t - Number(item.ts || 0)) > staleMs) break;
            if (resolveVisibleFeedItemAgentId(item, "") !== agentId) continue;
            const itemSessionKey = typeof item.sessionKey === "string" ? item.sessionKey.trim() : "";
            if (itemSessionKey !== sessionKey) continue;
            if (!activityNeedsFreshSession(inferActivityFromFeedItem(item))) continue;
            hits += 1;
            if (hits >= 2) return true;
          }
          return false;
        };

        const hasFreshCorroboratedActiveSignal = (params: {
          snapFresh: boolean;
          snapState: ActivityState | null;
          snapRow: any;
          feedTruth: FeedItem | null;
          feedTruthState: ActivityState | null;
        }): boolean => {
          const { snapFresh, snapState, snapRow, feedTruth, feedTruthState } = params;
          if (!snapFresh || !feedTruth || !feedTruthState) return false;
          if (!activityNeedsFreshSession(snapState) || !activityNeedsFreshSession(feedTruthState)) return false;
          const snapSessionKey = typeof snapRow?.details?.sessionKey === "string" ? snapRow.details.sessionKey.trim() : "";
          const feedSessionKey = typeof feedTruth?.sessionKey === "string" ? feedTruth.sessionKey.trim() : "";
          if (snapSessionKey && feedSessionKey && snapSessionKey !== feedSessionKey) return false;
          return true;
        };

        const agentsPayload = [] as any[];
        for (const agentId of allowIds) {
          const displayName = agentNameOverrides[agentId] || identityNameByAgentId.get(agentId) || agentId;
          const list = (sessionsByAgent.get(agentId) || []).filter((s) => typeof s?.key === "string");
          list.sort((a, b) => (Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0)));

          const maxUpdatedAt = list.length ? Number(list[0]?.updatedAt || 0) : 0;
          const freshSessions = list.filter((s) => {
            const updatedAt = Number(s?.updatedAt || 0);
            return !!(updatedAt && (t - updatedAt) <= staleMs);
          });
          const freshMaxUpdatedAt = freshSessions.length ? Number(freshSessions[0]?.updatedAt || 0) : 0;

          // session_status on the freshest candidate sessions only (best-effort)
          let queueDepth: number | null = null;
          let statusText: string | null = null;
          const statusCandidates = freshSessions.slice(0, 2);
          for (const sessionRow of statusCandidates) {
            try {
              const r2 = await invoke("session_status", { sessionKey: String(sessionRow.key) });
              const det2 = r2?.result?.details || {};
              const qd = det2.queueDepth ?? det2?.queue?.depth;
              if (Number.isFinite(Number(qd))) {
                const nextDepth = Number(qd);
                if (queueDepth == null || nextDepth > queueDepth) {
                  queueDepth = nextDepth;
                  statusText = typeof det2.statusText === "string" ? det2.statusText : statusText;
                }
                if (nextDepth > 0) break;
              }
            } catch {}
          }

          // sessions_history remains debug-only; do not let observation probes drive visible state.
          let lastType: string | null = null;
          let lastRole: string | null = null;
          let historyTypes: string[] = [];
          if (statusCandidates.length) {
            try {
              const r3 = await invoke("sessions_history", { sessionKey: String(statusCandidates[0].key), limit: 8 });
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
          let currentTruthSource = "idle";

          // P0 current-truth rule:
          // 1) fresh hook snapshot wins;
          // 2) else fresh visible feed row wins;
          // 3) else only a fresh queueDepth>0 may show active thinking;
          // 4) otherwise stay idle/wait. Old sessions and observation probes must not create fake tool/reply state.
          const snapRow = snapDisk?.agents?.[agentId];
          const snapLowSignal = !!(snapRow?.details && (
            snapRow.details.lowSignal === true
            || isLowSignalObservationTool(snapRow.details.toolName)
          ));
          const snapFresh = !!(
            snapRow
            && !snapLowSignal
            && typeof snapRow.lastEventMs === "number"
            && (t - snapRow.lastEventMs) <= staleMs
          );
          const snapState = snapFresh ? (snapRow.state as ActivityState) : null;
          const feedTruth = latestVisibleFeedItemForAgent(agentId);
          // Now panel enforces a stricter 10s window for feed-based activity (vs staleMs 15s used elsewhere)
          const nowPanelFeedTruth = (feedTruth && (t - Number(feedTruth.ts)) <= 10000) ? feedTruth : null;
          const feedTruthState = inferActivityFromFeedItem(nowPanelFeedTruth);
          const freshCanonicalChildFeedCluster = hasFreshCanonicalChildFeedCluster(agentId, feedTruth);
          const freshActiveCorroborated = hasFreshCorroboratedActiveSignal({ snapFresh, snapState, snapRow, feedTruth, feedTruthState });
          const activeGrace = freshActiveCorroborated || freshCanonicalChildFeedCluster;
          const snapUsable = !!(snapFresh && (!activityNeedsFreshSession(snapState) || freshSessions.length || activeGrace));
          const feedTruthUsable = !!(feedTruthState && (!activityNeedsFreshSession(feedTruthState) || freshSessions.length || activeGrace));
          if (snapUsable) {
            activityState = snapState as ActivityState;
            uiState = mapActivityToUiState(activityState);
            currentTruthSource = "snapshot";
          } else if (feedTruthUsable) {
            activityState = feedTruthState as ActivityState;
            uiState = mapActivityToUiState(activityState);
            currentTruthSource = "feed";
          } else if (typeof queueDepth === "number" && queueDepth > 0 && freshSessions.length) {
            activityState = "thinking";
            uiState = "think";
            currentTruthSource = "session_status";
          } else {
            activityState = "idle";
            uiState = "wait";
            currentTruthSource = freshSessions.length ? "fresh_session_idle" : "stale_or_none";
          }

          const sinceOut = snapFresh
            ? (snapRow?.sinceMs || null)
            : (feedTruth ? Number(feedTruth.ts) : (freshMaxUpdatedAt || null));
          const lastOut = snapFresh
            ? (snapRow?.lastEventMs || null)
            : (feedTruth ? Number(feedTruth.ts) : (freshMaxUpdatedAt || null));
          const recentEvents = recentVisibleEventsForAgent(agentId);
          const decisionDetails: any = {
            queueDepth,
            statusText,
            historyTypes,
            lastRole,
            lastType,
            snapFresh,
            snapUsable,
            snapState: snapRow?.state || null,
            feedTruthKind: feedTruth?.kind || null,
            feedTruthSessionKey: feedTruth?.sessionKey || null,
            freshActiveCorroborated,
            freshCanonicalChildFeedCluster,
            feedTruthUsable,
            freshSessionCount: freshSessions.length,
            freshMaxUpdatedAt: freshMaxUpdatedAt || null,
            sessionBucketing: (sessionBucketDebug.get(agentId) || []).map((row) => ({
              key: row.key,
              source: row.source,
            })),
          };
          if (snapRow?.details && typeof snapRow.details === "object") {
            Object.assign(decisionDetails, snapRow.details);
          }
          if ((!decisionDetails.toolName || currentTruthSource === "feed") && feedTruth?.toolName) {
            decisionDetails.toolName = feedTruth.toolName;
          }
          if ((!decisionDetails.sessionKey || currentTruthSource === "feed") && feedTruth?.sessionKey) {
            decisionDetails.sessionKey = feedTruth.sessionKey;
          }
          if (currentTruthSource === "feed" && feedTruth?.details && typeof feedTruth.details === "object") {
            decisionDetails.feedTruthDetails = feedTruth.details;
            for (const [k, v] of Object.entries(feedTruth.details)) {
              if (decisionDetails[k] == null && v != null) decisionDetails[k] = v;
            }
          }
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
                currentTruthSource,
                details: decisionDetails,
                recentEvents,
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
