#!/usr/bin/env python3
"""DEPRECATED Lobster Room standalone server.

This file is **NOT** used by the current Lobster Room deployment (which is served by the
OpenClaw Gateway extension plugin under /lobster-room/).

Keeping this around without context is confusing during reviews.

If you really need the multi-gateway aggregator portal, move this file into a separate
repo/package (e.g. lobster-room-portal) and document it there.

(Edward老大 note): We should avoid maintaining two implementations (plugin vs server.py)
in the same repo unless there's a clear migration plan.
"""

import argparse
import http.server
import json
import os
import socket
import threading
import time
import urllib.error
import urllib.request


DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(DIR, "config.json")


def _debug_enabled():
    return os.environ.get("LOBSTER_ROOM_DEBUG", "").strip().lower() in ("1", "true", "yes", "on")


# Server-side cache to prevent UI disappearance / flapping when gateways time out.
_cache_lock = threading.Lock()
_cache_last_ok = None  # last successful payload
_cache_last_ok_ms = 0

# Transient state cache: shows short-lived tool/reply even if updatedAt doesn't move.
_transient_lock = threading.Lock()
_transient = {}  # gatewayId -> {state, expiresAtMs, observedAtMs, sessionKey}


def load_config():
    # This portal is designed for env-first configuration.
    return {}


def load_gateway_aggregator_config():
    """Load gateways and top-level knobs.

    Sources (priority):
      1) env LOBSTER_ROOM_GATEWAYS_JSON (JSON object or array)
      2) config.json gateways

    Env formats:
      - Array: [{"id","label","baseUrl","tokenEnv"}, ...]
      - Object: {"gateways":[...], "pollSeconds":5, "activeWindowMs":10000}
    """
    cfg = load_config()

    env_raw = os.environ.get("LOBSTER_ROOM_GATEWAYS_JSON")
    env_obj = None
    if env_raw:
        try:
            env_obj = json.loads(env_raw)
        except json.JSONDecodeError:
            env_obj = []

    gateways = None
    extra = {}
    if isinstance(env_obj, dict):
        gateways = env_obj.get("gateways")
        for k in ("pollSeconds", "activeWindowMs"):
            if k in env_obj:
                extra[k] = env_obj.get(k)
    elif isinstance(env_obj, list):
        gateways = env_obj

    if gateways is None:
        gateways = cfg.get("gateways", [])

    if not isinstance(gateways, list):
        gateways = []

    norm = []
    for g in gateways:
        if not isinstance(g, dict):
            continue
        gid = (g.get("id") or "").strip()
        label = (g.get("label") or gid).strip()
        base_url = (g.get("baseUrl") or "").strip().rstrip("/")
        token_env = (g.get("tokenEnv") or "").strip()
        agent_label = (g.get("agentLabel") or "").strip()
        if not gid or not base_url:
            continue
        item = {"id": gid, "label": label or gid, "baseUrl": base_url, "tokenEnv": token_env}
        if agent_label:
            item["agentLabel"] = agent_label
        norm.append(item)

    poll_seconds = int(extra.get("pollSeconds") or (cfg.get("lobsterRoom") or {}).get("pollSeconds", 2))
    out = {"gateways": norm, "pollSeconds": poll_seconds}
    if "activeWindowMs" in extra:
        out["activeWindowMs"] = extra["activeWindowMs"]
    return out


def _gateway_headers_from_env(token_env):
    if not token_env:
        return {}
    token = os.environ.get(token_env, "").strip()
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def _active_window_ms_from_env_or_cfg(cfg):
    env = os.environ.get("LOBSTER_ROOM_ACTIVE_WINDOW_MS", "").strip()
    if env:
        try:
            return max(0, int(env))
        except ValueError:
            pass
    try:
        return max(0, int(cfg.get("activeWindowMs", 10000)))
    except (TypeError, ValueError):
        return 10000


