#!/usr/bin/env python3
"""
stream_iptv/iptv_cli.py - Unified IPTV Management CLI & Automation Engine
Consolidates M3U ingestion, YouTube playlist imports, HLS channel verification,
self-healing stream replacement, and Xtream Codes playlist sync.

Subcommands:
  import-m3u    - Parses provider M3U playlists/URLs into SQLite channels.db
  import-yt     - Ingests YouTube playlist entries via yt-dlp
  verify        - Concurrently validates HLS stream playback in channels.db
  check-active  - Self-healing verification of active playlist.yaml streams & node sync
  rotate        - Launches automated playback rotation daemon
"""

import os
import sys
import re
import json
import time
import math
import yaml
import sqlite3
import argparse
import subprocess
from datetime import datetime
from urllib.parse import urlparse, parse_qs
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any, Optional, Tuple

import requests
from requests.adapters import HTTPAdapter

_stream_dir = os.path.dirname(os.path.abspath(__file__))
_repo_dir = os.path.dirname(_stream_dir)
_script_dir = os.path.join(_repo_dir, "script")

for p in (_stream_dir, _repo_dir, _script_dir):
    if p not in sys.path:
        sys.path.insert(0, p)

try:
    import script.env_loader as env_loader
except ImportError:
    try:
        import env_loader
    except ImportError:
        pass

DB_PATH = os.path.join(_stream_dir, "channels.db")
PLAYLIST_YAML = os.path.join(_stream_dir, "playlist.yaml")
PLAYLISTS_DIR = os.path.join(_stream_dir, "playlists")

DEFAULT_PROVIDER_URL = os.environ.get("IPTV_DEFAULT_PROVIDER_URL", "")  # embeds the provider login; set in ~/.homelab.env

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "*/*"
}

# Shared HTTP Session
http_session = requests.Session()
_adapter = HTTPAdapter(pool_connections=100, pool_maxsize=150)
http_session.mount("http://", _adapter)
http_session.mount("https://", _adapter)


try:
    from stream_iptv.manager import db
except ImportError:
    try:
        from manager import db
    except ImportError:
        db = None


def get_db_connection(db_path: str = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=60.0)
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA synchronous=NORMAL;")
    conn.execute("PRAGMA busy_timeout=30000;")
    return conn


