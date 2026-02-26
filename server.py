#!/usr/bin/env python3
"""OpenClaw Dashboard Server — static files + on-demand refresh."""

import argparse
import functools
import http.server
import json
import os
import socket
import subprocess
import threading
import time
import sys
import urllib.request
import urllib.error

VERSION = "2.4.0"
PORT = 8080
BIND = "127.0.0.1"
DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(DIR, "config.json")
REFRESH_SCRIPT = os.path.join(DIR, "refresh.sh")
DATA_FILE = os.path.join(DIR, "data.json")
REFRESH_TIMEOUT = 15

_last_refresh = 0
_refresh_lock = threading.Lock()
_debounce_sec = 30
_ai_cfg = {}
_gateway_token = ""


OPENCLAW_PATH = os.path.expanduser("~/.openclaw")


def _load_agent_default_models():
    """Read agent default models from openclaw.json dynamically."""
    try:
        with open(os.path.join(OPENCLAW_PATH, "openclaw.json")) as f:
            cfg = json.load(f)
        primary = cfg.get("agents", {}).get("defaults", {}).get("model", {}).get("primary", "unknown")
        defaults = {}
        agents = cfg.get("agents", {})
        for name, val in agents.items():
            if name == "defaults" or not isinstance(val, dict):
                continue
            agent_primary = val.get("model", {}).get("primary", primary)
            defaults[name] = agent_primary
        # Ensure common agents have entries
        for a in ("main", "work", "group"):
            if a not in defaults:
                defaults[a] = primary
        return defaults
    except Exception:
        return {"main": "unknown", "work": "unknown", "group": "unknown"}


