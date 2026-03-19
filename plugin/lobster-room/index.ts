import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import fs from "node:fs/promises";

type PluginRoute = {
  path: string;
  auth?: "gateway" | "plugin";
  match?: "exact" | "prefix";
  replaceExisting?: boolean;
  handler: (req: IncomingMessage, res: ServerResponse) => boolean | void | Promise<boolean | void>;
};

type PluginApi = {
  id: string;
  config: any;
  logger: { info: (msg: string, meta?: any) => void; warn: (msg: string, meta?: any) => void };
  registerHttpRoute: (params: PluginRoute) => void;
  on: (hookName: string, handler: (event: any, ctx: any) => any, opts?: { priority?: number }) => void;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

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

const BUILD_TAG = "feed-v3-20260315.19";

export default {
  id: "lobster-room",
  register(api: PluginApi) {
    api.logger.info("[lobster-room] register", { buildTag: BUILD_TAG });
    // Resolve asset path relative to this plugin module (NOT the gateway cwd).
    const pluginDir = dirname(fileURLToPath(import.meta.url));
    const portalHtmlPath = join(pluginDir, "assets", "lobster-room.html");
    const bundledRoomImgPath = join(pluginDir, "assets", "default-room.jpg");
    const bundledManualMapPath = join(pluginDir, "assets", "default-manual-map.json");

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
    // OpenClaw 2026.3.13 removed registerHttpHandler; use a prefix route instead.
    registerSafePluginRoute(api, {
      path: "/lobster-room",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => {
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
          if (rel === "user/activity.js") {
            const payload = JSON.stringify({ status: "" });
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.setHeader("cache-control", "no-store");
            res.end(payload);
            // Best-effort seed so future reads succeed.
            try {
              const target = join(pluginDir, "assets", rel);
              await fs.mkdir(dirname(target), { recursive: true });
              await fs.writeFile(target, payload);
            } catch {}
          } else {
            res.statusCode = 404;
            res.end("not_found");
          }
        }
        return true;
      }

      // Agent label mapping API
      if (p === "/lobster-room/api/agent-labels") {
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
            try {
              const txt = await fs.readFile(bundledManualMapPath, "utf8");
              res.statusCode = 200;
              res.setHeader("content-type", "application/json; charset=utf-8");
              res.setHeader("cache-control", "no-store");
              res.end(txt);
              // Best-effort seed so future reads succeed.
              try {
                await fs.mkdir(dirname(mapPath), { recursive: true });
                await fs.writeFile(mapPath, txt);
              } catch {}
            } catch {
              const empty = { version: 1, tx: 32, ty: 20, cells: new Array(32 * 20).fill(null), updatedAt: null };
              const txt = JSON.stringify(empty, null, 2);
              res.statusCode = 200;
              res.setHeader("content-type", "application/json; charset=utf-8");
              res.setHeader("cache-control", "no-store");
              res.end(txt);
              // Best-effort seed so future reads succeed.
              try {
                await fs.mkdir(dirname(mapPath), { recursive: true });
                await fs.writeFile(mapPath, txt);
              } catch {}
            }
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
        // Cache strategy A: serve the image with a long-lived immutable cache.
        // Frontend uses a versioned query param (?v=<updatedAt>) so this is safe.
        if ((req.method || "GET").toUpperCase() === "GET") {
          try {
            const st = await fs.stat(imgPath);
            const etag = `W/"${st.size}-${Math.floor(st.mtimeMs)}"`;

            res.setHeader("content-type", "image/jpeg");
            res.setHeader("cache-control", "public, max-age=31536000, immutable");
            res.setHeader("etag", etag);
            res.setHeader("last-modified", st.mtime.toUTCString());

            // Conditional GET: if the browser already has this exact content cached.
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
            try {
              const st = await fs.stat(bundledRoomImgPath);
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

              const buf = await fs.readFile(bundledRoomImgPath);
              res.statusCode = 200;
              res.end(buf);
              // Best-effort seed so future reads succeed.
              try {
                await fs.mkdir(dirname(imgPath), { recursive: true });
                await fs.writeFile(imgPath, buf);
              } catch {}
            } catch {
              res.statusCode = 404;
              res.end("not_found");
            }
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

    const readSnapshotDisk = async (): Promise<ActivitySnapshot | null> => {
      try {
        const txt = await fs.readFile(snapshotPath, "utf8");
        const obj = JSON.parse(txt);
        if (obj && typeof obj === "object" && typeof (obj as any).buildTag === "string") return obj as any;
      } catch {
        return null;
      }
      return null;
    };

    const collectAllowedAgentIds = (snapDisk: ActivitySnapshot | null): string[] => {
      const agentIdAllowRaw = (process.env.LOBSTER_ROOM_AGENT_IDS || "").trim();
      let allowIds: string[] = [];
      if (agentIdAllowRaw) {
        allowIds = agentIdAllowRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
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
        for (const id of activity.keys()) {
          if (id && !seen.has(id)) {
            ids.push(id);
            seen.add(id);
          }
        }
        const snapAgentIds = snapDisk && snapDisk.agents ? Object.keys(snapDisk.agents) : [];
        for (const id of snapAgentIds) {
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
      return allowIds;
    };

    const activitySnapshotCacheMs = Math.max(1000, Math.min(10000, Number.parseInt((process.env.LOBSTER_ROOM_ACTIVITY_CACHE_MS || "3000").trim(), 10) || 3000));
    let activitySnapshotCache: { at: number; value: ActivitySnapshot | null; inFlight: Promise<ActivitySnapshot> | null } = {
      at: 0,
      value: null,
      inFlight: null,
    };

    const deriveActivitySnapshot = async (): Promise<ActivitySnapshot> => {
      const cachedAge = nowMs() - activitySnapshotCache.at;
      if (activitySnapshotCache.value && cachedAge >= 0 && cachedAge < activitySnapshotCacheMs) return activitySnapshotCache.value;
      if (activitySnapshotCache.inFlight) return activitySnapshotCache.inFlight;

      const run = async (): Promise<ActivitySnapshot> => {
      const t = nowMs();
      const snapDisk = await readSnapshotDisk();
      const allowIds = collectAllowedAgentIds(snapDisk);
      for (const id of allowIds) ensure(id);

      const gatewayToken: string | null = typeof api.config?.gateway?.auth?.token === "string" ? api.config.gateway.auth.token : null;
      const invokeUrl = "http://127.0.0.1:18789/tools/invoke";
      const invoke = async (tool: string, args: any) => {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (gatewayToken) headers.authorization = `Bearer ${gatewayToken}`;
        const resp = await fetch(invokeUrl, { method: "POST", headers, body: JSON.stringify({ tool, args }) });
        const data = await resp.json();
        if (!data?.ok) throw new Error(String(data?.error || "invoke_failed"));
        return data;
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

      const agents: ActivitySnapshot["agents"] = {};
      let updatedAtMs = snapDisk?.updatedAtMs || 0;

      for (const agentId of allowIds) {
        const list = (sessionsByAgent.get(agentId) || []).filter((s) => typeof s?.key === "string");
        list.sort((a, b) => (Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0)));

        const maxUpdatedAt = list.length ? Number(list[0]?.updatedAt || 0) : 0;
        const recent = !!(maxUpdatedAt && (t - maxUpdatedAt) <= staleMs);

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
        const snapRow = snapDisk?.agents?.[agentId];
        const snapFresh = !!(snapRow && typeof snapRow.lastEventMs === "number" && (t - snapRow.lastEventMs) <= staleMs);
        if (snapFresh) {
          activityState = snapRow.state as ActivityState;
        } else if (typeof queueDepth === "number" && queueDepth > 0) {
          activityState = "thinking";
        } else if (recent && lastType === "toolCall") {
          activityState = "tool";
        } else if (recent && lastType === "text" && lastRole === "assistant") {
          activityState = "reply";
        } else {
          activityState = "idle";
        }

        const sinceOut = snapFresh ? (snapRow?.sinceMs || null) : (maxUpdatedAt || null);
        const lastOut = snapFresh ? (snapRow?.lastEventMs || null) : (maxUpdatedAt || null);
        const details = snapFresh ? (snapRow?.details || null) : { queueDepth, statusText, historyTypes, lastRole, lastType };

        agents[agentId] = {
          state: activityState,
          sinceMs: sinceOut || t,
          lastEventMs: lastOut || t,
          details: details || null,
        };
        if (typeof lastOut === "number" && Number.isFinite(lastOut)) updatedAtMs = Math.max(updatedAtMs, lastOut);
      }

      if (!updatedAtMs) updatedAtMs = t;

      return {
        buildTag: BUILD_TAG,
        updatedAtMs,
        agents,
        events: snapDisk?.events || [],
      };
      };

      activitySnapshotCache.inFlight = run();
      try {
        const snapshot = await activitySnapshotCache.inFlight;
        activitySnapshotCache = { at: nowMs(), value: snapshot, inFlight: null };
        return snapshot;
      } catch (err) {
        activitySnapshotCache.inFlight = null;
        throw err;
      }
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
      | "agent_end"
      | "presence";

    type FeedItem = {
      ts: number;
      kind: FeedKind;
      agentId?: string;
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
    const FEED_PRESENCE_MIN_MS = Math.max(2000, Number(api.config?.feedPresenceMinMs) || 0);
    const FEED_HEARTBEAT_MS = Math.max(5000, Number(api.config?.feedPresenceHeartbeatMs) || 0);
    const lastPresenceByAgent = new Map<string, { state: ActivityState; ts: number; toolName?: string }>();
    const lastFeedByAgent = new Map<string, number>();

    // Synthetic feed events for spawned sub-agents (sessions_spawn).
    // The runtime doesn't currently emit feed hooks for child agents unless they use /tools/invoke.
    type SpawnInfo = {
      childAgentId: string;
      childSessionKey: string;
      startTs: number;
    };
    const spawnStacksByAgent = new Map<string, SpawnInfo[]>();


    const redactSecretsInText = (s: string): string => {
      let out = String(s || "");

      // OpenClaw tool call ids / file cache ids can appear in logs as call_*/fc_* tokens.
      // Redact them WITHOUT leaking the prefixes (no literal 'call_' / 'fc_' should remain).
      // Match even when embedded (e.g. JSON, markdown, stack traces).
      out = out.replace(/(?:call|fc)_[A-Za-z0-9_-]{6,}/g, '[OC_ID_REDACTED]'); // CALL_FC_REDACTED

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

    const feedPreview = (it: FeedItem): string => {
      const agent = it.agentId ? `@${it.agentId}` : "";
      if (it.kind === "presence") {
        const stRaw = typeof (it.details as any)?.state === "string" ? String((it.details as any).state) : "";
        const st = stRaw === "reply" ? "replying"
          : stRaw === "tool" ? "tool"
          : stRaw === "thinking" ? "thinking"
          : stRaw === "idle" ? "idle"
          : stRaw === "error" ? "error"
          : stRaw;
        const tn = typeof it.toolName === "string" ? it.toolName : (typeof (it.details as any)?.toolName === "string" ? (it.details as any).toolName : "");
        const tail = (stRaw === "tool" && tn) ? `: ${tn}` : "";
        return `${agent} ${st}${tail}`.trim();
      }
      if (it.kind === "before_agent_start") return `${agent} started`;
      if (it.kind === "before_tool_call") {
        const tn = it.toolName || "tool";
        const cmd = coerceStr((it.details as any)?.command, 180);
        const url = coerceStr((it.details as any)?.url, 180);
        const extra = cmd ? ` — ${cmd}` : url ? ` — ${url}` : "";
        return `${agent} ${tn}${extra}`.trim();
      }
      if (it.kind === "after_tool_call") {
        const tn = it.toolName || "tool";
        const d = typeof it.durationMs === "number" ? ` (${Math.round(it.durationMs)}ms)` : "";
        return `${agent} ${tn} done${d}`.trim();
      }
      if (it.kind === "tool_result_persist") return `${agent} tool result persisted`;
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
      if (it.kind === "state") {
        const st = String((it.details as any)?.state || "");
        return st ? `${agent} state → ${st}` : `${agent} state changed`;
      }
      return it.kind;
    };

    const pushFeed = (item: FeedItem) => {
      feedBuf.push(item);
      if (typeof item.agentId === "string" && item.agentId.trim()) {
        lastFeedByAgent.set(item.agentId.trim(), item.ts || nowMs());
      }
      if (feedBuf.length > FEED_MAX) feedBuf.splice(0, feedBuf.length - FEED_MAX);
    };

    const pushPresence = (
      agentId: string,
      state: ActivityState,
      details?: Record<string, unknown> | null,
      opts?: { force?: boolean; heartbeat?: boolean },
    ) => {
      const t = nowMs();
      const toolName = typeof (details as any)?.toolName === "string" ? String((details as any).toolName) : undefined;
      const prev = lastPresenceByAgent.get(agentId);
      const force = !!opts?.force;
      if (!force && prev && prev.state === state && (prev.toolName || "") === (toolName || "")) return;
      if (!force && prev && (t - prev.ts) < FEED_PRESENCE_MIN_MS) return;
      lastPresenceByAgent.set(agentId, { state, ts: t, toolName });
      const detailPayload: Record<string, unknown> = { state, toolName };
      if (opts?.heartbeat) detailPayload.heartbeat = true;
      const extra: any = details && typeof details === "object" ? details : null;
      if (extra) {
        if (typeof extra.command === "string" || Array.isArray(extra.command)) detailPayload.command = extra.command;
        if (typeof extra.action === "string") detailPayload.action = extra.action;
        if (typeof extra.targetUrl === "string") detailPayload.targetUrl = extra.targetUrl;
        if (typeof extra.ref === "string") detailPayload.ref = extra.ref;
        if (typeof extra.selector === "string") detailPayload.selector = extra.selector;
        if (typeof extra.op === "string") detailPayload.op = extra.op;
        if (typeof extra.url === "string") detailPayload.url = extra.url;
      }

      pushFeed({
        ts: t,
        kind: "presence",
        agentId,
        sessionKey: typeof (details as any)?.sessionKey === "string" ? String((details as any).sessionKey) : undefined,
        toolName,
        details: detailPayload,
      });
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

      // Otherwise infer intent from the first meaningful tool call(s).
      const first = items.find((x) => x.kind === "before_tool_call" && x.toolName)?.toolName;
      if (first) {
        const tn = String(first);
        if (tn === "browser") return "QA in browser";
        if (tn === "read") return "Review project files";
        if (tn === "write" || tn === "edit") return "Update project files";
        if (tn === "exec") return "Run a command";
        if (tn === "message") return "Prepare a reply";
        return "Tool: " + tn;
      }

      return "Agent run";
    };

    const taskSummaryFromItems = (items: FeedItem[], status: FeedTaskStatus): string => {
      const toolCalls = items.filter((x) => x.kind === "before_tool_call").length;
      const msgSent = items.filter((x) => x.kind === "message_sent" && x.success !== false).length;
      const msgFail = items.filter((x) => x.kind === "message_sent" && x.success === false).length;
      const errors = items.map((x) => (x.error ? String(x.error) : "")).filter(Boolean);

      const bits: string[] = [];
      if (toolCalls) bits.push(String(toolCalls) + " tool call" + (toolCalls === 1 ? "" : "s"));
      if (msgSent) bits.push(String(msgSent) + " message" + (msgSent === 1 ? "" : "s") + " sent");
      if (msgFail) bits.push(String(msgFail) + " message" + (msgFail === 1 ? "" : "s") + " failed");

      if (status === "running") return bits.length ? "In progress · " + bits.join(" · ") : "In progress";

      if (status === "error") {
        const e = errors[0] ? "Error: " + redactSecretsInText(errors[0]).slice(0, 160) : "Error";
        return bits.length ? e + " · " + bits.join(" · ") : e;
      }

      return bits.length ? "Completed · " + bits.join(" · ") : "Completed";
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
        const agentId = sorted.find((x) => x.agentId)?.agentId || "unknown";
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
          const a = it.agentId || "unknown";
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

    // --- Message Feed v3 (human-friendly rows; timeline style) ---
    type FeedRowV3 = {
      id: string;
      ts: number;
      agentId: string;
      sessionKey?: string;
      // Keep legacy rowType field for older clients; v3 now uses only timeline rows.
      rowType: "timeline";
      kind?: FeedKind | "error" | "sessions_spawn";

      // v3 UX: human-friendly, single-line text.
      // Keep legacy `action` for backwards compatibility with older frontends.
      what: string;
      plain?: string;
      action?: string;
    };

    const maskUrlLite = (s: string): string => {
      // Keep feed content-free: strip literal URLs / localhost.
      // (We do not want clickable URLs in the default feed.)
      return s
        .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
        .replace(/\blocalhost(?:\:\d+)?(?:\/[\w-.~%!$&'()*+,;=:@\/]*)?/gi, "[URL]")
        .replace(/\b127\.0\.0\.1(?:\:\d+)?(?:\/[\w-.~%!$&'()*+,;=:@\/]*)?/gi, "[URL]");
    };

    const redactLine = (s: string, max = 200): string => {
      const x = redactSecretsInText(String(s || "")).replace(/\s+/g, " ").trim();
      return maskUrlLite(x).slice(0, max);
    };

    // (Advanced feed removed)

    const safeCmdSummary = (cmd: unknown): string => {
      if (Array.isArray(cmd)) {
        const parts = cmd
          .map((x) => (typeof x === "string" ? x.trim() : ""))
          .filter(Boolean);
        return parts.length ? parts.join(" ") : "command";
      }
      if (typeof cmd === "string") {
        const s = cmd.trim();
        if (!s) return "command";
        return s.split(/\r?\n/)[0].trim();
      }
      return "command";
    };

    const basenameLite = (p: unknown): string => {
      const s = typeof p === "string" ? p.trim() : "";
      if (!s) return "";
      const parts = s.split(/\\|\//g).filter(Boolean);
      const base = parts[parts.length - 1] || "";
      return redactLine(base, 80);
    };

    const scrubUrlForFeed = (u: unknown): string => {
      const s = typeof u === "string" ? u.trim() : "";
      if (!s) return "";
      // Keep it non-clickable: drop scheme + query/hash.
      // Also avoid leaking localhost.
      try {
        const uu = new URL(s);
        const host = uu.hostname;
        const path = uu.pathname || "/";
        const out = `${host}${path}`;
        if (/^(localhost|127\.0\.0\.1)$/i.test(host)) return "[URL]";
        return redactLine(out, 80);
      } catch {
        // Fall back: remove protocol if present.
        const out = s.replace(/^https?:\/\//i, "").split(/[?#]/)[0];
        if (/\blocalhost\b|\b127\.0\.0\.1\b/i.test(out)) return "[URL]";
        return redactLine(out, 80);
      }
    };

    const isOpaqueRef = (s: string): boolean => {
      const t = String(s || "").trim();
      if (!t) return false;
      return /^[a-z]{1,2}\d{1,6}$/i.test(t);
    };

    const browserActionLabel = (raw: string): string => {
      const v = String(raw || "").trim().toLowerCase();
      if (!v) return "";
      if (v === "navigate" || v === "open") return "Open";
      if (v === "focus") return "Switch tab";
      if (v === "close") return "Close tab";
      if (v === "screenshot") return "Take screenshot";
      if (v === "snapshot") return "Inspect page";
      if (v === "act") return "Interact";
      if (v === "upload") return "Upload";
      if (v === "console") return "Console";
      if (v === "pdf") return "Export PDF";
      if (v === "click") return "Click";
      if (v === "type") return "Type";
      if (v === "press") return "Press key";
      if (v === "hover") return "Hover";
      if (v === "drag") return "Drag";
      if (v === "select") return "Select";
      if (v === "fill") return "Fill";
      if (v === "resize") return "Resize";
      if (v === "wait") return "Wait";
      return raw;
    };

    const browserTarget = (d: any): string => {
      const url = scrubUrlForFeed(d.targetUrl || d.url);
      const selectorRaw = typeof d.selector === "string" ? d.selector : (typeof d?.request?.selector === "string" ? d.request.selector : "");
      const selector = selectorRaw ? redactLine(selectorRaw, 120) : "";
      const refRaw = typeof d.ref === "string" ? d.ref : (typeof d?.request?.ref === "string" ? d.request.ref : "");
      const ref = refRaw && !isOpaqueRef(refRaw) ? redactLine(refRaw, 80) : "";
      return url || selector || (ref ? `ref ${ref}` : "");
    };

    const toolHumanSummary = (it: FeedItem): string => {
      const tn = (it.toolName || "tool").trim();
      const d: any = it.details || {};

      if (tn === "browser") {
        const action = typeof d.action === "string" ? d.action
          : (typeof d.op === "string" ? d.op
            : (typeof d?.request?.kind === "string" ? String(d.request.kind) : ""));
        const verb = browserActionLabel(action) || "Browser step";
        const target = browserTarget(d);
        return target ? `Browser — ${verb} ${target}` : `Browser — ${verb}`;
      }

      if (tn === "exec") {
        const code = typeof d.exitCode === "number" ? d.exitCode : (typeof d.code === "number" ? d.code : null);
        const tail = code === null ? "" : ` (exit ${code})`;
        return `Running a command${tail}`.trim();
      }

      if (tn === "read") {
        const p = d.path ?? d.file_path;
        const base = basenameLite(p);
        return base ? `Reading project file: ${base}` : "Reading project files";
      }
      if (tn === "write") {
        const p = d.path ?? d.file_path;
        const base = basenameLite(p);
        return base ? `Updating project file: ${base}` : "Updating project files";
      }
      if (tn === "edit") {
        const p = d.path ?? d.file_path;
        const base = basenameLite(p);
        return base ? `Updating project file: ${base}` : "Updating project files";
      }

      if (tn === "sessions_spawn") {
        const child = typeof d.spawnAgentId === "string" ? String(d.spawnAgentId) : "";
        const label = typeof d.label === "string" ? String(d.label) : "";
        const task = typeof d.task === "string" ? String(d.task) : "";
        const desc = redactLine((label || task).trim(), 120);
        const tail = desc ? ` — ${desc}` : "";
        return `Starting a helper task${child ? ` @${child}` : ""}${tail}`.trim();
      }

      return tn;
    };

    const toolStateSummary = (details: any): string => {
      const tn = typeof details?.toolName === "string" ? String(details.toolName).trim() : "";
      if (tn === "browser") {
        const action = typeof details?.action === "string" ? details.action
          : (typeof details?.op === "string" ? details.op
            : (typeof details?.request?.kind === "string" ? String(details.request.kind) : ""));
        const verb = browserActionLabel(action) || "browser step";
        const target = browserTarget(details || {});
        return target ? `Inspecting in browser — ${verb} ${target}` : `Inspecting in browser — ${verb}`;
      }
      if (tn === "exec") return "Running a command";
      if (tn === "read") return "Reading project files";
      if (tn === "write") return "Updating project files";
      if (tn === "edit") return "Updating project files";
      if (tn === "message") return "Preparing a reply";
      if (tn === "web_fetch") return "Checking a page";
      if (tn === "sessions_spawn") return "Starting a helper task";
      if (tn) return "Working";
      return "Working";
    };

    const humanStateLabel = (stRaw: string, details?: any): string => {
      const st = stRaw === "reply" ? "replying"
        : stRaw === "tool" ? "tool"
        : stRaw === "thinking" ? "thinking"
        : stRaw === "idle" ? "idle"
        : stRaw === "error" ? "error"
        : stRaw;
      if (st === "thinking") return "Thinking";
      if (st === "replying") return "Replying";
      if (st === "idle") return "Idle";
      if (st === "tool") return toolStateSummary(details || {});
      if (st === "error") return "Error";
      return st || "State update";
    };

    const rowSentenceHuman = (it: FeedItem): { kind: FeedRowV3["kind"]; what: string } | null => {
      const tn = (it.toolName || "tool").trim();

      if (it.kind === "presence") {
        const stRaw = typeof (it.details as any)?.state === "string" ? String((it.details as any).state) : "";
        const what = humanStateLabel(stRaw, it.details || {});
        return { kind: stRaw === "error" ? "error" : it.kind, what };
      }

      // started/ended rows are rendered at the task level for clearer titles.

      if (it.kind === "message_sending") return { kind: it.kind, what: "Sending message" };
      if (it.kind === "message_sent") {
        if (it.success === false) return { kind: "error", what: "Message failed" };
        return { kind: it.kind, what: "Message sent" };
      }

      // State changes: show as "idle", "thinking", "tool", "reply", "error".
      if (it.kind === "state") {
        const stRaw = typeof (it.details as any)?.state === "string" ? String((it.details as any).state) : "";
        const label = humanStateLabel(stRaw, it.details || {});
        return { kind: it.kind, what: stRaw ? `State update: ${label}` : "State update" };
      }

      // Hide low-signal bookkeeping in default view.
      if (it.kind === "tool_result_persist") return null;

      const humanTools = new Set(["browser", "exec", "read", "write", "edit", "sessions_spawn"]);
      if ((it.kind === "before_tool_call" || it.kind === "after_tool_call") && humanTools.has(tn)) {
        const summary = toolHumanSummary(it);
        if (it.kind === "before_tool_call") return { kind: it.kind, what: summary };
        // after_tool_call
        if (it.success === false || it.error) return { kind: "error", what: `${summary} (failed)` };
        return { kind: it.kind, what: `${summary} (done)` };
      }

      // Fallback: omit other raw events in default feed.
      return null;
    };

    const buildFeedV3Rows = (items: FeedItem[]): FeedRowV3[] => {
      const tasks = groupFeedIntoTasks(items, { includeRaw: true });
      const out: FeedRowV3[] = [];

      // Default feed should be readable: de-dup short bursts of identical low-signal rows.
      const humanDedupeWindowMs = 1500;
      const presenceDedupeWindowMs = 12000;
      const heartbeatDedupeWindowMs = 15000;
      const lastHumanSigByAgent = new Map<string, { sig: string; ts: number }>();

      const toolPresenceMergeWindowMs = 1200;

      const shouldSkipPresenceTool = (it: FeedItem, idx: number, raw: FeedItem[], who: string): boolean => {
        if (it.kind !== "presence") return false;
        const stRaw = typeof (it.details as any)?.state === "string" ? String((it.details as any).state) : "";
        if (stRaw !== "tool") return false;
        const toolName = typeof it.toolName === "string" ? it.toolName
          : (typeof (it.details as any)?.toolName === "string" ? String((it.details as any).toolName) : "");

        const matches = (x: FeedItem): boolean => {
          if (!x || x.kind !== "before_tool_call") return false;
          const agent = x.agentId || who;
          if (agent !== who) return false;
          if (!toolName) return true;
          return (x.toolName || "") === toolName;
        };

        for (let j = idx - 1; j >= 0; j--) {
          const prev = raw[j];
          if (it.ts - prev.ts > toolPresenceMergeWindowMs) break;
          if (matches(prev)) return true;
        }
        for (let j = idx + 1; j < raw.length; j++) {
          const next = raw[j];
          if (next.ts - it.ts > toolPresenceMergeWindowMs) break;
          if (matches(next)) return true;
        }
        return false;
      };

      const pushRow = (it: FeedItem, what: string, kind: FeedRowV3["kind"], agentId: string, sessionKey?: string, taskId?: string) => {
        const base = `${sessionKey || taskId || "task"}:row:${it.ts}:${String(kind || it.kind)}:${it.toolName || ""}`;
        const id = base;
        out.push({
          id,
          ts: it.ts,
          agentId,
          sessionKey,
          rowType: "timeline",
          kind,
          what,
          plain: what,
          action: what,
        });
      };

      for (const task of tasks) {
        const fallbackAgentId = task.agentId || "unknown";
        const sessionKey = task.sessionKey;
        const raw = Array.isArray(task.items) ? task.items.slice().sort((a, b) => a.ts - b.ts) : [];
        if (!raw.length) continue;

        for (let i = 0; i < raw.length; i++) {
          const it = raw[i];
          const who = it.agentId || fallbackAgentId;

          // Task boundaries: render meaningful started/ended rows.
          if (it.kind === "before_agent_start") {
            const title = redactLine(task.title || "Agent run", 120);
            pushRow(it, `started — ${title}`, it.kind, who, sessionKey, task.id);
            continue;
          }
          if (it.kind === "agent_end") {
            const title = redactLine(task.title || "Agent run", 120);
            const ok = task.status !== "error";
            pushRow(it, `ended — ${title} (${ok ? "ok" : "failed"})`, ok ? it.kind : "error", who, sessionKey, task.id);
            continue;
          }

          if (shouldSkipPresenceTool(it, i, raw, who)) continue;

          const h = rowSentenceHuman(it);
          if (h) {
            const sig = `${who}|${String(h.kind)}|${h.what}`;
            const prev = lastHumanSigByAgent.get(who);
            const isPresence = it.kind === "presence" || it.kind === "state";
            const isHeartbeat = it.kind === "presence" && !!(it.details as any)?.heartbeat;
            const dedupeWindowMs = isHeartbeat
              ? heartbeatDedupeWindowMs
              : (isPresence ? presenceDedupeWindowMs : humanDedupeWindowMs);
            if (!(prev && prev.sig === sig && Math.abs(it.ts - prev.ts) < dedupeWindowMs)) {
              lastHumanSigByAgent.set(who, { sig, ts: it.ts });
              pushRow(it, h.what, h.kind, who, sessionKey, task.id);
            }
          }
        }
      }

      // Timeline newest-first (UI shows latest at top).
      return out.sort((a, b) => b.ts - a.ts);
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
        pushPresence(agentId, "idle", cur.details || null);
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
        pushPresence(agentId, "thinking", cur.details || null);
        setIdleWithCooldown(agentId);
      }, toolMaxMs);
    };

    const setState = (agentId: string, next: ActivityState, details?: Record<string, unknown> | null) => {
      const row = ensure(agentId);
      const t = nowMs();
      const prevState = row.state;

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
        // Emit state change to feed.
        pushPresence(agentId, next, details ?? null);
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
        pushPresence(agentId, "idle", null);
      }, waitMs);
      // Update lastEvent so API knows something just happened.
      row.lastEventMs = scheduledAt;
    };

    // Feed heartbeat: keep the timeline advancing while an agent is active.
    const feedHeartbeatPollMs = Math.max(1000, Math.floor(FEED_HEARTBEAT_MS / 2));
    setInterval(() => {
      const t = nowMs();
      for (const [agentId, row] of activity.entries()) {
        if (!row || row.state === "idle") continue;
        const last = lastFeedByAgent.get(agentId) || 0;
        if (t - last < FEED_HEARTBEAT_MS) continue;
        pushPresence(agentId, row.state, row.details || null, { force: true, heartbeat: true });
      }
    }, feedHeartbeatPollMs);

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
      const startTs = nowMs();
      pushFeed({ ts: startTs, kind: "before_agent_start", agentId, sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined });
      pushPresence(agentId, "thinking", { sessionKey: ctx?.sessionKey, messageProvider: ctx?.messageProvider }, { force: true });
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, messageProvider: ctx?.messageProvider });
    });

    api.on("before_tool_call", (event, ctx) => {
      const agentId = resolveAgentId(ctx);
      const toolName = event?.toolName || event?.tool || event?.name;

      // Capture high-value params for debugging (truncate aggressively).
      let toolData: any = { toolName, sessionKey: ctx?.sessionKey };
      const p = event?.params || null;

      if (toolName === "exec") {
        const cmd = (p && (p.command || p.cmd || p.args)) || null;
        toolData.command = cmd;
      }

      if (toolName === "browser") {
        // params: {action, targetUrl, targetId, request:{...}}
        toolData.action = typeof p?.action === "string" ? p.action : undefined;
        toolData.targetUrl = typeof p?.targetUrl === "string" ? p.targetUrl : undefined;
        toolData.targetId = typeof p?.targetId === "string" ? p.targetId : undefined;
        toolData.ref = typeof p?.ref === "string" ? p.ref : undefined;
        toolData.selector = typeof p?.selector === "string" ? p.selector : undefined;
        toolData.op = typeof p?.request?.kind === "string" ? p.request.kind : undefined;
        // Some calls put URL inside request fields.
        toolData.url = typeof p?.request?.url === "string" ? p.request.url : undefined;
      }

      if (toolName === "read" || toolName === "write" || toolName === "edit") {
        toolData.path = typeof p?.path === "string" ? p.path : undefined;
        toolData.file_path = typeof p?.file_path === "string" ? p.file_path : undefined;
      }

      // Show what spawned the subagent.
      if (toolName === "sessions_spawn") {
        toolData.spawnAgentId = p?.agentId;
        toolData.label = p?.label;
        const task = typeof p?.task === "string" ? p.task : "";
        toolData.task = task ? task.slice(0, 160) : undefined;

        // SYNTH_SUBAGENT_FEED_START
        try {
          const childAgentId = typeof p?.agentId === "string" ? String(p.agentId).trim() : "";
          if (childAgentId) {
            const parentSk = typeof ctx?.sessionKey === "string" ? String(ctx.sessionKey) : "";
            const startTs = nowMs();
            const childSessionKey = `spawn:${parentSk || agentId}:${childAgentId}:${startTs}`;
            const st = spawnStacksByAgent.get(agentId) || [];
            st.push({ childAgentId, childSessionKey, startTs });
            spawnStacksByAgent.set(agentId, st);

            // Start a synthetic task card for the child agent.
            pushFeed({
              ts: startTs,
              kind: "before_agent_start",
              agentId: childAgentId,
              sessionKey: childSessionKey,
              details: { parentSessionKey: parentSk ? redactSecretsInText(parentSk).slice(0, 120) : undefined },
            });
            pushFeed({
              ts: startTs + 1,
              kind: "before_tool_call",
              agentId: childAgentId,
              sessionKey: childSessionKey,
              toolName: "sessions_spawn",
              details: {
                label: coerceStr(toolData.label, 120),
                task: coerceStr(toolData.task, 180),
                spawnAgentId: coerceStr(childAgentId, 80),
              },
            });
            setState(childAgentId, "thinking", { sessionKey: childSessionKey, spawnedBy: agentId });
          }
        } catch {
          // best-effort only
        }
        // SYNTH_SUBAGENT_FEED_END
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

      pushEvent("before_tool_call", { agentId, data: toolData });
      pushFeed({
        ts: nowMs(),
        kind: "before_tool_call",
        agentId,
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
      setState(agentId, "tool", { ...toolData, sessionKey: ctx?.sessionKey });
    });

    api.on("after_tool_call", (event, ctx) => {
      const agentId = resolveAgentId(ctx);
      pushEvent("after_tool_call", { agentId, data: { toolName: event?.toolName, durationMs: event?.durationMs } });

      // Best-effort: capture a safe preview of sessions_spawn final assistant output (if the runtime provides it).
      // This helps surface sub-agent completions even when no message_sent hook is emitted.
      let outputPreview: string | undefined = undefined;
      if (event?.toolName === "sessions_spawn") {
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

      // SYNTH_SUBAGENT_FEED_FINISH
      if (event?.toolName === "sessions_spawn") {
        try {
          const st = spawnStacksByAgent.get(agentId) || [];
          const info = st.pop();
          if (st.length) spawnStacksByAgent.set(agentId, st);
          else spawnStacksByAgent.delete(agentId);

          if (info?.childAgentId && info.childSessionKey) {
            const t = nowMs();
            const rawErr = event?.error || event?.result?.error;
            const err = typeof rawErr === "string" && rawErr.trim() ? rawErr.trim() : "";
            const ok = !err;

            pushFeed({
              ts: t,
              kind: "after_tool_call",
              agentId: info.childAgentId,
              sessionKey: info.childSessionKey,
              toolName: "sessions_spawn",
              durationMs: typeof event?.durationMs === "number" ? event.durationMs : undefined,
              success: ok,
              error: err ? redactSecretsInText(err).slice(0, 200) : undefined,
              details: outputPreview ? { outputPreview } : undefined,
            });
            pushFeed({
              ts: t + 1,
              kind: "agent_end",
              agentId: info.childAgentId,
              sessionKey: info.childSessionKey,
              success: ok,
              error: err ? redactSecretsInText(err).slice(0, 200) : undefined,
            });
            setState(info.childAgentId, ok ? "idle" : "error", { sessionKey: info.childSessionKey });
          }
        } catch {
          // best-effort only
        }
      }

      pushFeed({
        ts: nowMs(),
        kind: "after_tool_call",
        agentId,
        sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
        toolName: typeof event?.toolName === "string" ? event.toolName : undefined,
        durationMs: typeof event?.durationMs === "number" ? event.durationMs : undefined,
        details: outputPreview ? { outputPreview } : undefined,
      });
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey });
    });

    // Some tools may not reliably fire after_tool_call in all paths; use persist as a backup.
    api.on("tool_result_persist", (event, ctx) => {
      const agentId = resolveAgentId(ctx);
      pushEvent("tool_result_persist", {
        agentId,
        data: { toolName: event?.toolName, toolCallId: event?.toolCallId, isSynthetic: event?.isSynthetic },
      });
      pushFeed({
        ts: nowMs(),
        kind: "tool_result_persist",
        agentId,
        sessionKey: typeof ctx?.sessionKey === "string" ? ctx.sessionKey : undefined,
        toolName: typeof event?.toolName === "string" ? event.toolName : undefined,
        details: {
          toolCallId: typeof event?.toolCallId === "string" ? event.toolCallId : undefined,
          isSynthetic: !!event?.isSynthetic,
        },
      });
      setState(agentId, "thinking", { sessionKey: ctx?.sessionKey, persisted: true });
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

    api.on("agent_end", (event, ctx) => {
      const agentId = resolveAgentId(ctx);
      pushEvent("agent_end", { agentId, data: { success: event?.success, error: event?.error, sessionKey: ctx?.sessionKey } });
      pushFeed({
        ts: nowMs(),
        kind: "agent_end",
        agentId,
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
      auth: "plugin",
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
    registerSafePluginRoute(api, {
      path: "/lobster-room/",
      auth: "plugin",
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

    // NOTE: Message Feed API is multiplexed via /lobster-room/api/lobster-room (op=feedGet/feedSummarize)
    // because some gateway/proxy setups only reliably route this single plugin API endpoint.

    registerSafePluginRoute(api, {
      path: "/lobster-room/api/feed/summarize",
      auth: "plugin",
      handler: async (req, res) => {
        if ((req.method || "GET").toUpperCase() !== "POST") {
          sendJson(res, 405, { ok: false, error: "method_not_allowed" });
          return;
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
          return;
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
            return;
          }

          const data: any = await r.json().catch(() => null);
          const summary = data?.choices?.[0]?.message?.content;
          if (typeof summary !== "string" || !summary.trim()) {
            sendJson(res, 200, { ok: false, error: "llm_no_summary" });
            return;
          }

          sendJson(res, 200, { ok: true, summary: summary.trim(), model });
        } catch (err: any) {
          sendJson(res, 200, { ok: false, error: "llm_unreachable", detail: String(err?.message || err) });
        }
      },
    });

    // HTTP: API
    registerSafePluginRoute(api, {
      path: "/lobster-room/api/lobster-room",
      auth: "plugin",
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

            // --- Message Feed ops (multiplexed) ---
            if (op === "feedGet") {
              const tNow = nowMs();
              // Feed freeze fix: ensure latest.ts always advances while any agent is non-idle.
              // Inject heartbeat presence events into feedBuf to prevent feed freeze.
              // This runs on every feedGet call (not just when gap > 10s) to ensure feed keeps moving.
              try {
                const snapDerived = await deriveActivitySnapshot();
                const activeAgents = Object.entries(snapDerived.agents || {}).filter(([, row]) => row && row.state !== "idle");
                for (const [agentId, row] of activeAgents) {
                  pushPresence(agentId as string, row.state as ActivityState, row.details || null, { force: true, heartbeat: true });
                }
              } catch {}

              const limit = Math.max(1, Math.min(500, Number(payload?.limit) || 120));
              const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
              const kind = typeof payload?.kind === "string" ? payload.kind.trim() : "";
              const includeRaw = !!payload?.includeRaw;

              let items = feedBuf.slice();
              if (agentId) items = items.filter((x) => x.agentId === agentId);
              if (kind) items = items.filter((x) => x.kind === (kind as any));
              items = items.slice(-limit);

              const tasks = groupFeedIntoTasks(items, { includeRaw });

              // Latest preview = most recent event.
              const last = items.length ? items[items.length - 1] : null;

              const version = Number(payload?.version) || 2;
              const rows = version >= 3 ? buildFeedV3Rows(items) : undefined;

              sendJson(res, 200, {
                ok: true,
                buildTagFeed: version >= 3 ? "feed-v3" : "feed-v2",
                latest: last ? { ...last, preview: feedPreview(last) } : null,
                rows,
                tasks: tasks.map((t) => ({
                  id: t.id,
                  sessionKey: t.sessionKey,
                  agentId: t.agentId,
                  startTs: t.startTs,
                  endTs: t.endTs,
                  status: t.status,
                  title: t.title,
                  summary: t.summary,
                  items: t.items ? t.items.map((it) => ({ ...it, preview: feedPreview(it) })) : undefined,
                })),
                items: includeRaw ? items.slice().reverse().map((it) => ({ ...it, preview: feedPreview(it) })) : undefined,
              });
              return;
            }

            if (op === "activityGet") {
              try {
                const snapshot = await deriveActivitySnapshot();
                sendJson(res, 200, { ok: true, snapshot });
              } catch (err: any) {
                sendJson(res, 200, { ok: false, error: "activity_failed", detail: String(err?.message || err) });
              }
              return;
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
                return;
              }

              const sessionKey = typeof payload?.sessionKey === "string" ? payload.sessionKey.trim() : "";
              const agentId = typeof payload?.agentId === "string" ? payload.agentId.trim() : "";
              const maxItems = Math.max(10, Math.min(500, Number(payload?.maxItems) || 200));
              const windowMs = Math.max(10_000, Math.min(24 * 60 * 60 * 1000, Number(payload?.timeWindowMs) || 60 * 60 * 1000));
              const sinceMs = typeof payload?.sinceMs === "number" && Number.isFinite(payload.sinceMs)
                ? payload.sinceMs
                : (nowMs() - windowMs);

              const startMs = typeof payload?.startMs === "number" && Number.isFinite(payload.startMs) ? payload.startMs : null;
              const endMs = typeof payload?.endMs === "number" && Number.isFinite(payload.endMs) ? payload.endMs : null;

              let items = feedBuf.slice();
              if (sessionKey) items = items.filter((x) => x.sessionKey === sessionKey);
              else {
                if (agentId) items = items.filter((x) => x.agentId === agentId);
                items = items.filter((x) => x.ts >= sinceMs);
              }

              // Optional explicit window (used by v3 "Summary: this segment")
              if (startMs !== null || endMs !== null) {
                const a = startMs !== null ? startMs : (nowMs() - windowMs);
                const b = endMs !== null ? endMs : nowMs();
                items = items.filter((x) => x.ts >= a && x.ts <= b);
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
                  return;
                }

                const data: any = await r.json().catch(() => null);
                const summary = data?.choices?.[0]?.message?.content;
                if (typeof summary !== "string" || !summary.trim()) {
                  sendJson(res, 200, { ok: false, error: "llm_no_summary" });
                  return;
                }

                sendJson(res, 200, { ok: true, summary: summary.trim(), model });
              } catch (err: any) {
                sendJson(res, 200, { ok: false, error: "llm_unreachable", detail: String(err?.message || err) });
              }
              return;
            }

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
                sendJson(res, 200, { ok: true, debug: { opReceived: op } });
              } catch (err: any) {
                sendJson(res, 500, { ok: false, error: String(err?.message || err), debug: { opReceived: op } });
              }
              return;
            }
            // Debug support: echo opReceived for unknown POST+JSON payloads.
            if (op) {
              sendJson(res, 400, { ok: false, error: "unknown_op", debug: { opReceived: op } });
              return;
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
          allowIds = agentIdAllowRaw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
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
          for (const id of activity.keys()) {
            if (id && !seen.has(id)) {
              ids.push(id);
              seen.add(id);
            }
          }
          // IMPORTANT: hook handlers may run in a different isolate; in that case this HTTP handler
          // won't see hook-updated in-memory `activity`, but it *will* see the on-disk snapshot.
          const snapAgentIds = snapDisk && snapDisk.agents ? Object.keys(snapDisk.agents) : [];
          for (const id of snapAgentIds) {
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

        const snapshot = await deriveActivitySnapshot();
        const agentsPayload = allowIds.map((agentId) => {
          const displayName = agentNameOverrides[agentId] || identityNameByAgentId.get(agentId) || agentId;
          const snapRow = snapshot.agents?.[agentId];
          const activityState = (snapRow?.state || "idle") as ActivityState;
          const uiState = mapActivityToUiState(activityState);
          const details = (snapRow?.details || {}) as any;
          return {
            id: `resident@${agentId}`,
            hostId: "local",
            hostLabel: "OpenClaw",
            name: displayName,
            state: uiState,
            meta: {
              active: uiState !== "wait",
              sinceMs: snapRow?.sinceMs || null,
              maxUpdatedAt: snapRow?.lastEventMs || null,
              queueDepth: Number.isFinite(Number(details?.queueDepth)) ? Number(details.queueDepth) : null,
              statusText: typeof details?.statusText === "string" ? details.statusText : null,
            },
            debug: {
              decision: {
                agentId,
                displayName,
                activityState,
                sinceMs: snapRow?.sinceMs || null,
                lastEventMs: snapRow?.lastEventMs || null,
                cooldownMs,
                staleMs,
                toolMaxMs,
                finalState: uiState,
                details,
                recentEvents: snapshot.events || (snapDisk?.events || eventBuf),
              },
            },
          };
        });

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
      auth: "plugin",
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
      },
    });

    // Convenience redirect
    registerSafePluginRoute(api, {
      path: "/lobster-room",
      auth: "plugin",
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