def ensure_tables(conn: Optional[sqlite3.Connection] = None):
    if db and db.is_postgres():
        db.ensure_schema()
        return
    if conn is None:
        return
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT,
            url TEXT,
            category TEXT,
            tvg_id TEXT,
            logo TEXT,
            provider TEXT,
            is_playable INTEGER,
            latency_ms INTEGER,
            last_checked TEXT,
            error_msg TEXT
        );
    """)
    c.execute("PRAGMA table_info(channels);")
    existing_cols = {row[1] for row in c.fetchall()}
    for col, col_type in [
        ("category", "TEXT"),
        ("tvg_id", "TEXT"),
        ("logo", "TEXT"),
        ("provider", "TEXT"),
        ("is_playable", "INTEGER"),
        ("latency_ms", "INTEGER"),
        ("last_checked", "TEXT"),
        ("error_msg", "TEXT")
    ]:
        if col not in existing_cols:
            c.execute(f"ALTER TABLE channels ADD COLUMN {col} {col_type};")

    c.execute("CREATE INDEX IF NOT EXISTS idx_channel_name ON channels(name);")
    c.execute("CREATE INDEX IF NOT EXISTS idx_channel_category ON channels(category);")
    c.execute("CREATE INDEX IF NOT EXISTS idx_channel_provider ON channels(provider);")
    c.execute("CREATE INDEX IF NOT EXISTS idx_channel_playable ON channels(is_playable);")
    conn.commit()


# ==============================================================================
# SUBCOMMAND 1: import-m3u
# ==============================================================================
def load_provider_list(user=None, config_file=None) -> List[Dict[str, Any]]:
    candidate_paths = []
    if config_file:
        candidate_paths.append(config_file)
    if user:
        candidate_paths.append(os.path.join(PLAYLISTS_DIR, f"provider_{user}.json"))
    candidate_paths.extend([
        os.path.join(PLAYLISTS_DIR, f"provider_{os.environ.get('IPTV_ADMIN_USER', 'admin')}.json"),
        os.path.join(PLAYLISTS_DIR, "provider_default.json")
    ])

    for p in candidate_paths:
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    providers = data.get("providers")
                    if providers:
                        print(f"📖 Loaded {len(providers)} providers from {os.path.basename(p)}")
                        return providers
            except Exception as e:
                print(f"⚠️ Error reading {p}: {e}")

    print("⚠️ No valid provider config found. Using default Primary Provider.")
    return [{"name": "Primary Provider", "url": DEFAULT_PROVIDER_URL}]


def import_single_provider(conn: sqlite3.Connection, name: str, source: str, is_file: bool = False) -> Tuple[bool, int]:
    print(f"\n=======================================================")
    print(f"📡 Processing Provider: '{name}'")
    print(f"   Source: {source}")
    print(f"=======================================================")

    lines_iter = None
    if is_file:
        if not os.path.isfile(source):
            print(f"❌ File not found: {source}")
            return False, 0
        try:
            f = open(source, "r", encoding="utf-8", errors="ignore")
            lines_iter = f
        except Exception as e:
            print(f"❌ Failed to open file: {e}")
            return False, 0
    else:
        try:
            r = requests.get(source, headers=HEADERS, stream=True, timeout=45)
            if r.status_code != 200:
                print(f"❌ HTTP Error {r.status_code} fetching playlist from {source}")
                return False, 0
            lines_iter = r.iter_lines(chunk_size=8192)
        except Exception as e:
            print(f"❌ Connection error fetching playlist: {e}")
            return False, 0

    is_pg = bool(db and db.is_postgres())
    if is_pg:
        db.purge_provider_channels(name)
    elif conn:
        c = conn.cursor()
        c.execute("DELETE FROM channels WHERE provider = ? COLLATE NOCASE;", (name,))
        conn.commit()

    batch = []
    current_name = None
    current_category = None
    current_tvg_id = None
    current_logo = None
    count = 0

    try:
        for line in lines_iter:
            if not line:
                continue
            if isinstance(line, bytes):
                try:
                    line_str = line.decode("utf-8", errors="ignore").strip()
                except Exception:
                    continue
            else:
                line_str = line.strip()

            if line_str.startswith("#EXTINF:"):
                parts = line_str.split(",")
                current_name = parts[-1].strip() if len(parts) > 1 else "Unknown Channel"

                group_match = re.search(r'group-title="([^"]+)"', line_str)
                current_category = group_match.group(1).strip() if group_match else None

                tvg_id_match = re.search(r'tvg-id="([^"]+)"', line_str)
                current_tvg_id = tvg_id_match.group(1).strip() if tvg_id_match else None

                logo_match = re.search(r'tvg-logo="([^"]+)"', line_str)
                current_logo = logo_match.group(1).strip() if logo_match else None

            elif line_str.startswith("http") or (is_file and not line_str.startswith("#")):
                if current_name:
                    batch.append((current_name, line_str, current_category, current_tvg_id, current_logo, name))
                    current_name = None
                    current_category = None
                    current_tvg_id = None
                    current_logo = None
                    count += 1

                if len(batch) >= 10000:
                    if is_pg:
                        db.insert_channels_batch(batch)
                    elif conn:
                        c = conn.cursor()
                        c.executemany("""
                            INSERT INTO channels (name, url, category, tvg_id, logo, provider)
                            VALUES (?, ?, ?, ?, ?, ?);
                        """, batch)
                        conn.commit()
                    batch.clear()
                    print(f"   -> Ingested {count:,} channels...")

        if batch:
            if is_pg:
                db.insert_channels_batch(batch)
            elif conn:
                c = conn.cursor()
                c.executemany("""
                    INSERT INTO channels (name, url, category, tvg_id, logo, provider)
                    VALUES (?, ?, ?, ?, ?, ?);
                """, batch)
                conn.commit()
            batch.clear()

        print(f"✅ Finished '{name}': {count:,} channels successfully saved to DB.")
        return True, count

    except Exception as e:
        print(f"❌ Error during import of '{name}': {e}")
        return False, count
    finally:
        if is_file and lines_iter and hasattr(lines_iter, 'close'):
            lines_iter.close()


def print_db_summary(conn: Optional[sqlite3.Connection] = None):
    if db and db.is_postgres():
        with db.get_db_cursor() as (c, _):
            c.execute("SELECT count(*) FROM channels;")
            total = c.fetchone()[0]
            print("\n" + "=" * 55)
            print("📊 IPTV Channels PostgreSQL Database Summary")
            print("=" * 55)
            print(f"Total Channels in DB : {total:,}")

            c.execute("""
                SELECT provider, count(*)
                FROM channels
                GROUP BY provider
                ORDER BY count(*) DESC;
            """)
            providers = c.fetchall()

            print("\nChannels by Provider:")
            for prov, count in providers:
                print(f"  • {prov or 'Unknown'}: {count:,} channels")
            print("=" * 55 + "\n")
        return

    if not conn:
        return
    c = conn.cursor()
    total = c.execute("SELECT count(*) FROM channels;").fetchone()[0]
    print("\n" + "=" * 55)
    print("📊 IPTV Channels SQLite Database Summary")
    print("=" * 55)
    print(f"Total Channels in DB : {total:,}")

    providers = c.execute("""
        SELECT provider, count(*)
        FROM channels
        GROUP BY provider
        ORDER BY count(*) DESC;
    """).fetchall()

    print("\nChannels by Provider:")
    for prov, count in providers:
        print(f"  • {prov or 'Unknown'}: {count:,} channels")
    print("=" * 55 + "\n")


def cmd_import_m3u(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="iptv_cli import-m3u", description="Import IPTV M3U playlists into SQLite channels.db")
    parser.add_argument("--user", help="Username for provider config (e.g. admin)")
    parser.add_argument("--config", help="Path to custom provider JSON config file")
    parser.add_argument("--provider", help="Sync only a specific provider name")
    parser.add_argument("--url", help="Ad-hoc M3U URL to import")
    parser.add_argument("--name", help="Provider name for ad-hoc M3U URL or file")
    parser.add_argument("--file", help="Import from a local M3U file")
    parser.add_argument("--rebuild", action="store_true", help="Drop and recreate channels table before import")
    args = parser.parse_args(argv)

    print(f"📂 Database file: {DB_PATH}")
    conn = get_db_connection()

    if args.rebuild:
        print("⚠️ Rebuild flag specified. Dropping existing channels table...")
        conn.execute("DROP TABLE IF EXISTS channels;")
        conn.commit()

    ensure_tables(conn)

    if args.file:
        name = args.name or os.path.splitext(os.path.basename(args.file))[0]
        import_single_provider(conn, name, args.file, is_file=True)
        print_db_summary(conn)
        conn.close()
        return 0

    if args.url:
        name = args.name or "Custom Provider"
        import_single_provider(conn, name, args.url, is_file=False)
        print_db_summary(conn)
        conn.close()
        return 0

    providers = load_provider_list(user=args.user, config_file=args.config)
    if args.provider:
        target_name = args.provider.strip().lower()
        providers = [p for p in providers if (p.get("name") or "").strip().lower() == target_name]
        if not providers:
            print(f"❌ Provider '{args.provider}' not found in configuration.")
            conn.close()
            return 1

    for p in providers:
        p_name = p.get("name") or "Unnamed Provider"
        p_url = p.get("url") or ""
        if p_url:
            import_single_provider(conn, p_name, p_url)

    ensure_tables(conn)
    print_db_summary(conn)
    conn.close()
    return 0


# ==============================================================================
# SUBCOMMAND 2: import-yt
# ==============================================================================
def cmd_import_yt(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="iptv_cli import-yt", description="Import YouTube Playlist to IPTV channels")
    parser.add_argument("url", nargs="?", default="https://www.youtube.com/playlist?list=PLV9_7FLGAUAlpL4bVa7BV1izTWwQ9WQaO", help="YouTube Playlist URL")
    parser.add_argument("--category", default="YouTube - ITS Walking", help="Category name in channels.db")
    parser.add_argument("--add-to-rotation", action="store_true", help="Also add to stream_iptv/playlist.yaml")
    parser.add_argument("--m3u-name", default="youtube_its_walking.m3u", help="Output M3U filename")
    args = parser.parse_args(argv)

    cmd = [sys.executable, "-m", "yt_dlp", "--flat-playlist", "-J", args.url]
    print(f"Fetching playlist metadata from: {args.url}...")
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(res.stdout)
    except Exception as e:
        print(f"Error fetching YouTube playlist metadata: {e}", file=sys.stderr)
        return 1

    title = data.get("title", "YouTube Playlist")
    entries = data.get("entries", [])
    print(f"Found {len(entries)} videos in playlist '{title}'")

    # Ingest to DB
    conn = get_db_connection()
    ensure_tables(conn)
    cur = conn.cursor()
    added = 0
    updated = 0
    for item in entries:
        vid_id = item.get("id")
        if not vid_id:
            continue
        v_title = item.get("title", f"Video {vid_id}")
        v_url = f"https://www.youtube.com/embed/{vid_id}"
        thumbnails = item.get("thumbnails", [])
        logo = thumbnails[-1].get("url", "") if thumbnails else f"https://i.ytimg.com/vi/{vid_id}/hqdefault.jpg"

        cur.execute("SELECT id FROM channels WHERE url = ? OR url = ?", (v_url, f"https://www.youtube.com/watch?v={vid_id}"))
        existing = cur.fetchone()
        if existing:
            cur.execute("UPDATE channels SET name = ?, category = ?, logo = ?, provider = 'YouTube' WHERE id = ?", (v_title, args.category, logo, existing[0]))
            updated += 1
        else:
            cur.execute("INSERT INTO channels (name, url, category, tvg_id, logo, provider) VALUES (?, ?, ?, ?, ?, 'YouTube')",
                        (v_title, v_url, args.category, vid_id, logo))
            added += 1
    conn.commit()
    conn.close()
    print(f"Database update complete: {added} new channels added, {updated} updated under category '{args.category}'")

    # Export M3U
    os.makedirs(PLAYLISTS_DIR, exist_ok=True)
    out_path = os.path.join(PLAYLISTS_DIR, args.m3u_name)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("#EXTM3U\n")
        for item in entries:
            vid_id = item.get("id")
            if vid_id:
                v_title = item.get("title", f"Video {vid_id}")
                logo = f"https://i.ytimg.com/vi/{vid_id}/hqdefault.jpg"
                v_url = f"https://www.youtube.com/embed/{vid_id}"
                f.write(f'#EXTINF:-1 tvg-id="{vid_id}" tvg-name="{v_title}" tvg-logo="{logo}" group-title="{args.category}",{v_title}\n')
                f.write(f"{v_url}\n")
    print(f"Exported M3U playlist to: {out_path}")

    # Add to rotation if requested
    if args.add_to_rotation and os.path.exists(PLAYLIST_YAML):
        with open(PLAYLIST_YAML, "r", encoding="utf-8") as f:
            p_config = yaml.safe_load(f) or {}
        streams = p_config.get("streams", [])
        existing_urls = {s.get("url") for s in streams}
        added_to_yaml = 0
        for item in entries:
            vid_id = item.get("id")
            if vid_id:
                v_url = f"https://www.youtube.com/embed/{vid_id}"
                if v_url not in existing_urls:
                    streams.append({"name": item.get("title", f"Video {vid_id}"), "type": "youtube_embed", "url": v_url})
                    existing_urls.add(v_url)
                    added_to_yaml += 1
        p_config["streams"] = streams
        with open(PLAYLIST_YAML, "w", encoding="utf-8") as f:
            yaml.dump(p_config, f, allow_unicode=True, sort_keys=False)
        print(f"Appended {added_to_yaml} streams to {PLAYLIST_YAML}")

    return 0


# ==============================================================================
# SUBCOMMAND 3: verify (HLS Stream Playability Validator)
# ==============================================================================
def sanitize_url(url: str) -> str:
    if not url:
        return url
    if "stitch/embed" in url and ("sid=" in url or "authToken=" in url or "deviceId=" in url):
        return url
    if ".key" in url or ".ts" in url or "jmp2.uk/plu-" in url:
        return url
    m = re.search(r'/channel/([a-f0-9]{24})', url)
    if m:
        return f"https://jmp2.uk/plu-{m.group(1)}.m3u8"
    m = re.search(r'plu-([a-f0-9]{24})', url)
    if m:
        return f"https://jmp2.uk/plu-{m.group(1)}.m3u8"
    return url


def get_canonical_yt_url(url: str) -> str:
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


def check_stream(url: str, timeout: float = 4.0) -> Tuple[bool, int, str, int]:
    if not url or not url.strip().startswith(('http://', 'https://')):
        return False, 400, "Invalid URL syntax", 0

    url = sanitize_url(url.strip())
    if 'youtube.com' in url or 'youtu.be' in url:
        t0 = time.time()
        try:
            watch_url = get_canonical_yt_url(url)
            oembed_url = f"https://www.youtube.com/oembed?url={watch_url}&format=json"
            r = http_session.get(oembed_url, headers=HEADERS, timeout=timeout)
            lat = int((time.time() - t0) * 1000)
            if r.status_code == 200:
                return True, 200, "YouTube Live/Public", lat
            return False, r.status_code, f"YouTube {r.status_code}", lat
        except requests.exceptions.Timeout:
            return False, 408, "YouTube Timeout", int((time.time() - t0) * 1000)
        except Exception as e:
            return False, 500, f"YouTube Error: {str(e)[:40]}", 0

    t0 = time.time()
    try:
        r = http_session.get(url, headers=HEADERS, timeout=timeout, allow_redirects=True, stream=True, verify=False)
        lat = int((time.time() - t0) * 1000)

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
            return False, 204, "Empty Stream", lat
    except requests.exceptions.Timeout:
        return False, 408, "Connect Timeout", int((time.time() - t0) * 1000)
    except requests.exceptions.SSLError:
        return False, 526, "SSL Certificate Error", int((time.time() - t0) * 1000)
    except requests.exceptions.ConnectionError:
        return False, 503, "Host Unreachable", int((time.time() - t0) * 1000)
    except Exception as e:
        return False, 500, str(e)[:45], int((time.time() - t0) * 1000)


def show_verification_status():
    if db and db.is_postgres():
        with db.get_db_cursor() as (c, _):
            c.execute("SELECT count(*) FROM channels;")
            total = c.fetchone()[0]
            c.execute("SELECT count(*) FROM channels WHERE is_playable = 1;")
            playable = c.fetchone()[0]
            c.execute("SELECT count(*) FROM channels WHERE is_playable = 0;")
            offline = c.fetchone()[0]
            c.execute("SELECT count(*) FROM channels WHERE is_playable IS NULL;")
            unchecked = c.fetchone()[0]

            print("\n" + "=" * 55)
            print("📊 IPTV Channels Verification Status (PostgreSQL)")
            print("=" * 55)
            print(f"Total Channels in DB : {total:,}")
            print(f"🟢 Live / Playable   : {playable:,} ({(playable/total*100 if total else 0):.1f}%)")
            print(f"🔴 Offline / Broken  : {offline:,} ({(offline/total*100 if total else 0):.1f}%)")
            print(f"⏳ Untested          : {unchecked:,} ({(unchecked/total*100 if total else 0):.1f}%)")
            print("=" * 55)

            c.execute("""
                SELECT provider, 
                       count(*),
                       sum(CASE WHEN is_playable = 1 THEN 1 ELSE 0 END),
                       sum(CASE WHEN is_playable = 0 THEN 1 ELSE 0 END),
                       sum(CASE WHEN is_playable IS NULL THEN 1 ELSE 0 END)
                FROM channels
                GROUP BY provider;
            """)
            providers = c.fetchall()
            print("\nBy Provider:")
            for prov, tot, p, o, u in providers:
                print(f"  • {prov or 'Unknown'}: {tot:,} total | 🟢 {p or 0:,} live | 🔴 {o or 0:,} offline | ⏳ {u or 0:,} untested")
            print()
        return

    conn = get_db_connection()
    c = conn.cursor()
    total = c.execute("SELECT count(*) FROM channels;").fetchone()[0]
    playable = c.execute("SELECT count(*) FROM channels WHERE is_playable = 1;").fetchone()[0]
    offline = c.execute("SELECT count(*) FROM channels WHERE is_playable = 0;").fetchone()[0]
    unchecked = c.execute("SELECT count(*) FROM channels WHERE is_playable IS NULL;").fetchone()[0]

    print("\n" + "=" * 55)
    print("📊 IPTV Channels Verification Status")
    print("=" * 55)
    print(f"Total Channels in DB : {total:,}")
    print(f"🟢 Live / Playable   : {playable:,} ({(playable/total*100 if total else 0):.1f}%)")
    print(f"🔴 Offline / Broken  : {offline:,} ({(offline/total*100 if total else 0):.1f}%)")
    print(f"⏳ Untested          : {unchecked:,} ({(unchecked/total*100 if total else 0):.1f}%)")
    print("=" * 55)

    providers = c.execute("""
        SELECT provider, 
               count(*),
               sum(CASE WHEN is_playable = 1 THEN 1 ELSE 0 END),
               sum(CASE WHEN is_playable = 0 THEN 1 ELSE 0 END),
               sum(CASE WHEN is_playable IS NULL THEN 1 ELSE 0 END)
        FROM channels
        GROUP BY provider;
    """).fetchall()

    print("\nBy Provider:")
    for prov, tot, p, o, u in providers:
        print(f"  • {prov or 'Unknown'}: {tot:,} total | 🟢 {p or 0:,} live | 🔴 {o or 0:,} offline | ⏳ {u or 0:,} untested")
    print()
    conn.close()


def cmd_verify(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="iptv_cli verify", description="Concurrently test and update HLS channel playability")
    parser.add_argument("--provider", help="Only verify channels from specific provider")
    parser.add_argument("--category", help="Only verify channels in specific category")
    parser.add_argument("--limit", type=int, default=100, help="Max channels to test (default 100, 0 for all)")
    parser.add_argument("--workers", type=int, default=20, help="Concurrent HTTP worker threads (default 20)")
    parser.add_argument("--timeout", type=float, default=4.0, help="Per-channel HTTP timeout in seconds (default 4.0)")
    parser.add_argument("--status", action="store_true", help="Print verification statistics and exit")
    parser.add_argument("--untested-only", action="store_true", help="Only test channels with is_playable IS NULL")
    args = parser.parse_args(argv)

    if args.status:
        show_verification_status()
        return 0

    is_pg = bool(db and db.is_postgres())
    ensure_tables()

    rows = []
    if is_pg:
        with db.get_db_cursor() as (c, _):
            query = "SELECT id, name, url, provider FROM channels WHERE 1=1"
            params = []
            if args.provider:
                query += " AND LOWER(TRIM(provider)) = LOWER(TRIM(%s))"
                params.append(args.provider)
            if args.category:
                query += " AND category = %s"
                params.append(args.category)
            if args.untested_only:
                query += " AND is_playable IS NULL"

            query += " ORDER BY CASE WHEN is_playable IS NULL THEN 0 ELSE 1 END, id ASC"
            if args.limit and args.limit > 0:
                query += f" LIMIT {args.limit}"
            c.execute(query, params)
            rows = c.fetchall()
    else:
        conn = get_db_connection()
        c = conn.cursor()
        query = "SELECT id, name, url, provider FROM channels WHERE 1=1"
        params = []
        if args.provider:
            query += " AND provider = ? COLLATE NOCASE"
            params.append(args.provider)
        if args.category:
            query += " AND category = ?"
            params.append(args.category)
        if args.untested_only:
            query += " AND is_playable IS NULL"

        query += " ORDER BY CASE WHEN is_playable IS NULL THEN 0 ELSE 1 END, id ASC"
        if args.limit and args.limit > 0:
            query += f" LIMIT {args.limit}"
        rows = c.execute(query, params).fetchall()
        conn.close()

    if not rows:
        print("No channels found matching filter criteria.")
        return 0

    print(f"Testing {len(rows)} channels with {args.workers} concurrent workers (timeout {args.timeout}s)...")
    live_count = 0
    offline_count = 0

    def _worker(item):
        cid, name, url, prov = item
        ok, code, msg, lat = check_stream(url, timeout=args.timeout)
        return cid, ok, code, msg, lat, name

    updates = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(_worker, r): r for r in rows}
        for future in as_completed(futures):
            cid, ok, code, msg, lat, name = future.result()
            now_iso = datetime.now().isoformat()
            updates.append((1 if ok else 0, lat, now_iso, msg, cid))
            if ok:
                live_count += 1
                status_icon = "🟢"
            else:
                offline_count += 1
                status_icon = "🔴"
            print(f"{status_icon} [{code}] {name[:35]:<35} ({lat}ms) - {msg}")

    # Batch commit updates
    if is_pg:
        with db.get_db_cursor(commit=True) as (c, _):
            for u in updates:
                c.execute("""
                    UPDATE channels
                    SET is_playable = %s, latency_ms = %s, last_checked = %s, error_msg = %s
                    WHERE id = %s;
                """, u)
    else:
        conn = get_db_connection()
        c = conn.cursor()
        c.executemany("""
            UPDATE channels
            SET is_playable = ?, latency_ms = ?, last_checked = ?, error_msg = ?
            WHERE id = ?;
        """, updates)
        conn.commit()
        conn.close()

    print(f"\nVerification Batch Completed: 🟢 {live_count} Live | 🔴 {offline_count} Offline.")
    return 0


# ==============================================================================
# SUBCOMMAND 5: sync-xtream
# ==============================================================================
def cmd_sync_xtream(argv: List[str]) -> int:
    parser = argparse.ArgumentParser(prog="iptv_cli sync-xtream", description="Fetch Xtream Codes API streams & generate M3U")
    parser.add_argument("--host", default=os.environ.get("XTREAM_HOST", ""), help="Xtream server base URL")
    parser.add_argument("--user", default=os.environ.get("XTREAM_USER", ""), help="Xtream username")
    parser.add_argument("--pass", dest="password", default=os.environ.get("XTREAM_PASS", ""), help="Xtream password")
    parser.add_argument("--stream-host", default=None, help="Stream playback host (defaults to --host)")
    parser.add_argument("--output", default=os.path.join(PLAYLISTS_DIR, "xtream.m3u"), help="Path to output M3U file")
    parser.add_argument("--format", default="ts", choices=["ts", "m3u8"], help="Stream format (ts or m3u8)")
    parser.add_argument("--dry-run", action="store_true", help="Query API without writing M3U file")
    args = parser.parse_args(argv)

    base_url = args.host.rstrip("/")
    stream_host = (args.stream_host or base_url).rstrip("/")
    username = args.user
    password = args.password
    m3u_path = args.output

    print(f"📡 Connecting to Xtream API at {base_url}...")
    headers = {"User-Agent": "Mozilla/5.0"}

    cat_map = {}
    try:
        r_cat = requests.get(
            f"{base_url}/player_api.php?username={username}&password={password}&action=get_live_categories",
            headers=headers, timeout=15
        )
        if r_cat.status_code == 200:
            cats = r_cat.json()
            if isinstance(cats, list):
                cat_map = {str(c.get("category_id")): c.get("category_name", "General") for c in cats}
    except Exception as e:
        print(f"⚠️ Warning: Could not fetch categories: {e}")

    try:
        r_streams = requests.get(
            f"{base_url}/player_api.php?username={username}&password={password}&action=get_live_streams",
            headers=headers, timeout=45
        )
        r_streams.raise_for_status()
        streams = r_streams.json()
    except Exception as e:
        print(f"❌ Failed to fetch live streams: {e}")
        return 1

    if not isinstance(streams, list):
        print(f"❌ Unexpected response format from API: {streams}")
        return 1

    if args.dry_run:
        print(f"[sync-xtream:dry-run] Found {len(streams)} live streams. Skipping write.")
        return 0

    os.makedirs(os.path.dirname(m3u_path), exist_ok=True)
    with open(m3u_path, "w", encoding="utf-8") as f:
        f.write("#EXTM3U\n")
        for s in streams:
            name = s.get("name", "Unknown Channel")
            sid = s.get("stream_id")
            cat_id = str(s.get("category_id", ""))
            category = cat_map.get(cat_id, "General")
            icon = s.get("stream_icon", "")
            tvg_id = s.get("epg_channel_id", "")
            stream_url = f"{stream_host}/live/{username}/{password}/{sid}.{args.format}"
            f.write(f'#EXTINF:-1 tvg-id="{tvg_id}" tvg-name="{name}" tvg-logo="{icon}" group-title="{category}",{name}\n')
            f.write(f"{stream_url}\n")

    print(f"✅ Successfully wrote {len(streams)} channels to {m3u_path} ({os.path.getsize(m3u_path):,} bytes).")
    return 0


# ==============================================================================
# SUBCOMMAND 5: check-active
# ==============================================================================
def cmd_check_active(argv: List[str]) -> int:
    checker_script = os.path.join(_stream_dir, "channel_checker.py")
    if os.path.exists(checker_script):
        cmd = [sys.executable, checker_script] + argv
        return subprocess.run(cmd).returncode
    print("Active playlist health check complete.")
    return 0


# ==============================================================================
# SUBCOMMAND 6: rotate
# ==============================================================================
def cmd_rotate(argv: List[str]) -> int:
    rotate_script = os.path.join(_stream_dir, "rotate_stream.py")
    if os.path.exists(rotate_script):
        cmd = [sys.executable, rotate_script] + argv
        return subprocess.run(cmd).returncode
    return 0


SUBCOMMANDS = {
    "import-m3u": cmd_import_m3u,
    "import-yt": cmd_import_yt,
    "verify": cmd_verify,
    "sync-xtream": cmd_sync_xtream,
    "check-active": cmd_check_active,
    "rotate": cmd_rotate,
}


def run_subcommand(subcommand: str, argv: Optional[List[str]] = None) -> int:
    if argv is None:
        argv = []
    handler = SUBCOMMANDS.get(subcommand)
    if not handler:
        print(f"Error: Unknown subcommand '{subcommand}'. Available: {list(SUBCOMMANDS.keys())}", file=sys.stderr)
        return 1
    return handler(argv)


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        sys.exit(0)

    subcommand = sys.argv[1]
    if subcommand not in SUBCOMMANDS:
        print(f"Unknown subcommand '{subcommand}'. Available:\n  " + "\n  ".join(SUBCOMMANDS.keys()))
        sys.exit(1)

    sys.exit(run_subcommand(subcommand, sys.argv[2:]))


if __name__ == "__main__":
    main()
