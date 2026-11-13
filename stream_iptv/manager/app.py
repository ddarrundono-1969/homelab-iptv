import os
import logging
import sys
import subprocess
import sqlite3
import re
import json
import yaml
import time
if hasattr(time, 'tzset'):
    os.environ['TZ'] = 'America/Los_Angeles'
    time.tzset()
import collections
import uuid
import threading
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor
import urllib.request
from flask import Flask, render_template, request, jsonify, send_from_directory, make_response, redirect, session as flask_session

def _escape_influx_tag(s):
    # An empty tag value or a trailing backslash makes the whole line invalid and
    # InfluxDB rejects the batch, so normalise both.
    s = str(s).replace("\\", "/").replace("\n", " ").replace("\r", " ").strip() or "none"
    return s.replace(",", "\\,").replace(" ", "\\ ").replace("=", "\\=")

def _escape_influx_field(s):
    s = str(s).replace("\n", " ").replace("\r", " ")
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

def _send_influx_async(lines):
    # Metrics are optional: without a token there is nowhere to send them.
    if not lines or not os.environ.get("INFLUXDB_TOKEN"):
        return
    def _worker():
        try:
            url = os.environ.get("INFLUXDB_URL", "http://influxdb:8086").rstrip("/")
            token = os.environ.get("INFLUXDB_TOKEN", "")
            org = os.environ.get("INFLUXDB_ORG", "laborg")
            bucket = os.environ.get("INFLUXDB_BUCKET", "mrtg_bucket")
            write_url = f"{url}/api/v2/write?org={org}&bucket={bucket}&precision=ns"
            data = "\n".join(lines).encode("utf-8")
            req = urllib.request.Request(write_url, data=data, headers={"Authorization": f"Token {token}"})
            with urllib.request.urlopen(req, timeout=3):
                pass
        except Exception as e:
            # Rejected batches used to vanish silently; log at most every 10 minutes.
            global _influx_last_warn
            if time.time() - _influx_last_warn > 600:
                _influx_last_warn = time.time()
                detail = e.read().decode("utf-8", "replace")[:200] if hasattr(e, "read") else ""
                logging.getLogger(__name__).warning(f"InfluxDB write failed: {e} {detail}")
    threading.Thread(target=_worker, daemon=True).start()

_influx_last_warn = 0.0

app = Flask(__name__, template_folder="templates")
app.config["TEMPLATES_AUTO_RELOAD"] = True
app.jinja_env.auto_reload = True
# Every playlist read and write goes under this root (playlist.yaml + playlists/).
# Point IPTV_PLAYLIST_ROOT at a scratch copy to run the app without touching the
# real playlists (the .139 watchdog syncs this directory to the live server).
PLAYLIST_ROOT = os.path.abspath(os.environ.get("IPTV_PLAYLIST_ROOT")
                                or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def _load_secret_key():
    """FLASK_SECRET_KEY, else a random key persisted next to the playlists (gitignored)."""
    if os.environ.get("FLASK_SECRET_KEY"):
        return os.environ["FLASK_SECRET_KEY"]
    key_path = os.path.join(PLAYLIST_ROOT, "playlists/.flask_secret_key")
    try:
        with open(key_path) as f:
            key = f.read().strip()
        if key:
            return key
    except FileNotFoundError:
        pass
    import secrets
    key = secrets.token_hex(32)
    fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(key)
    return key

app.secret_key = _load_secret_key()
app.config["SESSION_COOKIE_NAME"] = "stream_iptv_session"
app.config["SESSION_COOKIE_PATH"] = "/"
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=30)

import user_manager
import db
import requests
from requests.adapters import HTTPAdapter

# Initialize a global session with a pool of connections for Keep-Alive connection reuse
import ipaddress
import socket


def assert_public_host(host):
    """Raise unless every address `host` resolves to is publicly routable."""
    if not host:
        raise requests.exceptions.InvalidURL("Missing host")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror as e:
        raise requests.exceptions.ConnectionError(f"DNS lookup failed for {host}: {e}")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global:
            raise requests.exceptions.InvalidURL(f"Blocked non-public destination {host} ({ip})")


class PublicOnlyAdapter(HTTPAdapter):
    """Refuses private, loopback, link-local, CGNAT/Tailscale and other non-public
    destinations. send() runs for every redirect hop too, so the public proxy
    endpoints cannot be used to reach the homelab LAN or cloud metadata."""

    def send(self, request, **kwargs):
        assert_public_host(urlparse(request.url).hostname)
        return super().send(request, **kwargs)


http_pool = requests.Session()
adapter = PublicOnlyAdapter(pool_connections=100, pool_maxsize=150)
http_pool.mount('http://', adapter)
http_pool.mount('https://', adapter)

@app.after_request
def add_header(response):
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# --- Provider credential masking -------------------------------------------
# Xtream-style stream URLs carry the subscriber login in the path
# (http://host/live/<user>/<pass>/<id>.ts, http://host/<user>/<pass>/<id>)
# or query (?username=..&password=..). Responses to clients that are not logged
# in (kiosk, view, player) replace each pair with an opaque token; /api/proxy and
# /api/channel/preflight swap the real values back in server-side, so the login
# never reaches the browser. Token -> (user, pass) is kept in a 0600 file so URLs
# a kiosk already holds keep working across restarts.
import hmac
import hashlib

CRED_MAP_PATH = os.path.join(PLAYLIST_ROOT, "playlists/.cred_map.json")
# Hosts whose path-style URLs (host/<user>/<pass>/<id>) carry a login, comma-separated.
CRED_DOMAINS = tuple(d.strip().lower() for d in os.environ.get("IPTV_CRED_DOMAINS", "").split(",") if d.strip())
_cred_map = {}
_cred_lock = threading.Lock()
try:
    with open(CRED_MAP_PATH) as _f:
        _cred_map = json.load(_f)
except (FileNotFoundError, ValueError):
    pass

_CRED_PATH_RE = re.compile(
    r"(?P<pre>https?://(?P<host>[^/\s\"'<>]+)/(?:(?:live|movie|series)/)?)"
    r"(?P<u>[^/\s\"'<>?#]+)/(?P<p>[^/\s\"'<>?#]+)/(?P<rest>\d+(?:\.\w+)?)"
)
_CRED_QUERY_RE = re.compile(r"(?P<k>[?&](?:username|password)=)(?P<v>[^&\s\"'<>#]+)")
_CRED_TOKEN_RE = re.compile(r"_c([0-9a-f]{12})([up])_")


def _is_cred_host(host):
    host = (host or "").lower().split(":")[0]
    return any(host == d or host.endswith("." + d) for d in CRED_DOMAINS)