def _poll_seconds_from_env_or_cfg(cfg):
    env = os.environ.get("LOBSTER_ROOM_POLL_SECONDS", "").strip()
    if env:
        try:
            return max(1, int(env))
        except ValueError:
            pass
    try:
        return max(1, int(cfg.get("pollSeconds", 2)))
    except (TypeError, ValueError):
        return 2


def _tool_ttl_ms_from_env_or_cfg(cfg):
    env = os.environ.get("LOBSTER_ROOM_TOOL_TTL_MS", "").strip()
    if env:
        try:
            return max(0, int(env))
        except ValueError:
            pass
    try:
        return max(0, int(cfg.get("toolTtlMs", 8000)))
    except (TypeError, ValueError):
        return 8000


def _cache_ttl_ms_from_env_or_cfg(cfg):
    env = os.environ.get("LOBSTER_ROOM_CACHE_TTL_MS", "").strip()
    if env:
        try:
            return max(0, int(env))
        except ValueError:
            pass
    # Default: 5000ms gives stability and reduces gateway load/timeouts.
    try:
        return max(0, int(cfg.get("cacheTtlMs", 5000)))
    except (TypeError, ValueError):
        return 1500


def _agent_id_from_session_key(key):
    if not isinstance(key, str):
        return None
    if not key.startswith("agent:"):
        return None
    parts = key.split(":")
    if len(parts) < 2:
        return None
    return parts[1] or None


def _pick_resident_session_for_agent(sessions, agent_id):
    """Pick a stable "resident" sessionKey to represent the agent.

    Heuristics (in order):
    - Prefer agent:main:main for main agent
    - Avoid cron sessions
    - Otherwise pick the most recently updated session
    """
    if not sessions:
        return None

    if agent_id == "main":
        for s in sessions:
            k = s.get("key")
            if isinstance(k, str) and k == "agent:main:main":
                return k

    # Prefer non-cron sessions.
    best = None
    best_ts = None
    for s in sessions:
        k = s.get("key")
        kind = (s.get("kind") or "").lower()
        ts = s.get("updatedAt")
        if not isinstance(k, str) or not isinstance(ts, (int, float)):
            continue
        if kind == "cron":
            continue
        ts = int(ts)
        if best is None or ts > best_ts:
            best = k
            best_ts = ts

    if best:
        return best

    # Fallback: latest by updatedAt.
    sessions2 = [s for s in sessions if isinstance(s.get("key"), str) and isinstance(s.get("updatedAt"), (int, float))]
    if not sessions2:
        return None
    sessions2.sort(key=lambda s: int(s.get("updatedAt")), reverse=True)
    return sessions2[0].get("key")