def _ttl_hash(ttl_seconds=300):
    """Return a hash that changes every ttl_seconds (default 5 min)."""
    return int(time.time() // ttl_seconds)


@functools.lru_cache(maxsize=512)
def _get_session_model_cached(session_key, jsonl_path, _ttl):
    """Cached model lookup from JSONL file. _ttl param drives cache invalidation."""
    try:
        with open(jsonl_path, "r") as f:
            for i, line in enumerate(f):
                if i >= 10:
                    break
                try:
                    obj = json.loads(line)
                    if obj.get("type") == "model_change":
                        provider = obj.get("provider", "")
                        model_id = obj.get("modelId", "")
                        if provider and model_id:
                            return f"{provider}/{model_id}"
                except (json.JSONDecodeError, ValueError):
                    continue
    except (FileNotFoundError, PermissionError, OSError):
        pass
    return None


def get_session_model(session_key, session_file=None):
    """Get the model for a session by reading its JSONL file.

    Reads first 10 lines looking for a model_change event.
    Uses LRU cache with 5-minute TTL for performance.
    Falls back to agent config defaults if JSONL is missing.
    """
    # Determine JSONL path from session_file or session_key
    jsonl_path = None
    if session_file and os.path.exists(session_file):
        jsonl_path = session_file
    else:
        # Try to find it from sessions.json
        parts = (session_key or "").split(":")
        agent_name = parts[1] if len(parts) >= 2 else "main"
        sessions_json = os.path.join(
            OPENCLAW_PATH, "agents", agent_name, "sessions", "sessions.json"
        )
        try:
            with open(sessions_json, "r") as f:
                store = json.load(f)
            session_data = store.get(session_key, {})
            sid = session_data.get("sessionId", "")
            if sid:
                candidate = os.path.join(
                    OPENCLAW_PATH, "agents", agent_name, "sessions", f"{sid}.jsonl"
                )
                if os.path.exists(candidate):
                    jsonl_path = candidate
        except (FileNotFoundError, json.JSONDecodeError, PermissionError):
            pass

    if jsonl_path:
        result = _get_session_model_cached(session_key, jsonl_path, _ttl_hash())
        if result:
            return result

    # Fallback to agent defaults
    parts = (session_key or "").split(":")
    agent_name = parts[1] if len(parts) >= 2 else "main"
    return _load_agent_default_models().get(agent_name, "unknown")


def load_config():
    """Load config.json, return empty dict on failure."""
    try:
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def load_gateway_aggregator_config():
    """Load multi-gateway config.

    Sources (priority):
      1) env LOBSTER_ROOM_GATEWAYS_JSON (JSON object or array)
      2) config.json gateways

    Env formats supported:
      - Array: [{"id","label","baseUrl","tokenEnv"}, ...]
      - Object: {"gateways":[...], "activeWindowMs":10000, ...}

    Each gateway object:
      {"id","label","baseUrl","tokenEnv"}

    Tokens are never stored in config.json; they are read from environment.
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
        # Allow top-level knobs in env JSON.
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
        item = {
            "id": gid,
            "label": label or gid,
            "baseUrl": base_url,
            "tokenEnv": token_env,
        }
        if agent_label:
            item["agentLabel"] = agent_label
        norm.append(item)

    poll_seconds = int((cfg.get("lobsterRoom") or {}).get("pollSeconds", 2))
    if "pollSeconds" in extra:
        try:
            poll_seconds = int(extra["pollSeconds"])
        except (TypeError, ValueError):
            pass

    out = {
        "gateways": norm,
        "pollSeconds": poll_seconds,
    }
    if "activeWindowMs" in extra:
        out["activeWindowMs"] = extra["activeWindowMs"]
    return out


def read_dotenv(path):
    """Read a KEY=VALUE .env file, return dict. Ignores comments and blanks."""
    result = {}
    try:
        expanded = os.path.expanduser(path)
        with open(expanded, "r") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" in line:
                    key, _, value = line.partition("=")
                    result[key.strip()] = value.strip()
    except (FileNotFoundError, PermissionError):
        pass
    return result


def build_dashboard_prompt(data):
    """Build a compressed system prompt from data.json for the AI assistant."""
    gw = data.get("gateway") or {}
    ac = data.get("agentConfig") or {}

    lines = [
        "You are an AI assistant embedded in the OpenClaw Dashboard.",
        "Answer questions concisely. Use plain text, no markdown.",
        f"Data as of: {data.get('lastRefresh', 'unknown')}",
        "",
        "=== GATEWAY ===",
        f"Status: {gw.get('status', '?')} | PID: {gw.get('pid', '?')} | "
        f"Uptime: {gw.get('uptime', '?')} | Memory: {gw.get('memory', '?')}",
        "",
        "=== COSTS ===",
        f"Today: ${data.get('totalCostToday', 0):.4f} "
        f"(sub-agents: ${data.get('subagentCostToday', 0):.4f})",
        f"All-time: ${data.get('totalCostAllTime', 0):.2f} | "
        f"Projected monthly: ${data.get('projectedMonthly', 0):.0f}",
    ]

    breakdown = data.get("costBreakdown") or []
    if breakdown:
        lines.append("By model (all-time): " + ", ".join(
            f"{d.get('model', '?')} ${d.get('cost', 0):.2f}"
            for d in breakdown[:5]
        ))

    sess = data.get("sessions") or []
    lines += [
        "",
        f"=== SESSIONS ({data.get('sessionCount', len(sess))} total, showing top 3) ===",
    ]
    for s in sess[:3]:
        lines.append(
            f"  {s.get('name', '?')} | {s.get('model', '?')} | "
            f"{s.get('type', '?')} | context: {s.get('contextPct', 0)}%"
        )

    crons = data.get("crons") or []
    failed = [c for c in crons if c.get("lastStatus") == "error"]
    lines += [
        "",
        f"=== CRON JOBS ({len(crons)} total, {len(failed)} failed) ===",
    ]
    for c in crons[:5]:
        status = c.get("lastStatus", "?")
        err = f" ERROR: {c.get('lastError', '')}" if status == "error" else ""
        lines.append(f"  {c.get('name', '?')} | {c.get('schedule', '?')} | {status}{err}")

    alerts = data.get("alerts") or []
    lines += ["", "=== ALERTS ==="]
    if alerts:
        for a in alerts:
            lines.append(f"  [{a.get('severity', '?').upper()}] {a.get('message', '?')}")
    else:
        lines.append("  None")

    lines += [
        "",
        "=== CONFIGURATION ===",
        f"Primary model: {ac.get('primaryModel', '?')}",
        f"Fallbacks: {', '.join(ac.get('fallbacks', [])) or 'none'}",
    ]

    return "\n".join(lines)


def call_gateway(system, history, question, port, token, model):
    """Call the OpenClaw gateway's OpenAI-compatible chat completions endpoint.

    Returns {"answer": "..."} on success, {"error": "..."} on failure.
    """
    messages = [{"role": "system", "content": system}]
    messages.extend(history)
    messages.append({"role": "user", "content": question})

    payload = json.dumps({
        "model": model,
        "messages": messages,
        "max_tokens": 512,
        "stream": False,
    }).encode()

    req = urllib.request.Request(
        f"http://localhost:{port}/v1/chat/completions",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode())
            content = (
                body.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content", "")
            )
            return {"answer": content or "(empty response)"}
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        return {"error": f"Gateway HTTP {e.code}: {body[:200]}"}
    except urllib.error.URLError as e:
        return {"error": f"Gateway unreachable: {e.reason}"}
    except socket.timeout:
        return {"error": "Gateway timed out — model took too long to respond"}
    except Exception as e:
        return {"error": f"Unexpected error: {e}"}




def _fetch_json(url, headers=None, timeout=6):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8", errors="ignore")
    return json.loads(raw)


def _gateway_headers_from_env(token_env):
    if not token_env:
        return {}
    token = os.environ.get(token_env, "").strip()
    if not token:
        return {}
    return {"Authorization": f"Bearer {token}"}


def _active_window_ms_from_env_or_cfg(cfg):
    """Active/idle cutoff (ms) for the lobster-room agent view.

    v1 is intentionally coarse: sessions_list exposes `updatedAt` but not a
    rich "running" status; we treat "anything updated recently" as active.
    """
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
    """Client poll interval (seconds) exposed via /api/lobster-room payload."""
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


def build_lobster_room_state():
    """Aggregate multi-gateway status into a single payload for lobster-room.html.

    MVP: pulls each gateway's dashboard JSON via /api/refresh and maps sessions to
    a coarse state bubble.
    """
    agg_cfg = load_gateway_aggregator_config()
    gateways = agg_cfg.get("gateways", [])
    active_window_ms = _active_window_ms_from_env_or_cfg(agg_cfg)
    poll_seconds = _poll_seconds_from_env_or_cfg(agg_cfg)

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
        out["errors"].append("No gateways configured. Add gateways[] to config.json")
        return out

    for gw in gateways:
        base = gw["baseUrl"]
        url = f"{base}/tools/invoke"
        headers = _gateway_headers_from_env(gw.get("tokenEnv", ""))
        if gw.get("tokenEnv") and not headers:
            out["ok"] = False
            out["errors"].append(f"{gw['id']} missing env var: {gw['tokenEnv']} (for {base})")
            continue

        try:
            # Use the official Tools Invoke HTTP API to list sessions.
            payload = {"tool": "sessions_list", "action": "json", "args": {}}
            req = urllib.request.Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={**headers, "Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                raw = resp.read().decode("utf-8", errors="ignore")
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                snippet = raw[:200].replace('\n', ' ')
                raise Exception(f"Non-JSON response from tools/invoke: {snippet}")
            if not data.get("ok"):
                raise Exception(str(data.get("error") or "tools/invoke failed"))
            details = (data.get("result") or {}).get("details") or {}
            sessions = details.get("sessions") or []

            # v1: show one resident agent per gateway to avoid session noise.
            max_updated_at = None
            for s in sessions:
                ts = s.get("updatedAt")
                if isinstance(ts, (int, float)):
                    ts = int(ts)
                    if max_updated_at is None or ts > max_updated_at:
                        max_updated_at = ts

            out["gateways"].append({
                "id": gw["id"],
                "label": gw["label"],
                "baseUrl": gw["baseUrl"],
                "status": "ok",
                "sessionCount": details.get("count"),
                "lastRefresh": None,
                "maxUpdatedAt": max_updated_at,
            })

            now_ms = int(time.time() * 1000)
            is_active = bool(max_updated_at and (now_ms - max_updated_at) <= active_window_ms)
            out["agents"].append({
                "id": f"resident@{gw['id']}",
                "hostId": gw["id"],
                "hostLabel": gw["label"],
                "name": gw.get("agentLabel") or gw.get("label") or gw["id"],
                "state": "think" if is_active else "wait",
                "meta": {
                    "active": is_active,
                    "activeWindowMs": active_window_ms,
                    "maxUpdatedAt": max_updated_at,
                    "sessionCount": details.get("count"),
                },
            })

        except urllib.error.HTTPError as e:
            out["ok"] = False
            out["errors"].append(f"{gw['id']} HTTP {e.code} at {url}")
        except Exception as e:
            out["ok"] = False
            out["errors"].append(f"{gw['id']} error: {e}")

    return out
class DashboardHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIR, **kwargs)

    def end_headers(self):
        # Prevent browser caching of HTML/JS files
        if hasattr(self, 'path') and (self.path.endswith('.html') or self.path == '/' or self.path.endswith('.js')):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()

    def do_GET(self):
        # Healthcheck (for Zeabur / platform health probes)
        if self.path in ("/healthz", "/healthz/"):
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(b"ok")
            return

        # Friendly routes
        if self.path in ("/lobster-room", "/lobster-room/"):
            self.path = "/lobster-room.html"

        if self.path == "/api/refresh" or self.path.startswith("/api/refresh?"):
            self.handle_refresh()
        elif self.path == "/api/lobster-room" or self.path.startswith("/api/lobster-room?"):
            self.handle_lobster_room()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == "/api/chat":
            self.handle_chat()
        else:
            self.send_response(404)
            self.end_headers()

    def handle_refresh(self):
        run_refresh()

        try:
            with open(DATA_FILE, "r") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-cache")
            origin = self.headers.get("Origin", "")
            if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
                self.send_header("Access-Control-Allow-Origin", origin)
            else:
                self.send_header("Access-Control-Allow-Origin", "http://localhost:8080")
            self.end_headers()
            self.wfile.write(data.encode())
        except FileNotFoundError:
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "data.json not found"}).encode())
        except Exception as e:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def handle_lobster_room(self):
        payload = build_lobster_room_state()
        # Always return JSON; caller can render errors.
        self._send_json(200, payload)

    def handle_chat(self):
        if not _ai_cfg.get("enabled", True):
            self._send_json(503, {"error": "AI chat is disabled in config.json"})
            return

        length = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, ValueError):
            self._send_json(400, {"error": "Invalid JSON body"})
            return

        question = body.get("question", "").strip()
        if not question:
            self._send_json(400, {"error": "question is required and must be non-empty"})
            return

        history = body.get("history", [])
        if not isinstance(history, list):
            history = []
        max_hist = int(_ai_cfg.get("maxHistory", 6))
        history = history[-max_hist:]

        try:
            with open(DATA_FILE, "r") as f:
                data = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            data = {}

        system_prompt = build_dashboard_prompt(data)
        result = call_gateway(
            system=system_prompt,
            history=history,
            question=question,
            port=int(_ai_cfg.get("gatewayPort", 18789)),
            token=_gateway_token,
            model=_ai_cfg.get("model", "kimi-coding/k2p5"),
        )
        self._send_json(200, result)

    def _send_json(self, status, data):
        """Send a JSON response with CORS headers."""
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-cache")
        origin = self.headers.get("Origin", "")
        if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
            self.send_header("Access-Control-Allow-Origin", origin)
        else:
            self.send_header("Access-Control-Allow-Origin", "http://localhost:8080")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        # Quiet logging — only log errors and refreshes
        msg = format % args
        if "/api/refresh" in msg or "/api/chat" in msg or "error" in msg.lower():
            print(f"[dashboard] {msg}")


def resolve_config_value(key, cli_val, env_var, config_path, default):
    """Resolve config with priority: CLI flag > env var > config.json > default."""
    if cli_val is not None:
        return cli_val
    env_val = os.environ.get(env_var)
    if env_val is not None:
        return env_val
    cfg = load_config()
    parts = config_path.split(".")
    val = cfg
    for part in parts:
        if isinstance(val, dict):
            val = val.get(part)
        else:
            val = None
            break
    if val is not None:
        return val
    return default


def run_refresh():
    """Run refresh.sh with debounce and timeout."""
    global _last_refresh
    now = time.time()

    with _refresh_lock:
        if now - _last_refresh < _debounce_sec:
            return True  # debounced, serve cached

        try:
            subprocess.run(
                ["bash", REFRESH_SCRIPT],
                timeout=REFRESH_TIMEOUT,
                cwd=DIR,
                capture_output=True,
            )
            _last_refresh = time.time()
            return True
        except subprocess.TimeoutExpired:
            print(f"[dashboard] refresh.sh timed out after {REFRESH_TIMEOUT}s")
            return False
        except Exception as e:
            print(f"[dashboard] refresh.sh failed: {e}")
            return False


def main():
    cfg = load_config()
    server_cfg = cfg.get("server", {})
    refresh_cfg = cfg.get("refresh", {})

    cfg_bind = server_cfg.get("host", BIND)
    cfg_port = server_cfg.get("port", PORT)
    global _debounce_sec, _ai_cfg, _gateway_token
    _debounce_sec = refresh_cfg.get("intervalSeconds", _debounce_sec)

    # Load AI config and gateway token
    _ai_cfg = cfg.get("ai", {})
    dotenv_path = _ai_cfg.get("dotenvPath", "~/.openclaw/.env")
    env_vars = read_dotenv(dotenv_path)
    _gateway_token = env_vars.get("OPENCLAW_GATEWAY_TOKEN", "")
    if _ai_cfg.get("enabled", True) and not _gateway_token:
        print("[dashboard] WARNING: ai.enabled=true but OPENCLAW_GATEWAY_TOKEN not found in dotenv")

    # Deployment-friendly env vars
    # - Zeabur/Heroku-like platforms typically provide PORT
    # - Keep existing DASHBOARD_BIND/DASHBOARD_PORT for explicit control
    env_port_raw = os.environ.get("DASHBOARD_PORT")
    if env_port_raw is None:
        env_port_raw = os.environ.get("PORT")
    env_port = int(env_port_raw) if env_port_raw is not None else int(cfg_port)

    env_bind = os.environ.get("DASHBOARD_BIND")
    if env_bind is None:
        # If PORT is provided, assume we're in a platform environment and bind publicly.
        env_bind = "0.0.0.0" if os.environ.get("PORT") else cfg_bind

    parser = argparse.ArgumentParser(
        description="OpenClaw Dashboard Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""priority: CLI flags > env vars > config.json > defaults

examples:
  %(prog)s                          # localhost:8080 (default)
  %(prog)s --bind 0.0.0.0           # LAN access on port 8080
  %(prog)s -b 0.0.0.0 -p 9090      # LAN access on custom port
  DASHBOARD_BIND=0.0.0.0 %(prog)s   # env var override""",
    )
    parser.add_argument(
        "--bind", "-b",
        default=env_bind,
        help=f"Bind address (default: {env_bind}, use 0.0.0.0 for LAN)",
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=env_port,
        help=f"Listen port (default: {env_port})",
    )
    parser.add_argument(
        "--version", "-V",
        action="version",
        version=f"%(prog)s {VERSION}",
    )
    args = parser.parse_args()

    server = http.server.HTTPServer((args.bind, args.port), DashboardHandler)
    server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    print(f"[dashboard] v{VERSION}")
    print(f"[dashboard] Serving on http://{args.bind}:{args.port}/")
    print(f"[dashboard] Refresh endpoint: /api/refresh (debounce: {_debounce_sec}s)")
    if _ai_cfg.get("enabled", True):
        print(f"[dashboard] AI chat: /api/chat (gateway: localhost:{_ai_cfg.get('gatewayPort', 18789)}, model: {_ai_cfg.get('model', '?')})")
    if args.bind == "0.0.0.0":
        try:
            hostname = socket.gethostname()
            local_ip = socket.gethostbyname(hostname)
            print(f"[dashboard] LAN access: http://{local_ip}:{args.port}/")
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[dashboard] Shutting down.")
        server.shutdown()


if __name__ == "__main__":
    main()
