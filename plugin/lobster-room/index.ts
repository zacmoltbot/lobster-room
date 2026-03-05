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

export default {
  id: "lobster-room",
  register(api: PluginApi) {
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

    // --- HTTP: dynamic handler (prefix routing) ---
    // OpenClaw plugin httpRoutes are exact-path matches; use httpHandler for prefix routes like static assets.
    api.registerHttpHandler(async (req, res) => {
      const url = readRequestUrl(req);
      // Normalize trailing slashes so routes work with or without a final '/'
      const pRaw = url.pathname || "/";
      const p = (pRaw !== "/") ? pRaw.replace(/\/+$/, "") : "/";

      // Static assets: /lobster-room/assets/** → <pluginDir>/assets/**
      const assetsPrefix = "/lobster-room/assets/";
      if (p.startsWith(assetsPrefix)) {
        let rel = p.slice(assetsPrefix.length);
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
      }

      // Rooms API
      if (p === "/lobster-room/api/rooms" || p === "/lobster-room/api/rooms/active" || p === "/lobster-room/api/rooms/delete") {
        if ((req.method || "GET").toUpperCase() === "GET") {
          const idx = (await readRoomsIndex()) || { activeRoomId: defaultRoomId, rooms: [{ id: defaultRoomId, name: "Default", createdAt: 0, updatedAt: 0 }] };
          sendJson(res, 200, { ok: true, ...idx });
          return true;
        }
        if ((req.method || "GET").toUpperCase() === "POST" && p.endsWith("/active")) {
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

        if ((req.method || "GET").toUpperCase() === "POST" && p.endsWith("/delete")) {
          try {
            const buf = await readBody(req, 128 * 1024);
            const obj = JSON.parse(buf.toString("utf8"));
            const roomId = String(obj?.roomId || "").trim();
            if (!safeRoomId(roomId)) throw new Error("bad_room_id");
            if (roomId === defaultRoomId) throw new Error("cannot_delete_default");
            const idx = (await readRoomsIndex()) || { activeRoomId: defaultRoomId, rooms: [{ id: defaultRoomId, name: "Default", createdAt: 0, updatedAt: 0 }] };
            if (!idx.rooms.find((r) => r.id === roomId)) throw new Error("room_not_found");

            // Remove from index
            idx.rooms = idx.rooms.filter((r) => r.id !== roomId);
            if (idx.activeRoomId === roomId) idx.activeRoomId = defaultRoomId;
            await writeRoomsIndex(idx);

            // Delete directory best-effort
            try {
              // Node 22: fs.rm available
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
      }

      // Manual map API (user painted walkable zones) (per-active-room)
      if (p === "/lobster-room/api/manual-map" || p === "/lobster-room/api/manual-map/reset") {
        const roomId = await getActiveRoomId();
        const mapPath = roomPath(roomId, "manual-map.json");

        if (p.endsWith("/reset")) {
          if ((req.method || "GET").toUpperCase() !== "POST") {
            res.statusCode = 405;
            res.end("method_not_allowed");
            return true;
          }
          try {
            await fs.unlink(mapPath).catch(() => undefined);
            sendJson(res, 200, { ok: true });
          } catch (err: any) {
            sendJson(res, 500, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }

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
            // lightweight validation
            if (!obj || typeof obj !== "object") throw new Error("bad_json");
            if (typeof (obj as any).tx !== "number" || typeof (obj as any).ty !== "number" || !Array.isArray((obj as any).cells)) {
              throw new Error("bad_shape");
            }
            await fs.writeFile(mapPath, JSON.stringify(obj, null, 2));
            // update room updatedAt
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
      }

      // Room layout API (inferred regions)
      if (p === "/lobster-room/api/room-layout" || p === "/lobster-room/api/room-layout/reset") {
        const layoutPath = join(rootUserDir, "room-layout.json");

        if (p.endsWith("/reset")) {
          if ((req.method || "GET").toUpperCase() !== "POST") {
            res.statusCode = 405;
            res.end("method_not_allowed");
            return true;
          }
          try {
            await fs.unlink(layoutPath).catch(() => undefined);
            sendJson(res, 200, { ok: true });
          } catch (err: any) {
            sendJson(res, 500, { ok: false, error: String(err?.message || err) });
          }
          return true;
        }

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
            // validate JSON shape lightly
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
      }

      // Room image API (per-active-room)
      if (p === "/lobster-room/api/room-image/info" || p === "/lobster-room/api/room-image" || p === "/lobster-room/api/room-image/reset") {
        const roomId = await getActiveRoomId();
        const imgPath = roomPath(roomId, "room.jpg");

        // info
        if (p.endsWith("/info")) {
          const idx = await readRoomsIndex();
          const room = idx?.rooms?.find((r) => r.id === roomId) || { id: roomId, name: roomId, createdAt: 0, updatedAt: 0 };
          sendJson(res, 200, { ok: true, exists: true, roomId, roomName: room.name, updatedAt: room.updatedAt || null });
          return true;
        }

        // reset = switch to default (do not delete)
        if (p.endsWith("/reset")) {
          if ((req.method || "GET").toUpperCase() !== "POST") {
            res.statusCode = 405;
            res.end("method_not_allowed");
            return true;
          }
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

        // GET image bytes
        if ((req.method || "GET").toUpperCase() === "GET") {
          try {
            const buf = await fs.readFile(imgPath);
            res.statusCode = 200;
            res.setHeader("content-type", "image/jpeg");
            res.setHeader("cache-control", "no-store");
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
            // Store as JPEG to simplify; keep bytes as-is (we don't transcode here).
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
      }

      return false;
    });

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
      if (event?.success === false) {
        setState(agentId, "error", { error: event?.error || "message_sent failed", to: event?.to, channelId: ctx?.channelId });
      }
      setIdleWithCooldown(agentId);
    });

    api.on("agent_end", (event, ctx) => {
      const agentId = resolveAgentId(ctx);
      pushEvent("agent_end", { agentId, data: { success: event?.success, error: event?.error, sessionKey: ctx?.sessionKey } });

      if (event?.success === false) {
        setState(agentId, "error", { error: event?.error || "agent_end: unsuccessful" });
        setTimeout(() => setIdleWithCooldown(agentId), cooldownMs);
        return;
      }

      setState(agentId, "reply", { synthetic: true });
      setIdleWithCooldown(agentId);
    });

    // --- Local assets via API (most reliable across gateway routers) ---
    // Usage: /lobster-room/api/asset?path=furniture/sofa.svg
    api.registerHttpRoute({
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
          return;
        }
        if (!rel.startsWith("furniture/")) {
          res.statusCode = 403;
          res.end("forbidden");
          return;
        }
        const ct = contentTypeByExt(extname(rel));
        if (!ct) {
          res.statusCode = 415;
          res.end("unsupported_media_type");
          return;
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
      },
    });

    // HTTP: portal
    api.registerHttpRoute({
      path: "/lobster-room/",
      handler: async (_req, res) => {
        try {
          const html = await fs.readFile(portalHtmlPath, "utf8");
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

    // HTTP: API
    api.registerHttpRoute({
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
              return;
            }
            const boundary = m[1];
            try {
              await fs.mkdir(rootUserDir, { recursive: true });
              const body = await readBody(req, 12 * 1024 * 1024);
              const filePart = parseMultipartFile(body, boundary);
              const ext = extFromContentType(filePart.contentType) || extname(filePart.filename).toLowerCase();
              if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
                sendJson(res, 415, { ok: false, error: "unsupported_image_type", contentType: filePart.contentType });
                return;
              }
              const outExt = ext === ".jpeg" ? ".jpg" : ext;
              const outFile = `room${outExt}`;
              await fs.writeFile(join(rootUserDir, outFile), filePart.data);
              await fs.writeFile(roomMetaPath, JSON.stringify({ file: outFile, updatedAt: Date.now() }, null, 2));
              sendJson(res, 200, { ok: true, file: outFile });
            } catch (err: any) {
              sendJson(res, 500, { ok: false, error: String(err?.message || err) });
            }
            return;
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

            if (op === "roomImageInfo") {
              const meta = await readRoomMeta();
              sendJson(res, 200, { ok: true, exists: !!meta?.file, file: meta?.file || null, updatedAt: meta?.updatedAt || null });
              return;
            }

            if (op === "roomImageGet") {
              const meta = await readRoomMeta();
              const file = meta?.file;
              if (!file) {
                sendJson(res, 200, { ok: true, exists: false });
                return;
              }
              const rel = file.replace(/^\/+/, "");
              if (rel.includes("..") || rel.includes("\\")) {
                sendJson(res, 400, { ok: false, error: "bad_request" });
                return;
              }
              const ct = contentTypeByExt(extname(rel));
              if (!ct || !ct.startsWith("image/")) {
                sendJson(res, 415, { ok: false, error: "unsupported_media_type" });
                return;
              }
              const buf = await fs.readFile(join(rootUserDir, rel));
              const b64 = buf.toString("base64");
              sendJson(res, 200, { ok: true, exists: true, contentType: ct.split(";")[0], dataUrl: `data:${ct.split(";")[0]};base64,${b64}`, updatedAt: meta?.updatedAt || null });
              return;
            }

            if (op === "roomImageReset") {
              try {
                const meta = await readRoomMeta();
                if (meta?.file) {
                  try { await fs.unlink(join(rootUserDir, meta.file)); } catch {}
                }
                try { await fs.unlink(roomMetaPath); } catch {}
                sendJson(res, 200, { ok: true });
              } catch (err: any) {
                sendJson(res, 500, { ok: false, error: String(err?.message || err) });
              }
              return;
            }
          }
        }

        const t = nowMs();

        const agentIdByDefault = "main";
        const agentIdAllowRaw = (process.env.LOBSTER_ROOM_AGENT_IDS || "").trim();
        const allowIds = agentIdAllowRaw
          ? agentIdAllowRaw
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [agentIdByDefault];

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
            const displayName = agentNameOverrides[row.agentId] || identityNameByAgentId.get(row.agentId) || row.agentId;
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
      portalHtmlPath,
      cooldownMs,
      minDwellMs,
      pollSeconds,
      staleMs,
      toolMaxMs,
    });
  },
};