def build_lobster_room_state():
    agg_cfg = load_gateway_aggregator_config()
    gateways = agg_cfg.get("gateways", [])
    active_window_ms = _active_window_ms_from_env_or_cfg(agg_cfg)
    tool_ttl_ms = _tool_ttl_ms_from_env_or_cfg(agg_cfg)
    cache_ttl_ms = _cache_ttl_ms_from_env_or_cfg(agg_cfg)
    poll_seconds = _poll_seconds_from_env_or_cfg(agg_cfg)

    # Cache hit: return last successful payload to avoid UI flapping.
    now_ms = int(time.time() * 1000)
    with _cache_lock:
        if _cache_last_ok and (now_ms - _cache_last_ok_ms) <= cache_ttl_ms:
            cached = dict(_cache_last_ok)
            cached["cached"] = True
            cached["cacheAgeMs"] = now_ms - _cache_last_ok_ms
            return cached

    out = {
        "ok": True,
        "generatedAt": int(time.time()),
        "pollSeconds": poll_seconds,
        "gateways": [],
        "agents": [],
        "errors": [],
    }

    if not gateways:
        out["ok"] = False
        out["errors"].append("No gateways configured. Set LOBSTER_ROOM_GATEWAYS_JSON")
        return out

    # now_ms already computed above (used for cache + status heuristics)

    for gw in gateways:
        base = gw["baseUrl"]
        url = f"{base}/tools/invoke"
        headers = _gateway_headers_from_env(gw.get("tokenEnv", ""))
        if gw.get("tokenEnv") and not headers:
            out["ok"] = False
            out["errors"].append(f"{gw['id']} missing env var: {gw['tokenEnv']} (for {base})")
            continue

        try:
            debug = {"gatewayId": gw.get("id"), "timingsMs": {}, "sessionCandidates": [], "decision": {}}
            t0 = int(time.time() * 1000)

            # 1) sessions_list
            payload = {"tool": "sessions_list", "action": "json", "args": {}}
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={**headers, "Content-Type": "application/json"},
                method="POST",
            )
            t_list_0 = int(time.time() * 1000)
            with urllib.request.urlopen(req, timeout=4) as resp:
                raw = resp.read().decode("utf-8", errors="ignore")
            debug["timingsMs"]["sessions_list"] = int(time.time() * 1000) - t_list_0
            data = json.loads(raw)
            if not data.get("ok"):
                raise Exception(str(data.get("error") or "tools/invoke failed"))
            details = (data.get("result") or {}).get("details") or {}
            sessions = details.get("sessions") or []

            # For gateway meta, track max updatedAt across all sessions.
            max_updated_at_all = None
            for s in sessions:
                ts = s.get("updatedAt")
                if isinstance(ts, (int, float)):
                    ts = int(ts)
                    if max_updated_at_all is None or ts > max_updated_at_all:
                        max_updated_at_all = ts

            out["gateways"].append(
                {
                    "id": gw["id"],
                    "label": gw["label"],
                    "baseUrl": gw["baseUrl"],
                    "status": "ok",
                    "sessionCount": details.get("count"),
                    "maxUpdatedAt": max_updated_at_all,
                }
            )

            # Group sessions by agentId (derived from sessionKey).
            sessions_by_agent = {}
            for s in sessions:
                aid = _agent_id_from_session_key(s.get("key"))
                if not aid:
                    continue
                sessions_by_agent.setdefault(aid, []).append(s)

            if not sessions_by_agent:
                sessions_by_agent = {"resident": sessions}

            gwid = gw.get("id")

            for agent_id, agent_sessions in sessions_by_agent.items():
                # Prefer non-cron sessions if available.
                non_cron = [s for s in agent_sessions if (s.get("kind") or "").lower() != "cron"]
                base_sessions = non_cron or agent_sessions

                # For "activity window" we use max updatedAt across the agent's sessions.
                max_updated_at = None
                for s in base_sessions:
                    ts = s.get("updatedAt")
                    if isinstance(ts, (int, float)):
                        ts = int(ts)
                        if max_updated_at is None or ts > max_updated_at:
                            max_updated_at = ts

                # For richer status, don't rely on a single session; evaluate a few.
                sessions_sorted = [s for s in base_sessions if isinstance(s.get("key"), str) and isinstance(s.get("updatedAt"), (int, float))]
                sessions_sorted.sort(key=lambda s: int(s.get("updatedAt")), reverse=True)
                top_sessions = sessions_sorted[:2]

                recent_activity = bool(max_updated_at and (now_ms - max_updated_at) <= active_window_ms)

                # Per-agent debug
                dbg = {
                    "gatewayId": gw.get("id"),
                    "agentId": agent_id,
                    "timingsMs": {},
                    "sessionCandidates": [],
                    "decision": {},
                }
                for s in sessions_sorted[:10]:
                    dbg["sessionCandidates"].append({
                        "key": s.get("key"),
                        "kind": s.get("kind"),
                        "updatedAt": int(s.get("updatedAt")) if isinstance(s.get("updatedAt"), (int, float)) else None,
                    })
                dbg["decision"]["recentActivity"] = recent_activity
                dbg["decision"]["maxUpdatedAt"] = max_updated_at
                dbg["decision"]["nowMs"] = now_ms
                dbg["decision"]["activeWindowMs"] = active_window_ms
                dbg["decision"]["toolTtlMs"] = tool_ttl_ms

                # Ensure we always include the resident session if present.
                resident_key = _pick_resident_session_for_agent(base_sessions, agent_id)
                if resident_key and all(s.get("key") != resident_key for s in top_sessions):
                    top_sessions = ([{"key": resident_key}] + top_sessions)[:6]

                session_key_for_status = resident_key or (top_sessions[0].get("key") if top_sessions else None)

                # 2) session_status (aggregate over top sessions)
                # Always attempt at least one session_status call so we can detect active runs
                # even if sessions_list.updatedAt is stale.
                queue_depth = None
                status_text = None
                status_session_key = None

                for i, ss in enumerate(top_sessions):
                    # If we already consider it "recent", only check the first candidate (usually resident)
                    # to keep load low.
                    if recent_activity and i > 0:
                        break
                    k = ss.get("key")
                    if not isinstance(k, str) or not k:
                        continue
                    payload2 = {"tool": "session_status", "args": {"sessionKey": k}}
                    req2 = urllib.request.Request(
                        url,
                        data=json.dumps(payload2).encode("utf-8"),
                        headers={**headers, "Content-Type": "application/json"},
                        method="POST",
                    )
                    t_stat_0 = int(time.time() * 1000)
                    with urllib.request.urlopen(req2, timeout=2) as resp:
                        raw2 = resp.read().decode("utf-8", errors="ignore")
                    dbg.setdefault("timingsMs", {}).setdefault("session_status", {})[k] = int(time.time() * 1000) - t_stat_0
                    data2 = json.loads(raw2)
                    if not data2.get("ok"):
                        continue
                    det2 = (data2.get("result") or {}).get("details") or {}
                    qd = None
                    if isinstance(det2.get("queueDepth"), (int, float)):
                        qd = int(det2.get("queueDepth"))
                    elif isinstance(det2.get("queue"), dict) and isinstance(det2.get("queue").get("depth"), (int, float)):
                        qd = int(det2.get("queue").get("depth"))
                    if isinstance(qd, int):
                        if queue_depth is None or qd > queue_depth:
                            queue_depth = qd
                            status_text = det2.get("statusText")
                            status_session_key = k
                        if qd > 0:
                            break

                # 3) sessions_history (latest message only, aggregate over top sessions)
                history_types = []
                last_msg_role = None
                last_part_type = None
                history_session_key = None
                if not recent_activity:
                    for ss in top_sessions:
                        k = ss.get("key")
                        if not isinstance(k, str) or not k:
                            continue
                        try:
                            payload3 = {"tool": "sessions_history", "args": {"sessionKey": k, "limit": 8}}
                            req3 = urllib.request.Request(
                                url,
                                data=json.dumps(payload3).encode("utf-8"),
                                headers={**headers, "Content-Type": "application/json"},
                                method="POST",
                            )
                            t_hist_0 = int(time.time() * 1000)
                            with urllib.request.urlopen(req3, timeout=2) as resp:
                                raw3 = resp.read().decode("utf-8", errors="ignore")
                            dbg.setdefault("timingsMs", {}).setdefault("sessions_history", {})[k] = int(time.time() * 1000) - t_hist_0
                            data3 = json.loads(raw3)
                            if not data3.get("ok"):
                                continue
                            msgs = ((data3.get("result") or {}).get("details") or {}).get("messages") or []
                            if not msgs:
                                continue
                            last = msgs[0]
                            c = last.get("content")
                            lpt = None
                            types = []
                            if isinstance(c, list):
                                for part in c:
                                    if isinstance(part, dict) and part.get("type"):
                                        types.append(part.get("type"))
                                        if lpt is None:
                                            lpt = part.get("type")
                            role = last.get("role")

                            if lpt == "toolCall":
                                history_session_key = k
                                history_types = types
                                last_part_type = lpt
                                last_msg_role = role
                                break
                            if lpt == "text" and role == "assistant" and last_part_type is None:
                                history_session_key = k
                                history_types = types
                                last_part_type = lpt
                                last_msg_role = role
                        except Exception:
                            continue

                # Status selection
                is_active = False
                if isinstance(queue_depth, int):
                    is_active = queue_depth > 0
                if not is_active:
                    is_active = bool(max_updated_at and (now_ms - max_updated_at) <= active_window_ms)

                state = "think" if is_active else "wait"
                if not is_active:
                    within_ttl = bool(max_updated_at and (now_ms - max_updated_at) <= tool_ttl_ms)
                    if within_ttl and last_part_type == "toolCall":
                        state = "tool"
                    elif within_ttl and last_part_type == "text" and last_msg_role == "assistant":
                        state = "reply"

                # Record transient observation (tool/reply) keyed by gateway+agent.
                fingerprint = None
                transient_key = f"{gwid}:{agent_id}"
                if gwid and last_part_type in ("toolCall", "text"):
                    fingerprint = f"{history_session_key}|{last_msg_role}|{last_part_type}|{','.join(history_types[:2])}"
                    transient_state = None
                    if last_part_type == "toolCall":
                        transient_state = "tool"
                    elif last_part_type == "text" and last_msg_role == "assistant":
                        transient_state = "reply"
                    if transient_state:
                        with _transient_lock:
                            prev = _transient.get(transient_key)
                            prev_fp = prev.get("fingerprint") if isinstance(prev, dict) else None
                            if prev_fp != fingerprint:
                                _transient[transient_key] = {
                                    "state": transient_state,
                                    "observedAtMs": now_ms,
                                    "firstObservedAtMs": (prev.get("firstObservedAtMs") if isinstance(prev, dict) and prev.get("state") == transient_state else now_ms),
                                    "expiresAtMs": now_ms + tool_ttl_ms,
                                    "sessionKey": history_session_key,
                                    "fingerprint": fingerprint,
                                }

                # Apply transient state if still valid.
                transient_applied = False
                if gwid:
                    with _transient_lock:
                        tr = _transient.get(transient_key)
                    if tr and now_ms <= int(tr.get("expiresAtMs") or 0):
                        if state == "wait":
                            max_ms = int(os.environ.get("LOBSTER_ROOM_TRANSIENT_MAX_MS", "15000") or "15000")
                            first_ms = int(tr.get("firstObservedAtMs") or tr.get("observedAtMs") or now_ms)
                            if (now_ms - first_ms) <= max_ms:
                                state = tr.get("state") or state
                                transient_applied = True
                            else:
                                with _transient_lock:
                                    _transient.pop(transient_key, None)

                dbg["decision"]["queueDepth"] = queue_depth
                dbg["decision"]["statusSessionKey"] = status_session_key
                dbg["decision"]["historySessionKey"] = history_session_key
                dbg["decision"]["historyLastType"] = last_part_type
                dbg["decision"]["historyLastRole"] = last_msg_role
                dbg["decision"]["transientState"] = (tr.get("state") if ('tr' in locals() and tr) else None)
                dbg["decision"]["transientExpiresAtMs"] = (tr.get("expiresAtMs") if ('tr' in locals() and tr) else None)
                dbg["decision"]["transientFingerprint"] = (tr.get("fingerprint") if ('tr' in locals() and tr) else None)
                dbg["decision"]["transientFirstObservedAtMs"] = (tr.get("firstObservedAtMs") if ('tr' in locals() and tr) else None)
                dbg["decision"]["transientApplied"] = transient_applied
                dbg["decision"]["finalState"] = state
                dbg["timingsMs"]["gatewayTotal"] = int(time.time() * 1000) - t0

                agent_name = agent_id
                if agent_id == "main" and gw.get("agentLabel"):
                    agent_name = gw.get("agentLabel")

                agent_payload = {
                    "id": f"{agent_id}@{gw['id']}",
                    "hostId": gw["id"],
                    "hostLabel": gw["label"],
                    "name": agent_name,
                    "state": state,
                    "meta": {
                        "agentId": agent_id,
                        "active": is_active,
                        "activeWindowMs": active_window_ms,
                        "toolTtlMs": tool_ttl_ms,
                        "maxUpdatedAt": max_updated_at,
                        "sessionKeyForStatus": session_key_for_status,
                        "statusSessionKey": status_session_key,
                        "historySessionKey": history_session_key,
                        "queueDepth": queue_depth,
                        "statusText": status_text,
                        "historyTypes": history_types,
                        "historyLastRole": last_msg_role,
                        "historyLastType": last_part_type,
                        "sessionCount": len(agent_sessions),
                    },
                }
                if _debug_enabled():
                    agent_payload["debug"] = dbg
                out["agents"].append(agent_payload)

        except urllib.error.HTTPError as e:
            out["ok"] = False
            msg = f"{gw['id']} HTTP {e.code} at {url}"
            out["errors"].append(msg)
            if _debug_enabled():
                print(json.dumps({"kind": "lobster_room", "gatewayId": gw.get("id"), "error": msg}))
        except Exception as e:
            out["ok"] = False
            msg = f"{gw['id']} error: {e}"
            out["errors"].append(msg)
            if _debug_enabled():
                print(json.dumps({"kind": "lobster_room", "gatewayId": gw.get("id"), "error": msg}))

    # If we got at least one agent, treat as good and update cache.
    if out.get("ok") and out.get("agents"):
        with _cache_lock:
            globals()["_cache_last_ok"] = out
            globals()["_cache_last_ok_ms"] = now_ms
        out["cached"] = False
        out["cacheAgeMs"] = 0
        return out

    # If current fetch failed but we have last-known-good, return cached to prevent UI disappearing.
    with _cache_lock:
        if _cache_last_ok:
            cached = dict(_cache_last_ok)
            cached["cached"] = True
            cached["cacheAgeMs"] = now_ms - _cache_last_ok_ms
            cached.setdefault("errors", [])
            cached["errors"] = list(cached["errors"]) + list(out.get("errors") or [])
            return cached

    return out


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def end_headers(self):
        if hasattr(self, "path") and (
            self.path.endswith(".html") or self.path == "/" or self.path.endswith(".js")
        ):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, code, payload):
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode("utf-8"))

    def do_GET(self):
        if self.path in ("/healthz", "/healthz/"):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(b"ok")
            return

        if self.path in ("/", ""):
            self.path = "/lobster-room.html"
        elif self.path in ("/lobster-room", "/lobster-room/"):
            self.path = "/lobster-room.html"

        if self.path == "/api/lobster-room" or self.path.startswith("/api/lobster-room?"):
            self._send_json(200, build_lobster_room_state())
            return

        super().do_GET()


def main():
    cfg = load_config()
    server_cfg = cfg.get("server", {})

    env_port_raw = os.environ.get("PORT") or os.environ.get("DASHBOARD_PORT")
    port = int(env_port_raw) if env_port_raw else int(server_cfg.get("port", 8080))

    env_bind = os.environ.get("DASHBOARD_BIND")
    if env_bind is None:
        env_bind = "0.0.0.0" if os.environ.get("PORT") else server_cfg.get("host", "127.0.0.1")

    parser = argparse.ArgumentParser(description="Lobster Room server")
    parser.add_argument("--bind", "-b", default=env_bind)
    parser.add_argument("--port", "-p", type=int, default=port)
    args = parser.parse_args()

    httpd = http.server.HTTPServer((args.bind, args.port), Handler)
    httpd.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    print(f"[lobster-room] Serving on http://{args.bind}:{args.port}/")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