def _cred_token(user, pwd):
    tok = hmac.new(app.secret_key.encode(), f"{user}\0{pwd}".encode(), hashlib.sha256).hexdigest()[:12]
    if _cred_map.get(tok) != [user, pwd]:
        with _cred_lock:
            _cred_map[tok] = [user, pwd]
            fd = os.open(CRED_MAP_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump(_cred_map, f)
    return tok


_ENCODED_URL_RE = re.compile(r"https?%3A%2F%2F[^\s\"'&<>]+", re.IGNORECASE)


def mask_credentials(text):
    """Replace provider logins embedded in stream URLs with opaque tokens."""
    if text and "%3A%2F%2F" in text.upper():
        text = _ENCODED_URL_RE.sub(
            lambda m: urllib.parse.quote(mask_credentials(urllib.parse.unquote(m.group(0))), safe=""), text)
    if not text or ("://" not in text):
        return text

    def path_repl(m):
        if not _is_cred_host(m.group("host")) and "/live/" not in m.group(0) and "/movie/" not in m.group(0) and "/series/" not in m.group(0):
            return m.group(0)
        tok = _cred_token(m.group("u"), m.group("p"))
        return f"{m.group('pre')}_c{tok}u_/_c{tok}p_/{m.group('rest')}"

    text = _CRED_PATH_RE.sub(path_repl, text)
    if "username=" in text and "password=" in text:
        # Query-string logins (get.php / xmltv.php style): mask each value
        def query_repl(m):
            kind = "u" if "username" in m.group("k") else "p"
            tok = _cred_token(m.group("v"), "") if kind == "u" else _cred_token("", m.group("v"))
            return f"{m.group('k')}_c{tok}{kind}_"
        text = _CRED_QUERY_RE.sub(query_repl, text)
    return text


def unmask_credentials(text):
    """Restore real logins in a URL masked by mask_credentials()."""
    if not text or "_c" not in text:
        return text

    def repl(m):
        pair = _cred_map.get(m.group(1))
        if not pair:
            return m.group(0)
        return pair[0] if m.group(2) == "u" else pair[1]

    return _CRED_TOKEN_RE.sub(repl, text)


class _MaskCredentialsFilter(logging.Filter):
    """Keep provider logins out of access/app logs (they are shipped to OpenSearch)."""

    def filter(self, record):
        try:
            msg = record.getMessage()
        except Exception:
            return True
        masked = mask_credentials(msg)
        if masked != msg:
            record.msg, record.args = masked, None
        return True


for _name in ("werkzeug", "gunicorn.access", "gunicorn.error", app.logger.name):
    logging.getLogger(_name).addFilter(_MaskCredentialsFilter())


_MASKED_TYPES = ("text/", "application/json", "application/x-yaml", "application/yaml", "mpegurl", "javascript")


@app.after_request
def mask_credentials_for_anonymous(response):
    if flask_session.get("user"):
        return response
    is_file = request.path.endswith((".yaml", ".yml", ".m3u", ".m3u8"))
    ctype = (response.mimetype or "").lower()
    if not is_file and (response.is_streamed or not any(t in ctype for t in _MASKED_TYPES)):
        return response  # binary video and other non-text responses pass through
    response.direct_passthrough = False  # send_from_directory serves files as passthrough
    try:
        body = response.get_data().decode("utf-8")
    except UnicodeDecodeError:
        return response  # binary sent with a text type, e.g. .ts segments some upstreams label text/plain
    if len(body) < 30_000_000:
        masked = mask_credentials(body)
        if masked != body:
            response.set_data(masked)
    return response


# Active session tracking with thread-safe lock
active_sessions = {}
sessions_lock = threading.Lock()
active_players = {}
players_lock = threading.Lock()
client_logs = collections.deque(maxlen=2000)
client_logs_lock = threading.Lock()
kicked_ips = set()
kicked_users = set()
playlist_version = int(time.time())
reload_version = int(time.time())
skip_version = int(time.time())

def register_session():
    ua = request.headers.get('User-Agent', 'unknown')
    if any(bot in ua for bot in ['HeadlessChrome', 'curl', 'kube-probe', 'Wget']):
        return
    user = get_current_username()
    ip = request.headers.get('X-Real-IP') or request.remote_addr or 'unknown'
    with sessions_lock:
        active_sessions[(ip, user, ua)] = datetime.now()

def cleanup_sessions():
    with sessions_lock:
        cutoff = datetime.now() - timedelta(seconds=90)
        to_remove = [k for k, v in active_sessions.items() if v < cutoff]
        for k in to_remove:
            del active_sessions[k]

def cleanup_players():
    with players_lock:
        cutoff = datetime.now() - timedelta(seconds=90)
        to_remove = [k for k, v in active_players.items() if v.get("last_seen_dt", datetime.min) < cutoff]
        for k in to_remove:
            del active_players[k]

def get_current_username():
    # Identity comes only from the login session. `?user=` selects whose playlist
    # a public page shows (see get_playlist_path) but never authenticates.
    return flask_session.get("user") or None

def get_base_url():
    prefix = request.headers.get("X-Forwarded-Prefix") or request.headers.get("X-Base-Path")
    if prefix:
        return prefix.rstrip("/") + "/"
    if request.path.startswith("/stream-iptv"):
        return "/stream-iptv/"
    return "/stream-iptv/"

ADMIN_USERNAME = os.environ.get("IPTV_ADMIN_USER", "admin").strip().lower() or "admin"


@app.context_processor
def _inject_admin_user():
    return {"admin_user": ADMIN_USERNAME}

# Reachable without logging in: the kiosk/view/player pages and only the calls
# they make. Everything else needs a session; ADMIN_ONLY paths need the admin.
PUBLIC_ROUTES = {
    "/login": {"GET", "POST"},
    "/logout": {"GET", "POST"},
    "/kiosk": {"GET"},
    "/view": {"GET"},
    "/player": {"GET"},
    "/playlist.yaml": {"GET"},
    "/playlist_kiosk.yaml": {"GET"},
    "/api/auth/login": {"POST"},
    "/api/auth/logout": {"POST", "GET"},
    "/api/playlist": {"GET"},
    "/api/playlist/version": {"GET"},
    "/api/channels": {"GET"},
    "/api/channels/search": {"GET"},
    "/api/categories": {"GET"},
    "/api/epg": {"GET"},
    "/api/epg/now": {"GET"},
    "/api/provider/slots": {"GET"},
    "/api/proxy": {"GET"},
    "/api/channel/preflight": {"GET", "POST"},
    "/api/player/heartbeat": {"POST"},
    "/api/player/log": {"POST"},
}
PUBLIC_PREFIXES = ("/static/",)
ADMIN_ONLY_PREFIXES = ("/admin", "/api/admin/", "/api/provider/", "/api/providers/")


@app.before_request
def enforce_auth():
    clean_path = request.path
    if clean_path.startswith("/stream-iptv"):
        clean_path = clean_path[len("/stream-iptv"):]
    clean_path = clean_path.rstrip("/") or "/"

    if request.method in ("OPTIONS", "HEAD") and clean_path in PUBLIC_ROUTES:
        return None
    if request.method in PUBLIC_ROUTES.get(clean_path, ()) or clean_path.startswith(PUBLIC_PREFIXES):
        return None

    user = get_current_username()
    if not user:
        if clean_path.startswith("/api/"):
            return jsonify({"success": False, "error": "Unauthorized"}), 401
        base = get_base_url()
        current_loc = request.full_path if request.query_string else request.path
        if not current_loc.startswith(base.rstrip("/")):
            current_loc = f"{base.rstrip('/')}{current_loc}"
        return redirect(f"{base}login?next={current_loc}")

    # Provider and user management change shared state; reads of the provider
    # list stay open to logged-in users (passwords are stripped from responses).
    writes = request.method not in ("GET", "HEAD", "OPTIONS")
    if clean_path.startswith(ADMIN_ONLY_PREFIXES) and (writes or clean_path.startswith(("/admin", "/api/admin/"))):
        if user != ADMIN_USERNAME:
            return jsonify({"success": False, "error": "Admin only"}), 403
    return None


def get_playlist_path(target_user=None, mode=None):
    if not target_user:
        try:
            target_user = request.args.get("user") or get_current_username()
        except RuntimeError:
            target_user = None

    playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    os.makedirs(playlists_dir, exist_ok=True)
    default_path = os.path.join(PLAYLIST_ROOT, "playlist.yaml")

    # Guard against target_user being None, empty, or literal "None"
    if not target_user or str(target_user).strip() in ("None", "null", "undefined", ""):
        candidate_user = None
        try:
            if flask_session.get("user"):
                candidate_user = flask_session.get("user")
        except Exception:
            pass
        if candidate_user and os.path.exists(os.path.join(playlists_dir, f"playlist_{candidate_user}.yaml")):
            target_user = candidate_user
        elif os.path.exists(os.path.join(playlists_dir, f"playlist_{ADMIN_USERNAME}.yaml")):
            target_user = ADMIN_USERNAME
        else:
            target_user = "default"

    if target_user == "default":
        return default_path

    # No copy-on-read: `?user=` is accepted on public routes, so creating files
    # here let any visitor add playlist_<anything>.yaml. Readers fall back to the
    # default playlist; the file is created on the user's first save.
    clean_user = "".join(c for c in str(target_user) if c.isalnum() or c in ("-", "_"))
    return os.path.join(playlists_dir, f"playlist_{clean_user}.yaml")

def load_playlist(target_user=None, mode=None):
    cleanup_expired_playlists()
    path = get_playlist_path(target_user, mode)
    default_path = get_playlist_path("default", mode)

    if not target_user:
        try:
            target_user = request.args.get("user") or get_current_username()
        except RuntimeError:
            target_user = None

    if target_user and str(target_user).strip() not in ("", "None", "null", "undefined"):
        meta = read_playlist_meta(target_user)
        if meta.get("list_type") == "temporary" and playlist_is_expired(meta):
            cleanup_expired_playlists()
            return {"rotation_interval_seconds": 900, "streams": []}

    if not os.path.exists(path):
        if os.path.exists(default_path):
            try:
                with open(default_path, "r", encoding="utf-8") as f:
                    return yaml.safe_load(f) or {"rotation_interval_seconds": 900, "streams": []}
            except Exception:
                pass
        return {"rotation_interval_seconds": 900, "streams": []}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
            if isinstance(data, dict):
                streams = data.get("streams")
                if isinstance(streams, list):
                    sync_window_stream_times(data)
                    active_win = get_active_temporary_window(data)
                    data["temporary_mode_active"] = active_win is not None
                    data["active_temporary_window"] = active_win
                    for s in streams:
                        if isinstance(s, dict):
                            s["is_active_now"] = is_schedule_active_now(s)
                    override = load_playback_override()
                    data["playback_override"] = override
                    if override and mode in ("streamer", "kiosk"):
                        picked = playback_override_streams(streams, override["mode"], data)
                        if picked:
                            data["streams"] = picked
                    elif active_win is not None and mode in ("streamer", "kiosk"):
                        # In playback mode during active temporary window: filter to streams designated for this specific window
                        temp_streams = [
                            s for s in streams 
                            if is_stream_temporary(s) and is_stream_for_window(s, active_win, data)
                        ]
                        if temp_streams:
                            data["streams"] = temp_streams
                    elif mode in ("streamer", "kiosk"):
                        # Outside both windows: normal rotation only, window channels stay out
                        normal_streams = normal_rotation_streams(streams)
                        if normal_streams:
                            data["streams"] = normal_streams
                return data
            return {"rotation_interval_seconds": 900, "streams": []}
    except Exception as e:
        return {"error": str(e), "rotation_interval_seconds": 900, "streams": []}

def save_playlist(data, target_user=None, mode=None):
    path = get_playlist_path(target_user, mode)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if isinstance(data, dict) and isinstance(data.get("streams"), list):
            sync_window_stream_times(data)
            if data.get("anti_collision_enabled", True) is not False:
                try:
                    base_dir = os.path.dirname(os.path.abspath(__file__))
                    parent_dir = os.path.abspath(os.path.join(base_dir, ".."))
                    if parent_dir not in sys.path:
                        sys.path.insert(0, parent_dir)
                    from anti_collision import interleave_streams_anti_collision
                    data["streams"] = interleave_streams_anti_collision(data["streams"])
                except Exception as e_ac:
                    app.logger.warning(f"Could not apply anti-collision interleaving: {e_ac}")

        with open(path, "w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)

        # Keep playlist.yaml and the admin's playlist in sync for primary user
        default_path = os.path.join(PLAYLIST_ROOT, "playlist.yaml")
        admin_path = os.path.join(PLAYLIST_ROOT, "playlists", f"playlist_{ADMIN_USERNAME}.yaml")

        if not target_user or str(target_user).strip() in (ADMIN_USERNAME, "default"):
            if os.path.abspath(path) != default_path:
                with open(default_path, "w", encoding="utf-8") as f:
                    yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)
            if os.path.abspath(path) != admin_path:
                with open(admin_path, "w", encoding="utf-8") as f:
                    yaml.safe_dump(data, f, default_flow_style=False, sort_keys=False)

        return True
    except Exception as e:
        app.logger.error(f"Error saving playlist: {e}")
        return False


def get_playlist_meta_file(target_name):
    if not target_name:
        return None
    playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    clean_name = "".join(ch for ch in str(target_name) if ch.isalnum() or ch in ("-", "_"))
    if not clean_name:
        return None
    os.makedirs(playlists_dir, exist_ok=True)
    return os.path.join(playlists_dir, f"playlist_{clean_name}.meta.json")


def read_playlist_meta(target_name):
    meta_file = get_playlist_meta_file(target_name)
    default_meta = {
        "category": "General",
        "list_type": "permanent",
        "expires_at": None,
        "start_date": None,
        "end_date": None,
        "start_time": None,
        "end_time": None
    }
    # Check if target_name itself implies temporary
    clean_target = str(target_name or "").strip().lower()
    if clean_target in ("temp", "temporary") or clean_target.startswith("temp_") or clean_target.startswith("temp-") or clean_target.endswith("_temp") or clean_target.endswith("-temp") or "_temp_" in clean_target:
        default_meta["list_type"] = "temporary"

    # Also inspect YAML file header/fields if meta file doesn't exist
    base_dir = os.path.dirname(os.path.abspath(__file__))
    yaml_file = os.path.join(PLAYLIST_ROOT, "playlists", f"playlist_{target_name}.yaml")
    if os.path.exists(yaml_file):
        try:
            with open(yaml_file, "r", encoding="utf-8") as yf:
                ydata = yaml.safe_load(yf)
                if isinstance(ydata, dict):
                    if ydata.get("list_type") in ("permanent", "temporary"):
                        default_meta["list_type"] = ydata["list_type"]
                    elif ydata.get("temporary") is True or ydata.get("is_temporary") is True:
                        default_meta["list_type"] = "temporary"
                    if ydata.get("category"):
                        default_meta["category"] = ydata["category"]
                    for k in ("expires_at", "start_date", "end_date", "start_time", "end_time"):
                        if ydata.get(k):
                            default_meta[k] = ydata[k]
        except Exception:
            pass

    if not meta_file or not os.path.exists(meta_file):
        return default_meta
    try:
        with open(meta_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return default_meta
        list_type = str(data.get("list_type", default_meta["list_type"])).strip().lower()
        if list_type not in ("permanent", "temporary"):
            list_type = default_meta["list_type"]
        return {
            "category": str(data.get("category", default_meta["category"])).strip() or "General",
            "list_type": list_type,
            "expires_at": data.get("expires_at") or default_meta.get("expires_at"),
            "start_date": data.get("start_date") or default_meta.get("start_date"),
            "end_date": data.get("end_date") or default_meta.get("end_date"),
            "start_time": data.get("start_time") or default_meta.get("start_time"),
            "end_time": data.get("end_time") or default_meta.get("end_time")
        }
    except Exception:
        return default_meta


def write_playlist_meta(target_name, category="General", list_type="permanent", expires_at=None, start_date=None, end_date=None, start_time=None, end_time=None):
    meta_file = get_playlist_meta_file(target_name)
    if not meta_file:
        return False
    payload = {
        "category": str(category or "General").strip(),
        "list_type": list_type,
        "expires_at": expires_at,
        "start_date": start_date,
        "end_date": end_date,
        "start_time": start_time,
        "end_time": end_time
    }
    try:
        with open(meta_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        return True
    except Exception as e:
        app.logger.error(f"Error saving playlist metadata: {e}")
        return False


def _check_single_window_active(ts, now):
    if not ts or not isinstance(ts, dict) or not ts.get("enabled"):
        return False

    now_date_str = now.strftime("%Y-%m-%d")
    current_mins = now.hour * 60 + now.minute

    # Date range checks
    start_date = ts.get("start_date")
    if start_date and str(start_date).strip():
        if now_date_str < str(start_date).strip()[:10]:
            return False

    end_date = ts.get("end_date")
    if end_date and str(end_date).strip():
        if now_date_str > str(end_date).strip()[:10]:
            return False

    # Day of week check (optional, 0=Mon .. 6=Sun)
    days = ts.get("days")
    if days and isinstance(days, list) and len(days) > 0:
        if now.weekday() not in days:
            return False

    # Time of day (hours) check
    start_time = ts.get("start_time")
    end_time = ts.get("end_time")
    if start_time and end_time and str(start_time).strip() and str(end_time).strip():
        try:
            s_parts = [int(p) for p in str(start_time).strip().split(":")[:2]]
            e_parts = [int(p) for p in str(end_time).strip().split(":")[:2]]
            s_mins = s_parts[0] * 60 + (s_parts[1] if len(s_parts) > 1 else 0)
            e_mins = e_parts[0] * 60 + (e_parts[1] if len(e_parts) > 1 else 0)

            if s_mins <= e_mins:
                return s_mins <= current_mins < e_mins
            else:
                # Spans across midnight e.g. 20:00 to 02:00
                return current_mins >= s_mins or current_mins < e_mins
        except Exception:
            pass

    return True


def get_active_temporary_window(playlist_data):
    """
    Returns 1 if Window 1 is active, 2 if Window 2 is active, or None if no temporary window is active.
    Window 1 takes precedence if both somehow overlap.
    """
    if not isinstance(playlist_data, dict):
        return None
    now = datetime.now()
    if _check_single_window_active(playlist_data.get("temporary_schedule"), now):
        return 1
    if _check_single_window_active(playlist_data.get("temporary_schedule_2"), now):
        return 2
    return None


def is_temporary_mode_active(playlist_data):
    """
    Checks if the playlist is currently in a scheduled Temporary-Only playback window.
    Supports Window 1 (temporary_schedule) and Window 2 (temporary_schedule_2).
    During any active window, only temporary streams are played.
    Outside active windows, all streams play normally.
    """
    return get_active_temporary_window(playlist_data) is not None


def is_stream_for_window(s, window_num, playlist_data=None):
    """
    Determines if a temporary stream belongs to window_num (1 or 2).
    Checks:
    1. s.get("schedule_window") == window_num
    2. Start/end time or start/end date matches that window's config in playlist_data
    3. If unassigned and window_num == 1, defaults to window 1 for backward compatibility
    """
    if not isinstance(s, dict):
        return False
    sw = s.get("schedule_window")
    if sw is not None:
        try:
            return int(sw) == window_num
        except Exception:
            pass
    # Check if time/date matches window_num schedule in playlist_data
    if playlist_data and isinstance(playlist_data, dict):
        cfg_key = "temporary_schedule" if window_num == 1 else "temporary_schedule_2"
        w_cfg = playlist_data.get(cfg_key)
        if isinstance(w_cfg, dict):
            w_start = w_cfg.get("start_time")
            w_end = w_cfg.get("end_time")
            s_start = s.get("start_time")
            s_end = s.get("end_time")
            if w_start and s_start and w_start == s_start:
                return True
            if w_end and s_end and w_end == s_end:
                return True
    # Default unassigned temporary channels to Window 1
    return window_num == 1


def stream_dedupe_key(url, s):
    """Duplicate check for playlist streams. A channel can be in the normal rotation and
    also copied into a temporary window (same URL), so only identical schedules collide."""
    window = str(s.get("schedule_window") or "") if isinstance(s, dict) else ""
    return (url, is_stream_temporary(s), window)


def sync_window_stream_times(playlist_data):
    """Copy each window's current times/dates onto the channels assigned to it
    (schedule_window), so editing a window's hours also moves its channels; the
    per-channel copies the UI writes when adding a channel would otherwise go stale."""
    if not isinstance(playlist_data, dict) or not isinstance(playlist_data.get("streams"), list):
        return
    for s in playlist_data["streams"]:
        if not isinstance(s, dict) or s.get("schedule_window") in (None, ""):
            continue
        try:
            window_num = int(s["schedule_window"])
        except (ValueError, TypeError):
            continue
        w_cfg = playlist_data.get("temporary_schedule" if window_num == 1 else "temporary_schedule_2")
        if window_num not in (1, 2) or not isinstance(w_cfg, dict):
            continue
        for key in ("start_time", "end_time", "start_date", "end_date"):
            val = str(w_cfg.get(key) or "").strip()
            if val:
                s[key] = val
            else:
                s.pop(key, None)


def is_stream_temporary(s):
    if not isinstance(s, dict):
        return False
    stype = str(s.get("schedule_type") or s.get("list_type") or "").strip().lower()
    if stype == "temporary":
        return True
    if s.get("temporary") is True or s.get("is_temporary") is True or str(s.get("temporary")).lower() in ("true", "1") or str(s.get("is_temporary")).lower() in ("true", "1"):
        return True
    cat = str(s.get("category") or "").strip().lower()
    if cat in ("temporary", "temp") or cat.startswith("temp"):
        return True
    if any(s.get(k) for k in ("start_date", "end_date", "start_time", "end_time", "expires_at")):
        return True
    return False


def normal_rotation_streams(streams):
    """Permanent streams minus any channel also copied into Window 1 or 2 (same URL or name)."""
    def key(s, field):
        return str(s.get(field) or "").strip().lower()
    window = [s for s in streams if isinstance(s, dict) and is_stream_temporary(s)]
    window_urls = {key(s, "url") for s in window} - {""}
    window_names = {key(s, "name") for s in window} - {""}
    return [
        s for s in streams
        if isinstance(s, dict) and not is_stream_temporary(s)
        and key(s, "url") not in window_urls and key(s, "name") not in window_names
    ]


def is_schedule_active_now(item):
    """
    Checks if a stream or playlist item is active now based on date and hours restrictions.
    Permanent items are always active.
    Temporary items must be:
      1. Not expired
      2. Within start_date and end_date (if specified)
      3. Within start_time and end_time hours (if specified, e.g. '09:00' to '17:00')
    """
    if not isinstance(item, dict):
        return True
    if item.get("offline") or item.get("is_offline"):
        return False
    if not is_stream_temporary(item):
        return True

    now = datetime.now()
    now_date_str = now.strftime("%Y-%m-%d")
    current_mins = now.hour * 60 + now.minute

    # 1. Expiration check
    expires_at = item.get("expires_at")
    if expires_at:
        try:
            dt = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
            if datetime.now(dt.tzinfo or datetime.now().astimezone().tzinfo) >= dt:
                return False
        except Exception:
            pass

    # 2. Date restrictions
    start_date = item.get("start_date")
    if start_date and str(start_date).strip():
        if now_date_str < str(start_date).strip()[:10]:
            return False

    end_date = item.get("end_date")
    if end_date and str(end_date).strip():
        if now_date_str > str(end_date).strip()[:10]:
            return False

    # 3. Hour restrictions (time of day)
    start_time = item.get("start_time")
    end_time = item.get("end_time")
    if start_time and end_time and str(start_time).strip() and str(end_time).strip():
        try:
            s_parts = [int(p) for p in str(start_time).strip().split(":")[:2]]
            e_parts = [int(p) for p in str(end_time).strip().split(":")[:2]]
            s_mins = s_parts[0] * 60 + (s_parts[1] if len(s_parts) > 1 else 0)
            e_mins = e_parts[0] * 60 + (e_parts[1] if len(e_parts) > 1 else 0)

            if s_mins <= e_mins:
                if not (s_mins <= current_mins <= e_mins):
                    return False
            else:
                # Spans across midnight e.g. 21:00 to 06:00
                if not (current_mins >= s_mins or current_mins <= e_mins):
                    return False
        except Exception:
            pass

    return True


def playlist_is_expired(meta):
    if meta.get("list_type") != "temporary":
        return False
    expires_at = meta.get("expires_at")
    if expires_at:
        try:
            dt = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00"))
            if datetime.now(dt.tzinfo or datetime.now().astimezone().tzinfo) >= dt:
                return True
        except Exception:
            pass
    end_date = meta.get("end_date")
    if end_date and str(end_date).strip():
        now_date_str = datetime.now().strftime("%Y-%m-%d")
        if now_date_str > str(end_date).strip()[:10]:
            return True
    return False


def cleanup_expired_playlists():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    if not os.path.exists(playlists_dir):
        return []

    removed = []
    for fname in os.listdir(playlists_dir):
        if not (fname.startswith("playlist_") and fname.endswith(".yaml") and ".bak." not in fname):
            continue
        pname = fname[len("playlist_"):-len(".yaml")]
        meta = read_playlist_meta(pname)
        if meta.get("list_type") == "temporary" and playlist_is_expired(meta):
            for candidate in [
                os.path.join(playlists_dir, fname),
                get_playlist_meta_file(pname),
            ]:
                try:
                    if candidate and os.path.exists(candidate):
                        os.remove(candidate)
                except Exception:
                    pass
            removed.append(pname)
    return removed


def list_playlist_names_for_type(list_type="all"):
    base_dir = os.path.dirname(os.path.abspath(__file__))
    playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    if not os.path.exists(playlists_dir):
        return []

    valid_types = {"all", "both", "permanent", "temporary"}
    if list_type not in valid_types:
        list_type = "all"

    names = []
    for fname in os.listdir(playlists_dir):
        if not (fname.startswith("playlist_") and fname.endswith(".yaml") and ".bak." not in fname):
            continue
        pname = fname[len("playlist_"):-len(".yaml")]
        meta = read_playlist_meta(pname)
        meta_type = meta.get("list_type", "permanent")
        if meta_type == "temporary" and playlist_is_expired(meta):
            cleanup_expired_playlists()
            continue
        if list_type in ("permanent", "temporary") and meta_type != list_type:
            continue
        if list_type == "both" and meta_type not in ("permanent", "temporary"):
            continue
        names.append(pname)
    return sorted(names, key=lambda n: n.lower())


def load_playlist_group(target_user=None, mode=None, playlist_type="all"):
    if playlist_type not in ("all", "both", "permanent", "temporary"):
        playlist_type = "all"

    if playlist_type == "all":
        return load_playlist(target_user=target_user, mode=mode)

    clean_targets = list_playlist_names_for_type(playlist_type)
    merged = {"rotation_interval_seconds": 900, "streams": []}
    seen_urls = set()

    for pname in clean_targets:
        data = load_playlist(target_user=pname, mode=mode)
        if not isinstance(data, dict):
            continue
        streams = data.get("streams") or []
        if not isinstance(streams, list):
            continue
        for stream in streams:
            if not isinstance(stream, dict):
                continue
            url = str(stream.get("url") or "").strip()
            if not url:
                continue
            is_temp = is_stream_temporary(stream)
            if playlist_type == "permanent" and is_temp:
                continue
            key = stream_dedupe_key(url.lower(), stream)
            if key in seen_urls:
                continue
            seen_urls.add(key)
            merged.setdefault("browser_channel", data.get("browser_channel", "chrome"))
            if "rotation_interval_seconds" in data and isinstance(data.get("rotation_interval_seconds"), int):
                merged["rotation_interval_seconds"] = data.get("rotation_interval_seconds")
            if playlist_type == "temporary" or is_temp:
                stream["schedule_type"] = "temporary"
            stream["is_active_now"] = is_schedule_active_now(stream)
            merged["streams"].append(stream)

    # Also include/filter streams from target_user's active playlist
    if target_user and target_user not in clean_targets:
        user_data = load_playlist(target_user=target_user, mode=mode)
        if isinstance(user_data, dict):
            merged.setdefault("browser_channel", user_data.get("browser_channel", "chrome"))
            for s in user_data.get("streams", []):
                if not isinstance(s, dict):
                    continue
                is_temp = is_stream_temporary(s)
                if playlist_type == "temporary" and not is_temp:
                    continue
                if playlist_type == "permanent" and is_temp:
                    continue
                url = str(s.get("url") or "").strip()
                if not url:
                    continue
                key = stream_dedupe_key(url.lower(), s)
                if key in seen_urls:
                    continue
                seen_urls.add(key)
                if is_temp:
                    s["schedule_type"] = "temporary"
                s["is_active_now"] = is_schedule_active_now(s)
                merged["streams"].append(s)

    # If temporary filter is requested, also scan all other playlists for any streams marked temporary
    if playlist_type == "temporary":
        base_dir = os.path.dirname(os.path.abspath(__file__))
        playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
        if os.path.exists(playlists_dir):
            for fname in sorted(os.listdir(playlists_dir)):
                if not (fname.startswith("playlist_") and fname.endswith(".yaml") and ".bak." not in fname):
                    continue
                pname = fname[len("playlist_"):-len(".yaml")]
                if pname in clean_targets or pname == target_user:
                    continue
                other_data = load_playlist(target_user=pname, mode=mode)
                if not isinstance(other_data, dict):
                    continue
                for s in other_data.get("streams", []):
                    if not isinstance(s, dict):
                        continue
                    if is_stream_temporary(s):
                        url = str(s.get("url") or "").strip()
                        if not url:
                            continue
                        key = stream_dedupe_key(url.lower(), s)
                        if key in seen_urls:
                            continue
                        seen_urls.add(key)
                        s["schedule_type"] = "temporary"
                        s["is_active_now"] = is_schedule_active_now(s)
                        merged["streams"].append(s)

    return merged

DEFAULT_PROVIDER_URL = os.environ.get("IPTV_DEFAULT_PROVIDER_URL", "")

def get_provider_config_path(target_user=None):
    if not target_user:
        try:
            target_user = get_current_username() or "default"
        except (RuntimeError, Exception):
            target_user = "default"
    if not target_user:
        target_user = "default"
    base_dir = os.path.dirname(os.path.abspath(__file__))
    playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    os.makedirs(playlists_dir, exist_ok=True)
    return os.path.join(playlists_dir, f"provider_{target_user}.json")

def load_provider_config(target_user=None):
    path = get_provider_config_path(target_user)
    default_config = {
        "providers": [
            {"name": "Primary Provider", "url": DEFAULT_PROVIDER_URL}
        ],
        "url": DEFAULT_PROVIDER_URL,
        "url2": "",
        "provider1_name": "Primary Provider",
        "provider2_name": "Secondary Provider",
        "is_custom": False,
        "default_url": DEFAULT_PROVIDER_URL
    }
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
                providers = data.get("providers")
                if providers is None:
                    providers = []
                    p1_url = (data.get("url") or DEFAULT_PROVIDER_URL).strip()
                    p1_name = (data.get("provider1_name") or "Primary Provider").strip()
                    if p1_url:
                        providers.append({"name": p1_name, "url": p1_url})
                    p2_url = (data.get("url2") or "").strip()
                    p2_name = (data.get("provider2_name") or "Secondary Provider").strip()
                    if p2_url:
                        providers.append({"name": p2_name, "url": p2_url})

                p1 = providers[0] if providers else {"name": "Primary Provider", "url": DEFAULT_PROVIDER_URL}
                p2 = providers[1] if len(providers) > 1 else None
                return {
                    "providers": providers,
                    "url": p1["url"],
                    "url2": p2["url"] if p2 else "",
                    "provider1_name": p1["name"],
                    "provider2_name": p2["name"] if p2 else "Secondary Provider",
                    "is_custom": data.get("is_custom", len(providers) > 1 or p1["url"] != DEFAULT_PROVIDER_URL),
                    "default_url": DEFAULT_PROVIDER_URL
                }
        except Exception:
            pass
    return default_config

def save_provider_config(providers=None, url=None, url2=None, provider1_name=None, provider2_name=None, is_custom=False, target_user=None):
    path = get_provider_config_path(target_user)

    # Track previously configured providers to detect removals
    old_provider_names = []
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                old_data = json.load(f)
                old_provider_names = [p.get("name", "").strip() for p in old_data.get("providers", []) if p.get("name")]
        except Exception:
            pass

    if providers is None:
        providers = []
        p1_url = (url or DEFAULT_PROVIDER_URL).strip()
        p1_name = (provider1_name or "Primary Provider").strip()
        if p1_url:
            providers.append({"name": p1_name, "url": p1_url})
        p2_url = (url2 or "").strip()
        p2_name = (provider2_name or "Secondary Provider").strip()
        if p2_url:
            providers.append({"name": p2_name, "url": p2_url})

    cleaned_providers = []
    seen = set()
    for p in providers:
        name = (p.get("name") or "Provider").strip()
        purl = (p.get("url") or "").strip()
        pserver = (p.get("server") or "").strip()
        if (purl or pserver) and name not in seen:
            seen.add(name)
            entry = dict(p)
            entry["name"] = name
            if purl:
                entry["url"] = purl
            cleaned_providers.append(entry)

    p1 = cleaned_providers[0] if cleaned_providers else {"name": "Primary Provider", "url": DEFAULT_PROVIDER_URL}
    p2 = cleaned_providers[1] if len(cleaned_providers) > 1 else None
    data = {
        "providers": cleaned_providers,
        "url": p1.get("url", ""),
        "url2": p2.get("url", "") if p2 else "",
        "provider1_name": p1.get("name", "Primary Provider"),
        "provider2_name": p2.get("name", "Secondary Provider") if p2 else "Secondary Provider",
        "is_custom": is_custom or len(cleaned_providers) > 1 or p1.get("url") != DEFAULT_PROVIDER_URL,
        "default_url": DEFAULT_PROVIDER_URL
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

    # Sync default provider config if saving for specific user
    playlists_dir = os.path.dirname(path)
    default_provider_path = os.path.join(playlists_dir, "provider_default.json")
    if os.path.abspath(path) != os.path.abspath(default_provider_path):
        try:
            with open(default_provider_path, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            app.logger.warning(f"Failed to sync provider_default.json: {e}")

    # Check for removed providers and purge all corresponding entries
    cleaned_names_lower = {p["name"].lower() for p in cleaned_providers}
    removed_names = [old_name for old_name in old_provider_names if old_name.lower() not in cleaned_names_lower]
    if removed_names:
        for rname in removed_names:
            try:
                purged = db.purge_provider_channels(rname)
                app.logger.info(f"Purged {purged} entries for removed provider '{rname}'")
            except Exception as e:
                app.logger.error(f"Error purging removed provider entries '{rname}': {e}")

    global playlist_version
    playlist_version = int(time.time())

    return data

def sync_xtream_provider(name, server, username, password, stream_format="ts", write_m3u=True):
    """
    Directly queries Xtream Codes API (player_api.php), saves local .m3u,
    and returns list of channel tuples: (name, stream_url, category, tvg_id, logo, provider_name).
    """
    server = server.rstrip("/")
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}

    cat_map = {}
    try:
        r_cat = requests.get(
            f"{server}/player_api.php?username={username}&password={password}&action=get_live_categories",
            headers=headers, timeout=15
        )
        if r_cat.status_code == 200:
            cats = r_cat.json()
            if isinstance(cats, list):
                cat_map = {str(c.get("category_id")): c.get("category_name", "General") for c in cats}
    except Exception as e:
        app.logger.warning(f"Xtream categories fetch warning for {name}: {e}")

    r_streams = requests.get(
        f"{server}/player_api.php?username={username}&password={password}&action=get_live_streams",
        headers=headers, timeout=45
    )
    r_streams.raise_for_status()
    streams = r_streams.json()
    if not isinstance(streams, list):
        raise ValueError(f"Unexpected API response from Xtream server: {streams}")

    clean_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', name.lower())
    base_dir = os.path.dirname(os.path.abspath(__file__))
    playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    os.makedirs(playlists_dir, exist_ok=True)
    m3u_path = os.path.join(playlists_dir, f"{clean_slug}.m3u")

    batch = []
    if write_m3u:
        with open(m3u_path, "w", encoding="utf-8") as f:
            f.write("#EXTM3U\n")
            for s in streams:
                c_name = s.get("name", "Unknown Channel")
                sid = s.get("stream_id")
                cat_id = str(s.get("category_id", ""))
                category = cat_map.get(cat_id, "General")
                icon = s.get("stream_icon", "")
                tvg_id = s.get("epg_channel_id", "")
                stream_url = f"{server}/live/{username}/{password}/{sid}.{stream_format}"
                f.write(f'#EXTINF:-1 tvg-id="{tvg_id}" tvg-name="{c_name}" tvg-logo="{icon}" group-title="{category}",{c_name}\n')
                f.write(f"{stream_url}\n")
                batch.append((c_name, stream_url, category, tvg_id, icon, name))
    else:
        for s in streams:
            c_name = s.get("name", "Unknown Channel")
            sid = s.get("stream_id")
            cat_id = str(s.get("category_id", ""))
            category = cat_map.get(cat_id, "General")
            icon = s.get("stream_icon", "")
            tvg_id = s.get("epg_channel_id", "")
            stream_url = f"{server}/live/{username}/{password}/{sid}.{stream_format}"
            batch.append((c_name, stream_url, category, tvg_id, icon, name))

    return batch, m3u_path

@app.route("/api/providers", methods=["GET"])
def api_list_providers():
    user = get_current_username()
    config = load_provider_config(user)
    providers = config.get("providers", [])

    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")
    counts = db.get_provider_channel_counts(db_path=db_path)
    total_channels = sum(counts.values())

    result = []
    for p in providers:
        name = p.get("name", "Provider")
        url = p.get("url", "")
        item = {
            "name": name,
            "url": url,
            "type": p.get("type", "m3u"),
            "server": p.get("server", ""),
            "username": p.get("username", ""),
            "stream_format": p.get("stream_format", "ts"),
            "channel_count": counts.get(name, 0),
            "is_default": (url == DEFAULT_PROVIDER_URL)
        }
        result.append(item)

    return jsonify({
        "success": True,
        "providers": result,
        "total_channels": total_channels,
        "is_custom": config.get("is_custom", False),
        "last_refresh": dict(PROVIDER_REFRESH_STATE)
    })

@app.route("/api/providers/add", methods=["POST"])
def api_add_provider():
    user = get_current_username()
    req_data = request.get_json() or {}
    name = (req_data.get("name") or "").strip()
    prov_type = (req_data.get("type") or "m3u").strip().lower()
    server = (req_data.get("server") or "").strip().rstrip("/")
    username = (req_data.get("username") or "").strip()
    password = (req_data.get("password") or "").strip()
    stream_format = (req_data.get("stream_format") or "ts").strip().lower()
    url = (req_data.get("url") or "").strip()
    fetch_now = req_data.get("fetch_now", True)

    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")

    # Auto-detect Xtream get.php or player_api.php URLs pasted into the M3U field
    if url and ("get.php" in url or "player_api.php" in url) and ("username=" in url and "password=" in url):
        try:
            import urllib.parse
            parsed_u = urllib.parse.urlparse(url)
            qs = urllib.parse.parse_qs(parsed_u.query)
            if "username" in qs and "password" in qs:
                prov_type = "xtream"
                server = f"{parsed_u.scheme}://{parsed_u.netloc}"
                username = qs["username"][0]
                password = qs["password"][0]
                stream_format = qs.get("output", [stream_format])[0]
        except Exception as ex:
            app.logger.warning(f"Failed to auto-detect Xtream parameters from url {url}: {ex}")

    if prov_type == "xtream" or (server and username and password):
        if not server or not username or not password:
            return jsonify({"success": False, "error": "Server URL, Username, and Password are all required for Xtream provider."}), 400
        if not name:
            name = "Xtream Provider " + str(int(time.time()))

        clean_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', name.lower())
        m3u_url = f"/app/stream_iptv/playlists/{clean_slug}.m3u"
        prov_entry = {
            "name": name,
            "url": m3u_url,
            "type": "xtream",
            "server": server,
            "username": username,
            "password": password,
            "stream_format": stream_format
        }

        config = load_provider_config(user)
        providers = config.get("providers", [])
        updated = False
        for i, p in enumerate(providers):
            if p.get("name") == name:
                providers[i] = prov_entry
                updated = True
                break
        if not updated:
            providers.append(prov_entry)
        save_provider_config(providers=providers, target_user=user)

        if fetch_now:
            t = threading.Thread(target=_bg_refresh_provider_db, args=(user, name, False), daemon=True)
            t.start()

        return jsonify({
            "success": True,
            "provider": {"name": name, "url": m3u_url, "type": "xtream"},
            "refresh_started": bool(fetch_now),
            "message": f"Added Xtream provider '{name}'." + (" Ingestion started in background." if fetch_now else "")
        })

    # Standard M3U playlist provider
    if not url:
        return jsonify({"success": False, "error": "Provider M3U URL is required"}), 400
    if not name:
        name = "Provider " + str(int(time.time()))

    config = load_provider_config(user)
    providers = config.get("providers", [])
    
    updated = False
    for p in providers:
        if p.get("name") == name:
            p["url"] = url
            p["type"] = "m3u"
            updated = True
            break
    if not updated:
        providers.append({"name": name, "url": url, "type": "m3u"})

    save_provider_config(providers=providers, target_user=user)

    if fetch_now:
        t = threading.Thread(target=_bg_refresh_provider_db, args=(user, name, False), daemon=True)
        t.start()

    return jsonify({
        "success": True,
        "provider": {"name": name, "url": url, "type": "m3u"},
        "refresh_started": bool(fetch_now),
        "message": f"Added provider '{name}'." + (" Ingestion started in background." if fetch_now else "")
    })

@app.route("/api/providers/update", methods=["POST"])
def api_update_provider():
    user = get_current_username()
    req_data = request.get_json() or {}
    orig_name = (req_data.get("orig_name") or "").strip()
    new_name = (req_data.get("name") or orig_name).strip()
    prov_type = (req_data.get("type") or "m3u").strip().lower()
    server = (req_data.get("server") or "").strip().rstrip("/")
    username = (req_data.get("username") or "").strip()
    password = (req_data.get("password") or "").strip()
    stream_format = (req_data.get("stream_format") or "ts").strip().lower()
    url = (req_data.get("url") or "").strip()
    fetch_now = bool(req_data.get("fetch_now", False))

    if not orig_name:
        return jsonify({"success": False, "error": "Original provider name ('orig_name') is required."}), 400
    if not new_name:
        return jsonify({"success": False, "error": "Provider name cannot be empty."}), 400

    # Auto-detect Xtream get.php or player_api.php URLs pasted into URL field
    if url and ("get.php" in url or "player_api.php" in url) and ("username=" in url and "password=" in url):
        try:
            import urllib.parse
            parsed_u = urllib.parse.urlparse(url)
            qs = urllib.parse.parse_qs(parsed_u.query)
            if "username" in qs and "password" in qs:
                prov_type = "xtream"
                server = f"{parsed_u.scheme}://{parsed_u.netloc}"
                username = qs["username"][0]
                password = qs["password"][0]
                stream_format = qs.get("output", [stream_format])[0]
        except Exception as ex:
            app.logger.warning(f"Failed to auto-detect Xtream parameters in update: {ex}")

    if prov_type == "xtream" and not password:
        # The UI never receives the stored password; blank means "keep it"
        existing = next((p for p in load_provider_config(user).get("providers", []) if p.get("name") == orig_name), {})
        password = existing.get("password", "")

    clean_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', new_name.lower())
    if prov_type == "xtream" or (server and username and password):
        if not server or not username or not password:
            return jsonify({"success": False, "error": "Server URL, Username, and Password are all required for Xtream provider."}), 400
        m3u_url = f"/app/stream_iptv/playlists/{clean_slug}.m3u"
        updated_entry = {
            "name": new_name,
            "url": m3u_url,
            "type": "xtream",
            "server": server,
            "username": username,
            "password": password,
            "stream_format": stream_format
        }
    else:
        if not url:
            return jsonify({"success": False, "error": "Provider M3U URL is required."}), 400
        updated_entry = {
            "name": new_name,
            "url": url,
            "type": "m3u"
        }

    config = load_provider_config(user)
    providers = config.get("providers", [])
    found = False
    for i, p in enumerate(providers):
        if (p.get("name") or "").strip().lower() == orig_name.lower():
            providers[i] = updated_entry
            found = True
            break

    if not found:
        return jsonify({"success": False, "error": f"Provider '{orig_name}' not found."}), 404

    save_provider_config(providers=providers, target_user=user)

    # If provider was renamed, update database channel rows and active playlist
    renamed_count = 0
    if orig_name.lower() != new_name.lower():
        try:
            renamed_count = db.rename_provider_channels(orig_name, new_name)
            app.logger.info(f"Renamed provider '{orig_name}' -> '{new_name}' across {renamed_count} channels in DB.")
        except Exception as ren_err:
            app.logger.error(f"Error updating provider name in DB: {ren_err}")

        # Update in active user's playlist.yaml if present
        try:
            p_data = load_playlist(user)
            p_changed = False
            for s in p_data.get("streams", []):
                if (s.get("provider") or "").strip().lower() == orig_name.lower():
                    s["provider"] = new_name
                    p_changed = True
            if p_changed:
                save_playlist(p_data, user)
        except Exception as pl_err:
            app.logger.warning(f"Error updating provider name in playlist.yaml: {pl_err}")

    if fetch_now:
        t = threading.Thread(target=_bg_refresh_provider_db, args=(user, new_name, False), daemon=True)
        t.start()

    return jsonify({
        "success": True,
        "provider": updated_entry,
        "renamed_channels": renamed_count,
        "refresh_started": bool(fetch_now),
        "message": f"Updated provider '{new_name}' successfully." + (" Ingestion started in background." if fetch_now else "")
    })

@app.route("/api/providers/set-primary", methods=["POST"])
def api_set_primary_provider():
    user = get_current_username()
    req_data = request.get_json() or {}
    name = (req_data.get("name") or "").strip()
    if not name:
        return jsonify({"success": False, "error": "Provider name is required"}), 400

    config = load_provider_config(user)
    providers = config.get("providers", [])

    target_idx = next((i for i, p in enumerate(providers) if (p.get("name") or "").strip().lower() == name.lower()), None)
    if target_idx is None:
        return jsonify({"success": False, "error": f"Provider '{name}' not found"}), 404

    target_prov = providers.pop(target_idx)
    providers.insert(0, target_prov)

    save_provider_config(providers=providers, target_user=user)

    global playlist_version
    playlist_version = int(time.time())

    return jsonify({
        "success": True,
        "primary": target_prov.get("name"),
        "message": f"'{target_prov.get('name')}' is now the Primary Provider."
    })

@app.route("/api/providers/remove", methods=["POST"])
def api_remove_provider():
    user = get_current_username()
    req_data = request.get_json() or {}
    name_to_remove = (req_data.get("name") or "").strip()
    if not name_to_remove:
        return jsonify({"success": False, "error": "Provider name is required"}), 400

    config = load_provider_config(user)
    providers = config.get("providers", [])

    new_providers = [p for p in providers if (p.get("name") or "").strip().lower() != name_to_remove.lower()]

    # Clean up associated local playlist files ONLY if no remaining provider references it
    base_dir = os.path.dirname(os.path.abspath(__file__))
    playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    target_prov = next((p for p in providers if (p.get("name") or "").strip().lower() == name_to_remove.lower()), None)
    if target_prov and target_prov.get("url"):
        purl = target_prov["url"]
        if "/playlists/" in purl:
            fname = os.path.basename(purl.split("?")[0])
            still_used = any(fname in (p.get("url") or "") for p in new_providers)
            if not still_used:
                local_m3u = os.path.join(playlists_dir, fname)
                if os.path.exists(local_m3u):
                    try:
                        os.remove(local_m3u)
                        app.logger.info(f"Deleted local playlist file for removed provider: {local_m3u}")
                    except Exception as ex:
                        app.logger.warning(f"Failed to delete {local_m3u}: {ex}")

    clean_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', name_to_remove.lower())
    slug_still_used = any(clean_slug in (p.get("url") or "") or clean_slug == re.sub(r'[^a-zA-Z0-9_-]', '_', (p.get("name") or "").lower()) for p in new_providers)
    if not slug_still_used:
        slug_m3u = os.path.join(playlists_dir, f"{clean_slug}.m3u")
        if os.path.exists(slug_m3u):
            try:
                os.remove(slug_m3u)
                app.logger.info(f"Deleted slug playlist file for removed provider: {slug_m3u}")
            except Exception:
                pass

    # 1. Purge all channels for this provider from database
    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")
    try:
        deleted_count = db.purge_provider_channels(name_to_remove, db_path=db_path)
        app.logger.info(f"Purged {deleted_count} channels for provider '{name_to_remove}'")
    except Exception as e:
        deleted_count = 0
        app.logger.error(f"Error removing provider channels: {e}")

    # 2. Save updated provider list (also syncs config files and purges any other unlisted provider)
    save_provider_config(providers=new_providers, target_user=user)

    global playlist_version
    playlist_version = int(time.time())

    return jsonify({
        "success": True,
        "removed": name_to_remove,
        "deleted_channels": deleted_count,
        "message": f"Removed '{name_to_remove}' and purged all {deleted_count:,} channel(s) from shared database."
    })

@app.route("/api/providers/channels", methods=["GET"])
def api_list_provider_channels():
    provider = (request.args.get("provider") or "").strip()
    q = (request.args.get("q") or "").strip()
    category = (request.args.get("category") or "").strip()
    page = max(1, int(request.args.get("page", 1)))
    per_page = min(200, max(10, int(request.args.get("per_page", 100))))

    if not provider:
        return jsonify({"success": False, "error": "Provider name required"}), 400

    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")

    try:
        data = db.get_provider_channels(provider, q=q, category=category, page=page, per_page=per_page, db_path=db_path)
        data["success"] = True
        data["provider"] = provider
        return jsonify(data)
    except Exception as e:
        app.logger.error(f"Error fetching provider channels for '{provider}': {e}")
        return jsonify({"success": False, "error": str(e)}), 500

def probe_stream_url(url: str, timeout: float = 15.0, retries: int = 1):
    if not url or not url.strip().startswith(('http://', 'https://')):
        return False, 400, "Invalid URL syntax", 0
    clean = sanitize_pluto_url(unmask_credentials(url.strip()))
    provider = provider_of_url(clean)
    if provider_limit(provider):
        with _hubs_lock:
            live = _hubs.get(clean)
        if live and not live.closed:
            return True, 200, "Live now (shared stream)", 0
        if provider_busy(provider):
            # Probing would use the account's only connection and cut off a viewer
            return True, 200, f"Skipped: {provider} connection in use", 0
    opened = []
    try:
        return _probe_stream_url(clean, timeout, retries, opened)
    finally:
        for resp in opened:  # stream=True responses hold the upstream connection until closed
            try:
                resp.close()
            except Exception:
                pass


def _probe_stream_url(url: str, timeout: float, retries: int, opened: list):

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*'
    }

    if isinstance(timeout, (int, float)):
        req_timeout = (min(float(timeout), 8.0), float(timeout))
    else:
        req_timeout = timeout

    if 'youtube.com' in url or 'youtu.be' in url:
        t0 = time.time()
        try:
            watch_url = get_canonical_youtube_watch_url(url)
            oembed_url = f"https://www.youtube.com/oembed?url={watch_url}&format=json"
            r = http_pool.get(oembed_url, headers=headers, timeout=req_timeout)
            lat = int((time.time() - t0) * 1000)
            if r.status_code == 200:
                return True, 200, "YouTube Live/Public", lat
            return False, r.status_code, f"YouTube {r.status_code}", lat
        except requests.exceptions.Timeout:
            return False, 408, "YouTube Timeout", int((time.time() - t0) * 1000)
        except Exception as e:
            return False, 500, f"YouTube Error: {str(e)[:40]}", 0

    for attempt in range(retries + 1):
        t0 = time.time()
        try:
            r = http_pool.get(url, headers=headers, timeout=req_timeout, allow_redirects=True, stream=True, verify=False)
            opened.append(r)
            lat = int((time.time() - t0) * 1000)

            if r.status_code in (429, 503, 408) and attempt < retries:
                time.sleep(1.2)
                continue

            if r.status_code not in (200, 206):
                return False, r.status_code, f"HTTP {r.status_code}", lat

            raw_chunk = next(r.iter_content(2048), b'')
            chunk_str = raw_chunk.decode('utf-8', errors='ignore')
            ct = r.headers.get('content-type', '').lower()

            if '#EXTM3U' in chunk_str or '#EXTINF' in chunk_str or '#EXT-X-' in chunk_str:
                return True, 200, "Valid HLS Manifest", lat
            elif '<mpd' in chunk_str.lower() or 'dash' in ct or url.endswith('.mpd'):
                return True, 200, "DASH Stream OK", lat
            elif ct.startswith(('video/', 'audio/', 'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'binary/octet-stream', 'application/octet-stream')):
                return True, 200, f"Stream OK ({ct.split(';')[0]})", lat
            elif len(raw_chunk) > 0 and raw_chunk[0] == 0x47:
                return True, 200, "MPEG-TS Stream OK", lat
            elif '<!doctype html' in chunk_str.lower() or '<html' in chunk_str.lower():
                return False, 200, "HTML Block/Paywall", lat
            elif len(raw_chunk) > 0:
                return True, 200, "Stream Data OK", lat
            else:
                if attempt < retries:
                    time.sleep(1.0)
                    continue
                return False, 204, "Empty Stream", lat

        except requests.exceptions.Timeout:
            if attempt < retries:
                time.sleep(1.0)
                continue
            return False, 408, "Connect Timeout", int((time.time() - t0) * 1000)
        except requests.exceptions.SSLError:
            return False, 526, "SSL Certificate Error", int((time.time() - t0) * 1000)
        except requests.exceptions.ConnectionError:
            if attempt < retries:
                time.sleep(1.0)
                continue
            return False, 503, "Host Unreachable", int((time.time() - t0) * 1000)
        except Exception as e:
            if attempt < retries:
                time.sleep(1.0)
                continue
            return False, 500, str(e)[:45], int((time.time() - t0) * 1000)

@app.route("/api/channels/verify", methods=["POST"])
def api_verify_single_channel():
    data = request.get_json() or {}
    ch_id = data.get("id")
    url = data.get("url", "").strip()
    force_playable = data.get("force_playable")

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    if force_playable is not None:
        is_playable = 1 if force_playable else 0
        lat = int(data.get("latency_ms", 150))
        msg = "Player Confirmed Live" if is_playable else "Player Confirmed Offline"
    else:
        ok, code, msg, lat = probe_stream_url(url, timeout=18.0, retries=1)
        is_playable = 1 if ok else 0

    if db.is_postgres():
        with db.get_db_cursor(commit=True) as (cur, _):
            if ch_id and not url:
                cur.execute("SELECT url FROM channels WHERE id = %s", (ch_id,))
                row = cur.fetchone()
                if not row:
                    return jsonify({"success": False, "error": "Channel not found"}), 404
                url = row[0]
            if ch_id:
                cur.execute("""
                    UPDATE channels 
                    SET is_playable = %s, latency_ms = %s, last_checked = %s, error_msg = %s
                    WHERE id = %s
                """, (is_playable, lat, now, msg, ch_id))
    else:
        import sqlite3
        default_path = get_playlist_path("default")
        db_path = os.path.join(os.path.dirname(default_path), "channels.db")
        if not os.path.exists(db_path):
            return jsonify({"success": False, "error": "Database not initialized"}), 500

        conn = sqlite3.connect(db_path, timeout=10.0)
        cursor = conn.cursor()
        if ch_id and not url:
            cursor.execute("SELECT url FROM channels WHERE id = ?", (ch_id,))
            row = cursor.fetchone()
            if not row:
                conn.close()
                return jsonify({"success": False, "error": "Channel not found"}), 404
            url = row[0]

        if ch_id:
            cursor.execute("""
                UPDATE channels 
                SET is_playable = ?, latency_ms = ?, last_checked = ?, error_msg = ?
                WHERE id = ?
            """, (is_playable, lat, now, msg, ch_id))
            conn.commit()
        conn.close()

    return jsonify({
        "success": True,
        "id": ch_id,
        "is_playable": is_playable,
        "latency_ms": lat,
        "last_checked": now,
        "error_msg": msg
    })

@app.route("/api/channels/verify_batch", methods=["POST"])
def api_verify_batch_channels():
    data = request.get_json() or {}
    ch_ids = data.get("ids", [])
    if not isinstance(ch_ids, list) or not ch_ids:
        return jsonify({"success": False, "error": "ids list required"}), 400

    ch_ids = ch_ids[:100]  # Max 100 per batch request

    channels_to_check = []
    if db.is_postgres():
        with db.get_db_cursor() as (cur, _):
            cur.execute("SELECT id, url, name FROM channels WHERE id = ANY(%s)", (ch_ids,))
            channels_to_check = cur.fetchall()
    else:
        import sqlite3
        default_path = get_playlist_path("default")
        db_path = os.path.join(os.path.dirname(default_path), "channels.db")
        if not os.path.exists(db_path):
            return jsonify({"success": False, "error": "Database not initialized"}), 500
        conn = sqlite3.connect(db_path, timeout=10.0)
        cursor = conn.cursor()
        placeholders = ",".join("?" for _ in ch_ids)
        cursor.execute(f"SELECT id, url, name FROM channels WHERE id IN ({placeholders})", ch_ids)
        channels_to_check = cursor.fetchall()
        conn.close()

    results = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    updates = []

    from concurrent.futures import ThreadPoolExecutor

    def check_one(item):
        cid, url, name = item
        ok, code, msg, lat = probe_stream_url(url, timeout=15.0, retries=1)
        return (cid, 1 if ok else 0, lat, now, msg)

    with ThreadPoolExecutor(max_workers=5) as executor:
        for res in executor.map(check_one, channels_to_check):
            updates.append(res)
            results.append({
                "id": res[0],
                "is_playable": res[1],
                "latency_ms": res[2],
                "last_checked": res[3],
                "error_msg": res[4]
            })

    if updates:
        if db.is_postgres():
            with db.get_db_cursor(commit=True) as (cur, _):
                for u in updates:
                    cur.execute("""
                        UPDATE channels 
                        SET is_playable = %s, latency_ms = %s, last_checked = %s, error_msg = %s
                        WHERE id = %s
                    """, (u[1], u[2], u[3], u[4], u[0]))
        else:
            default_path = get_playlist_path("default")
            db_path = os.path.join(os.path.dirname(default_path), "channels.db")
            conn = sqlite3.connect(db_path, timeout=10.0)
            conn.executemany("""
                UPDATE channels 
                SET is_playable = ?, latency_ms = ?, last_checked = ?, error_msg = ?
                WHERE id = ?
            """, [(u[1], u[2], u[3], u[4], u[0]) for u in updates])
            conn.commit()
            conn.close()

    return jsonify({
        "success": True,
        "count": len(results),
        "results": results
    })

@app.route("/api/channels/verify_all", methods=["GET"])
def api_verify_all_channels():
    """
    SSE endpoint: streams verification progress for all channels, provider-by-provider.
    Query params:
      - provider: optional, limit to a single provider name
      - workers: int, default 8
      - timeout: float, default 15.0
      - force: 1 to re-verify already-checked channels
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed

    filter_provider = request.args.get("provider", "").strip()
    workers = min(int(request.args.get("workers", 8)), 16)
    timeout = min(float(request.args.get("timeout", 15.0)), 25.0)
    force = request.args.get("force", "0") == "1"

    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")
    use_pg = db.is_postgres()

    def generate():
        import json as _json

        def sse(event, data):
            return f"event: {event}\ndata: {_json.dumps(data)}\n\n"

        if not use_pg and not os.path.exists(db_path):
            yield sse("error", {"message": "channels.db not found"})
            return

        # Fetch providers to scan
        try:
            if use_pg:
                with db.get_db_cursor() as (cursor, _):
                    if filter_provider:
                        cursor.execute(
                            "SELECT DISTINCT provider FROM channels WHERE LOWER(TRIM(provider)) = LOWER(TRIM(%s))",
                            (filter_provider,)
                        )
                    else:
                        cursor.execute("SELECT DISTINCT provider FROM channels ORDER BY provider ASC")
                    providers = [r[0] for r in cursor.fetchall() if r[0]]
            else:
                import sqlite3
                conn = sqlite3.connect(db_path, timeout=30.0)
                conn.execute("PRAGMA journal_mode=WAL;")
                conn.execute("PRAGMA busy_timeout=30000;")
                cursor = conn.cursor()
                if filter_provider:
                    cursor.execute(
                        "SELECT DISTINCT provider FROM channels WHERE LOWER(TRIM(provider)) = LOWER(TRIM(?))",
                        (filter_provider,)
                    )
                else:
                    cursor.execute("SELECT DISTINCT provider FROM channels ORDER BY provider ASC")
                providers = [r[0] for r in cursor.fetchall() if r[0]]
                conn.close()
        except Exception as e:
            yield sse("error", {"message": str(e)})
            return

        # Count totals per provider
        total_all = 0
        provider_totals = {}
        try:
            if use_pg:
                with db.get_db_cursor() as (cursor, _):
                    for prov in providers:
                        where = "WHERE LOWER(TRIM(provider)) = LOWER(TRIM(%s))"
                        if not force:
                            where += " AND is_playable IS NULL"
                        cursor.execute(f"SELECT count(*) FROM channels {where}", (prov,))
                        cnt = cursor.fetchone()[0]
                        provider_totals[prov] = cnt
                        total_all += cnt
            else:
                import sqlite3
                conn = sqlite3.connect(db_path, timeout=30.0)
                conn.execute("PRAGMA busy_timeout=30000;")
                cursor = conn.cursor()
                for prov in providers:
                    where = "WHERE LOWER(TRIM(provider)) = LOWER(TRIM(?))"
                    if not force:
                        where += " AND is_playable IS NULL"
                    cursor.execute(f"SELECT count(*) FROM channels {where}", (prov,))
                    cnt = cursor.fetchone()[0]
                    provider_totals[prov] = cnt
                    total_all += cnt
                conn.close()
        except Exception as e:
            yield sse("error", {"message": str(e)})
            return

        yield sse("start", {
            "total": total_all,
            "providers": providers,
            "provider_totals": provider_totals
        })

        completed_all = 0
        live_all = 0
        dead_all = 0

        for prov in providers:
            prov_total = provider_totals.get(prov, 0)
            if prov_total == 0:
                yield sse("provider_skip", {"provider": prov, "reason": "already verified"})
                continue

            yield sse("provider_start", {"provider": prov, "total": prov_total})

            # Fetch channels for this provider
            try:
                if use_pg:
                    with db.get_db_cursor() as (cursor, _):
                        where = "WHERE LOWER(TRIM(provider)) = LOWER(TRIM(%s))"
                        if not force:
                            where += " AND is_playable IS NULL"
                        cursor.execute(
                            f"SELECT id, name, url FROM channels {where} ORDER BY id ASC",
                            (prov,)
                        )
                        rows = cursor.fetchall()
                else:
                    import sqlite3
                    conn = sqlite3.connect(db_path, timeout=30.0)
                    conn.execute("PRAGMA busy_timeout=30000;")
                    cursor = conn.cursor()
                    where = "WHERE LOWER(TRIM(provider)) = LOWER(TRIM(?))"
                    if not force:
                        where += " AND is_playable IS NULL"
                    cursor.execute(
                        f"SELECT id, name, url FROM channels {where} ORDER BY id ASC",
                        (prov,)
                    )
                    rows = cursor.fetchall()
                    conn.close()
            except Exception as e:
                yield sse("provider_error", {"provider": prov, "message": str(e)})
                continue

            prov_live = 0
            prov_dead = 0
            prov_done = 0
            batch_updates = []

            def _check(item):
                ch_id, ch_name, url = item
                ok, code, msg, lat = probe_stream_url(url, timeout=timeout)
                now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                return (ch_id, 1 if ok else 0, lat, now, msg, ch_name, ok)

            chunk_size = max(200, workers * 10)
            for chunk_start in range(0, len(rows), chunk_size):
                chunk = rows[chunk_start:chunk_start + chunk_size]
                with ThreadPoolExecutor(max_workers=workers) as executor:
                    futures = {executor.submit(_check, row): row for row in chunk}
                    for future in as_completed(futures):
                        try:
                            ch_id, is_playable, lat, now, msg, ch_name, ok = future.result()
                        except Exception:
                            continue

                        if ok:
                            prov_live += 1
                            live_all += 1
                        else:
                            prov_dead += 1
                            dead_all += 1

                        prov_done += 1
                        completed_all += 1
                        batch_updates.append((is_playable, lat, now, msg, ch_id))

                        # Flush DB every 100 results
                        if len(batch_updates) >= 100:
                            try:
                                if use_pg:
                                    with db.get_db_cursor(commit=True) as (cur, _):
                                        for u in batch_updates:
                                            cur.execute(
                                                "UPDATE channels SET is_playable=%s, latency_ms=%s, last_checked=%s, error_msg=%s WHERE id=%s",
                                                u
                                            )
                                else:
                                    import sqlite3
                                    c2 = sqlite3.connect(db_path, timeout=30.0)
                                    c2.execute("PRAGMA busy_timeout=30000;")
                                    c2.executemany(
                                        "UPDATE channels SET is_playable=?, latency_ms=?, last_checked=?, error_msg=? WHERE id=?",
                                        batch_updates
                                    )
                                    c2.commit()
                                    c2.close()
                            except Exception:
                                pass
                            batch_updates.clear()

                        # Emit progress every 50 completed
                        if prov_done % 50 == 0 or prov_done == prov_total:
                            yield sse("progress", {
                                "provider": prov,
                                "prov_done": prov_done,
                                "prov_total": prov_total,
                                "prov_live": prov_live,
                                "prov_dead": prov_dead,
                                "total_done": completed_all,
                                "total": total_all,
                                "live": live_all,
                                "dead": dead_all
                            })

            # Flush remaining
            if batch_updates:
                try:
                    if use_pg:
                        with db.get_db_cursor(commit=True) as (cur, _):
                            for u in batch_updates:
                                cur.execute(
                                    "UPDATE channels SET is_playable=%s, latency_ms=%s, last_checked=%s, error_msg=%s WHERE id=%s",
                                    u
                                )
                    else:
                        import sqlite3
                        c2 = sqlite3.connect(db_path, timeout=30.0)
                        c2.execute("PRAGMA busy_timeout=30000;")
                        c2.executemany(
                            "UPDATE channels SET is_playable=?, latency_ms=?, last_checked=?, error_msg=? WHERE id=?",
                            batch_updates
                        )
                        c2.commit()
                        c2.close()
                except Exception:
                    pass

            yield sse("provider_done", {
                "provider": prov,
                "live": prov_live,
                "dead": prov_dead,
                "total": prov_total
            })

        yield sse("done", {
            "total": total_all,
            "live": live_all,
            "dead": dead_all,
            "completed": completed_all
        })

    return app.response_class(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


def redact_provider_config(config):
    """Copy of a provider config without provider passwords (kept server-side only)."""
    clean = dict(config)
    clean["providers"] = [{k: v for k, v in p.items() if k != "password"} for p in config.get("providers", [])]
    return clean


@app.route("/api/provider/config", methods=["GET"])
def api_get_provider_config():
    user = get_current_username()
    return jsonify(redact_provider_config(load_provider_config(user)))

@app.route("/api/provider/config", methods=["POST"])
def api_save_provider_config():
    user = get_current_username()
    req_data = request.get_json() or {}
    url = req_data.get("url", "").strip()
    url2 = req_data.get("url2", "").strip()
    p1_name = req_data.get("provider1_name", "Primary Provider").strip()
    p2_name = req_data.get("provider2_name", "Secondary Provider").strip()
    is_custom = req_data.get("is_custom", True)
    if not url or url == DEFAULT_PROVIDER_URL:
        if not url2:
            is_custom = False
        url = DEFAULT_PROVIDER_URL
    saved = save_provider_config(url=url, url2=url2, provider1_name=p1_name, provider2_name=p2_name, is_custom=is_custom, target_user=user)
    return jsonify({"success": True, "config": redact_provider_config(saved)})

@app.route("/api/provider/reset", methods=["POST"])
def api_reset_provider_config():
    user = get_current_username()
    saved = save_provider_config(url=DEFAULT_PROVIDER_URL, url2="", provider1_name="Primary Provider", provider2_name="Secondary Provider", is_custom=False, target_user=user)
    # Also clean up non-default channels from channels table if requested
    if db.is_postgres():
        try:
            with db.get_db_cursor(commit=True) as (cur, _):
                cur.execute("DELETE FROM channels WHERE provider IS NOT NULL AND provider != 'Primary Provider'")
        except Exception as e:
            app.logger.error(f"Error resetting provider channels in PostgreSQL: {e}")
    else:
        import sqlite3
        default_path = get_playlist_path("default")
        db_path = os.path.join(os.path.dirname(default_path), "channels.db")
        if os.path.exists(db_path):
            try:
                conn = sqlite3.connect(db_path, timeout=30.0)
                conn.execute("PRAGMA busy_timeout=30000;")
                cursor = conn.cursor()
                cursor.execute("DELETE FROM channels WHERE provider IS NOT NULL AND provider != 'Primary Provider'")
                conn.commit()
                conn.close()
            except Exception as e:
                app.logger.error(f"Error resetting provider channels: {e}")
    return jsonify({"success": True, "config": saved})

PROVIDER_REFRESH_META_PATH = os.path.join(os.path.dirname(get_playlist_path("default")), "provider_refresh_meta.json")

def _load_persisted_refresh_state():
    state = {
        "status": "idle",
        "progress": "",
        "total_channels": 0,
        "updated_playlist_streams": 0,
        "results_summary": [],
        "message": "",
        "error": None,
        "started_at": 0,
        "finished_at": 0,
        "last_success_at": 0,
        "last_error": None,
        "last_error_at": 0
    }
    try:
        if os.path.exists(PROVIDER_REFRESH_META_PATH):
            with open(PROVIDER_REFRESH_META_PATH, "r", encoding="utf-8") as f:
                saved = json.load(f)
                state.update(saved)
            # Migrate older meta files that predate the last_success/last_error fields
            if not state.get("last_success_at") and state.get("status") == "completed" and state.get("finished_at"):
                state["last_success_at"] = state["finished_at"]
            if not state.get("last_error") and state.get("error"):
                state["last_error"] = state["error"]
                state["last_error_at"] = state.get("finished_at") or 0
        else:
            db_path = os.path.join(os.path.dirname(PROVIDER_REFRESH_META_PATH), "channels.db")
            if os.path.exists(db_path):
                state["finished_at"] = os.path.getmtime(db_path)
                state["last_success_at"] = state["finished_at"]
                state["status"] = "completed"
    except Exception:
        pass
    # A run can never still be "running" after a process restart
    if state.get("status") == "running":
        state["status"] = "error"
        state["error"] = "Previous refresh was interrupted by a service restart."
        state["last_error"] = state["error"]
        state["last_error_at"] = time.time()
        state["finished_at"] = state.get("finished_at") or time.time()
    return state

PROVIDER_REFRESH_STATE = _load_persisted_refresh_state()
PLAYLIST_EDIT_LOCK = {
    "locked": False,
    "user": None,
    "client_id": None,
    "expires_at": 0,
    "reason": ""
}
PLAYLIST_EDIT_LOCK_MUTEX = threading.Lock()

def is_playlist_editing_locked(exclude_client_id=None):
    with PLAYLIST_EDIT_LOCK_MUTEX:
        if not PLAYLIST_EDIT_LOCK["locked"]:
            lockfile = "/tmp/stream_iptv_editing.lock"
            if os.path.exists(lockfile):
                try:
                    with open(lockfile, "r") as f:
                        data = json.load(f)
                        if data.get("locked") and data.get("expires_at", 0) > time.time():
                            if exclude_client_id and data.get("client_id") == exclude_client_id:
                                return False
                            return True
                except Exception:
                    pass
            return False
        if time.time() > PLAYLIST_EDIT_LOCK["expires_at"]:
            PLAYLIST_EDIT_LOCK["locked"] = False
            return False
        if exclude_client_id and PLAYLIST_EDIT_LOCK.get("client_id") == exclude_client_id:
            return False
        return True

def set_playlist_editing_lock(user=ADMIN_USERNAME, client_id=None, duration=900, reason="User is editing channels in UI"):
    with PLAYLIST_EDIT_LOCK_MUTEX:
        PLAYLIST_EDIT_LOCK.update({
            "locked": True,
            "user": user,
            "client_id": client_id,
            "expires_at": time.time() + duration,
            "reason": reason
        })
        try:
            with open("/tmp/stream_iptv_editing.lock", "w") as f:
                json.dump(PLAYLIST_EDIT_LOCK, f)
        except Exception:
            pass

def release_playlist_editing_lock(client_id=None, force=False):
    with PLAYLIST_EDIT_LOCK_MUTEX:
        if force or not client_id or PLAYLIST_EDIT_LOCK.get("client_id") == client_id:
            PLAYLIST_EDIT_LOCK["locked"] = False
            PLAYLIST_EDIT_LOCK["expires_at"] = 0
            try:
                if os.path.exists("/tmp/stream_iptv_editing.lock"):
                    os.remove("/tmp/stream_iptv_editing.lock")
            except Exception:
                pass

PROVIDER_REFRESH_LOCK = threading.Lock()


def _bg_refresh_provider_db(user, target_provider=None, update_playlist=False):
    with PROVIDER_REFRESH_LOCK:
        PROVIDER_REFRESH_STATE.update({
            "status": "running",
            "progress": "Starting database sync...",
            "total_channels": 0,
            "updated_playlist_streams": 0,
            "results_summary": [],
            "message": "",
            "error": None,
            "started_at": time.time(),
            "finished_at": 0
        })
        try:
            with open(PROVIDER_REFRESH_META_PATH, "w", encoding="utf-8") as f:
                json.dump(PROVIDER_REFRESH_STATE, f, indent=2)
        except Exception:
            pass

    try:
        config = load_provider_config(user)
        all_providers = config.get("providers", [])
        if not all_providers:
            all_providers = [{"name": "Primary Provider", "url": DEFAULT_PROVIDER_URL}]

        providers_to_sync = []
        if target_provider:
            for p in all_providers:
                if p.get("name") == target_provider:
                    providers_to_sync.append(p)
        else:
            for p in all_providers:
                p_url = (p.get("url") or "").strip()
                p_server = (p.get("server") or "").strip()
                if p_url or p_server:
                    providers_to_sync.append(p)

        if not providers_to_sync:
            providers_to_sync.append({"name": "Primary Provider", "url": DEFAULT_PROVIDER_URL})

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }

        default_path = get_playlist_path("default")
        db_path = os.path.join(os.path.dirname(default_path), "channels.db")

        import sqlite3
        import re

        use_pg = db.is_postgres()
        conn = None
        cursor = None
        if not use_pg:
            conn = sqlite3.connect(db_path, timeout=60.0)
            try:
                conn.execute("PRAGMA journal_mode=WAL;")
            except Exception:
                pass
            cursor = conn.cursor()
            ensure_db_tables(conn)
        else:
            db.ensure_schema()

        total_count = 0
        results_summary = []
        has_success = False
        num_providers = len(providers_to_sync)

        for prov_idx, prov in enumerate(providers_to_sync, 1):
            prov_name = (prov.get("name") or "Provider").strip()
            prov_type = (prov.get("type") or "m3u").strip().lower()
            server = (prov.get("server") or "").strip().rstrip("/")
            username = (prov.get("username") or "").strip()
            password = (prov.get("password") or "").strip()
            stream_format = (prov.get("stream_format") or "ts").strip().lower()
            prov_url = (prov.get("url") or "").strip()

            # Auto-detect Xtream get.php or player_api.php URLs when prov_type wasn't explicitly set to xtream
            if (not (server and username and password)) and prov_url and ("get.php" in prov_url or "player_api.php" in prov_url):
                try:
                    import urllib.parse
                    parsed_u = urllib.parse.urlparse(prov_url)
                    qs = urllib.parse.parse_qs(parsed_u.query)
                    if "username" in qs and "password" in qs:
                        server = f"{parsed_u.scheme}://{parsed_u.netloc}"
                        username = qs["username"][0]
                        password = qs["password"][0]
                        stream_format = qs.get("output", [stream_format])[0]
                        prov_type = "xtream"
                except Exception as ex:
                    app.logger.warning(f"Failed to auto-detect Xtream parameters from {prov_url}: {ex}")

            with PROVIDER_REFRESH_LOCK:
                PROVIDER_REFRESH_STATE["progress"] = f"[{prov_idx}/{num_providers}] Fetching {prov_name}..."

            file_handle = None
            try:
                if prov_type == "xtream" or (server and username and password):
                    app.logger.info(f"Syncing Xtream provider {prov_name}: {server}")
                    with PROVIDER_REFRESH_LOCK:
                        PROVIDER_REFRESH_STATE["progress"] = f"[{prov_idx}/{num_providers}] Querying Xtream API for {prov_name}..."
                    batch, m3u_path = sync_xtream_provider(prov_name, server, username, password, stream_format=stream_format, write_m3u=True)
                    db.purge_provider_channels(prov_name, db_path=db_path)
                    for i in range(0, len(batch), 10000):
                        db.insert_channels_batch(batch[i:i+10000], db_path=db_path)
                    prov_count = len(batch)

                    # Persist local playlist path and xtream metadata in provider configuration
                    clean_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', prov_name.lower())
                    expected_m3u_url = f"/app/stream_iptv/playlists/{clean_slug}.m3u"
                    if prov.get("url") != expected_m3u_url or prov.get("type") != "xtream":
                        try:
                            cfg = load_provider_config(user)
                            cfg_provs = cfg.get("providers", [])
                            for cp in cfg_provs:
                                if cp.get("name") == prov_name:
                                    cp["url"] = expected_m3u_url
                                    cp["type"] = "xtream"
                                    cp["server"] = server
                                    cp["username"] = username
                                    cp["password"] = password
                                    cp["stream_format"] = stream_format
                            save_provider_config(providers=cfg_provs, target_user=user)
                        except Exception as update_err:
                            app.logger.warning(f"Could not update provider entry in config: {update_err}")
                else:
                    app.logger.info(f"Fetching M3U for {prov_name}: {prov_url}")
                    lines_iter = None
                    clean_url = prov_url.strip()
                    if clean_url.startswith("file://") or clean_url.startswith("/"):
                        file_path = clean_url[7:] if clean_url.startswith("file://") else clean_url
                        if not os.path.isabs(file_path):
                            base_d = os.path.dirname(os.path.abspath(__file__))
                            file_path = os.path.join(PLAYLIST_ROOT, "playlists", file_path)
                        if not os.path.isfile(file_path):
                            base_d = os.path.dirname(os.path.abspath(__file__))
                            alt_path = os.path.join(PLAYLIST_ROOT, "playlists", os.path.basename(file_path))
                            if os.path.isfile(alt_path):
                                file_path = alt_path
                            else:
                                results_summary.append(f"{prov_name} (File not found)")
                                continue
                        file_handle = open(file_path, "r", encoding="utf-8", errors="ignore")
                        lines_iter = (l.strip() for l in file_handle)
                    else:
                        r = requests.get(clean_url, headers=headers, stream=True, timeout=60)
                        if r.status_code != 200:
                            # Check if the URL was an Xtream URL blocked by upstream CDN proxy (e.g. HTTP 884)
                            import urllib.parse
                            parsed_u = urllib.parse.urlparse(clean_url)
                            qs = urllib.parse.parse_qs(parsed_u.query)
                            if "username" in qs and "password" in qs:
                                app.logger.info(f"HTTP {r.status_code} received on get.php for {prov_name}. Falling back to Xtream player_api.php sync...")
                                fb_server = f"{parsed_u.scheme}://{parsed_u.netloc}"
                                fb_user = qs["username"][0]
                                fb_pass = qs["password"][0]
                                fb_format = qs.get("output", [stream_format])[0]
                                batch, _ = sync_xtream_provider(prov_name, fb_server, fb_user, fb_pass, stream_format=fb_format, write_m3u=True)
                                db.purge_provider_channels(prov_name, db_path=db_path)
                                for i in range(0, len(batch), 10000):
                                    db.insert_channels_batch(batch[i:i+10000], db_path=db_path)
                                prov_count = len(batch)
                                total_count += prov_count
                                has_success = True
                                results_summary.append(f"{prov_name}: {prov_count:,} channels (via Xtream fallback)")
                                continue
                            else:
                                results_summary.append(f"{prov_name} (HTTP {r.status_code})")
                                continue
                        lines_iter = (line.decode("utf-8", errors="ignore").strip() for line in r.iter_lines(chunk_size=4096) if line)

                    db.purge_provider_channels(prov_name, db_path=db_path)

                    batch = []
                    current_name = None
                    current_category = None
                    current_tvg_id = None
                    current_logo = None
                    prov_count = 0

                    for line_str in lines_iter:
                        if not line_str:
                            continue

                        if line_str.startswith("#EXTINF:"):
                            parts = line_str.split(",")
                            current_name = parts[-1].strip() if len(parts) > 1 else "Unknown Channel"

                            group_match = re.search(r'group-title="([^"]+)"', line_str)
                            current_category = group_match.group(1).strip() if group_match else None

                            tvg_id_match = re.search(r'tvg-id="([^"]+)"', line_str)
                            current_tvg_id = tvg_id_match.group(1).strip() if tvg_id_match else None

                            logo_match = re.search(r'tvg-logo="([^"]+)"', line_str)
                            current_logo = logo_match.group(1).strip() if logo_match else None
                        elif line_str.startswith("http"):
                            if current_name:
                                batch.append((current_name, line_str, current_category, current_tvg_id, current_logo, prov_name))
                                current_name = None
                                current_category = None
                                current_tvg_id = None
                                current_logo = None
                                prov_count += 1

                            if len(batch) >= 10000:
                                db.insert_channels_batch(batch, db_path=db_path)
                                batch = []
                                with PROVIDER_REFRESH_LOCK:
                                    PROVIDER_REFRESH_STATE["progress"] = f"[{prov_idx}/{num_providers}] {prov_name}: parsed {prov_count:,} channels..."

                    if batch:
                        db.insert_channels_batch(batch, db_path=db_path)

                total_count += prov_count
                has_success = True
                results_summary.append(f"{prov_name}: {prov_count:,} channels")
            except Exception as prov_err:
                app.logger.error(f"Error fetching provider {prov_name}: {prov_err}")
                results_summary.append(f"{prov_name} error: {prov_err}")
            finally:
                if file_handle:
                    try:
                        file_handle.close()
                    except Exception:
                        pass

        if not has_success:
            if conn:
                conn.close()
            with PROVIDER_REFRESH_LOCK:
                PROVIDER_REFRESH_STATE.update({
                    "status": "error",
                    "error": "; ".join(results_summary),
                    "finished_at": time.time()
                })
            return

        with PROVIDER_REFRESH_LOCK:
            PROVIDER_REFRESH_STATE["progress"] = "Indexing channels..."

        if not use_pg and cursor and conn:
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_channel_name ON channels(name)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_channel_category ON channels(category)")
            cursor.execute("CREATE INDEX IF NOT EXISTS idx_channel_provider ON channels(provider)")
            conn.commit()
            conn.close()

        # Update active user's playlist streams using fresh shared IPTV database URLs (only if explicitly requested and not locked)
        updated_playlist_count = 0
        if update_playlist:
            if is_playlist_editing_locked():
                app.logger.info("[Provider Refresh] Skipping playlist.yaml URL sync: User edit lock active in web UI.")
            else:
                playlist_data = load_playlist(user)
                streams = playlist_data.get("streams", [])
                if streams:
                    with PROVIDER_REFRESH_LOCK:
                        PROVIDER_REFRESH_STATE["progress"] = "Updating playlist streams with fresh provider URLs..."
                    stream_names = [s.get("name") for s in streams if s.get("name")]
                    if stream_names:
                        channel_map = {}
                        if use_pg:
                            with db.get_db_cursor() as (pg_cur, _):
                                pg_cur.execute("SELECT name, url, logo FROM channels WHERE name = ANY(%s)", (stream_names,))
                                channel_map = {row[0]: (row[1], row[2]) for row in pg_cur.fetchall()}
                        elif cursor:
                            placeholders = ",".join("?" for _ in stream_names)
                            cursor.execute(f"SELECT name, url, logo FROM channels WHERE name IN ({placeholders})", stream_names)
                            channel_map = {row[0]: (row[1], row[2]) for row in cursor.fetchall()}

                        for s in streams:
                            s_name = s.get("name")
                            if s_name and s_name in channel_map:
                                new_url, new_logo = channel_map[s_name]
                                changed = False
                                if new_url and s.get("url") != new_url:
                                    s["url"] = new_url
                                    changed = True
                                if new_logo and not s.get("logo"):
                                    s["logo"] = new_logo
                                    changed = True
                                if changed:
                                    updated_playlist_count += 1

                        if updated_playlist_count > 0:
                            playlist_data["streams"] = streams
                            save_playlist(playlist_data, user)
                            global playlist_version
                            playlist_version = int(time.time())

        if conn:
            try:
                conn.close()
            except Exception:
                pass

        summary_str = " | ".join(results_summary)
        success_msg = f"Refreshed shared IPTV database ({total_count:,} total channels from {summary_str}). Updated {updated_playlist_count} playlist stream(s)."

        with PROVIDER_REFRESH_LOCK:
            PROVIDER_REFRESH_STATE.update({
                "status": "completed",
                "total_channels": total_count,
                "updated_playlist_streams": updated_playlist_count,
                "results_summary": results_summary,
                "message": success_msg,
                "progress": "Completed",
                "finished_at": time.time(),
                "last_success_at": time.time()
            })
            try:
                with open(PROVIDER_REFRESH_META_PATH, "w", encoding="utf-8") as f:
                    json.dump(PROVIDER_REFRESH_STATE, f, indent=2)
            except Exception:
                pass
    except Exception as e:
        app.logger.error(f"Error in background IPTV refresh: {e}")
        with PROVIDER_REFRESH_LOCK:
            PROVIDER_REFRESH_STATE.update({
                "status": "error",
                "error": str(e),
                "last_error": str(e),
                "last_error_at": time.time(),
                "finished_at": time.time()
            })
            try:
                with open(PROVIDER_REFRESH_META_PATH, "w", encoding="utf-8") as f:
                    json.dump(PROVIDER_REFRESH_STATE, f, indent=2)
            except Exception:
                pass


@app.route("/api/provider/refresh-status", methods=["GET"])
def api_provider_refresh_status():
    with PROVIDER_REFRESH_LOCK:
        return jsonify(dict(PROVIDER_REFRESH_STATE))


@app.route("/api/provider/refresh-db", methods=["POST"])
def api_refresh_provider_db():
    user = get_current_username() or ADMIN_USERNAME
    req_data = request.get_json(silent=True) or {}
    target_provider = req_data.get("name") or request.args.get("name")
    is_sync = request.args.get("sync", "").lower() in ("1", "true")
    update_playlist = bool(req_data.get("update_playlist", False) or request.args.get("update_playlist", "").lower() in ("1", "true"))

    with PROVIDER_REFRESH_LOCK:
        if PROVIDER_REFRESH_STATE["status"] == "running":
            return jsonify({
                "success": True,
                "status": "running",
                "message": "Database refresh is already in progress.",
                "progress": PROVIDER_REFRESH_STATE.get("progress", "")
            })

    if is_sync:
        _bg_refresh_provider_db(user, target_provider, update_playlist=update_playlist)
        with PROVIDER_REFRESH_LOCK:
            if PROVIDER_REFRESH_STATE["status"] == "completed":
                return jsonify({
                    "success": True,
                    "status": "completed",
                    "total_channels": PROVIDER_REFRESH_STATE["total_channels"],
                    "updated_playlist_streams": PROVIDER_REFRESH_STATE["updated_playlist_streams"],
                    "message": PROVIDER_REFRESH_STATE["message"]
                })
            else:
                return jsonify({
                    "success": False,
                    "status": "error",
                    "error": PROVIDER_REFRESH_STATE.get("error", "Failed to sync IPTV database")
                }), 500

    # Default: launch asynchronous background thread
    t = threading.Thread(target=_bg_refresh_provider_db, args=(user, target_provider, update_playlist), daemon=True)
    t.start()

    return jsonify({
        "success": True,
        "status": "started",
        "message": "IPTV database refresh started in background."
    })


@app.route("/api/provider/upload-m3u", methods=["POST"])
def api_upload_m3u_provider():
    user = get_current_username()

    # Get uploaded files (support both 'files' and 'file' form fields, multiple files)
    uploaded_files = request.files.getlist("files")
    if not uploaded_files:
        uploaded_files = request.files.getlist("file")
    uploaded_files = [f for f in uploaded_files if f and f.filename]
    if not uploaded_files:
        return jsonify({"success": False, "error": "No M3U files uploaded"}), 400

    mode = (request.form.get("mode") or "separate").strip().lower()  # 'separate' or 'merged'
    target_provider_name = (request.form.get("provider_name") or "").strip()

    base_dir = os.path.dirname(os.path.abspath(__file__))
    playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    os.makedirs(playlists_dir, exist_ok=True)

    cfg = load_provider_config(user)
    existing_provs = cfg.get("providers", [])

    results = []
    total_imported_channels = 0

    if mode == "merged" or (len(uploaded_files) == 1 and target_provider_name):
        # Single provider list for all uploaded files
        prov_name = target_provider_name
        if not prov_name:
            prov_name = os.path.splitext(uploaded_files[0].filename)[0].replace("_", " ").replace("-", " ").title()

        clean_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', prov_name.lower())
        saved_filename = f"{clean_slug}.m3u"
        saved_path = os.path.join(playlists_dir, saved_filename)

        # Clear existing channels for this provider
        db.purge_provider_channels(prov_name)

        # Combine all files into master M3U and parse
        with open(saved_path, "w", encoding="utf-8") as out_f:
            out_f.write("#EXTM3U\n")
            for idx, f in enumerate(uploaded_files):
                content = f.read().decode("utf-8", errors="ignore")
                for line in content.splitlines():
                    if line.strip() and not line.strip().startswith("#EXTM3U"):
                        out_f.write(line.strip() + "\n")

        # Parse saved combined M3U
        prov_channel_count = 0
        batch = []
        current_name = None
        current_category = None
        current_tvg_id = None
        current_logo = None

        with open(saved_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line_str = line.strip()
                if not line_str:
                    continue
                if line_str.startswith("#EXTINF:"):
                    parts = line_str.split(",")
                    current_name = parts[-1].strip() if len(parts) > 1 else "Unknown Channel"
                    group_match = re.search(r'group-title="([^"]+)"', line_str)
                    current_category = group_match.group(1).strip() if group_match else None
                    tvg_id_match = re.search(r'tvg-id="([^"]+)"', line_str)
                    current_tvg_id = tvg_id_match.group(1).strip() if tvg_id_match else None
                    logo_match = re.search(r'tvg-logo="([^"]+)"', line_str)
                    current_logo = logo_match.group(1).strip() if logo_match else None
                elif not line_str.startswith("#") and (line_str.startswith("http") or line_str.startswith("rtmp") or line_str.startswith("rtsp") or "://" in line_str):
                    if current_name:
                        batch.append((current_name, line_str, current_category, current_tvg_id, current_logo, prov_name))
                        current_name = None
                        current_category = None
                        current_tvg_id = None
                        current_logo = None
                        prov_channel_count += 1
                    if len(batch) >= 5000:
                        db.insert_channels_batch(batch)
                        batch = []

        if batch:
            db.insert_channels_batch(batch)

        total_imported_channels += prov_channel_count

        # Register provider
        prov_url = f"/app/stream_iptv/playlists/{saved_filename}"
        found = False
        for p in existing_provs:
            if (p.get("name") or "").strip().lower() == prov_name.lower():
                p["url"] = prov_url
                found = True
                break
        if not found:
            existing_provs.append({"name": prov_name, "url": prov_url})

        results.append({
            "provider": prov_name,
            "channels": prov_channel_count,
            "file": saved_filename
        })

    else:
        # Separate mode: each uploaded file creates its own distinct provider list!
        for f in uploaded_files:
            prov_name = os.path.splitext(f.filename)[0].replace("_", " ").replace("-", " ").title()
            clean_slug = re.sub(r'[^a-zA-Z0-9_-]', '_', prov_name.lower())
            saved_filename = f"{clean_slug}.m3u"
            saved_path = os.path.join(playlists_dir, saved_filename)
            f.save(saved_path)

            # Purge prior channels for this specific provider
            db.purge_provider_channels(prov_name)

            prov_channel_count = 0
            batch = []
            current_name = None
            current_category = None
            current_tvg_id = None
            current_logo = None

            with open(saved_path, "r", encoding="utf-8", errors="ignore") as in_f:
                for line in in_f:
                    line_str = line.strip()
                    if not line_str:
                        continue
                    if line_str.startswith("#EXTINF:"):
                        parts = line_str.split(",")
                        current_name = parts[-1].strip() if len(parts) > 1 else "Unknown Channel"
                        group_match = re.search(r'group-title="([^"]+)"', line_str)
                        current_category = group_match.group(1).strip() if group_match else None
                        tvg_id_match = re.search(r'tvg-id="([^"]+)"', line_str)
                        current_tvg_id = tvg_id_match.group(1).strip() if tvg_id_match else None
                        logo_match = re.search(r'tvg-logo="([^"]+)"', line_str)
                        current_logo = logo_match.group(1).strip() if logo_match else None
                    elif not line_str.startswith("#") and (line_str.startswith("http") or line_str.startswith("rtmp") or line_str.startswith("rtsp") or "://" in line_str):
                        if current_name:
                            batch.append((current_name, line_str, current_category, current_tvg_id, current_logo, prov_name))
                            current_name = None
                            current_category = None
                            current_tvg_id = None
                            current_logo = None
                            prov_channel_count += 1
                        if len(batch) >= 5000:
                            db.insert_channels_batch(batch)
                            batch = []

            if batch:
                db.insert_channels_batch(batch)

            total_imported_channels += prov_channel_count

            # Register provider
            prov_url = f"/app/stream_iptv/playlists/{saved_filename}"
            found = False
            for p in existing_provs:
                if (p.get("name") or "").strip().lower() == prov_name.lower():
                    p["url"] = prov_url
                    found = True
                    break
            if not found:
                existing_provs.append({"name": prov_name, "url": prov_url})

            results.append({
                "provider": prov_name,
                "channels": prov_channel_count,
                "file": saved_filename
            })

    save_provider_config(providers=existing_provs, target_user=user)

    global playlist_version
    playlist_version = int(time.time())

    prov_summary_str = ", ".join([f"'{r['provider']}' ({r['channels']:,})" for r in results])
    return jsonify({
        "success": True,
        "mode": mode,
        "files_count": len(uploaded_files),
        "total_channels": total_imported_channels,
        "results": results,
        "message": f"Successfully imported {total_imported_channels:,} channels across {len(results)} provider list(s): {prov_summary_str}"
    })


@app.route("/login", methods=["GET", "POST"])
def login_view():
    base = get_base_url()
    if request.method == "POST":
        data = request.get_json(silent=True) or request.form
        username = (data.get("username") or "").strip().lower()
        password = data.get("password") or ""

        if user_manager.verify_user_credentials(username, password):
            flask_session["user"] = username
            flask_session.permanent = True
            if request.is_json:
                return jsonify({"success": True, "user": username})
            next_url = request.args.get("next") or base
            return redirect(next_url)
        else:
            if request.is_json:
                return jsonify({"success": False, "error": "Invalid username or password"}), 401
            return render_template("login.html", error="Invalid username or password")

    if flask_session.get("user"):
        return redirect(base)
    return render_template("login.html")

@app.route("/")
def index():
    user = get_current_username()
    if not user:
        base = get_base_url()
        return redirect(f"{base}login")
    playlist = load_playlist(user)
    streams = playlist.get("streams", []) if isinstance(playlist, dict) else []
    offline_count = len([s for s in streams if isinstance(s, dict) and (s.get("offline") or s.get("is_offline"))])
    resp = make_response(render_template("index.html", playlist=playlist, playlist_version=playlist_version, current_user=user, offline_count=offline_count))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp

def ensure_db_tables(conn):
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS channels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                url TEXT,
                category TEXT,
                tvg_id TEXT,
                logo TEXT,
                provider TEXT
            )
        """)
        # Bring tables created by older code (or by this function before db.ensure_schema
        # ran) up to the columns db.py queries; search fails on a fresh SQLite otherwise.
        for col, typ in (("provider", "TEXT"), ("is_playable", "INTEGER DEFAULT NULL"),
                         ("latency_ms", "INTEGER DEFAULT NULL"), ("last_checked", "TIMESTAMP DEFAULT NULL"),
                         ("error_msg", "TEXT DEFAULT NULL")):
            try:
                conn.execute(f"ALTER TABLE channels ADD COLUMN {col} {typ}")
            except Exception:
                pass
        conn.execute("""
            CREATE TABLE IF NOT EXISTS epg_schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tvg_id TEXT,
                start TEXT,
                stop TEXT,
                title TEXT,
                desc TEXT
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_epg_tvg_id ON epg_schedules(tvg_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_epg_start_stop ON epg_schedules(start, stop)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_channel_provider ON channels(provider)")
        try:
            conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS channels_fts USING fts5(name, category, content=channels, content_rowid=id)")
        except Exception:
            pass
        conn.commit()
    except Exception:
        pass

def get_db_reader(db_path, timeout=30.0):
    import sqlite3
    conn = sqlite3.connect(db_path, timeout=timeout)
    try:
        conn.execute(f"PRAGMA busy_timeout = {int(timeout * 1000)};")
        conn.execute("PRAGMA query_only = ON;")
    except Exception:
        pass
    return conn

@app.route("/api/channels/search")
def search_channels():
    query = request.args.get("q", "").strip()
    if not query or len(query) < 2:
        return jsonify([])
    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")
    try:
        results = db.search_channels(query, db_path=db_path, limit=200)
        return jsonify(results)
    except Exception as e:
        app.logger.error(f"Search error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/categories")
def get_categories():
    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")
    try:
        results = db.get_distinct_categories(db_path=db_path)
        return jsonify(results)
    except Exception as e:
        app.logger.error(f"Categories error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/channels")
def get_channels_by_category():
    category = request.args.get("category", "").strip()
    if not category:
        return jsonify([])
    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")
    try:
        results = db.get_channels_by_category(category, db_path=db_path)
        return jsonify(results)
    except Exception as e:
        app.logger.error(f"Channels by category error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/view")
def view():
    interval = request.args.get("interval", "900")
    user = request.args.get("user")
    user_param = f"&user={user}" if user else ""
    return redirect(f"/stream-iptv/kiosk?interval={interval}{user_param}", code=302)

@app.route("/kiosk")
def kiosk():
    register_session()
    resp = make_response(render_template("kiosk.html", kiosk_build=kiosk_build_hash()))
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    return resp

def sanitize_pluto_url(url):
    if not url:
        return url
    import re
    # If this is already an authenticated stitcher child/variant playlist or key or segment, do not touch
    if ("stitch/embed" in url or "stitch/hls" in url) and ("sid=" in url or "jwt=" in url or "authToken=" in url or "deviceId=" in url):
        return url
    if ".key" in url or ".ts" in url or "jmp2.uk/plu-" in url:
        return url
    
    # If it is a Pluto channel master stitcher or direct channel link, map to working authenticated partner stream
    m = re.search(r'/channel/([a-f0-9]{24})(?:/master\.m3u8)?$', url.split('?')[0])
    if m:
        return f"https://jmp2.uk/plu-{m.group(1)}.m3u8"
    m = re.search(r'plu-([a-f0-9]{24})', url)
    if m:
        return f"https://jmp2.uk/plu-{m.group(1)}.m3u8"
    # Also handle full pluto.tv web or live URLs like /live-tv/channel/...
    m = re.search(r'/channel/([a-f0-9]{24})', url)
    if m and not any(k in url for k in ["/stitch/", "jwt=", "sid="]):
        return f"https://jmp2.uk/plu-{m.group(1)}.m3u8"
        
    return url

@app.route("/player")
@app.route("/stream-iptv/player")
def player():
    stream_url = request.args.get("url")
    if stream_url:
        stream_url = sanitize_pluto_url(unmask_credentials(stream_url))
    from urllib.parse import quote
    if not stream_url:
        player_src = ""
    elif stream_url.startswith("/stream-iptv/api/proxy") or stream_url.startswith("/api/proxy"):
        player_src = stream_url
    elif "/stream-iptv/api/proxy" in stream_url:
        player_src = stream_url
    elif "youtube.com" in stream_url or "youtu.be" in stream_url:
        player_src = stream_url
    elif stream_url.startswith("http://") or stream_url.startswith("https://"):
        player_src = f"/stream-iptv/api/proxy?url={quote(stream_url, safe='')}"
    else:
        player_src = stream_url
        
    return f'''
    <!DOCTYPE html>
    <html>
    <head>
        <title>IPTV Player</title>
        <script src="https://cdn.jsdelivr.net/npm/hls.js@1.7.3"></script>
        <script src="https://cdn.jsdelivr.net/npm/mpegts.js@latest/dist/mpegts.js"></script>
        <style>
            body, html, video {{
                margin: 0;
                padding: 0;
                width: 100%;
                height: 100%;
                background: #000;
                overflow: hidden;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            }}
            #status-overlay {{
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(15, 23, 42, 0.88);
                color: #f8fafc;
                padding: 12px 20px;
                border-radius: 10px;
                display: flex;
                align-items: center;
                gap: 10px;
                font-size: 13px;
                font-weight: 500;
                border: 1px solid rgba(255,255,255,0.15);
                box-shadow: 0 10px 25px rgba(0,0,0,0.6);
                z-index: 10;
                pointer-events: none;
                transition: opacity 0.25s ease;
            }}
            .spinner {{
                width: 16px;
                height: 16px;
                border: 2px solid rgba(255,255,255,0.25);
                border-top-color: #38bdf8;
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
            }}
            @keyframes spin {{
                to {{ transform: rotate(360deg); }}
            }}
        </style>
    </head>
    <body>
        <div id="status-overlay">
            <div class="spinner" id="spinner"></div>
            <span id="status-text">Connecting stream...</span>
        </div>
        <video id="video" autoplay controls playsinline style="width:100%; height:100%; object-fit:contain;"></video>
        <script>
            var video = document.getElementById('video');
            var statusOverlay = document.getElementById('status-overlay');
            var statusText = document.getElementById('status-text');
            var spinner = document.getElementById('spinner');
            var videoSrc = "{player_src}";
            var retryCount = 0;
            var MAX_RETRIES = 5;
            var lastTime = -1;
            var stuckTicks = 0;
            var hlsInstance = null;
            var mpegtsPlayer = null;
            
            // Force volume and unmuted status initially
            video.muted = false;
            video.volume = 1.0;

            function showStatus(text, showSpinner = true, isError = false) {{
                if (!statusOverlay) return;
                statusOverlay.style.display = 'flex';
                statusOverlay.style.opacity = '1';
                if (statusText) statusText.innerHTML = text;
                if (spinner) spinner.style.display = showSpinner ? 'block' : 'none';
                if (isError) {{
                    statusOverlay.style.background = 'rgba(185, 28, 28, 0.9)';
                    statusOverlay.style.pointerEvents = 'auto';
                }} else {{
                    statusOverlay.style.background = 'rgba(15, 23, 42, 0.88)';
                    statusOverlay.style.pointerEvents = 'none';
                }}
            }}

            function hideStatus() {{
                if (!statusOverlay) return;
                statusOverlay.style.opacity = '0';
                setTimeout(function() {{
                    if (statusOverlay.style.opacity === '0') {{
                        statusOverlay.style.display = 'none';
                    }}
                }}, 250);
            }}

            function triggerStallRetry(reason) {{
                retryCount++;
                console.warn("Stall/Error detected (" + reason + "). Retry attempt " + retryCount + " of " + MAX_RETRIES);
                if (retryCount <= MAX_RETRIES) {{
                    showStatus("Retrying stream (" + retryCount + "/" + MAX_RETRIES + ")...", true, false);
                    try {{
                        if (isTsLike) {{
                            initMpegtsPlayer(false);
                        }} else if (hlsInstance) {{
                            hlsInstance.stopLoad();
                            hlsInstance.loadSource(videoSrc);
                            hlsInstance.startLoad();
                        }} else {{
                            video.load();
                        }}
                        video.play().catch(function() {{}});
                    }} catch (e) {{
                        console.error("Retry load failed:", e);
                    }}
                }} else {{
                    console.error("Stream failed after " + MAX_RETRIES + " retries.");
                    showStatus("⚠️ Stream offline or unreachable.<br><button onclick='retryCount=0;location.reload()' style='margin-top:6px;padding:4px 10px;background:#fff;color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:bold;font-size:11px;'>Retry</button>", false, true);
                    try {{
                        window.parent.postMessage({{ type: 'stream_failed', url: videoSrc, reason: reason }}, '*');
                        window.parent.postMessage({{ type: 'stream_stalled_skip', reason: reason }}, '*');
                    }} catch (e) {{}}
                }}
            }}

            var isXtreamTs = /\/[^\/?]+\/[^\/?]+\/\d+(\.ts)?(\?|$)/.test(decodeURIComponent(videoSrc));
            var isTsLike = isXtreamTs || videoSrc.includes('.ts');
            var isDirectVideo = !isTsLike && (videoSrc.toLowerCase().includes('.mp4') || videoSrc.includes('/series/') || videoSrc.includes('/movie/'));
            var streamHasAudio = true;
            
            function canPlayAc3() {{
                try {{
                    return window.MediaSource && (
                        MediaSource.isTypeSupported('audio/mp4; codecs="ac-3"') ||
                        MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.a5"') ||
                        MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"')
                    );
                }} catch (e) {{
                    return false;
                }}
            }}

            var streamInitTime = Date.now();
            function initMpegtsPlayer(withAudio) {{
                streamHasAudio = withAudio;
                streamInitTime = Date.now();
                try {{
                    if (mpegtsPlayer) {{
                        try {{ mpegtsPlayer.destroy(); }} catch (e) {{}}
                        mpegtsPlayer = null;
                    }}
                    mpegtsPlayer = mpegts.createPlayer({{
                        type: 'mpegts',
                        isLive: true,
                        url: videoSrc,
                        hasAudio: withAudio
                    }}, {{
                        enableWorker: false,
                        lazyLoad: false,
                        liveBufferLatencyChasing: false,
                        enableStashBuffer: true,
                        stashInitialSize: 384 * 1024,
                        autoCleanupSourceBuffer: true
                    }});
                    mpegtsPlayer.attachMediaElement(video);
                    mpegtsPlayer.load();
                    mpegtsPlayer.play().catch(function(err) {{
                        console.log("Mpegts autoplay blocked, attempting muted:", err);
                        video.muted = true;
                        mpegtsPlayer.play().catch(function() {{}});
                    }});
                    mpegtsPlayer.on(mpegts.Events.ERROR, function(type, detail, info) {{
                        console.warn("mpegts error:", type, detail, info);
                        if (streamHasAudio) {{
                            console.log("Audio track error or unsupported codec in stream. Retrying in video-only mode...");
                            setTimeout(function() {{ initMpegtsPlayer(false); }}, 100);
                        }} else {{
                            triggerStallRetry("mpegts_error");
                        }}
                    }});
                }} catch (e) {{
                    console.warn("Failed to create mpegts player:", e);
                    if (withAudio) {{
                        setTimeout(function() {{ initMpegtsPlayer(false); }}, 100);
                    }} else {{
                        video.src = videoSrc;
                        video.play().catch(function() {{}});
                    }}
                }}
            }}

            if (isTsLike && window.mpegts && mpegts.isSupported()) {{
                var startWithAudio = true;
                console.log("Initializing mpegts player. withAudio=" + startWithAudio);
                initMpegtsPlayer(startWithAudio);
            }} else if (isDirectVideo) {{
                showStatus("Buffering video...", true, false);
                video.src = videoSrc;
                video.play().catch(function(err) {{
                    console.log("Autoplay blocked, attempting muted:", err);
                    video.muted = true;
                    video.play().catch(function() {{}});
                }});
            }} else if (Hls.isSupported()) {{
                hlsInstance = new Hls({{
                    enableWorker: true,
                    lowLatencyMode: true,
                    backBufferLength: 60
                }});
                hlsInstance.loadSource(videoSrc);
                hlsInstance.attachMedia(video);
                
                hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {{
                    var playPromise = video.play();
                    if (playPromise !== undefined) {{
                        playPromise.catch(function(error) {{
                            console.log("Autoplay with sound blocked, attempting muted autoplay:", error);
                            video.muted = true;
                            video.play().catch(function() {{}});
                        }});
                    }}
                }});

                hlsInstance.on(Hls.Events.ERROR, function(event, data) {{
                    console.warn("HLS Error encountered:", data);
                    if (data.details === 'manifestParsingError') {{
                        console.warn("Manifest parsing error, trying native video playback...");
                        try {{ hlsInstance.destroy(); }} catch(e) {{}}
                        hlsInstance = null;
                        video.src = videoSrc;
                        video.play().catch(function() {{}});
                        return;
                    }}
                    if (data.fatal) {{
                        switch (data.type) {{
                            case Hls.ErrorTypes.NETWORK_ERROR:
                                console.log("HLS fatal network error, recovering...");
                                triggerStallRetry("network_error");
                                break;
                            case Hls.ErrorTypes.MEDIA_ERROR:
                                console.log("HLS fatal media error, recovering...");
                                hlsInstance.recoverMediaError();
                                break;
                            default:
                                console.error("HLS unrecoverable error:", data);
                                triggerStallRetry("hls_fatal");
                                break;
                        }}
                    }}
                }});
            }} else if (video.canPlayType('application/vnd.apple.mpegurl')) {{
                video.src = videoSrc;
                video.addEventListener('loadedmetadata', function() {{
                    var playPromise = video.play();
                    if (playPromise !== undefined) {{
                        playPromise.catch(function(error) {{
                            console.log("Autoplay with sound blocked, attempting muted autoplay:", error);
                            video.muted = true;
                            video.play().catch(function() {{}});
                        }});
                    }}
                }});
            }}

            // Playback Watchdog & Status Handlers
            video.addEventListener('playing', function() {{
                stuckTicks = 0;
                retryCount = 0;
                hideStatus();
                try {{
                    window.parent.postMessage({{ type: 'stream_playing', url: videoSrc }}, '*');
                }} catch (e) {{}}
            }});
            video.addEventListener('waiting', function() {{
                if (retryCount <= MAX_RETRIES) {{
                    showStatus("Buffering...", true, false);
                }}
            }});
            video.addEventListener('timeupdate', function() {{
                if (video.buffered && video.buffered.length > 0 && video.currentTime < video.buffered.start(0)) {{
                    video.currentTime = video.buffered.start(0) + 0.05;
                }}
                if (video.currentTime > 2 && stuckTicks === 0) {{
                    retryCount = 0;
                    hideStatus();
                }}
            }});
            video.addEventListener('error', function(e) {{
                console.warn("video error event:", video.error);
                if (isTsLike && streamHasAudio) {{
                    console.log("Video element error with audio enabled. Falling back to video-only mode...");
                    setTimeout(function() {{ initMpegtsPlayer(false); }}, 100);
                    return;
                }}
                triggerStallRetry("video_error");
            }});

            setInterval(function() {{
                if (video.paused && !video.ended) {{
                    video.play().catch(function() {{}});
                }}
                // Startup grace period: live streams need time to buffer and demux initial keyframe
                if (Date.now() - streamInitTime < 10000) {{
                    if (video.buffered && video.buffered.length > 0 && video.currentTime < video.buffered.start(0)) {{
                        video.currentTime = video.buffered.start(0) + 0.05;
                    }}
                    return;
                }}
                if (Math.abs(video.currentTime - lastTime) < 0.2) {{
                    stuckTicks++;
                    if (stuckTicks === 4 && mpegtsPlayer && streamHasAudio && (video.currentTime === 0 || lastTime <= 0.1)) {{
                        console.log("Stream stuck at 0s waiting on audio packets. Fallback to video-only mode...");
                        stuckTicks = 0;
                        initMpegtsPlayer(false);
                        return;
                    }}
                    if (stuckTicks >= 12) {{
                        stuckTicks = 0;
                        triggerStallRetry("playback_frozen");
                    }}
                }} else {{
                    lastTime = video.currentTime;
                    stuckTicks = 0;
                }}
            }}, 1000);

            // Listen for postMessage volume control from parent kiosk window
            window.addEventListener('message', function(e) {{
                if (e.data && e.data.type === 'set_volume') {{
                    if (typeof e.data.volume === 'number') {{
                        video.volume = e.data.volume;
                    }}
                    if (typeof e.data.muted === 'boolean') {{
                        video.muted = e.data.muted;
                    }}
                }}
            }});
        </script>
    </body>
    </html>
    '''

@app.route("/playlist.yaml", methods=["GET"])
def get_playlist_file():
    register_session()
    path = get_playlist_path()
    if not os.path.exists(path):  # user without their own playlist yet
        path = get_playlist_path("default")
    return send_from_directory(os.path.dirname(path), os.path.basename(path))

@app.route("/api/playlist", methods=["GET"])
def get_playlist_api():
    register_session()
    mode = request.args.get("mode") or request.args.get("type") or "streamer"
    user = request.args.get("user") or get_current_username()
    playlist_type = normalize_playlist_type(request.args.get("playlist_type") or request.args.get("type_filter"))
    return jsonify(build_playlist_payload(user, mode, playlist_type))


def normalize_playlist_type(value):
    playlist_type = str(value or "all").strip().lower()
    return playlist_type if playlist_type in ("all", "both", "permanent", "temporary") else "all"


def build_playlist_payload(user, mode, playlist_type):
    """The /api/playlist body, plus playlist_hash so a kiosk can report which copy it holds."""
    if playlist_type == "all":
        data = load_playlist(target_user=user, mode=mode)
    else:
        data = load_playlist_group(target_user=user, mode=mode, playlist_type=playlist_type)
    if isinstance(data, dict):
        data = dict(data)
        data["playlist_hash"] = playlist_content_hash(data.get("streams"))
    return data


def playlist_content_hash(streams):
    # Names + state, not URLs: provider credentials in URLs are re-masked per response.
    rows = sorted(
        "|".join([str(s.get("name") or s.get("title") or ""),
                  "off" if (s.get("offline") or s.get("is_offline")) else "on",
                  "1" if s.get("is_active_now", True) else "0"])
        for s in (streams or []) if isinstance(s, dict)
    )
    return hashlib.sha1("\n".join(rows).encode("utf-8")).hexdigest()[:12]


_kiosk_build_cache = {"key": None, "hash": ""}

def kiosk_build_hash():
    """Hash of the kiosk template, so kiosks running an old copy can be spotted and reloaded."""
    path = os.path.join(app.root_path, "templates", "kiosk.html")
    try:
        st = os.stat(path)
    except OSError:
        return ""
    key = (st.st_mtime_ns, st.st_size)
    if _kiosk_build_cache["key"] != key:
        with open(path, "rb") as f:
            _kiosk_build_cache["hash"] = hashlib.sha1(f.read()).hexdigest()[:12]
        _kiosk_build_cache["key"] = key
    return _kiosk_build_cache["hash"]

@app.route("/api/kiosk/playlist", methods=["GET"])
def get_kiosk_playlist_api():
    register_session()
    user = request.args.get("user") or get_current_username()
    playlist_type = str(request.args.get("playlist_type") or request.args.get("type_filter") or "all").strip().lower()
    if playlist_type not in ("all", "both", "permanent", "temporary"):
        playlist_type = "all"
    if playlist_type == "all":
        return jsonify(load_playlist(target_user=user, mode="kiosk"))
    return jsonify(load_playlist_group(target_user=user, mode="kiosk", playlist_type=playlist_type))

@app.route("/api/playlist/version", methods=["GET"])
def get_playlist_version():
    return jsonify({
        "version": playlist_version,
        "reload_version": reload_version,
        "skip_version": skip_version,
        "override": load_playback_override(),
        "kiosk_build": kiosk_build_hash()
    })


# "Play now" from Studio: the kiosks play one channel set (normal rotation, a window's
# channels, or everything) until `until`, ignoring the window schedule. Studio sets
# `until` to the next schedule change. Kept on disk so a restart doesn't drop it.
PLAYBACK_OVERRIDE_FILE = os.path.join(PLAYLIST_ROOT, "playlists/playback_override.json")
PLAYBACK_OVERRIDE_MODES = ("rotation", "1", "2", "all")


def load_playback_override():
    """The active override {mode, until, set_by, set_at}, or None when unset or expired."""
    try:
        with open(PLAYBACK_OVERRIDE_FILE, "r", encoding="utf-8") as f:
            override = json.load(f)
    except Exception:
        return None
    if not isinstance(override, dict) or override.get("mode") not in PLAYBACK_OVERRIDE_MODES:
        return None
    try:
        if float(override.get("until") or 0) <= time.time():
            return None
    except (TypeError, ValueError):
        return None
    return override


def playback_override_streams(streams, mode, playlist_data):
    """Streams an override plays, marked active whatever their window hours."""
    if mode == "all":
        picked = list(streams)
    elif mode == "rotation":
        picked = normal_rotation_streams(streams)
    else:
        picked = [s for s in streams if is_stream_temporary(s) and is_stream_for_window(s, int(mode), playlist_data)]
    for s in picked:
        if isinstance(s, dict):
            s["is_active_now"] = not (s.get("offline") or s.get("is_offline"))
    return picked


@app.route("/api/kiosk/override", methods=["GET", "POST"])
def kiosk_playback_override():
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        mode = str(data.get("mode") or "").strip()
        if mode in ("", "schedule"):
            try:
                os.remove(PLAYBACK_OVERRIDE_FILE)
            except FileNotFoundError:
                pass
            app.logger.warning(f"[play-now] {get_current_username()} returned the kiosks to the schedule")
        elif mode in PLAYBACK_OVERRIDE_MODES:
            now = time.time()
            try:
                until = float(data.get("until"))
            except (TypeError, ValueError):
                until = 0
            if not now < until <= now + 7 * 86400:
                return jsonify({"success": False, "error": "until must be within the next 7 days"}), 400
            with open(PLAYBACK_OVERRIDE_FILE, "w", encoding="utf-8") as f:
                json.dump({"mode": mode, "until": until, "set_by": get_current_username(), "set_at": now}, f, indent=2)
            app.logger.warning(f"[play-now] {get_current_username()} set the kiosks to {mode} until {datetime.fromtimestamp(until).strftime('%H:%M')}")
        else:
            return jsonify({"success": False, "error": f"unknown mode {mode!r}"}), 400
    return jsonify({"success": True, "override": load_playback_override()})

@app.route("/api/playlist/lock", methods=["POST"])
def api_set_playlist_lock():
    data = request.get_json(silent=True) or {}
    client_id = data.get("client_id") or request.remote_addr
    user = data.get("user") or get_current_username() or ADMIN_USERNAME
    duration = int(data.get("duration", 900))  # 15 min default
    reason = data.get("reason", "User is editing channels in UI")
    set_playlist_editing_lock(user=user, client_id=client_id, duration=duration, reason=reason)
    return jsonify({"success": True, "locked": True, "expires_in": duration, "client_id": client_id})

@app.route("/api/playlist/unlock", methods=["POST"])
def api_release_playlist_lock():
    data = request.get_json(silent=True) or {}
    client_id = data.get("client_id")
    force = bool(data.get("force", False))
    release_playlist_editing_lock(client_id=client_id, force=force)
    return jsonify({"success": True, "locked": False})

@app.route("/api/playlist/lock-status", methods=["GET"])
def api_get_playlist_lock_status():
    client_id = request.args.get("client_id")
    with PLAYLIST_EDIT_LOCK_MUTEX:
        is_locked = bool(PLAYLIST_EDIT_LOCK["locked"] and time.time() <= PLAYLIST_EDIT_LOCK["expires_at"])
        is_mine = bool(is_locked and client_id and PLAYLIST_EDIT_LOCK.get("client_id") == client_id)
        return jsonify({
            "locked": is_locked,
            "is_mine": is_mine,
            "user": PLAYLIST_EDIT_LOCK.get("user"),
            "expires_at": PLAYLIST_EDIT_LOCK.get("expires_at"),
            "time_remaining": max(0, int(PLAYLIST_EDIT_LOCK.get("expires_at", 0) - time.time())) if is_locked else 0
        })

@app.route("/api/playlist/refresh", methods=["POST"])
def request_playlist_refresh():
    global playlist_version
    playlist_version = int(time.time())
    app.logger.info("Playlist refresh requested (seamless in-memory update).")
    return jsonify({"success": True, "version": playlist_version})

@app.route("/api/playlist/request-reload", methods=["POST"])
def request_reload():
    req_data = request.get_json(silent=True) or {}
    soft = req_data.get("soft", False) or request.args.get("soft", "").lower() in ("1", "true")
    if soft:
        global playlist_version
        playlist_version = int(time.time())
        app.logger.info("Soft playlist refresh requested (preserving kiosk fullscreen).")
        return jsonify({"success": True, "version": playlist_version, "soft": True})

    global reload_version
    reload_version = int(time.time())
    app.logger.info("Administrator requested client reload.")
    return jsonify({"success": True, "reload_version": reload_version})

@app.route("/api/playlist/request-skip", methods=["POST"])
def request_skip():
    global skip_version
    skip_version = int(time.time())
    app.logger.info("Administrator requested client skip to next stream.")
    return jsonify({"success": True, "skip_version": skip_version})

# Kiosk sync checks, run on each heartbeat (2026-11-08: a rotation bug played 2 of 4
# window channels for a day and nothing noticed).
SYNC_RESYNC_SECONDS = 60          # playlist mismatch this long -> tell the kiosk to refetch
SYNC_ALERT_SECONDS = 30 * 60      # build/playlist mismatch this long -> log a warning
STARVE_ROUNDS = 2                 # active channel unplayed for this many full rounds -> starved
_expected_playlist_cache = {}

def expected_playlist_state(query):
    """(playlist_hash, active channel names) for the query a kiosk used, cached 20 s."""
    user = query.get("user") or get_current_username()
    mode = query.get("mode") or "streamer"
    playlist_type = normalize_playlist_type(query.get("playlist_type"))
    key = (user, mode, playlist_type)
    hit = _expected_playlist_cache.get(key)
    if hit and time.time() - hit[0] < 20:
        return hit[1], hit[2]
    data = build_playlist_payload(user, mode, playlist_type)
    streams = data.get("streams") if isinstance(data, dict) else None
    names = [str(s.get("name") or s.get("title") or "") for s in (streams or [])
             if isinstance(s, dict) and s.get("is_active_now", True)
             and not (s.get("offline") or s.get("is_offline"))]
    names = [n for n in dict.fromkeys(names) if n]
    phash = data.get("playlist_hash") if isinstance(data, dict) else None
    _expected_playlist_cache[key] = (time.time(), phash, names)
    return phash, names


def evaluate_player_sync(existing, data, now, client_id):
    """Sync/starvation fields for one heartbeat. Old kiosks and daemons that don't
    report kiosk_build/playlist_hash get none."""
    client_build = data.get("kiosk_build")
    client_hash = data.get("playlist_hash")
    query = data.get("playlist_query")
    if not client_build and not client_hash:
        return {}
    label = f"{client_id} ({data.get('current_channel') or '?'})"

    expected_hash, active_names = None, []
    if isinstance(query, dict) and client_hash:
        try:
            expected_hash, active_names = expected_playlist_state(query)
        except Exception:
            app.logger.exception("Kiosk sync: could not load expected playlist")
    build_ok = not client_build or client_build == kiosk_build_hash()
    playlist_ok = expected_hash is None or client_hash == expected_hash
    in_sync = build_ok and playlist_ok

    since = None if in_sync else (existing.get("out_of_sync_since_dt") or now)
    out_secs = int((now - since).total_seconds()) if since else 0
    sync_alerted = existing.get("sync_alerted", False)
    if out_secs >= SYNC_ALERT_SECONDS and not sync_alerted:
        app.logger.warning("Kiosk sync: %s out of sync for %d min (build_ok=%s playlist_ok=%s)",
                           label, out_secs // 60, build_ok, playlist_ok)
        sync_alerted = True
    elif in_sync and sync_alerted:
        app.logger.info("Kiosk sync: %s back in sync", label)
        sync_alerted = False

    # Starvation: when did each active channel last show up as current_channel?
    channel = data.get("current_channel")
    play_times = {k: v for k, v in (existing.get("play_times") or {}).items() if k in active_names}
    if channel:
        play_times[channel] = now
    tracked_since = existing.get("rotation_tracked_since_dt") or now
    paused = str(data.get("playback_status") or "").lower() == "paused"
    if paused or (expected_hash and expected_hash != existing.get("rotation_hash")):
        tracked_since = now  # paused, or the channel set changed: restart the clock
    starved = []
    interval = max(int(data.get("duration_seconds") or 0), 30)
    window = STARVE_ROUNDS * len(active_names) * interval
    if len(active_names) > 1 and playlist_ok and (now - tracked_since).total_seconds() >= window:
        cutoff = now - timedelta(seconds=window)
        starved = [n for n in active_names if play_times.get(n, datetime.min) < cutoff]
    prev_starved = set(existing.get("starved_channels") or [])
    if starved and not set(starved) <= prev_starved:
        app.logger.warning("Kiosk sync: %s has not played %s in %d min (%d active channels)",
                           label, ", ".join(starved), window // 60, len(active_names))
    elif not starved and prev_starved:
        app.logger.info("Kiosk sync: %s rotation covers all channels again", label)

    return {
        "build_ok": build_ok,
        "playlist_ok": playlist_ok,
        "out_of_sync_since_dt": since,
        "out_of_sync_seconds": out_secs,
        "sync_alerted": sync_alerted,
        "resync": (not playlist_ok) and out_secs >= SYNC_RESYNC_SECONDS,
        "play_times": play_times,
        "rotation_hash": expected_hash or existing.get("rotation_hash"),
        "rotation_tracked_since_dt": tracked_since,
        "starved_channels": starved,
    }


PLAYER_PRIVATE_FIELDS = {"play_times", "rotation_hash", "sync_alerted", "resync"}

@app.route("/api/player/heartbeat", methods=["POST"])
def player_heartbeat():
    data = request.get_json(silent=True) or {}
    client_id = str(data.get("client_id") or "").strip()
    if not client_id:
        return jsonify({"success": False, "error": "Missing client_id"}), 400

    with players_lock:
        previous = dict(active_players.get(client_id, {}))
    now = datetime.now()
    sync = evaluate_player_sync(previous, data, now, client_id)

    client_ip = request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or request.headers.get("X-Real-IP") or request.remote_addr or "unknown"
    ua = request.headers.get("User-Agent", "unknown")
    
    player_type = data.get("player_type") or ("Python Daemon" if "python" in ua.lower() else "Web Kiosk")

    with players_lock:
        existing = active_players.get(client_id, {})
        first_seen = existing.get("first_seen", now.strftime("%Y-%m-%d %H:%M:%S"))
        
        active_players[client_id] = {
            "client_id": client_id,
            "player_type": player_type,
            "ip": client_ip,
            "user_agent": ua,
            "playlist_user": data.get("playlist_user") or get_current_username() or "default",
            "playlist_mode": data.get("playlist_mode") or "streamer",
            "current_channel": data.get("current_channel") or "Unknown Stream",
            "channel_url": data.get("channel_url") or "",
            "channel_index": data.get("channel_index", 0),
            "playback_status": data.get("playback_status") or "playing",
            "volume": data.get("volume", 100),
            "muted": data.get("muted", False),
            "shuffle": data.get("shuffle", True),
            "elapsed_seconds": data.get("elapsed_seconds", 0),
            "duration_seconds": data.get("duration_seconds", 0),
            "first_seen": first_seen,
            "last_seen": now.strftime("%Y-%m-%d %H:%M:%S"),
            "last_seen_dt": now,
            **sync,
        }
    return jsonify({
        "success": True,
        "registered_id": client_id,
        "resync": bool(sync.get("resync")),
        "kiosk_build": kiosk_build_hash(),
    })

@app.route("/api/players", methods=["GET"])
def get_active_players():
    cleanup_players()
    with players_lock:
        players = []
        for pid, p in active_players.items():
            p_copy = {k: v for k, v in p.items()
                      if not k.endswith("_dt") and k not in PLAYER_PRIVATE_FIELDS}
            if p.get("out_of_sync_since_dt"):
                p_copy["out_of_sync_since"] = p["out_of_sync_since_dt"].strftime("%Y-%m-%d %H:%M:%S")
            players.append(p_copy)
    players.sort(key=lambda x: x.get("last_seen", ""), reverse=True)
    attach_epg_programs(players)
    return jsonify({"count": len(players), "players": players})


def attach_epg_programs(players):
    """Set "program" (the guide's now/next) on each player whose channel has a tvg_id."""
    tvg_by_key = {}
    for user in {p.get("playlist_user") or "default" for p in players}:
        try:
            playlist = load_playlist_group(user)
        except Exception:
            continue
        for s in playlist.get("streams", []) if isinstance(playlist, dict) else []:
            if isinstance(s, dict) and s.get("tvg_id"):
                tvg_by_key.setdefault(("url", s.get("url") or ""), s["tvg_id"])
                tvg_by_key.setdefault(("name", s.get("name") or ""), s["tvg_id"])
    for p in players:
        p["tvg_id"] = tvg_by_key.get(("url", p.get("channel_url") or "")) or tvg_by_key.get(("name", p.get("current_channel") or ""))
    try:
        programs = epg_now_next(p["tvg_id"] for p in players if p["tvg_id"])
    except Exception as e:
        app.logger.error(f"[epg] Player programme lookup failed: {e}")
        programs = {}
    for p in players:
        p["program"] = programs.get(p["tvg_id"]) if p["tvg_id"] else None

# client_id -> (client timestamp of its last channel_change, provider of that channel)
_last_channel_change = {}


def _parse_client_ts(ts):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def _telemetry_extras(c_id, event_name, details, ts, provider):
    """Pull the error reason, retry count and startup time out of a kiosk event's details.

    Tags stay low-cardinality (player/library enums, truncated). Startup time uses the
    client's own timestamps, because events arrive batched and server time would skew it.
    """
    tags, fields = {}, []
    if event_name == "hls_error":
        tags["error_detail"] = str(details.get("details") or "unknown")[:40]
        tags["error_type"] = str(details.get("type") or "unknown")[:20]
    elif event_name == "mpegts_error":
        tags["error_detail"] = str(details.get("detail") or "unknown")[:40]
        tags["error_type"] = str(details.get("type") or "unknown")[:20]
    elif event_name == "playback_failure":
        tags["error_detail"] = str(details.get("reason") or "unknown")[:40]
        if isinstance(details.get("retry"), int):
            fields.append(f"retry={details['retry']}i")
            fields.append(f"gave_up={1 if details['retry'] >= (details.get('max_retries') or 0) else 0}i")
    elif event_name == "video_element_error":
        code = details.get("code")
        tags["error_detail"] = f"media_error_{code}" if code is not None else "unknown"
        if isinstance(code, int):
            fields.append(f"media_error_code={code}i")
    elif event_name == "playback_stall":
        if isinstance(details.get("current_time"), (int, float)):
            fields.append(f"stall_position_sec={float(details['current_time'])}")

    t = _parse_client_ts(ts)
    if event_name == "channel_change":
        if t is not None:
            _last_channel_change[c_id] = (t, provider)
    elif event_name == "stream_playing":
        if "with_audio" in details:
            fields.append(f"with_audio={1 if details.get('with_audio') else 0}i")
        started = _last_channel_change.pop(c_id, None)
        if started:
            # stream_playing carries no provider; credit the channel_change that led to it
            if provider == "Unknown":
                provider = started[1]
            if t is not None and 0 <= t - started[0] <= 120:
                fields.append(f"startup_ms={round((t - started[0]) * 1000)}i")
    return tags, fields, provider


@app.route("/api/player/log", methods=["POST"])
def receive_client_log():
    try:
        data = request.get_json(silent=True) or {}
        client_ip = request.headers.get("X-Forwarded-For", "").split(",")[0].strip() or request.headers.get("X-Real-IP") or request.remote_addr or "unknown"
        ua = request.headers.get("User-Agent", "unknown")

        entries = []
        if "logs" in data and isinstance(data["logs"], list):
            entries = data["logs"]
        elif "event" in data or "message" in data:
            entries = [data]

        client_id = str(data.get("client_id") or "").strip()
        now_dt = datetime.now()
        now_str = now_dt.strftime("%Y-%m-%d %H:%M:%S")

        log_file_path = os.path.join(os.path.dirname(__file__), "logs", "client_telemetry.log")
        try:
            os.makedirs(os.path.dirname(log_file_path), exist_ok=True)
        except Exception:
            pass

        with client_logs_lock:
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                c_id = str(entry.get("client_id") or client_id or "unknown").strip()
                level = str(entry.get("level") or "info").lower()
                event_name = str(entry.get("event") or "log")
                msg = str(entry.get("message") or "")
                details = entry.get("details") or {}
                channel = str(entry.get("channel_name") or "")
                url = str(entry.get("channel_url") or "")
                slot = str(entry.get("active_slot") or "")

                log_record = {
                    "id": str(uuid.uuid4())[:8],
                    "timestamp": entry.get("timestamp") or now_str,
                    "server_time": now_str,
                    "client_id": c_id,
                    "ip": client_ip,
                    "user_agent": ua,
                    "level": level,
                    "event": event_name,
                    "message": msg,
                    "channel": channel,
                    "url": url,
                    "slot": slot,
                    "details": details
                }
                client_logs.appendleft(log_record)

                # Update player last_error if warning or error
                if level in ["error", "warn"]:
                    with players_lock:
                        if c_id in active_players:
                            active_players[c_id]["last_error"] = f"[{event_name}] {msg}"
                            active_players[c_id]["last_error_time"] = now_str

                # Append to persistent log file
                detail_str = f" {json.dumps(details)}" if details else ""
                log_entry_line = f"[{now_str}] [{level.upper()}] [{c_id}@{client_ip}] [{event_name}] {channel} - {msg}{detail_str}"
                try:
                    with open(log_file_path, "a", encoding="utf-8") as lf:
                        lf.write(f"{log_entry_line}\n")
                except Exception:
                    pass

                # Stream to container stdout for Fluent-Bit -> OpenSearch -> Grafana
                telemetry_msg = f"[CLIENT-TELEMETRY] [{level.upper()}] [{c_id}@{client_ip}] [{event_name}] {channel} - {msg}{detail_str}"
                if level == "error":
                    app.logger.error(telemetry_msg)
                elif level == "warn":
                    app.logger.warning(telemetry_msg)
                else:
                    app.logger.info(telemetry_msg)

                # Stream to InfluxDB for Grafana IPTV dashboard
                try:
                    is_err = 1 if level in ["error", "warn"] else 0
                    is_fatal = 1 if details.get("fatal") is True else 0
                    dur = details.get("duration_seconds", 0) or 0
                    provider = details.get("provider", "Unknown") or "Unknown"
                    st_format = details.get("format", "unknown") or "unknown"
                    ch_tag = channel[:64] if channel else "Unknown"
                    extra_tags, extra_fields, provider = _telemetry_extras(c_id, event_name, details, entry.get("timestamp"), provider)

                    tag_parts = [
                        "iptv_telemetry",
                        f"client_id={_escape_influx_tag(c_id)}",
                        f"event={_escape_influx_tag(event_name)}",
                        f"level={_escape_influx_tag(level)}",
                        f"channel={_escape_influx_tag(ch_tag)}",
                        f"provider={_escape_influx_tag(provider[:40])}",
                        f"format={_escape_influx_tag(st_format[:20])}",
                        "host=ubuntu26-01"
                    ] + [f"{k}={_escape_influx_tag(v)}" for k, v in extra_tags.items()]
                    field_parts = [
                        "count=1i",
                        f"is_error={is_err}i",
                        f"is_fatal={is_fatal}i",
                        f"duration_sec={int(dur)}i",
                        f"message={_escape_influx_field(msg[:200])}"
                    ] + extra_fields
                    now_ns = int(time.time() * 1e9)
                    _send_influx_async([f"{','.join(tag_parts)} {','.join(field_parts)} {now_ns}"])
                except Exception:
                    pass

        return jsonify({"success": True, "count": len(entries)})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/player/logs", methods=["GET", "DELETE"])
def get_or_clear_client_logs():
    if request.method == "DELETE":
        with client_logs_lock:
            client_logs.clear()
        return jsonify({"success": True, "cleared": True})

    client_id = request.args.get("client_id")
    level = request.args.get("level")
    try:
        limit = min(int(request.args.get("limit", 150)), 1000)
    except Exception:
        limit = 150

    with client_logs_lock:
        results = []
        for item in client_logs:
            if client_id and item.get("client_id") != client_id:
                continue
            if level and level != "all" and item.get("level") != level.lower():
                continue
            results.append(item)
            if len(results) >= limit:
                break

    return jsonify({
        "count": len(results),
        "total_buffered": len(client_logs),
        "logs": results
    })

@app.route("/api/sessions", methods=["GET"])
def get_active_sessions():
    cleanup_sessions()
    session_list = []
    with sessions_lock:
        for (ip, username, ua), last_seen in active_sessions.items():
            ua_str = str(ua or "")
            if "python-requests" in ua_str.lower():
                client_type = "Python Rotator Kiosk"
            elif any(m in ua_str.lower() for m in ["iphone", "ipad", "android", "mobile"]):
                client_type = "Mobile Viewer"
            else:
                client_type = "Browser Viewer"
            session_list.append({
                "ip": ip,
                "username": username or "anonymous",
                "user_agent": ua_str,
                "type": client_type,
                "last_seen": last_seen.strftime("%Y-%m-%d %H:%M:%S")
            })
    return jsonify({"count": len(session_list), "sessions": session_list})

@app.route("/api/sessions/kick", methods=["POST"])
def kick_session_endpoint():
    data = request.get_json() or {}
    target_ip = data.get("ip")
    target_user = data.get("username")
    kick_all = data.get("kick_all", False)
    
    global reload_version
    reload_version = int(time.time())
    
    with sessions_lock:
        if kick_all:
            kicked_ips.clear()
            for (sess_ip, _, _) in list(active_sessions.keys()):
                kicked_ips.add(sess_ip)
            active_sessions.clear()
        else:
            if target_ip:
                kicked_ips.add(target_ip)
            if target_user and target_user != "default":
                kicked_users.add(target_user)
            to_del = [k for k in list(active_sessions.keys()) if (target_ip and k[0] == target_ip) or (target_user and k[1] == target_user)]
            for k in to_del:
                if k in active_sessions:
                    del active_sessions[k]
                    
    app.logger.info(f"Kicked session: ip={target_ip}, user={target_user}, kick_all={kick_all}")
    return jsonify({"success": True, "reload_version": reload_version})

# /api/playlist/save is the same handler: CloudFront routes write paths under
# /api/playlist/* to the home origin only, while the exact GET /api/playlist stays
# on the failover origin group (documentation/iptv_cloud_failover_options.md section 6).
@app.route("/api/playlist/save", methods=["POST"])
@app.route("/api/playlist", methods=["POST"])
def update_playlist():
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "error": "Invalid JSON"}), 400
    
    mode = request.args.get("mode") or data.get("mode") or "streamer"
    target_user = request.args.get("user") or get_current_username()
    
    # Ensure correct structure
    try:
        rotation_interval = int(data.get("rotation_interval_seconds", 900))
        streams = data.get("streams", [])
        
        # Clean and deduplicate streams data
        clean_streams = []
        seen_urls = set()
        
        def normalize_youtube_url(url_val):
            u = url_val.strip()
            if u.endswith("/"):
                u = u[:-1]
            if "youtube.com/watch?v=" in u:
                try:
                    parsed = urlparse(u)
                    vid = parse_qs(parsed.query).get("v", [None])[0]
                    if vid:
                        return f"https://www.youtube.com/embed/{vid}"
                except Exception:
                    pass
            elif "youtu.be/" in u:
                try:
                    vid = u.split("youtu.be/")[1].split("?")[0]
                    if vid:
                        return f"https://www.youtube.com/embed/{vid}"
                except Exception:
                    pass
            return u

        for s in streams:
            url = s.get("url", "").strip()
            if not url:
                continue
                
            normalized = normalize_youtube_url(url)
            key = stream_dedupe_key(normalized, s)
            if key in seen_urls:
                continue
            seen_urls.add(key)
            
            clean_stream = {
                "url": normalized,
                "type": s.get("type", "youtube_embed").strip()
            }
            for str_field in ("name", "category", "provider", "logo", "title", "tvg_id", "schedule_type", "start_date", "end_date", "start_time", "end_time", "expires_at"):
                val = s.get(str_field)
                if val is not None and str(val).strip():
                    clean_stream[str_field] = str(val).strip()
            if s.get("duration_seconds"):
                try:
                    clean_stream["duration_seconds"] = int(s["duration_seconds"])
                except (ValueError, TypeError):
                    pass
            for bool_field in ("temporary", "is_temporary", "offline", "is_offline"):
                if bool_field in s:
                    clean_stream[bool_field] = bool(s[bool_field])
            # Which temporary window (1 or 2) the channel belongs to; without it the
            # UI and the scheduler fall back to Window 1
            if s.get("schedule_window") not in (None, ""):
                try:
                    window = int(s["schedule_window"])
                    if window in (1, 2):
                        clean_stream["schedule_window"] = window
                except (ValueError, TypeError):
                    pass
            clean_streams.append(clean_stream)
            
        new_playlist = {
            "rotation_interval_seconds": rotation_interval,
            "browser_channel": data.get("browser_channel", "msedge"),
            "streams": clean_streams
        }
        if "offline_streams" in data and isinstance(data["offline_streams"], list):
            new_playlist["offline_streams"] = data["offline_streams"]
        else:
            existing_pl = load_playlist(target_user=target_user, mode=mode)
            if isinstance(existing_pl, dict) and "offline_streams" in existing_pl:
                new_playlist["offline_streams"] = existing_pl["offline_streams"]
        
        if "quiet_hours" in data and isinstance(data["quiet_hours"], dict):
            qh = data["quiet_hours"]
            new_playlist["quiet_hours"] = {
                "enabled": bool(qh.get("enabled", False)),
                "start_time": str(qh.get("start_time", "22:00")).strip(),
                "end_time": str(qh.get("end_time", "07:00")).strip(),
                "days": qh.get("days", [0, 1, 2, 3, 4, 5, 6])
            }
        
        if "temporary_schedule" in data and isinstance(data["temporary_schedule"], dict):
            ts = data["temporary_schedule"]
            new_playlist["temporary_schedule"] = {
                "enabled": bool(ts.get("enabled", False)),
                "start_time": str(ts.get("start_time", "18:00")).strip(),
                "end_time": str(ts.get("end_time", "22:00")).strip(),
                "start_date": str(ts.get("start_date", "")).strip(),
                "end_date": str(ts.get("end_date", "")).strip(),
                "days": ts.get("days", [0, 1, 2, 3, 4, 5, 6])
            }

        if "temporary_schedule_2" in data and isinstance(data["temporary_schedule_2"], dict):
            ts2 = data["temporary_schedule_2"]
            new_playlist["temporary_schedule_2"] = {
                "enabled": bool(ts2.get("enabled", False)),
                "start_time": str(ts2.get("start_time", "06:00")).strip(),
                "end_time": str(ts2.get("end_time", "12:00")).strip(),
                "start_date": str(ts2.get("start_date", "")).strip(),
                "end_date": str(ts2.get("end_date", "")).strip(),
                "days": ts2.get("days", [0, 1, 2, 3, 4, 5, 6])
            }
        
        if save_playlist(new_playlist, target_user=target_user, mode=mode):
            global playlist_version
            playlist_version = int(time.time())
            release_playlist_editing_lock(client_id=data.get("client_id"), force=True)
            if not data.get("skip_verify"):
                run_background_playlist_check()
            if playlist_tvg_ids() - EPG_STATE["tvg_ids"]:
                update_epg_cache_async()
            return jsonify({"success": True, "version": playlist_version})
        else:
            return jsonify({"success": False, "error": "Failed to save file"}), 500
            
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/playlist/save-as", methods=["POST"])
def save_playlist_as():
    try:
        data = request.get_json() or {}
        name = data.get("name", "").strip()
        if not name:
            return jsonify({"success": False, "error": "Playlist name is required"}), 400

        clean_name = "".join(c for c in name if c.isalnum() or c in ("-", "_")).lower()
        if not clean_name:
            return jsonify({"success": False, "error": "Invalid playlist name (use letters, numbers, hyphens, underscores)"}), 400

        playlist_content = data.get("playlist") or {}
        if not isinstance(playlist_content, dict):
            return jsonify({"success": False, "error": "Invalid playlist content"}), 400

        category = str(data.get("category", "General")).strip() or "General"
        list_type = str(data.get("list_type", "permanent")).strip().lower()
        if list_type not in ("permanent", "temporary"):
            list_type = "permanent"

        start_date = data.get("start_date")
        end_date = data.get("end_date")
        start_time = data.get("start_time")
        end_time = data.get("end_time")

        expires_at = data.get("expires_at")
        if list_type == "temporary":
            if not expires_at and not end_date:
                expires_at = (datetime.utcnow() + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            expires_at = None
            start_date = None
            end_date = None
            start_time = None
            end_time = None

        if list_type:
            playlist_content["list_type"] = list_type

        if save_playlist(playlist_content, target_user=clean_name):
            write_playlist_meta(
                clean_name,
                category=category,
                list_type=list_type,
                expires_at=expires_at,
                start_date=start_date,
                end_date=end_date,
                start_time=start_time,
                end_time=end_time
            )
            global playlist_version
            playlist_version = int(time.time())
            return jsonify({
                "success": True,
                "name": clean_name,
                "filename": f"playlist_{clean_name}.yaml",
                "category": category,
                "list_type": list_type,
                "start_date": start_date,
                "end_date": end_date,
                "start_time": start_time,
                "end_time": end_time,
                "expires_at": expires_at,
                "is_active_now": is_schedule_active_now({
                    "list_type": list_type,
                    "expires_at": expires_at,
                    "start_date": start_date,
                    "end_date": end_date,
                    "start_time": start_time,
                    "end_time": end_time
                }),
                "version": playlist_version
            })
        else:
            return jsonify({"success": False, "error": "Failed to save playlist file"}), 500
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/playlist/set-list-type", methods=["POST"])
def set_playlist_list_type():
    try:
        data = request.get_json() or {}
        name = str(data.get("name", "")).strip()
        category = str(data.get("category", "")).strip()
        list_type = str(data.get("list_type", "permanent")).strip().lower()
        expires_at = data.get("expires_at")
        start_date = data.get("start_date")
        end_date = data.get("end_date")
        start_time = data.get("start_time")
        end_time = data.get("end_time")

        if not name:
            return jsonify({"success": False, "error": "Playlist name is required"}), 400
        if list_type not in ("permanent", "temporary"):
            return jsonify({"success": False, "error": "list_type must be permanent or temporary"}), 400

        current_meta = read_playlist_meta(name)
        if not category:
            category = current_meta.get("category", "General")

        if list_type == "temporary":
            if not expires_at and not end_date:
                expires_at = (datetime.utcnow() + timedelta(days=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            expires_at = None
            start_date = None
            end_date = None
            start_time = None
            end_time = None

        ok = write_playlist_meta(
            name,
            category=category,
            list_type=list_type,
            expires_at=expires_at,
            start_date=start_date,
            end_date=end_date,
            start_time=start_time,
            end_time=end_time
        )
        if not ok:
            return jsonify({"success": False, "error": "Failed to update playlist list type"}), 500

        base_dir = os.path.dirname(os.path.abspath(__file__))
        yaml_path = os.path.join(PLAYLIST_ROOT, "playlists", f"playlist_{name}.yaml")
        if os.path.exists(yaml_path):
            try:
                with open(yaml_path, "r", encoding="utf-8") as yf:
                    ypath_data = yaml.safe_load(yf) or {}
                if isinstance(ypath_data, dict):
                    ypath_data["list_type"] = list_type
                    with open(yaml_path, "w", encoding="utf-8") as yf:
                        yaml.safe_dump(ypath_data, yf, default_flow_style=False, sort_keys=False)
            except Exception:
                pass
        return jsonify({
            "success": True,
            "category": category,
            "list_type": list_type,
            "expires_at": expires_at,
            "start_date": start_date,
            "end_date": end_date,
            "start_time": start_time,
            "end_time": end_time,
            "is_active_now": is_schedule_active_now({
                "list_type": list_type,
                "expires_at": expires_at,
                "start_date": start_date,
                "end_date": end_date,
                "start_time": start_time,
                "end_time": end_time
            })
        })
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/playlists/<path:filename>", methods=["GET"])
def api_serve_playlist_file(filename):
    base_dir = os.path.dirname(os.path.abspath(__file__))
    playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    return send_from_directory(playlists_dir, filename)

@app.route("/api/playlist/list", methods=["GET"])
def list_saved_playlists():
    try:
        cleanup_expired_playlists()
        requested_type = str(request.args.get("type", "all")).strip().lower()
        if requested_type not in ("all", "both", "permanent", "temporary"):
            requested_type = "all"

        base_dir = os.path.dirname(os.path.abspath(__file__))
        playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
        playlists = []
        if os.path.exists(playlists_dir):
            for fname in os.listdir(playlists_dir):
                if fname.startswith("playlist_") and fname.endswith(".yaml") and not ".bak." in fname:
                    pname = fname[len("playlist_"):-len(".yaml")]
                    fpath = os.path.join(playlists_dir, fname)
                    mtime = os.path.getmtime(fpath)
                    channel_count = 0
                    interval = 900
                    meta = read_playlist_meta(pname)
                    if meta.get("list_type") == "temporary" and playlist_is_expired(meta):
                        cleanup_expired_playlists()
                        continue
                    try:
                        with open(fpath, "r", encoding="utf-8") as f:
                            pdata = yaml.safe_load(f) or {}
                            if isinstance(pdata, dict):
                                streams = pdata.get("streams", [])
                                if isinstance(streams, list):
                                    channel_count = len(streams)
                                interval = pdata.get("rotation_interval_seconds", 900)
                    except Exception:
                        pass

                    if requested_type in ("permanent", "temporary") and meta.get("list_type", "permanent") != requested_type:
                        continue

                    expired = playlist_is_expired(meta)
                    expired_label = "expired" if expired else "active"
                    is_active = is_schedule_active_now(meta)
                    playlists.append({
                        "name": pname,
                        "filename": fname,
                        "channel_count": channel_count,
                        "rotation_interval": interval,
                        "modified": datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M:%S"),
                        "is_protected": pname in (ADMIN_USERNAME, "default"),
                        "category": meta.get("category", "General"),
                        "list_type": meta.get("list_type", "permanent"),
                        "start_date": meta.get("start_date"),
                        "end_date": meta.get("end_date"),
                        "start_time": meta.get("start_time"),
                        "end_time": meta.get("end_time"),
                        "expires_at": meta.get("expires_at"),
                        "expired": expired,
                        "expired_label": expired_label,
                        "is_active_now": is_active
                    })
        return jsonify({"success": True, "playlists": sorted(playlists, key=lambda x: (not x["name"] == ADMIN_USERNAME, x["name"]))})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/playlist/delete", methods=["POST"])
def delete_saved_playlist():
    try:
        data = request.get_json() or {}
        name = data.get("name", "").strip().lower()
        if not name:
            return jsonify({"success": False, "error": "Playlist name is required"}), 400
        if name in (ADMIN_USERNAME, "default"):
            return jsonify({"success": False, "error": f"Cannot delete protected playlist '{name}'"}), 403

        clean_name = "".join(c for c in name if c.isalnum() or c in ("-", "_"))
        base_dir = os.path.dirname(os.path.abspath(__file__))
        playlists_dir = os.path.join(PLAYLIST_ROOT, "playlists")
        fpath = os.path.join(playlists_dir, f"playlist_{clean_name}.yaml")
        meta_path = get_playlist_meta_file(clean_name)
        if os.path.exists(fpath):
            os.remove(fpath)
        if meta_path and os.path.exists(meta_path):
            os.remove(meta_path)
        return jsonify({"success": True, "name": clean_name})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route("/api/playlist/parse-yaml", methods=["POST"])
def parse_playlist_yaml():
    try:
        data = request.get_json() or {}
        yaml_content = data.get("yaml", "").strip()
        if not yaml_content:
            return jsonify({"success": False, "error": "YAML content is required"}), 400
        parsed = yaml.safe_load(yaml_content)
        if not isinstance(parsed, dict):
            return jsonify({"success": False, "error": "Invalid playlist format (expected object/dict)"}), 400
        return jsonify({"success": True, "playlist": parsed})
    except Exception as e:
        return jsonify({"success": False, "error": f"YAML Parse Error: {str(e)}"}), 400

@app.route("/api/playlist/remove-stream", methods=["POST"])
def remove_stream():
    data = request.get_json() or {}
    if not data.get("url"):
        return jsonify({"success": False, "error": "Invalid JSON or missing url"}), 400
        
    target_url = data.get("url").strip()
    target_user = data.get("user") or get_current_username()
    mode = data.get("mode") or request.args.get("mode") or "streamer"
    
    playlist = load_playlist(target_user=target_user, mode=mode)
    if "error" in playlist:
        return jsonify({"success": False, "error": playlist["error"]}), 500
        
    streams = playlist.get("streams", [])
    new_streams = [s for s in streams if s.get("url", "").strip() != target_url]
    
    if len(streams) == len(new_streams):
        return jsonify({"success": True, "message": "URL not found in playlist"})
        
    playlist["streams"] = new_streams
    
    if save_playlist(playlist, target_user=target_user, mode=mode):
        global playlist_version
        playlist_version = int(time.time())
        app.logger.info(f"Automatically removed broken URL: {target_url} for user {target_user} ({mode})")
        return jsonify({"success": True})
    else:
        return jsonify({"success": False, "error": "Failed to save file"}), 500

def get_canonical_youtube_watch_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return ""
    try:
        parsed = urlparse(url)
        if "youtube.com" in parsed.netloc:
            qs = parse_qs(parsed.query)
            if "v" in qs and qs["v"] and len(qs["v"][0]) == 11:
                return f"https://www.youtube.com/watch?v={qs['v'][0]}"
        m = re.search(r'(?:embed\/|youtu\.be\/|live\/|v\/|shorts\/)([a-zA-Z0-9_-]{11})', url)
        if m:
            return f"https://www.youtube.com/watch?v={m.group(1)}"
    except Exception:
        pass
    return url

def check_youtube_video(url: str) -> bool:
    watch_url = get_canonical_youtube_watch_url(url)
    oembed_url = f"https://www.youtube.com/oembed?url={watch_url}&format=json"
    try:
        r = http_pool.get(oembed_url, timeout=5)
        if r.status_code == 200:
            return True
        if watch_url != url:
            r_orig = http_pool.get(f"https://www.youtube.com/oembed?url={url}&format=json", timeout=5)
            if r_orig.status_code == 200:
                return True
        return False
    except Exception:
        return False

def check_youtube_channel_live(channel_id: str) -> bool:
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
    }
    try:
        url = f"https://www.youtube.com/channel/{channel_id}/live"
        r = http_pool.get(url, headers=headers, timeout=5)
        if r.status_code != 200:
            return False
            
        text = r.text
        idx = text.find('ytInitialData =')
        if idx == -1:
            return False
            
        start = text.find('{', idx)
        brace_count = 0
        end = start
        for i in range(start, len(text)):
            if text[i] == '{':
                brace_count += 1
            elif text[i] == '}':
                brace_count -= 1
                if brace_count == 0:
                    end = i + 1
                    break
        data = json.loads(text[start:end])
        
        def find_first_video_id(d):
            if isinstance(d, dict):
                if 'videoId' in d:
                    return d['videoId']
                for k, v in d.items():
                    res = find_first_video_id(v)
                    if res:
                        return res
            elif isinstance(d, list):
                for item in d:
                    res = find_first_video_id(item)
                    if res:
                        return res
            return None
            
        video_id = find_first_video_id(data)
        if not video_id:
            return False
            
        watch_url = f"https://www.youtube.com/watch?v={video_id}"
        r_watch = http_pool.get(watch_url, headers=headers, timeout=5)
        text_watch = r_watch.text
        
        idx_p = text_watch.find('ytInitialPlayerResponse =')
        if idx_p == -1:
            idx_p = text_watch.find('ytInitialPlayerResponse=')
        if idx_p == -1:
            return False
            
        start_p = text_watch.find('{', idx_p)
        brace_count = 0
        end_p = start_p
        for i in range(start_p, len(text_watch)):
            if text_watch[i] == '{':
                brace_count += 1
            elif text_watch[i] == '}':
                brace_count -= 1
                if brace_count == 0:
                    end_p = i + 1
                    break
        data_p = json.loads(text_watch[start_p:end_p])
        is_live_content = data_p.get('videoDetails', {}).get('isLiveContent', False)
        return bool(is_live_content)
    except Exception:
        return False

def check_generic_url(url: str) -> bool:
    try:
        ok, _, _, _ = probe_stream_url(url, timeout=7.0)
        return ok
    except Exception:
        return False

def check_url_validity(url: str) -> bool:
    if ("youtube.com" in url or "youtu.be" in url) and "live_stream?channel=" not in url:
        return check_youtube_video(url)
    elif "live_stream?channel=" in url:
        try:
            parsed = urlparse(url)
            channel_id = parse_qs(parsed.query).get("channel", [None])[0]
            if channel_id:
                return check_youtube_channel_live(channel_id)
        except Exception:
            pass
        return False
    return check_generic_url(url)

@app.route("/api/playlist/check-validity", methods=["POST"])
def check_playlist_validity():
    data = request.get_json()
    if not data or "streams" not in data:
        return jsonify({"success": False, "error": "Missing streams data"}), 400
        
    streams = data.get("streams", [])
    if not streams:
        return jsonify({"success": True, "broken_urls": []})
        
    broken_urls = []
    
    def validate_stream(stream):
        url = stream.get("url", "").strip()
        if not url:
            return None
        if not check_url_validity(url):
            return url
        return None
        
    with ThreadPoolExecutor(max_workers=10) as executor:
        results = executor.map(validate_stream, streams)
        for r in results:
            if r:
                broken_urls.append(r)
                
    return jsonify({"success": True, "broken_urls": broken_urls})

@app.route("/api/playlist/check-single-url", methods=["GET"])
def check_single_url():
    url = request.args.get("url")
    if not url:
        return jsonify({"valid": False, "error": "Missing url parameter"}), 400
        
    valid = check_url_validity(url.strip())
    return jsonify({"url": url, "valid": valid})

def fetch_title_for_url(url: str) -> str:
    url = url.strip()
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
    }
    if ("youtube.com" in url or "youtu.be" in url) and "live_stream?channel=" not in url:
        try:
            watch_url = get_canonical_youtube_watch_url(url)
            oembed_url = f"https://www.youtube.com/oembed?url={watch_url}&format=json"
            r = http_pool.get(oembed_url, timeout=5)
            if r.status_code == 200:
                data = r.json()
                if data.get("title"):
                    return data["title"]
        except Exception:
            pass
    elif "live_stream?channel=" in url:
        try:
            parsed = urlparse(url)
            channel_id = parse_qs(parsed.query).get("channel", [None])[0]
            if channel_id:
                r_chan = http_pool.get(f"https://www.youtube.com/channel/{channel_id}", headers=headers, timeout=5)
                if r_chan.status_code == 200:
                    import re
                    m = re.search(r'<title>(.*?)</title>', r_chan.text)
                    if m:
                        return m.group(1).replace(" - YouTube", "").strip()
        except Exception:
            pass
    try:
        r = http_pool.get(url, headers=headers, timeout=5)
        if r.status_code == 200:
            import re
            m = re.search(r'<title>(.*?)</title>', r.text)
            if m:
                from html import unescape
                return unescape(m.group(1).strip())
    except Exception:
        pass
    return ""

@app.route("/api/playlist/get-title", methods=["GET"])
def get_title():
    url = request.args.get("url")
    if not url:
        return jsonify({"title": ""})
    title = fetch_title_for_url(url)
    return jsonify({"title": title})

def search_youtube(query, max_results=16):
    import urllib.request
    import urllib.parse
    import re
    import json
    
    try:
        search_url = f"https://www.youtube.com/results?search_query={urllib.parse.quote(query)}"
        req = urllib.request.Request(
            search_url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            
        match = re.search(r'var ytInitialData = ({.*?});</script>', html)
        if not match:
            return []
            
        data = json.loads(match.group(1))
        results = []
        
        contents = data.get("contents", {}).get("twoColumnSearchResultsRenderer", {}).get("primaryContents", {}).get("sectionListRenderer", {}).get("contents", [])
        for section in contents:
            item_section = section.get("itemSectionRenderer", {}).get("contents", [])
            for item in item_section:
                video = item.get("videoRenderer")
                if not video:
                    continue
                vid = video.get("videoId")
                if not vid:
                    continue
                title = video.get("title", {}).get("runs", [{}])[0].get("text", "")
                channel = video.get("ownerText", {}).get("runs", [{}])[0].get("text", "")
                thumb = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
                badges = video.get("badges", [])
                is_live = any(b.get("metadataBadgeRenderer", {}).get("style") == "BADGE_STYLE_TYPE_LIVE_NOW" for b in badges)
                
                results.append({
                    "videoId": vid,
                    "title": title,
                    "channel": channel,
                    "thumbnail": thumb,
                    "url": f"https://www.youtube.com/watch?v={vid}",
                    "embed_url": f"https://www.youtube.com/embed/{vid}",
                    "is_live": is_live
                })
                if len(results) >= max_results:
                    break
            if len(results) >= max_results:
                break
        return results
    except Exception as e:
        app.logger.error(f"YouTube search error for '{query}': {e}")
        return []

@app.route("/api/youtube/search", methods=["GET"])
def search_youtube_endpoint():
    query = request.args.get("q", "").strip()
    if not query or len(query) < 2:
        return jsonify([])
    results = search_youtube(query)
    return jsonify(results)

_pluto_cache = {"channels": [], "categories": [], "expires": 0}
_tubi_cache = {"channels": [], "categories": [], "expires": 0}

def get_pluto_channels():
    now = time.time()
    if _pluto_cache["channels"] and now < _pluto_cache["expires"]:
        return _pluto_cache["channels"], _pluto_cache["categories"]
    try:
        # Load verified Pluto US M3U playlist backed by valid Samsung TV Plus tokens
        m3u_url = "https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/plutotv_us.m3u"
        res = http_pool.get(m3u_url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}, timeout=10)
        lines = res.text.splitlines()

        # Fetch rich channel summaries from Pluto API where available
        summaries = {}
        try:
            api_res = http_pool.get("https://api.pluto.tv/v2/channels", headers={"User-Agent": "Mozilla/5.0"}, timeout=6)
            if api_res.status_code == 200:
                for c in api_res.json():
                    cid = c.get("_id")
                    if cid:
                        summaries[cid] = c.get("summary", "")
        except Exception as e:
            app.logger.warning(f"Failed to fetch Pluto summaries from API: {e}")

        live_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pluto_live_channels.json")
        live_ids = set()
        if os.path.exists(live_file):
            try:
                import json
                with open(live_file, "r") as f:
                    live_ids = set(json.load(f))
            except Exception as e:
                app.logger.warning(f"Failed to read pluto_live_channels.json: {e}")

        channels = []
        cats = set()
        import re
        for i in range(len(lines)):
            if lines[i].startswith("#EXTINF"):
                info = lines[i]
                stream_url = lines[i+1].strip() if i+1 < len(lines) else ""
                if not stream_url or stream_url.startswith("#"):
                    continue
                logo_m = re.search(r'tvg-logo="([^"]+)"', info)
                group_m = re.search(r'group-title="([^"]+)"', info)
                id_m = re.search(r'channel-id="([^"]+)"', info) or re.search(r'tvg-id="([^"]+)"', info) or re.search(r'plu-([a-f0-9]{24})', stream_url)
                
                ch_id = id_m.group(1).strip() if id_m else ""
                if live_ids and ch_id not in live_ids:
                    # Skip DRM-restricted channels that only stream the Pluto logo bouncing dots bumper animation
                    continue

                name = info.split(",")[-1].strip()
                cat = group_m.group(1).strip() if group_m else "General"
                logo = logo_m.group(1).strip() if logo_m else ""
                summary = summaries.get(ch_id, "")
                
                if name and stream_url:
                    channels.append({
                        "id": ch_id,
                        "name": name,
                        "category": cat,
                        "summary": summary,
                        "logo": logo,
                        "url": stream_url
                    })
                    cats.add(cat)

        _pluto_cache["channels"] = channels
        _pluto_cache["categories"] = sorted(list(cats))
        _pluto_cache["expires"] = now + 3600
        return _pluto_cache["channels"], _pluto_cache["categories"]
    except Exception as e:
        app.logger.error(f"Error loading Pluto channels: {e}")
        return _pluto_cache.get("channels", []), _pluto_cache.get("categories", [])

@app.route("/api/pluto/categories", methods=["GET"])
def get_pluto_categories_endpoint():
    _, cats = get_pluto_channels()
    return jsonify(cats)

@app.route("/api/pluto/search", methods=["GET"])
def search_pluto_endpoint():
    query = request.args.get("q", "").strip().lower()
    cat_filter = request.args.get("category", "").strip().lower()
    channels, _ = get_pluto_channels()
    
    results = []
    for ch in channels:
        if cat_filter and ch.get("category", "").lower() != cat_filter:
            continue
        if query:
            if (query not in ch.get("name", "").lower() and 
                query not in ch.get("summary", "").lower() and 
                query not in ch.get("category", "").lower()):
                continue
        results.append(ch)
        if len(results) >= 100:
            break
            
    return jsonify(results)

def get_tubi_channels():
    now = time.time()
    if _tubi_cache["channels"] and now < _tubi_cache["expires"]:
        return _tubi_cache["channels"], _tubi_cache["categories"]

    tubi_urls = [
        "https://raw.githubusercontent.com/BuddyChewChew/tubi-scraper/main/tubi_playlist.m3u",
        "https://raw.githubusercontent.com/BuddyChewChew/app-m3u-generator/main/playlists/tubi_all.m3u"
    ]
    local_paths = [
        os.path.join(PLAYLIST_ROOT, "playlists/tubi_playlist.m3u"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../stream_iptv/playlists/tubi_playlist.m3u"),
        "/app/stream_iptv/playlists/tubi_playlist.m3u"
    ]

    # Load curated channel-to-category dictionary
    curated_cats = {}
    cat_json = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tubi_categories.json")
    if os.path.exists(cat_json):
        try:
            with open(cat_json, "r", encoding="utf-8") as f:
                curated_cats = json.load(f)
        except Exception as e:
            app.logger.warning(f"Failed loading tubi_categories.json: {e}")

    def infer_tubi_cat(channel_name):
        nl = channel_name.lower()
        if any(w in nl for w in ["news", "fox 5", "fox 4", "fox 2", "fox 11", "fox 9", "kdfw", "wttg", "ktvb", "bloomberg", "scripps", "livenow", "abc news", "cbs news", "nbc news", "newsmax", "weather"]):
            return "National News" if any(w in nl for w in ["abc", "livenow", "scripps", "bloomberg", "newsmax", "cbs", "nbc"]) else "Local News"
        if any(w in nl for w in ["sports", "espn", "bein", "golf", "pga", "racing", "pac-12", "acc", "stadium", "fubo", "fight", "wrestling", "poker", "motorsport", "boxing", "fite"]):
            return "Sports On Now"
        if any(w in nl for w in ["crime", "forensic", "court tv", "unsolved", "murder", "cops", "justice", "interrogation"]):
            return "True Crime"
        if any(w in nl for w in ["comedy", "funny", "laugh", "anger management", "are we there yet"]):
            return "Comedy"
        if any(w in nl for w in ["movie", "film", "cinema", "hollywood", "action", "western"]):
            return "Movie Channels"
        if any(w in nl for w in ["kid", "cartoon", "family", "baby", "children", "teen"]):
            return "Kids & Family"
        if any(w in nl for w in ["eat", "kitchen", "cooking", "food", "tastemade"]):
            return "Good Eats"
        if any(w in nl for w in ["sci-fi", "horror", "alien", "ghost", "paranormal", "dust", "supernatural"]):
            return "Sci-Fi & Supernatural"
        if any(w in nl for w in ["classic", "baywatch", "retro", "vintage"]):
            return "Classic TV"
        if any(w in nl for w in ["drama", "heartland", "nashville", "degrassi"]):
            return "TV Dramas"
        return "Entertainment"

    m3u_text = ""
    # 1. Fetch from live upstream scrapers
    for url in tubi_urls:
        try:
            res = http_pool.get(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}, timeout=10)
            if res.status_code == 200 and "#EXTINF" in res.text:
                m3u_text = res.text
                break
        except Exception as e:
            app.logger.warning(f"Failed fetching Tubi from {url}: {e}")

    # 2. Also load channels from local cached playlist
    local_channels_raw = ""
    for lp in local_paths:
        if os.path.exists(lp):
            try:
                with open(lp, "r", encoding="utf-8") as f:
                    c = f.read()
                    if "#EXTINF" in c:
                        local_channels_raw = c
                        break
            except Exception:
                pass

    # 3. Parse M3U text and resolve categories
    source_texts = [t for t in [m3u_text, local_channels_raw] if t]
    if source_texts:
        try:
            import re
            channels = []
            seen_names = set()
            cats = set()

            for text in source_texts:
                lines = text.splitlines()
                for i in range(len(lines)):
                    if lines[i].startswith("#EXTINF"):
                        info = lines[i]
                        stream_url = lines[i+1].strip() if i+1 < len(lines) else ""
                        if not stream_url or stream_url.startswith("#"):
                            continue
                        name = info.split(",")[-1].strip()
                        if not name or name.lower() in seen_names:
                            continue

                        logo_m = re.search(r'tvg-logo="([^"]+)"', info)
                        group_m = re.search(r'group-title="([^"]+)"', info)
                        cat = group_m.group(1).strip() if group_m else ""

                        # If category is missing, generic, or "Other", resolve via curated dictionary or keyword inference
                        if not cat or cat.lower() in ("other", "general"):
                            cat = curated_cats.get(name.lower(), "") or infer_tubi_cat(name)

                        logo = logo_m.group(1).strip() if logo_m else ""
                        channels.append({
                            "name": name,
                            "category": cat,
                            "logo": logo,
                            "url": stream_url
                        })
                        seen_names.add(name.lower())
                        if cat and cat.lower() not in ("other", "general"):
                            cats.add(cat)

            if channels:
                valid_cats = sorted(list(cats))
                if not valid_cats:
                    valid_cats = ["Entertainment"]
                _tubi_cache["channels"] = channels
                _tubi_cache["categories"] = valid_cats
                _tubi_cache["expires"] = now + 3600

                # Upsert into channels.db for preflight and healing
                try:
                    default_path = get_playlist_path("default")
                    db_file = os.path.join(os.path.dirname(default_path), "channels.db")
                    if not os.path.exists(db_file):
                        db_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../channels.db")
                    if os.path.exists(db_file):
                        with sqlite3.connect(db_file, timeout=5) as conn:
                            cur = conn.cursor()
                            cur.executemany("""
                                INSERT OR IGNORE INTO channels (name, url, category, logo, provider, is_playable, last_checked)
                                VALUES (?, ?, ?, ?, 'Tubi', 1, ?)
                            """, [(c["name"], c["url"], c["category"], c.get("logo", ""), int(time.time())) for c in channels])
                            conn.commit()
                except Exception as dbe:
                    app.logger.warning(f"Could not populate Tubi channels in DB: {dbe}")

                return _tubi_cache["channels"], _tubi_cache["categories"]
        except Exception as pe:
            app.logger.error(f"Error parsing Tubi M3U: {pe}")

    # 4. Fallback to channels.db
    try:
        channels = []
        cats = set()
        default_path = get_playlist_path("default")
        db_file = os.path.join(os.path.dirname(default_path), "channels.db")
        if not os.path.exists(db_file):
            db_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "../channels.db")
        if os.path.exists(db_file):
            with sqlite3.connect(db_file, timeout=5) as conn:
                c = conn.cursor()
                c.execute("SELECT name, url, category, logo FROM channels WHERE url LIKE '%tubi%' OR provider LIKE '%tubi%'")
                for row in c.fetchall():
                    c_name, c_url, c_cat, c_logo = row
                    if not c_cat or c_cat.lower() in ("other", "general"):
                        c_cat = curated_cats.get(c_name.lower(), "") or infer_tubi_cat(c_name)
                    channels.append({
                        "name": c_name,
                        "url": c_url,
                        "category": c_cat,
                        "logo": c_logo or ""
                    })
                    if c_cat and c_cat.lower() not in ("other", "general"):
                        cats.add(c_cat)
        if channels:
            valid_cats = sorted(list(cats)) or ["Entertainment"]
            _tubi_cache["channels"] = channels
            _tubi_cache["categories"] = valid_cats
            _tubi_cache["expires"] = now + 1800
            return _tubi_cache["channels"], _tubi_cache["categories"]
    except Exception as dbe:
        app.logger.error(f"Error loading Tubi channels from DB: {dbe}")

    return _tubi_cache.get("channels", []), _tubi_cache.get("categories", [])

@app.route("/api/tubi/categories", methods=["GET"])
def get_tubi_categories_endpoint():
    _, cats = get_tubi_channels()
    return jsonify(cats)

@app.route("/api/tubi/search", methods=["GET"])
def search_tubi_endpoint():
    query = request.args.get("q", "").strip().lower()
    cat_filter = request.args.get("category", "").strip().lower()
    channels, _ = get_tubi_channels()
    
    results = []
    for ch in channels:
        if cat_filter and ch.get("category", "").lower() != cat_filter:
            continue
        if query:
            if (query not in ch.get("name", "").lower() and 
                query not in ch.get("category", "").lower()):
                continue
        results.append(ch)
        if len(results) >= 100:
            break
            
    return jsonify(results)

PLAYLIST_VERIFY_STATE = {
    "status": "idle",
    "progress": "Ready",
    "message": "",
    "error": None,
    "started_at": 0,
    "finished_at": 0,
    "summary": ""
}
PLAYLIST_VERIFY_LOCK = threading.Lock()

def _bg_run_playlist_verify():
    import subprocess
    with PLAYLIST_VERIFY_LOCK:
        PLAYLIST_VERIFY_STATE.update({
            "status": "running",
            "progress": "Validating channels & healing broken streams...",
            "message": "Running iptv_cli.py check-active",
            "error": None,
            "started_at": time.time(),
            "finished_at": 0,
            "summary": ""
        })

    try:
        script_candidates = [
            "/app/iptv_cli.py",
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "../iptv_cli.py")
        ]
        script_path = None
        for cand in script_candidates:
            if os.path.exists(cand):
                script_path = os.path.abspath(cand)
                break

        if not script_path:
            raise FileNotFoundError("iptv_cli.py script not found")

        proc = subprocess.run(
            [sys.executable, script_path, "check-active"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=180
        )
        output = proc.stdout or ""
        summary_line = "Verification completed"
        for line in output.splitlines():
            if "Verification Summary:" in line:
                summary_line = line.strip()
                break

        with PLAYLIST_VERIFY_LOCK:
            PLAYLIST_VERIFY_STATE.update({
                "status": "done" if proc.returncode == 0 else "error",
                "progress": "Completed",
                "message": summary_line,
                "summary": summary_line,
                "error": None if proc.returncode == 0 else f"Exited with code {proc.returncode}",
                "finished_at": time.time()
            })
    except Exception as e:
        app.logger.error(f"Playlist verify error: {e}")
        with PLAYLIST_VERIFY_LOCK:
            PLAYLIST_VERIFY_STATE.update({
                "status": "error",
                "progress": "Failed",
                "error": str(e),
                "finished_at": time.time()
            })

def run_background_playlist_check():
    """Runs iptv_cli.py check-active asynchronously in a background thread."""
    t = threading.Thread(target=_bg_run_playlist_verify, daemon=True)
    t.start()

@app.route("/api/playlist/verify", methods=["POST", "GET"])
@app.route("/stream-iptv/api/playlist/verify", methods=["POST", "GET"])
def api_playlist_verify():
    with PLAYLIST_VERIFY_LOCK:
        if PLAYLIST_VERIFY_STATE.get("status") == "running":
            return jsonify({
                "success": True,
                "status": "running",
                "message": "Playlist verification already in progress."
            })

    t = threading.Thread(target=_bg_run_playlist_verify, daemon=True)
    t.start()
    return jsonify({
        "success": True,
        "status": "started",
        "message": "Playlist health check & healing started."
    })

@app.route("/api/playlist/verify-status", methods=["GET"])
@app.route("/stream-iptv/api/playlist/verify-status", methods=["GET"])
def api_playlist_verify_status():
    with PLAYLIST_VERIFY_LOCK:
        return jsonify(dict(PLAYLIST_VERIFY_STATE))

@app.route("/api/channel/preflight", methods=["POST", "GET"])
@app.route("/stream-iptv/api/channel/preflight", methods=["POST", "GET"])
def api_channel_preflight():
    """
    Validates playability of an upcoming channel stream before rotation.
    If broken, auto-discovers a working replacement link from channels.db,
    updates channels.db and playlist.yaml, and returns the verified working stream.
    """
    if request.method == "POST":
        data = request.get_json(silent=True) or {}
        url = data.get("url") or request.form.get("url") or ""
        name = data.get("name") or request.form.get("name") or ""
        target_user = data.get("user") or request.form.get("user") or ADMIN_USERNAME
    else:
        url = request.args.get("url", "").strip()
        name = request.args.get("name", "").strip()
        target_user = request.args.get("user", ADMIN_USERNAME).strip()

    if not url:
        return jsonify({"playable": False, "error": "Missing URL parameter"}), 400

    url = sanitize_pluto_url(unmask_credentials(url))
    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")

    # Step 1: Probe current channel URL
    probe_url = url

    ok, code, msg, lat = probe_stream_url(probe_url, timeout=3.5)

    def update_db_status(target_u, playable, err_text, latency=0):
        try:
            db.update_channel_status(target_u, playable, latency=latency, err_text=err_text, db_path=db_path)
        except Exception as e:
            app.logger.warning(f"Failed to update channel status: {e}")

    if ok:
        update_db_status(url, True, "OK", lat)
        return jsonify({
            "playable": True,
            "healed": False,
            "url": url,
            "latency_ms": lat,
            "status": "Healthy"
        })

    # Step 2: Channel broken - update status and attempt healing from database
    update_db_status(url, False, f"{code} {msg}", lat)
    app.logger.info(f"[Preflight] Channel '{name}' ({url}) probe failed: {code} {msg}. Searching database for replacement...")

    healed_url = None
    healed_prov = None
    healed_name = None

    if name:
        try:
            candidates = db.find_replacement_channel(name, url, db_path=db_path)

            # Probe candidates to find first healthy replacement
            for cand_url, cand_name, cand_prov in candidates:
                cand_probe = cand_url
                cand_ok, cand_code, cand_msg, cand_lat = probe_stream_url(cand_probe, timeout=3.0)
                if cand_ok:
                    healed_url = cand_url
                    healed_prov = cand_prov
                    healed_name = cand_name
                    update_db_status(cand_url, True, "Auto-healed active replacement", cand_lat)
                    app.logger.info(f"[Preflight] Successfully healed '{name}' with: {cand_name} ({cand_url})")
                    break
        except Exception as db_err:
            app.logger.error(f"[Preflight] Error querying database: {db_err}")

    if healed_url:
        # Update user's active playlist
        try:
            pl = load_playlist(target_user=target_user)
            modified = False
            for s in pl.get("streams", []):
                if s.get("url") == url or (name and (s.get("name") == name or s.get("title") == name)):
                    s["url"] = healed_url
                    if healed_prov:
                        s["provider"] = healed_prov
                    s.pop("offline", None)
                    s.pop("is_offline", None)
                    modified = True
                    break
            if modified:
                save_playlist(pl, target_user=target_user)
                global playlist_version
                playlist_version = int(time.time())
        except Exception as save_err:
            app.logger.warning(f"[Preflight] Could not save healed URL to playlist: {save_err}")

        return jsonify({
            "playable": True,
            "healed": True,
            "url": healed_url,
            "provider": healed_prov,
            "channel_name": healed_name,
            "original_url": url,
            "status": "Auto-healed with working replacement from DB"
        })

    return jsonify({
        "playable": False,
        "healed": False,
        "url": url,
        "error": f"{code} {msg}",
        "status": "Offline - No working replacement in database"
    })

@app.route("/api/proxy", methods=["GET"])
@app.route("/stream-iptv/api/proxy", methods=["GET"])
def proxy_request():
    target_url = request.args.get("url")
    b64_url = request.args.get("b64")
    
    import base64
    from urllib.parse import urljoin, quote
    import re
    from flask import Response
    
    if b64_url:
        try:
            b64_url = b64_url.replace('-', '+').replace('_', '/')
            padding = len(b64_url) % 4
            if padding:
                b64_url += '=' * (4 - padding)
            target_url = base64.b64decode(b64_url.encode('utf-8')).decode('utf-8')
        except Exception as e:
            return jsonify({"error": f"Invalid base64: {e}"}), 400
            
    if not target_url:
        return jsonify({"error": "Missing URL parameter"}), 400
    
    target_url = sanitize_pluto_url(unmask_credentials(target_url))

    provider = provider_of_url(target_url)
    if provider_limit(provider):
        client = client_label(request)
        if target_url.split("?")[0].endswith(".m3u8"):
            if not release_provider_streams(provider, f"HLS channel requested by {client}", client):
                return jsonify({"error": f"{provider} connection is in use by the kiosk"}), 503
        elif is_live_channel_url(target_url):
            hub_resp = serve_from_hub(target_url, provider, client)
            if hub_resp is not None:
                return hub_resp

    seg = cached_segment(target_url)
    if seg:
        cached = Response(seg[1], status=200, content_type=seg[0])
        cached.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        cached.headers["Access-Control-Allow-Origin"] = "*"
        return cached

    try:
        app.logger.info(f"Proxying request to: {mask_credentials(target_url)}")
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        
        # Stream response for binary segments using global session for Keep-Alive
        res = http_pool.get(target_url, headers=headers, timeout=15, stream=True)
        content_type = res.headers.get("Content-Type", "")
        
        # Forward upstream HTTP errors immediately with CORS header
        if res.status_code >= 400:
            err_resp = Response(res.content, status=res.status_code, content_type=content_type or 'text/plain')
            err_resp.headers["Access-Control-Allow-Origin"] = "*"
            return err_resp

        is_key = target_url.lower().split('?')[0].endswith('.key')
        
        # Fast path for image logos, channel icons, and binary decryption keys
        if is_key or "image/" in content_type.lower() or target_url.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.key')):
            response = Response(res.content, status=res.status_code, content_type=content_type or 'application/octet-stream')
            response.headers["Cache-Control"] = "public, max-age=86400"
            response.headers["Access-Control-Allow-Origin"] = "*"
            return response

        # Check if this is an HLS stream playlist (.m3u8) and NOT an IPTV channel list playlist or direct binary video stream
        is_video_stream = "video/" in content_type.lower() or "audio/" in content_type.lower() or "octet-stream" in content_type.lower()
        is_m3u8 = (
            not is_key
            and not is_video_stream
            and ("mpegurl" in content_type.lower() or "application/vnd.apple.mpegurl" in content_type.lower() or target_url.split('?')[0].endswith('.m3u8'))
            and not ("/playlist/" in target_url or "m3u_plus" in target_url)
        )
        
        if is_m3u8:
            text_content = res.text
            if text_content.strip().startswith(('<!DOCTYPE', '<html', '<head', '<?xml')):
                err_resp = Response("Upstream returned HTML/XML error page instead of stream manifest", status=502, content_type="text/plain")
                err_resp.headers["Access-Control-Allow-Origin"] = "*"
                return err_resp
            lines = text_content.splitlines()
            rewritten_lines = []
            segment_urls = []
            is_media_playlist = "#EXTINF" in text_content
            
            for line in lines:
                line_str = line.strip()
                if not line_str:
                    rewritten_lines.append(line)
                    continue
                if line_str.startswith('#'):
                    # Rewrite key and subtitle URI attributes using base64
                    def repl(match):
                        uri = match.group(1)
                        if not uri.startswith('http'):
                            uri = urljoin(res.url, uri)
                        if uri.startswith('https://') and any(cdn in uri for cdn in ('plutotv.net', 'tubitv', 'akamaized.net', 'cloudfront.net', 'fastly.net', 'llnwi.net')):
                            return f'URI="{uri}"'
                        b64_uri = base64.b64encode(mask_credentials(uri).encode('utf-8')).decode('utf-8')
                        return f'URI="/stream-iptv/api/proxy?b64={b64_uri}"'
                    line_str = re.sub(r'URI="([^"]+)"', repl, line_str)
                    rewritten_lines.append(line_str)
                else:
                    # Resolve segment/variant relative URLs
                    if not line_str.startswith('http'):
                        abs_url = urljoin(res.url, line_str)
                    else:
                        abs_url = line_str
                    # Direct CDN fast-path for public HTTPS CDNs with CORS (bypasses Python proxy bottleneck)
                    if abs_url.startswith('https://') and any(cdn in abs_url for cdn in ('plutotv.net', 'tubitv', 'akamaized.net', 'cloudfront.net', 'fastly.net', 'llnwi.net')):
                        rewritten_lines.append(abs_url)
                    else:
                        if is_media_playlist:
                            segment_urls.append(abs_url)
                        # Route through proxy using base64
                        b64_abs = base64.b64encode(mask_credentials(abs_url).encode('utf-8')).decode('utf-8')
                        rewritten_lines.append(f"/stream-iptv/api/proxy?b64={b64_abs}")
            
            if segment_urls:
                prefetch_segments(segment_urls)
            rewritten_text = "\n".join(rewritten_lines)
            response = app.make_response(rewritten_text)
            response.headers["Content-Type"] = "application/x-mpegURL"
        else:
            # Stream binary content (.ts, .aac, mp4, etc.)
            from flask import Response, stream_with_context
            def generate_stream():
                try:
                    for chunk in res.iter_content(chunk_size=65536):
                        if chunk:
                            yield chunk
                except (GeneratorExit, ConnectionResetError, BrokenPipeError):
                    pass
                except Exception as e:
                    app.logger.warning(f"Proxy stream ended: {e}")
                finally:
                    res.close()

            out_content_type = content_type
            if is_video_stream or target_url.endswith('.ts') or is_live_channel_url(target_url):
                out_content_type = 'video/mp2t'

            response = Response(stream_with_context(generate_stream()), status=res.status_code, content_type=out_content_type or 'video/mp2t')
            content_length = res.headers.get("Content-Length")
            if content_length:
                response.headers["Content-Length"] = content_length
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
            response.headers["X-Accel-Buffering"] = "no"
            
        response.headers["Access-Control-Allow-Origin"] = "*"
        return response
    except Exception as e:
        app.logger.error(f"Proxy error: {mask_credentials(str(e))}")
        return jsonify({"error": str(e)}), 500

# --- HLS segment prefetch ----------------------------------------------------
# Far-away sources (e.g. Indonesian channels from the US) answer each segment
# request in 1-2 s regardless of size, so a player fetching one segment at a time
# cannot keep up with 2 s segments. When the proxy serves a media playlist it
# downloads the newest segments in parallel into a small in-memory cache; the
# player's own segment requests are then served from memory.
SEG_PREFETCH_COUNT = 6                 # kiosk starts liveSyncDurationCount=5 segments back
SEG_CACHE_TTL = 120                    # seconds
SEG_CACHE_MAX_BYTES = 256 * 1024 * 1024
_seg_cache = collections.OrderedDict()  # url -> (expires, content_type, data)
_seg_cache_bytes = 0
_seg_inflight = {}                      # url -> threading.Event
_seg_lock = threading.Lock()
_seg_pool = ThreadPoolExecutor(max_workers=12, thread_name_prefix="seg-prefetch")
_SEG_HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"}


def _seg_store(url, content_type, data):
    global _seg_cache_bytes
    now = time.time()
    with _seg_lock:
        _seg_cache[url] = (now + SEG_CACHE_TTL, content_type, data)
        _seg_cache_bytes += len(data)
        while _seg_cache and (_seg_cache_bytes > SEG_CACHE_MAX_BYTES or next(iter(_seg_cache.values()))[0] < now):
            _, (_, _, old) = _seg_cache.popitem(last=False)
            _seg_cache_bytes -= len(old)


def _seg_fetch(url):
    try:
        res = http_pool.get(url, headers=_SEG_HEADERS, timeout=(10, 60))
        if res.status_code == 200 and res.content:
            _seg_store(url, res.headers.get("Content-Type") or "video/mp2t", res.content)
    except Exception as e:
        app.logger.debug(f"Segment prefetch failed: {mask_credentials(str(e))}")
    finally:
        with _seg_lock:
            ev = _seg_inflight.pop(url, None)
        if ev:
            ev.set()


def prefetch_segments(urls):
    for url in urls[-SEG_PREFETCH_COUNT:]:
        with _seg_lock:
            if url in _seg_cache or url in _seg_inflight:
                continue
            _seg_inflight[url] = threading.Event()
        _seg_pool.submit(_seg_fetch, url)


def cached_segment(url, wait=60):
    """(content_type, data) for a cached or in-flight segment, else None."""
    with _seg_lock:
        hit = _seg_cache.get(url)
        ev = None if hit else _seg_inflight.get(url)
    if hit:
        return hit[1], hit[2]
    if ev and ev.wait(wait):
        with _seg_lock:
            hit = _seg_cache.get(url)
        if hit:
            return hit[1], hit[2]
    return None


# --- Provider connection limits and shared upstreams ---------------------------
# IPTV accounts cap simultaneous connections (often max_connections=1). The
# proxy keeps at most `limit` upstream connections per limited provider:
#   - viewers of the same live channel share one upstream (fan-out)
#   - a new channel on a full provider closes the oldest one first (newest wins),
#     so channel changes never trip the provider's limit
#   - an upstream closes HUB_IDLE_GRACE seconds after its last viewer leaves
# Probes (preflight, playlist checks) never open a stream on a busy provider.
import queue

HUB_IDLE_GRACE = 5
STALL_EVICT_SECONDS = 20
_PROVIDER_LIMITS = {}  # refreshed from the Xtream account API below
# PROVIDER_LIMITS caps what the proxy may use, e.g. "My Provider=1" leaves one of the
# account's two connections free for devices that use the provider directly.
_LIMIT_CAPS = {}
for _item in os.environ.get("PROVIDER_LIMITS", "").split(","):
    if "=" in _item:
        _k, _v = _item.rsplit("=", 1)
        _LIMIT_CAPS[_k.strip()] = int(_v)
_PROVIDER_LIMITS.update(_LIMIT_CAPS)
_hubs = {}
_hubs_lock = threading.Lock()
_LIVE_PATH_RE = re.compile(r"^/(?:live/)?[^/]+/[^/]+/\d+(?:\.ts)?$")


def provider_of_url(url):
    try:
        parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        if parent_dir not in sys.path:
            sys.path.insert(0, parent_dir)
        from anti_collision import get_stream_provider
        return get_stream_provider({"url": url})
    except Exception:
        return urlparse(url).netloc


def provider_limit(provider):
    return _PROVIDER_LIMITS.get(provider)


def is_live_channel_url(url):
    """Xtream-style continuous live stream (host/[live/]user/pass/<id>[.ts])."""
    return bool(_LIVE_PATH_RE.match(urlparse(url).path))


def _set_account_limit(provider, max_connections):
    """Record an account's max_connections, never above the PROVIDER_LIMITS cap."""
    _PROVIDER_LIMITS[provider] = min(max_connections, _LIMIT_CAPS.get(provider, max_connections))


def _refresh_provider_limits():
    """Read max_connections for Xtream providers from their account API (hourly)."""
    while True:
        try:
            cfg = load_provider_config(ADMIN_USERNAME)
            for prov in cfg.get("providers", []):
                if prov.get("type") == "xtream" and prov.get("server") and prov.get("username"):
                    r = http_pool.get(f"{prov['server'].rstrip('/')}/player_api.php",
                                      params={"username": prov["username"], "password": prov.get("password", "")},
                                      headers=_SEG_HEADERS, timeout=15)
                    info = r.json().get("user_info", {})
                    name = provider_of_url(prov["server"] + "/live/x/y/1.ts")
                    if str(info.get("max_connections", "")).isdigit():
                        _set_account_limit(name, int(info["max_connections"]))
        except Exception as e:
            app.logger.warning(f"Provider limit refresh failed: {mask_credentials(str(e))}")
        time.sleep(3600)


threading.Thread(target=_refresh_provider_limits, daemon=True, name="provider-limits").start()


def _record_capacity_metrics():
    """Every minute: proxy connections in use vs each provider's limit, and active players."""
    while True:
        time.sleep(60)
        try:
            with _hubs_lock:
                hubs = [h for h in _hubs.values() if not h.closed]
            now_ns = int(time.time() * 1e9)
            lines = []
            for name in set(_PROVIDER_LIMITS) | {h.provider for h in hubs}:
                mine = [h for h in hubs if h.provider == name]
                limit = _PROVIDER_LIMITS.get(name)
                fields = [f"in_use={len(mine)}i", f"viewers={sum(len(h.subscribers) for h in mine)}i"]
                if limit is not None:
                    fields += [f"limit={limit}i", f"busy={1 if len(mine) >= limit else 0}i"]
                lines.append(f"iptv_provider_slots,provider={_escape_influx_tag(name)},host=ubuntu26-01 {','.join(fields)} {now_ns}")
            with players_lock:
                by_type = collections.Counter(str(p.get("player_type") or "unknown") for p in active_players.values())
            lines.append(f"iptv_players,player_type=all,host=ubuntu26-01 active={sum(by_type.values())}i {now_ns}")
            for ptype, n in by_type.items():
                lines.append(f"iptv_players,player_type={_escape_influx_tag(ptype)},host=ubuntu26-01 active={n}i {now_ns}")
            _send_influx_async(lines)
        except Exception as e:
            app.logger.warning(f"Capacity metrics failed: {e}")


threading.Thread(target=_record_capacity_metrics, daemon=True, name="capacity-metrics").start()


PROVIDER_REFRESH_EVERY = 6 * 3600  # a full refresh pulls ~380k channels and takes ~4 min


def _scheduled_provider_refresh():
    """Refresh the shared provider DB every PROVIDER_REFRESH_EVERY seconds, counted from the
    last finished refresh (so a restart only refreshes when one is overdue)."""
    time.sleep(120)  # let the app settle after startup
    while True:
        with PROVIDER_REFRESH_LOCK:
            running = PROVIDER_REFRESH_STATE["status"] == "running"
            last = PROVIDER_REFRESH_STATE.get("finished_at") or 0
        wait = last + PROVIDER_REFRESH_EVERY - time.time()
        if running or wait > 0:
            time.sleep(min(max(wait, 60), 600))
            continue
        app.logger.warning("[provider-refresh] Scheduled provider DB refresh starting")
        try:
            _bg_refresh_provider_db(ADMIN_USERNAME)
            with PROVIDER_REFRESH_LOCK:
                state = dict(PROVIDER_REFRESH_STATE)
            if state.get("status") == "error":
                app.logger.error(f"[provider-refresh] Scheduled refresh failed: {state.get('error')}")
            else:
                app.logger.warning(f"[provider-refresh] Scheduled refresh done: {state.get('total_channels')} channels")
        except Exception as e:
            app.logger.error(f"[provider-refresh] Scheduled refresh crashed: {e}")
        time.sleep(60)


threading.Thread(target=_scheduled_provider_refresh, daemon=True, name="provider-refresh").start()


class _StreamHub:
    """One upstream connection to a live channel, fanned out to any number of viewers."""

    def __init__(self, url, provider, client="?"):
        self.url, self.provider = url, provider
        self.subscribers = set()
        self.clients = {}  # subscriber queue -> client label (see client_label)
        self.kiosk = is_kiosk_client(client)  # kiosk streams can't be preempted by other clients
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.closed = False
        self.status = None
        self.content_type = "video/mp2t"
        self.started = time.time()
        self.res = None
        self._idle_timer = None
        self.full_since = {}  # subscriber queue -> time it first stayed full (viewer not reading)
        app.logger.warning(f"[stream-hub] {provider}: opening upstream for channel {self.channel_id} (for {client})")
        threading.Thread(target=self._run, daemon=True, name="stream-hub").start()

    @property
    def channel_id(self):
        m = re.search(r"/(\d+)(?:\.\w+)?$", urlparse(self.url).path)
        return m.group(1) if m else "?"

    def _run(self):
        try:
            for attempt in range(2):
                res = http_pool.get(self.url, headers=_SEG_HEADERS, timeout=(10, 30), stream=True)
                # A just-preempted connection can still count against the account for a moment
                if res.status_code in (403, 429, 458, 503, 509) and attempt == 0:
                    res.close()
                    time.sleep(2)
                    continue
                break
            self.res, self.status = res, res.status_code
            self.content_type = res.headers.get("Content-Type") or "video/mp2t"
            self.ready.set()
            if res.status_code >= 400 or "mpegurl" in self.content_type.lower():
                return
            for chunk in res.iter_content(chunk_size=65536):
                if self.closed:
                    break
                if not chunk:
                    continue
                with self.lock:
                    subs = list(self.subscribers)
                now = time.time()
                for q in subs:
                    try:
                        q.put_nowait(chunk)
                        self.full_since.pop(q, None)
                    except queue.Full:
                        # Viewer not reading (paused/abandoned player whose connection is
                        # still open): evict after STALL_EVICT_SECONDS so it frees the slot
                        since = self.full_since.setdefault(q, now)
                        if now - since > STALL_EVICT_SECONDS:
                            app.logger.warning(f"[stream-hub] {self.provider}: evicting stalled viewer ({self.clients.get(q, '?')}) of channel {self.channel_id}")
                            self.full_since.pop(q, None)
                            with self.lock:
                                self.subscribers.discard(q)
                            try:
                                q.get_nowait()
                                q.put_nowait(None)
                            except (queue.Empty, queue.Full):
                                pass
                            self.unsubscribe(q)
                            continue
                        try:  # briefly slow viewer: drop its oldest chunk
                            q.get_nowait()
                            q.put_nowait(chunk)
                        except (queue.Empty, queue.Full):
                            pass
        except Exception as e:
            if not self.closed:
                app.logger.warning(f"Stream hub upstream ended: {mask_credentials(str(e))}")
        finally:
            self.ready.set()
            self.close("upstream ended")

    def subscribe(self, client="?"):
        q = queue.Queue(maxsize=256)
        with self.lock:
            self.subscribers.add(q)
            self.clients[q] = client
            self.kiosk = self.kiosk or is_kiosk_client(client)
            if self._idle_timer:
                self._idle_timer.cancel()
                self._idle_timer = None
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.subscribers.discard(q)
            self.clients.pop(q, None)
            if not self.subscribers and not self.closed:
                self._idle_timer = threading.Timer(HUB_IDLE_GRACE, self._close_if_idle)
                self._idle_timer.daemon = True
                self._idle_timer.start()

    def _close_if_idle(self):
        with self.lock:
            idle = not self.subscribers
        if idle:
            self.close("no viewers")

    def close(self, reason):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            subs = list(self.subscribers)
        app.logger.warning(f"[stream-hub] {self.provider}: closing upstream for channel {self.channel_id} after {int(time.time() - self.started)}s ({reason})")
        try:
            if self.res is not None:
                self.res.close()
        except Exception:
            pass
        for q in subs:
            try:
                q.put_nowait(None)
            except queue.Full:
                pass
        with _hubs_lock:
            if _hubs.get(self.url) is self:
                del _hubs[self.url]


def client_label(req):
    """Short, credential-free name of the requesting client, e.g. "kiosk/Windows"."""
    ref = urlparse(req.headers.get("Referer", "")).path
    page = next((p for p in ("kiosk", "player", "multiview") if f"/{p}" in ref), "manager" if ref else "direct")
    ua = req.headers.get("User-Agent", "")
    os_name = next((n for k, n in (("Windows", "Windows"), ("Mac OS", "Mac"), ("iPhone", "iPhone"), ("iPad", "iPad"),
                                   ("Android", "Android"), ("Linux", "Linux")) if k in ua), "other")
    return f"{page}/{os_name}"


def is_kiosk_client(client):
    return client.startswith("kiosk/")


def get_stream_hub(url, provider, client="?"):
    """Shared upstream for `url`, freeing the oldest connections when `provider` is
    at its limit. Returns None when only kiosk streams could be freed and the
    requester is not a kiosk: the TV keeps its channel and the preview is refused."""
    limit = provider_limit(provider)
    with _hubs_lock:
        hub = _hubs.get(url)
        if hub and not hub.closed:
            return hub
        same = sorted((h for h in _hubs.values() if h.provider == provider and not h.closed), key=lambda h: h.started)
        if limit and not is_kiosk_client(client):
            same = [h for h in same if not h.kiosk] + [h for h in same if h.kiosk]  # free non-kiosk first
        to_close = same[: max(0, len(same) - limit + 1)] if limit else []
        if not is_kiosk_client(client) and any(h.kiosk for h in to_close):
            app.logger.warning(f"[stream-hub] {provider}: refused {client}, slot held by the kiosk (limit {limit})")
            return None
        hub = None
    for old in to_close:
        holders = ", ".join(sorted(set(old.clients.values()))) or "no viewers"
        old.close(f"preempted by {client} (limit {limit}); was watched by {holders}")
    if to_close:
        time.sleep(0.5)  # let the provider register the disconnect
    with _hubs_lock:
        hub = _hubs.get(url)
        if not hub or hub.closed:
            hub = _StreamHub(url, provider, client)
            _hubs[url] = hub
    return hub


def release_provider_streams(provider, reason, client="?"):
    """Free one connection on `provider` for an HLS channel: close its oldest
    shared upstreams until at most limit-1 remain. Returns False (closing
    nothing) when a non-kiosk client would have to take the kiosk's stream."""
    limit = provider_limit(provider) or 0
    with _hubs_lock:
        live = sorted((h for h in _hubs.values() if h.provider == provider and not h.closed), key=lambda h: h.started)
    if not is_kiosk_client(client):
        live = [h for h in live if not h.kiosk] + [h for h in live if h.kiosk]
    to_close = live[: max(0, len(live) - limit + 1)]
    if not is_kiosk_client(client) and any(h.kiosk for h in to_close):
        app.logger.warning(f"[stream-hub] {provider}: refused {client}, slot held by the kiosk (limit {limit})")
        return False
    for h in to_close:
        h.close(reason)
    return True


def provider_busy(provider, except_url=None):
    """True when every allowed connection of `provider` is in use."""
    limit = provider_limit(provider)
    with _hubs_lock:
        in_use = sum(1 for h in _hubs.values() if h.provider == provider and not h.closed and h.url != except_url)
    return bool(limit) and in_use >= limit


def serve_from_hub(url, provider, client="?"):
    from flask import Response
    hub = get_stream_hub(url, provider, client)
    if hub is None:
        resp = jsonify({"error": f"{provider} allows {provider_limit(provider)} connection(s) and the kiosk is using it. "
                                 "Stop the kiosk channel or wait for it to switch to another provider."})
        resp.status_code = 503
        resp.headers["Access-Control-Allow-Origin"] = "*"
        return resp
    hub.ready.wait(20)
    if hub.status is None or hub.status >= 400 or "mpegurl" in hub.content_type.lower():
        return None  # caller falls back to the normal proxy path
    q = hub.subscribe(client)

    def generate():
        first = True
        try:
            while True:
                try:
                    chunk = q.get(timeout=30)
                except queue.Empty:
                    break
                if chunk is None:
                    break
                if first:
                    # Joining mid-stream: start at an MPEG-TS packet boundary
                    off = next((i for i in range(min(len(chunk), 188 * 4))
                                if chunk[i] == 0x47 and (i + 188 >= len(chunk) or chunk[i + 188] == 0x47)), 0)
                    chunk, first = chunk[off:], False
                yield chunk
        except (GeneratorExit, ConnectionResetError, BrokenPipeError):
            pass
        finally:
            hub.unsubscribe(q)

    # Plain generator: it needs no request context and may outlive it
    resp = Response(generate(), status=200, content_type=hub.content_type or "video/mp2t")
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["X-Accel-Buffering"] = "no"
    resp.headers["Access-Control-Allow-Origin"] = "*"
    return resp


@app.route("/api/provider/slots", methods=["GET"])
def api_provider_slots():
    """Connection use per limited provider (no URLs or credentials)."""
    with _hubs_lock:
        hubs = [h for h in _hubs.values() if not h.closed]
    out = {}
    for name, limit in _PROVIDER_LIMITS.items():
        mine = [h for h in hubs if h.provider == name]
        out[name] = {"limit": limit, "in_use": len(mine), "viewers": sum(len(h.subscribers) for h in mine),
                     "busy": len(mine) >= limit,
                     "streams": [{"channel": h.channel_id, "age_s": int(time.time() - h.started),
                                  "viewers": len(h.subscribers),
                                  "clients": sorted(h.clients.values())} for h in mine]}
    return jsonify(out)


def require_admin():
    user = get_current_username()
    if user != ADMIN_USERNAME:
        return jsonify({"success": False, "error": f"Access denied: User management portal is restricted to '{ADMIN_USERNAME}' only."}), 403
    return None

EPG_CACHE_FILE = os.path.join(PLAYLIST_ROOT, "playlists/epg_cache.json")
epg_update_lock = threading.Lock()

def get_epg_url(provider_url):
    if not provider_url:
        return None
    if "/playlist/" in provider_url:
        parts = provider_url.split("/playlist/")
        subparts = parts[1].split("/")
        if len(subparts) >= 2:
            username = subparts[0]
            password = subparts[1]
            host_part = parts[0]
            return f"{host_part}/xmltv.php?username={username}&password={password}"
    elif "username=" in provider_url and "password=" in provider_url:
        try:
            parsed = urlparse(provider_url)
            params = parse_qs(parsed.query)
            username = params.get("username", [""])[0]
            password = params.get("password", [""])[0]
            host_part = f"{parsed.scheme}://{parsed.netloc}"
            return f"{host_part}/xmltv.php?username={username}&password={password}"
        except Exception:
            pass
    return None

def parse_xmltv_time(t_str):
    if not t_str:
        return None
    try:
        clean_str = t_str.split()[0]
        return datetime.strptime(clean_str, "%Y%m%d%H%M%S")
    except Exception:
        return None

def get_live_program(programmes):
    now_utc = datetime.utcnow()
    live = None
    upcoming = None
    
    sorted_progs = []
    for p in programmes:
        p_start = parse_xmltv_time(p.get("start"))
        p_stop = parse_xmltv_time(p.get("stop"))
        if p_start and p_stop:
            sorted_progs.append((p_start, p_stop, p))
            
    sorted_progs.sort(key=lambda x: x[0])
    
    for i, (p_start, p_stop, p) in enumerate(sorted_progs):
        if p_start <= now_utc < p_stop:
            live = p
            if i + 1 < len(sorted_progs):
                upcoming = sorted_progs[i + 1][2]
            break
            
    if not live:
        for p_start, p_stop, p in sorted_progs:
            if p_start > now_utc:
                upcoming = p
                break
                
    return live, upcoming

def format_xmltv_time_to_utc_iso(t_str):
    if not t_str:
        return None
    try:
        parts = t_str.split()
        time_part = parts[0]
        offset_part = parts[1] if len(parts) > 1 else "+0000"
        
        dt = datetime.strptime(time_part, "%Y%m%d%H%M%S")
        
        sign = 1 if offset_part[0] == '+' else -1
        hours_offset = int(offset_part[1:3])
        mins_offset = int(offset_part[3:5])
        
        dt_utc = dt - sign * timedelta(hours=hours_offset, minutes=mins_offset)
        return dt_utc.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return None

def format_utc_to_xmltv(utc_str):
    if not utc_str:
        return ""
    try:
        dt = datetime.strptime(utc_str, "%Y-%m-%d %H:%M:%S")
        return dt.strftime("%Y%m%d%H%M%S") + " +0000"
    except Exception:
        return ""

# Public XMLTV guides, matched to channels by the tvg_id on each playlist stream.
# The providers' own xmltv.php carries no guide IDs for the channels we play.
EPG_SOURCES = (
    "https://iptv-epg.org/files/epg-us.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_US2.xml.gz",
    "https://epgshare01.online/epgshare01/epg_ripper_ID1.xml.gz",
)
EPG_REFRESH_EVERY = 12 * 3600
EPG_RETRY_EVERY = 3600
EPG_KEEP_HOURS = 48  # programmes kept ahead of now; the feeds hold 4-30 days
EPG_STATE = {"tvg_ids": set(), "last_attempt": 0}
EPG_TIME_FMT = "%Y-%m-%d %H:%M:%S"


def playlist_tvg_ids():
    """Every tvg_id set on a stream in any playlist file."""
    ids = set()
    paths = [os.path.join(PLAYLIST_ROOT, "playlist.yaml")]
    pl_dir = os.path.join(PLAYLIST_ROOT, "playlists")
    if os.path.isdir(pl_dir):
        paths += [os.path.join(pl_dir, f) for f in os.listdir(pl_dir) if f.endswith(".yaml")]
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f) or {}
        except Exception:
            continue
        for s in (data.get("streams") or []) if isinstance(data, dict) else []:
            if isinstance(s, dict) and str(s.get("tvg_id") or "").strip():
                ids.add(str(s["tvg_id"]).strip())
    return ids


def _epg_cache_age():
    try:
        with open(EPG_CACHE_FILE, "r", encoding="utf-8") as f:
            return time.time() - json.load(f).get("updated_at", 0)
    except Exception:
        return float("inf")


def _store_epg_rows(rows):
    """Replace the guide table with rows of (tvg_id, start, stop, title, desc)."""
    if db.is_postgres():
        from psycopg2.extras import execute_values
        with db.get_db_cursor(commit=True) as (cur, _):
            cur.execute("""
                CREATE TABLE IF NOT EXISTS epg_schedules (
                    id SERIAL PRIMARY KEY,
                    tvg_id TEXT,
                    start TEXT,
                    stop TEXT,
                    title TEXT,
                    "desc" TEXT
                );
            """)
            cur.execute("TRUNCATE epg_schedules")
            execute_values(cur, 'INSERT INTO epg_schedules (tvg_id, start, stop, title, "desc") VALUES %s', rows, page_size=5000)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_epg_tvg_id ON epg_schedules(tvg_id);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_epg_start_stop ON epg_schedules(start, stop);")
        return
    db_path = os.path.join(os.path.dirname(get_playlist_path("default")), "channels.db")
    conn = sqlite3.connect(db_path, timeout=30.0)
    try:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS epg_schedules (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tvg_id TEXT,
                start TEXT,
                stop TEXT,
                title TEXT,
                desc TEXT
            )
        """)
        conn.execute("DELETE FROM epg_schedules")
        conn.executemany("INSERT INTO epg_schedules (tvg_id, start, stop, title, desc) VALUES (?, ?, ?, ?, ?)", rows)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_epg_tvg_id ON epg_schedules(tvg_id)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_epg_start_stop ON epg_schedules(start, stop)")
        conn.commit()
    finally:
        conn.close()


def perform_epg_update(provider_url=None, active_tvg_ids=None):
    """Pull the guide for the playlists' tvg_ids from EPG_SOURCES.

    The feeds are streamed and parsed element by element: epg-us alone is over 1M
    programmes, and reading it whole once OOM-killed the pod (1 GiB limit). Only
    programmes for wanted channels in the next EPG_KEEP_HOURS are kept, and the
    table is left untouched if no feed produced anything.
    """
    if not epg_update_lock.acquire(blocking=False):
        return
    import gzip
    import xml.etree.ElementTree as ET
    try:
        EPG_STATE["last_attempt"] = time.time()
        wanted = set(active_tvg_ids or playlist_tvg_ids())
        if not wanted:
            return
        now = datetime.utcnow()
        window_start = (now - timedelta(hours=2)).strftime(EPG_TIME_FMT)
        window_end = (now + timedelta(hours=EPG_KEEP_HOURS)).strftime(EPG_TIME_FMT)
        rows = []
        found = set()
        for url in EPG_SOURCES:
            try:
                with requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60, stream=True) as r:
                    if r.status_code != 200:
                        app.logger.warning(f"[epg] {url} returned HTTP {r.status_code}")
                        continue
                    r.raw.decode_content = True
                    src = gzip.GzipFile(fileobj=r.raw) if url.endswith(".gz") else r.raw
                    context = ET.iterparse(src, events=("start", "end"))
                    _, root = next(context)
                    for event, elem in context:
                        if event != "end" or elem.tag not in ("programme", "channel"):
                            continue
                        chan = elem.get("channel")
                        if elem.tag == "programme" and chan in wanted:
                            start = format_xmltv_time_to_utc_iso(elem.get("start"))
                            stop = format_xmltv_time_to_utc_iso(elem.get("stop"))
                            if start and stop and stop > window_start and start < window_end:
                                rows.append((chan, start, stop, elem.findtext("title") or "", elem.findtext("desc") or ""))
                                found.add(chan)
                        root.clear()
            except Exception as fe:
                app.logger.error(f"[epg] Error reading {url}: {fe}")
        if not rows:
            app.logger.error("[epg] No programmes found in any feed; keeping the existing guide")
            return
        _store_epg_rows(rows)
        EPG_STATE["tvg_ids"] = wanted
        with open(EPG_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump({"updated_at": time.time(), "programmes": len(rows), "channels": len(found)}, f, indent=2)
        missing = sorted(wanted - found)
        app.logger.warning(f"[epg] Guide updated: {len(rows)} programmes for {len(found)}/{len(wanted)} channels"
                           + (f"; no data for {', '.join(missing)}" if missing else ""))
    except Exception as e:
        app.logger.error(f"[epg] Guide update failed: {e}")
    finally:
        epg_update_lock.release()

def update_epg_cache_async(provider_url=None, active_tvg_ids=None):
    thread = threading.Thread(target=perform_epg_update, args=(provider_url, active_tvg_ids), daemon=True, name="epg-update")
    thread.start()


def _scheduled_epg_refresh():
    """Refresh the guide every EPG_REFRESH_EVERY seconds, retrying hourly after a failure."""
    time.sleep(180)  # let the app settle after startup
    while True:
        if _epg_cache_age() > EPG_REFRESH_EVERY and time.time() - EPG_STATE["last_attempt"] > EPG_RETRY_EVERY:
            perform_epg_update()
        time.sleep(600)


threading.Thread(target=_scheduled_epg_refresh, daemon=True, name="epg-refresh").start()


def epg_now_next(tvg_ids):
    """{tvg_id: {"now": prog|None, "next": prog|None}} with prog = {title, start, stop} in UTC ISO."""
    ids = [t for t in {str(t).strip() for t in tvg_ids} if t]
    if not ids:
        return {}
    now_s = datetime.utcnow().strftime(EPG_TIME_FMT)
    horizon = (datetime.utcnow() + timedelta(hours=12)).strftime(EPG_TIME_FMT)
    if db.is_postgres():
        with db.get_db_cursor() as (cur, _):
            cur.execute("SELECT tvg_id, title, start, stop FROM epg_schedules WHERE tvg_id = ANY(%s) AND stop > %s AND start < %s ORDER BY start",
                        (ids, now_s, horizon))
            found = cur.fetchall()
    else:
        db_path = os.path.join(os.path.dirname(get_playlist_path("default")), "channels.db")
        if not os.path.exists(db_path):
            return {}
        conn = sqlite3.connect(db_path, timeout=30.0)
        try:
            marks = ",".join("?" * len(ids))
            found = conn.execute(f"SELECT tvg_id, title, start, stop FROM epg_schedules WHERE tvg_id IN ({marks}) AND stop > ? AND start < ? ORDER BY start",
                                 (*ids, now_s, horizon)).fetchall()
        finally:
            conn.close()
    out = {}
    for tvg_id, title, start, stop in found:
        entry = out.setdefault(tvg_id, {"now": None, "next": None})
        prog = {"title": title or "", "start": start.replace(" ", "T") + "Z", "stop": stop.replace(" ", "T") + "Z"}
        if start <= now_s and entry["now"] is None:
            entry["now"] = prog
        elif start > now_s and entry["next"] is None:
            entry["next"] = prog
    return out


@app.route("/api/epg/now")
def get_epg_now():
    ids = [t for t in (request.args.get("ids") or "").split(",") if t.strip()][:100]
    try:
        programs = epg_now_next(ids)
    except Exception as e:
        app.logger.error(f"[epg] now/next lookup failed: {e}")
        programs = {}
    age = _epg_cache_age()
    return jsonify({"programs": programs, "updated_at": None if age == float("inf") else int(time.time() - age)})


@app.route("/api/epg/refresh", methods=["POST"])
def refresh_epg():
    if epg_update_lock.locked():
        return jsonify({"success": True, "status": "running"})
    update_epg_cache_async()
    return jsonify({"success": True, "status": "started"})

@app.route("/api/epg")
def get_epg_data():
    all_channels = request.args.get("all", "false").lower() == "true"
    user = request.args.get("user") or get_current_username()
    
    default_path = get_playlist_path("default")
    db_path = os.path.join(os.path.dirname(default_path), "channels.db")
    
    results = []
    use_pg = db.is_postgres()
    if use_pg or os.path.exists(db_path):
        try:
            channels_list = []
            programmes_by_tvg = {}
            if use_pg:
                with db.get_db_cursor() as (cursor, _):
                    if all_channels:
                        cursor.execute("""
                            SELECT c.name, c.url, c.category, c.tvg_id, c.logo, c.provider
                            FROM channels c
                            WHERE c.name IS NOT NULL AND c.name != ''
                            GROUP BY c.name, c.url, c.category, c.tvg_id, c.logo, c.provider
                            ORDER BY 
                                (CASE WHEN c.category LIKE 'US%' OR c.category LIKE 'USA%' OR c.category LIKE 'CA%' OR c.category LIKE 'UK%' THEN 0 ELSE 1 END),
                                c.category ASC,
                                c.name ASC
                            LIMIT 2500
                        """)
                        channels_list = [
                            {
                                "index": idx,
                                "name": r[0],
                                "url": r[1],
                                "category": r[2] or "Uncategorized",
                                "tvg_id": r[3],
                                "logo": r[4] or "",
                                "provider": r[5] or "IPTV"
                            }
                            for idx, r in enumerate(cursor.fetchall())
                        ]
                    else:
                        playlist = load_playlist(user)
                        streams = playlist.get("streams", []) if isinstance(playlist, dict) else []
                        for idx, s in enumerate(streams):
                            url = s.get("url", "")
                            name = s.get("name", "")
                            tvg_id = s.get("tvg_id", "") or ""
                            logo = s.get("logo", "") or ""
                            prov = s.get("provider", "") or ""
                            if url:
                                cursor.execute("SELECT tvg_id, logo, provider FROM channels WHERE url = %s LIMIT 1", (url,))
                                row = cursor.fetchone()
                                if row:
                                    if not tvg_id: tvg_id = row[0] or ""
                                    if not logo: logo = row[1] or ""
                                    if not prov: prov = row[2] or ""
                            if not tvg_id and name:
                                cursor.execute("SELECT tvg_id, logo, provider FROM channels WHERE name = %s AND tvg_id IS NOT NULL AND tvg_id != '' LIMIT 1", (name,))
                                row = cursor.fetchone()
                                if row:
                                    if not tvg_id: tvg_id = row[0] or ""
                                    if not logo: logo = row[1] or ""
                                    if not prov: prov = row[2] or ""
                            channels_list.append({
                                "index": idx,
                                "name": name or f"Channel {idx+1}",
                                "category": s.get("category") or "Uncategorized",
                                "url": url,
                                "tvg_id": tvg_id,
                                "logo": logo,
                                "provider": prov or "IPTV"
                            })

                    target_tvg_ids = list({ch["tvg_id"] for ch in channels_list if ch.get("tvg_id")})
                    if target_tvg_ids:
                        cursor.execute("""
                            SELECT tvg_id, title, "desc", start, stop
                            FROM epg_schedules
                            WHERE tvg_id = ANY(%s)
                              AND stop > (CURRENT_TIMESTAMP - INTERVAL '2 hours')::text AND start < (CURRENT_TIMESTAMP + INTERVAL '28 hours')::text
                            ORDER BY start ASC
                        """, (target_tvg_ids,))
                        for row in cursor.fetchall():
                            tid = row[0]
                            if tid not in programmes_by_tvg:
                                programmes_by_tvg[tid] = []
                            programmes_by_tvg[tid].append({
                                "title": row[1],
                                "desc": row[2] or "",
                                "start": format_utc_to_xmltv(row[3]),
                                "stop": format_utc_to_xmltv(row[4])
                            })
            else:
                import sqlite3
                conn = sqlite3.connect(db_path, timeout=30.0)
                conn.execute("PRAGMA journal_mode=WAL;")
                conn.execute("PRAGMA busy_timeout=30000;")
                cursor = conn.cursor()
                if all_channels:
                    cursor.execute("""
                        SELECT c.name, c.url, c.category, c.tvg_id, c.logo, c.provider
                        FROM channels c
                        WHERE c.name IS NOT NULL AND c.name != ''
                        GROUP BY c.name
                        ORDER BY 
                            (CASE WHEN c.tvg_id IN (SELECT DISTINCT tvg_id FROM epg_schedules WHERE stop > datetime('now', '-2 hours') AND start < datetime('now', '+24 hours')) THEN 0 ELSE 1 END),
                            (CASE WHEN c.category LIKE 'US%' OR c.category LIKE 'USA%' OR c.category LIKE 'CA%' OR c.category LIKE 'UK%' THEN 0 ELSE 1 END),
                            c.category ASC,
                            c.name ASC
                        LIMIT 2500
                    """)
                    channels_list = [
                        {
                            "index": idx,
                            "name": r[0],
                            "url": r[1],
                            "category": r[2] or "Uncategorized",
                            "tvg_id": r[3],
                            "logo": r[4] or "",
                            "provider": r[5] or "IPTV"
                        }
                        for idx, r in enumerate(cursor.fetchall())
                    ]
                else:
                    playlist = load_playlist(user)
                    streams = playlist.get("streams", []) if isinstance(playlist, dict) else []
                    for idx, s in enumerate(streams):
                        url = s.get("url", "")
                        name = s.get("name", "")
                        tvg_id = s.get("tvg_id", "") or ""
                        logo = s.get("logo", "") or ""
                        prov = s.get("provider", "") or ""
                        if url:
                            cursor.execute("SELECT tvg_id, logo, provider FROM channels WHERE url = ? LIMIT 1", (url,))
                            row = cursor.fetchone()
                            if row:
                                if not tvg_id: tvg_id = row[0] or ""
                                if not logo: logo = row[1] or ""
                                if not prov: prov = row[2] or ""
                        if not tvg_id and name:
                            cursor.execute("SELECT tvg_id, logo, provider FROM channels WHERE name = ? AND tvg_id IS NOT NULL AND tvg_id != '' LIMIT 1", (name,))
                            row = cursor.fetchone()
                            if row:
                                if not tvg_id: tvg_id = row[0] or ""
                                if not logo: logo = row[1] or ""
                                if not prov: prov = row[2] or ""
                        channels_list.append({
                            "index": idx,
                            "name": name or f"Channel {idx+1}",
                            "category": s.get("category") or "Uncategorized",
                            "url": url,
                            "tvg_id": tvg_id,
                            "logo": logo,
                            "provider": prov or "IPTV"
                        })

                target_tvg_ids = list({ch["tvg_id"] for ch in channels_list if ch.get("tvg_id")})
                if target_tvg_ids:
                    placeholders = ",".join("?" for _ in target_tvg_ids)
                    query = f"""
                        SELECT tvg_id, title, desc, start, stop
                        FROM epg_schedules
                        WHERE tvg_id IN ({placeholders})
                          AND stop > datetime('now', '-2 hours') AND start < datetime('now', '+28 hours')
                        ORDER BY start ASC
                    """
                    cursor.execute(query, target_tvg_ids)
                    for row in cursor.fetchall():
                        tid = row[0]
                        if tid not in programmes_by_tvg:
                            programmes_by_tvg[tid] = []
                        programmes_by_tvg[tid].append({
                            "title": row[1],
                            "desc": row[2] or "",
                            "start": format_utc_to_xmltv(row[3]),
                            "stop": format_utc_to_xmltv(row[4])
                        })
                conn.close()

            for ch in channels_list:
                tid = ch["tvg_id"]
                results.append({
                    "index": ch["index"],
                    "name": ch["name"],
                    "category": ch["category"],
                    "url": ch["url"],
                    "logo": ch["logo"],
                    "tvg_id": tid,
                    "provider": ch.get("provider", "IPTV"),
                    "programmes": programmes_by_tvg.get(tid, [])
                })
        except Exception as e:
            app.logger.error(f"Error fetching EPG data: {e}")

            print(f"EPG DB lookup error: {e}")
            results = []
            
    return jsonify(results)

@app.route("/admin")
def admin_portal():
    user = get_current_username()
    if user != ADMIN_USERNAME:
        return f"<div style='font-family: sans-serif; padding: 40px; background: #0f172a; color: #ef4444; min-height: 100vh;'><h1>403 Access Denied</h1><p>The User Management Portal is restricted to superadmin <strong>{ADMIN_USERNAME}</strong> only. Current user: <code>{user}</code></p><p><a href='./' style='color: #818cf8;'>← Back to Manager</a></p></div>", 403
    users_list = user_manager.list_users()
    return render_template("admin.html", current_user=user, users=users_list)

@app.route("/api/admin/users", methods=["GET"])
def api_admin_list_users():
    err = require_admin()
    if err: return err
    # Never send password hashes or plaintext passwords to the browser
    return jsonify([{k: v for k, v in u.items() if k in ("username", "enabled")} for u in user_manager.list_users()])

@app.route("/api/admin/users/add", methods=["POST"])
def api_admin_add_user():
    err = require_admin()
    if err: return err
    data = request.get_json() or {}
    username = data.get("username")
    password = data.get("password")
    if not username or not password:
        return jsonify({"success": False, "error": "Username and password required"}), 400
    try:
        user_manager.add_user(username, password)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/admin/users/password", methods=["POST"])
def api_admin_change_password():
    err = require_admin()
    if err: return err
    data = request.get_json() or {}
    username = data.get("username")
    new_password = data.get("new_password")
    if not username or not new_password:
        return jsonify({"success": False, "error": "Username and new password required"}), 400
    try:
        user_manager.set_password(username, new_password)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/admin/users/toggle", methods=["POST"])
def api_admin_toggle_user():
    err = require_admin()
    if err: return err
    data = request.get_json() or {}
    username = data.get("username")
    enabled = data.get("enabled", True)
    if not username:
        return jsonify({"success": False, "error": "Username required"}), 400
    try:
        user_manager.toggle_user_status(username, enabled)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/admin/users/delete", methods=["POST"])
def api_admin_delete_user():
    err = require_admin()
    if err: return err
    data = request.get_json() or {}
    username = data.get("username")
    if not username:
        return jsonify({"success": False, "error": "Username required"}), 400
    try:
        user_manager.delete_user(username)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 400

@app.route("/api/auth/login", methods=["POST"])
def api_auth_login():
    data = request.get_json() or {}
    username = (data.get("username") or "").strip().lower()
    password = data.get("password") or ""
    if user_manager.verify_user_credentials(username, password):
        flask_session["user"] = username
        flask_session.permanent = True
        return jsonify({"success": True, "user": username})
    return jsonify({"success": False, "error": "Invalid credentials"}), 401

@app.route("/api/auth/logout", methods=["GET", "POST"])
def api_auth_logout():
    flask_session.clear()
    flask_session.pop("user", None)
    response = jsonify({"status": "logged_out", "message": "Credentials cleared"})
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "-1"
    response.delete_cookie("stream_iptv_session", path="/")
    response.delete_cookie("stream_iptv_session", path="/stream-iptv/")
    response.delete_cookie("session", path="/")
    response.delete_cookie("session", path="/stream-iptv/")
    return response

@app.route("/logout", methods=["GET", "POST"])
def logout():
    flask_session.clear()
    flask_session.pop("user", None)
    base = get_base_url()
    response = redirect(f"{base}login")
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "-1"
    response.delete_cookie("stream_iptv_session", path="/")
    response.delete_cookie("stream_iptv_session", path="/stream-iptv/")
    response.delete_cookie("session", path="/")
    response.delete_cookie("session", path="/stream-iptv/")
    return response

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=os.environ.get("FLASK_DEBUG") == "1", threaded=True)
