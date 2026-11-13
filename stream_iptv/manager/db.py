import os
import sys
import re
import time
import threading
import logging
from datetime import datetime
from contextlib import contextmanager

logger = logging.getLogger("stream_iptv.db")

_pg_pool = None
_use_postgres = False
DATABASE_URL = os.environ.get("DATABASE_URL")

try:
    import psycopg2
    from psycopg2 import pool, extras
    _HAS_PSYCOPG2 = True
except ImportError:
    _HAS_PSYCOPG2 = False

import sqlite3

def get_default_sqlite_path():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_dir, "../channels.db")

_PG_PASS = os.environ.get("POSTGRES_PASS", "")
# Postgres only when DATABASE_URL is set; otherwise SQLite in /data/channels.db.
DEFAULT_PG_URLS = [os.environ.get("DATABASE_URL")]

def init_postgres_pool(db_url=None):
    global _pg_pool, _use_postgres
    if not _HAS_PSYCOPG2:
        _use_postgres = False
        return False
    
    urls_to_try = [db_url] if db_url else [u for u in DEFAULT_PG_URLS if u]
    for url in urls_to_try:
        try:
            pool_candidate = pool.ThreadedConnectionPool(minconn=1, maxconn=20, dsn=url, connect_timeout=4)
            conn = pool_candidate.getconn()
            try:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1;")
                conn.commit()
                _pg_pool = pool_candidate
                _use_postgres = True
                logger.info(f"Successfully connected to PostgreSQL at {url.split('@')[-1]}.")
                return True
            finally:
                pool_candidate.putconn(conn)
        except Exception:
            continue

    _use_postgres = False
    REQUIRE_POSTGRES = os.environ.get("REQUIRE_POSTGRES", "0").lower() in ("1", "true", "yes")
    if REQUIRE_POSTGRES:
        logger.error("Could not connect to any PostgreSQL instance! PostgreSQL is strictly required.")
    else:
        logger.warning("Could not connect to any PostgreSQL instance. Falling back to SQLite.")
    return False

# Attempt initial pool setup
if _HAS_PSYCOPG2:
    init_postgres_pool()

_pg_retry_lock = threading.Lock()
_pg_last_attempt = 0.0
_PG_RETRY_SECONDS = 10


def is_postgres():
    """True when PostgreSQL is usable. If it is not (e.g. iptv-db was restarting
    when this worker booted), retry the connection at most every
    _PG_RETRY_SECONDS instead of silently staying on the SQLite path, whose
    channels.db is empty in K3s and fails with "no such table"."""
    global _pg_last_attempt
    if _use_postgres and _pg_pool is not None:
        return True
    if _HAS_PSYCOPG2 and time.time() - _pg_last_attempt >= _PG_RETRY_SECONDS:
        with _pg_retry_lock:
            if not (_use_postgres and _pg_pool is not None) and time.time() - _pg_last_attempt >= _PG_RETRY_SECONDS:
                _pg_last_attempt = time.time()
                init_postgres_pool()
    return _use_postgres and _pg_pool is not None

@contextmanager
def get_db_cursor(db_path=None, commit=False):
    """
    Context manager that yields (cursor, is_pg).
    Automatically returns connection to pool (PostgreSQL). SQLite fallback is blocked when REQUIRE_POSTGRES=1.
    """
    global _pg_pool, _use_postgres
    is_postgres()  # reconnects (throttled) if the pool is down

    REQUIRE_POSTGRES = os.environ.get("REQUIRE_POSTGRES", "0").lower() in ("1", "true", "yes")
    if is_postgres():
        conn = None
        try:
            conn = _pg_pool.getconn()
            with conn.cursor() as cur:
                yield cur, True
            if commit:
                conn.commit()
        except Exception as e:
            if conn:
                try:
                    conn.rollback()
                except Exception:
                    pass
            logger.error(f"PostgreSQL query error: {e}")
            raise
        finally:
            if conn:
                # Drop connections the server closed (iptv-db restart) instead of
                # handing them to the next request.
                _pg_pool.putconn(conn, close=bool(conn.closed))
    else:
        if REQUIRE_POSTGRES:
            raise RuntimeError("PostgreSQL database is required but unreachable! SQLite fallback is disabled.")
        path = db_path or get_default_sqlite_path()
        conn = sqlite3.connect(path, timeout=30.0)
        try:
            cur = conn.cursor()
            yield cur, False
            if commit:
                conn.commit()
        except Exception as e:
            if conn:
                try:
                    conn.rollback()
                except Exception:
                    pass
            logger.error(f"SQLite query error: {e}")
            raise
        finally:
            conn.close()

def ensure_schema(db_path=None):
    """Ensures tables and indexes exist on either PostgreSQL or SQLite."""
    if is_postgres():
        with get_db_cursor(commit=True) as (cur, is_pg):
            # Extensions
            try:
                cur.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm;")
            except Exception as ex:
                logger.warning(f"Could not enable pg_trgm extension: {ex}")

            # Channels table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS channels (
                    id SERIAL PRIMARY KEY,
                    name TEXT,
                    url TEXT,
                    category TEXT,
                    tvg_id TEXT,
                    logo TEXT,
                    provider TEXT,
                    is_playable INTEGER DEFAULT NULL,
                    latency_ms INTEGER DEFAULT NULL,
                    last_checked TIMESTAMP DEFAULT NULL,
                    error_msg TEXT DEFAULT NULL
                );
            """)

            # Indexes
            cur.execute("CREATE INDEX IF NOT EXISTS idx_channel_name ON channels(name);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_channel_category ON channels(category);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_channel_provider ON channels(provider);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_channels_prov_name ON channels(provider, name);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_channels_prov_cat ON channels(provider, category);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_channel_prov_lower ON channels(LOWER(provider));")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_channels_url ON channels(url);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_channels_playable ON channels(is_playable);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_channels_tvg_id ON channels(tvg_id);")
            try:
                cur.execute("CREATE INDEX IF NOT EXISTS idx_channels_name_trgm ON channels USING gin (name gin_trgm_ops);")
                cur.execute("CREATE INDEX IF NOT EXISTS idx_channels_category_trgm ON channels USING gin (category gin_trgm_ops);")
            except Exception as e:
                logger.warning(f"GIN trgm index setup note: {e}")

            # EPG table
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
            cur.execute("CREATE INDEX IF NOT EXISTS idx_epg_tvg_id ON epg_schedules(tvg_id);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_epg_start_stop ON epg_schedules(start, stop);")

            # DVR table
            cur.execute("""
                CREATE TABLE IF NOT EXISTS dvr_recordings (
                    id SERIAL PRIMARY KEY,
                    job_id TEXT UNIQUE,
                    username TEXT,
                    provider TEXT,
                    channel_name TEXT,
                    channel_url TEXT,
                    channel_logo TEXT,
                    program_title TEXT,
                    program_desc TEXT,
                    start_time TEXT,
                    end_time TEXT,
                    duration_seconds INTEGER,
                    status TEXT,
                    file_path TEXT,
                    file_size BIGINT DEFAULT 0,
                    error_message TEXT,
                    created_at TEXT
                );
            """)
            logger.info("PostgreSQL schema verification completed.")
            warm_provider_caches_async()
    else:
        path = db_path or get_default_sqlite_path()
        conn = sqlite3.connect(path, timeout=30.0)
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS channels (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT,
                    url TEXT,
                    category TEXT,
                    tvg_id TEXT,
                    logo TEXT,
                    provider TEXT,
                    is_playable INTEGER DEFAULT NULL,
                    latency_ms INTEGER DEFAULT NULL,
                    last_checked TIMESTAMP DEFAULT NULL,
                    error_msg TEXT DEFAULT NULL
                );
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS epg_schedules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tvg_id TEXT,
                    start TEXT,
                    stop TEXT,
                    title TEXT,
                    desc TEXT
                );
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS dvr_recordings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_id TEXT UNIQUE,
                    username TEXT,
                    provider TEXT,
                    channel_name TEXT,
                    channel_url TEXT,
                    channel_logo TEXT,
                    program_title TEXT,
                    program_desc TEXT,
                    start_time TEXT,
                    end_time TEXT,
                    duration_seconds INTEGER,
                    status TEXT,
                    file_path TEXT,
                    file_size INTEGER DEFAULT 0,
                    error_message TEXT,
                    created_at TEXT
                );
            """)
            conn.execute("CREATE INDEX IF NOT EXISTS idx_channel_name ON channels(name);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_channel_category ON channels(category);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_channel_provider ON channels(provider);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_channels_playable ON channels(is_playable);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_channels_tvg_id ON channels(tvg_id);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_epg_tvg_id ON epg_schedules(tvg_id);")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_epg_start_stop ON epg_schedules(start, stop);")
            try:
                conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS channels_fts USING fts5(name, category, content=channels, content_rowid=id)")
            except Exception:
                pass
            conn.commit()
        finally:
            conn.close()
        logger.info("SQLite schema verification completed.")

def search_channels(query, db_path=None, limit=200):
    """
    Search channels with sub-millisecond to low-millisecond performance.
    In PostgreSQL: Uses ILIKE with GIN trigram index and smart relevance sorting.
    In SQLite: Uses FTS5 with fallback to LIKE.
    """
    if not query or len(query.strip()) < 2:
        return []

    q = query.strip()
    if is_postgres():
        with get_db_cursor() as (cur, _):
            tokens = [t for t in q.split() if t]
            where_clauses = []
            params = []
            for t in tokens:
                where_clauses.append("(c.name ILIKE %s OR c.category ILIKE %s)")
                params.extend([f"%{t}%", f"%{t}%"])

            cur.execute(f"""
                SELECT c.id, c.name, c.url, c.category, NULL, c.logo, c.provider, c.is_playable, c.latency_ms, c.last_checked, c.error_msg
                FROM channels c
                WHERE {' AND '.join(where_clauses)}
                LIMIT %s
            """, params + [limit * 2])
            rows = cur.fetchall()

            # Fast in-memory sort to prioritize prefix matches, then substring matches, then name
            q_lower = q.lower()
            def sort_key(r):
                name = (r[1] or "").lower()
                if name.startswith(q_lower):
                    p = 0
                elif q_lower in name:
                    p = 1
                else:
                    p = 2
                return (p, name)
            rows.sort(key=sort_key)
            rows = rows[:limit]

            return [
                {
                    "id": r[0],
                    "name": r[1],
                    "url": r[2],
                    "category": r[3] or "",
                    "live_title": "",
                    "logo": r[5] or "",
                    "provider": r[6] or "",
                    "is_playable": r[7],
                    "latency_ms": r[8],
                    "last_checked": str(r[9]) if r[9] else None,
                    "error_msg": r[10] or ""
                }
                for r in rows
            ]
    else:
        path = db_path or get_default_sqlite_path()
        if not os.path.exists(path):
            return []
        conn = sqlite3.connect(path, timeout=30.0)
        try:
            cur = conn.cursor()
            results = []
            clean_tokens = [re.sub(r'[^a-zA-Z0-9_\u00C0-\u017F]', '', t) for t in q.split() if t]
            clean_tokens = [t for t in clean_tokens if len(t) >= 2 or len(clean_tokens) > 1]
            if clean_tokens:
                fts_expr = " ".join([f'"{t}"*' for t in clean_tokens])
                try:
                    cur.execute("""
                        SELECT c.id, c.name, c.url, c.category, NULL, c.logo, c.provider, c.is_playable, c.latency_ms, c.last_checked, c.error_msg
                        FROM channels_fts f
                        JOIN channels c ON c.id = f.rowid
                        WHERE channels_fts MATCH ?
                        ORDER BY rank
                        LIMIT ?
                    """, (fts_expr, limit))
                    rows = cur.fetchall()
                    if rows:
                        results = [
                            {
                                "id": row[0],
                                "name": row[1],
                                "url": row[2],
                                "category": row[3] or "",
                                "live_title": "",
                                "logo": row[5] or "",
                                "provider": row[6] or "",
                                "is_playable": row[7],
                                "latency_ms": row[8],
                                "last_checked": str(row[9]) if row[9] else None,
                                "error_msg": row[10] or ""
                            }
                            for row in rows
                        ]
                except Exception:
                    pass

            if not results:
                tokens = [t for t in q.split() if t]
                where_clauses = ["(c.name LIKE ? OR c.category LIKE ?)"] * len(tokens)
                params = []
                for t in tokens:
                    params.extend([f"%{t}%", f"%{t}%"])
                exact_prefix = f"{q}%"
                exact_contains = f"%{q}%"
                order_params = [exact_prefix, exact_contains]

                cur.execute(f"""
                    SELECT c.id, c.name, c.url, c.category, NULL, c.logo, c.provider, c.is_playable, c.latency_ms, c.last_checked, c.error_msg
                    FROM channels c
                    WHERE {' AND '.join(where_clauses)}
                    ORDER BY
                        CASE
                            WHEN c.name LIKE ? THEN 0
                            WHEN c.name LIKE ? THEN 1
                            ELSE 2
                        END,
                        c.name ASC
                    LIMIT ?
                """, params + order_params + [limit])
                results = [
                    {
                        "id": row[0],
                        "name": row[1],
                        "url": row[2],
                        "category": row[3] or "",
                        "live_title": "",
                        "logo": row[5] or "",
                        "provider": row[6] or "",
                        "is_playable": row[7],
                        "latency_ms": row[8],
                        "last_checked": str(row[9]) if row[9] else None,
                        "error_msg": row[10] or ""
                    }
                    for row in cur.fetchall()
                ]
            return results
        finally:
            conn.close()

_all_categories_cache = None
_all_categories_time = 0

def get_distinct_categories(db_path=None):
    global _all_categories_cache, _all_categories_time
    if is_postgres():
        now = time.time()
        if _all_categories_cache is not None and (now - _all_categories_time < 300):
            return list(_all_categories_cache)
        # Check provider categories cache if already warmed
        if _provider_categories_cache:
            merged = set()
            for cats in _provider_categories_cache.values():
                merged.update(cats)
            if merged:
                _all_categories_cache = sorted(list(merged))
                _all_categories_time = now
                return list(_all_categories_cache)
        with get_db_cursor() as (cur, _):
            cur.execute("SELECT DISTINCT category FROM channels WHERE category IS NOT NULL AND category != '' ORDER BY category ASC")
            _all_categories_cache = [row[0] for row in cur.fetchall()]
            _all_categories_time = now
            return list(_all_categories_cache)
    else:
        path = db_path or get_default_sqlite_path()
        if not os.path.exists(path):
            return []
        conn = sqlite3.connect(path, timeout=30.0)
        try:
            cur = conn.cursor()
            cur.execute("SELECT DISTINCT category FROM channels WHERE category IS NOT NULL AND category != '' ORDER BY category ASC")
            return [row[0] for row in cur.fetchall()]
        finally:
            conn.close()

def get_channels_by_category(category, db_path=None, limit=15000):
    if not category:
        return []
    if is_postgres():
        with get_db_cursor() as (cur, _):
            cur.execute("""
                SELECT c.id, c.name, c.url, c.category, e.title, c.logo, c.provider, c.is_playable, c.latency_ms, c.last_checked, c.error_msg
                FROM channels c
                LEFT JOIN epg_schedules e ON c.tvg_id = e.tvg_id AND CURRENT_TIMESTAMP::text BETWEEN e.start AND e.stop
                WHERE c.category = %s
                ORDER BY c.name ASC
                LIMIT %s
            """, (category, limit))
            return [
                {
                    "id": row[0],
                    "name": row[1],
                    "url": row[2],
                    "category": row[3],
                    "live_title": row[4] or "",
                    "logo": row[5] or "",
                    "provider": row[6] or "",
                    "is_playable": row[7],
                    "latency_ms": row[8],
                    "last_checked": str(row[9]) if row[9] else None,
                    "error_msg": row[10] or ""
                }
                for row in cur.fetchall()
            ]
    else:
        path = db_path or get_default_sqlite_path()
        if not os.path.exists(path):
            return []
        conn = sqlite3.connect(path, timeout=30.0)
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT c.id, c.name, c.url, c.category, e.title, c.logo, c.provider, c.is_playable, c.latency_ms, c.last_checked, c.error_msg
                FROM channels c
                LEFT JOIN epg_schedules e ON c.tvg_id = e.tvg_id AND datetime('now') BETWEEN e.start AND e.stop
                WHERE c.category = ?
                ORDER BY c.name ASC
                LIMIT ?
            """, (category, limit))
            return [
                {
                    "id": row[0],
                    "name": row[1],
                    "url": row[2],
                    "category": row[3],
                    "live_title": row[4] or "",
                    "logo": row[5] or "",
                    "provider": row[6] or "",
                    "is_playable": row[7],
                    "latency_ms": row[8],
                    "last_checked": str(row[9]) if row[9] else None,
                    "error_msg": row[10] or ""
                }
                for row in cur.fetchall()
            ]
        finally:
            conn.close()

_provider_counts_summary_cache = None
_provider_counts_summary_time = 0

def get_provider_channel_counts(db_path=None):
    global _provider_counts_summary_cache, _provider_counts_summary_time
    counts = {}
    if is_postgres():
        now = time.time()
        if _provider_counts_summary_cache is not None and (now - _provider_counts_summary_time < 300):
            return dict(_provider_counts_summary_cache)
        with get_db_cursor() as (cur, _):
            cur.execute("SELECT provider, count(*) FROM channels GROUP BY provider")
            for row in cur.fetchall():
                p_name = row[0] or "Unknown"
                counts[p_name] = row[1]
        _provider_counts_summary_cache = counts
        _provider_counts_summary_time = now
    else:
        path = db_path or get_default_sqlite_path()
        if os.path.exists(path):
            conn = sqlite3.connect(path, timeout=10.0)
            try:
                cur = conn.cursor()
                cur.execute("SELECT provider, count(*) FROM channels GROUP BY provider")
                for row in cur.fetchall():
                    p_name = row[0] or "Unknown"
                    counts[p_name] = row[1]
            finally:
                conn.close()
    return counts

def purge_provider_channels(provider_name, db_path=None):
    if not provider_name:
        return 0
    if is_postgres():
        with get_db_cursor(commit=True) as (cur, _):
            cur.execute("SELECT count(*) FROM channels WHERE LOWER(TRIM(provider)) = LOWER(TRIM(%s)) OR provider = %s", (provider_name, provider_name))
            deleted_count = cur.fetchone()[0]
            cur.execute("DELETE FROM channels WHERE LOWER(TRIM(provider)) = LOWER(TRIM(%s)) OR provider = %s", (provider_name, provider_name))
            return deleted_count
    else:
        path = db_path or get_default_sqlite_path()
        if not os.path.exists(path):
            return 0
        conn = sqlite3.connect(path, timeout=30.0)
        try:
            cur = conn.cursor()
            cur.execute("SELECT count(*) FROM channels WHERE LOWER(TRIM(provider)) = LOWER(TRIM(?)) OR provider = ?", (provider_name, provider_name))
            deleted_count = cur.fetchone()[0]
            cur.execute("DELETE FROM channels WHERE LOWER(TRIM(provider)) = LOWER(TRIM(?)) OR provider = ?", (provider_name, provider_name))
            conn.commit()
            return deleted_count
        finally:
            conn.close()

def rename_provider_channels(old_name, new_name, db_path=None):
    """Updates provider name for all channels in database."""
    if not old_name or not new_name or old_name.strip() == new_name.strip():
        return 0
    if is_postgres():
        with get_db_cursor(commit=True) as (cur, _):
            cur.execute(
                "UPDATE channels SET provider = %s WHERE LOWER(TRIM(provider)) = LOWER(TRIM(%s)) OR provider = %s;",
                (new_name.strip(), old_name.strip(), old_name.strip())
            )
            return cur.rowcount
    else:
        path = db_path or get_default_sqlite_path()
        if not os.path.exists(path):
            return 0
        conn = sqlite3.connect(path, timeout=30.0)
        try:
            cur = conn.cursor()
            cur.execute(
                "UPDATE channels SET provider = ? WHERE LOWER(TRIM(provider)) = LOWER(TRIM(?)) OR provider = ?;",
                (new_name.strip(), old_name.strip(), old_name.strip())
            )
            conn.commit()
            return cur.rowcount
        finally:
            conn.close()
_provider_categories_cache = {}
_provider_categories_time = {}
_provider_count_cache = {}
_provider_count_time = {}

def warm_provider_caches_async():
    """Warms categories and counts for all active providers in background."""
    import threading
    def _warm():
        if not is_postgres():
            return
        try:
            with get_db_cursor() as (cur, _):
                cur.execute("SELECT DISTINCT provider FROM channels WHERE provider IS NOT NULL AND provider != '';")
                providers = [r[0] for r in cur.fetchall() if r and r[0]]
                now = time.time()
                for p in providers:
                    if p not in _provider_categories_cache:
                        cur.execute(
                            "SELECT DISTINCT category FROM channels WHERE provider = %s AND category IS NOT NULL AND category != '' ORDER BY category ASC",
                            (p,)
                        )
                        _provider_categories_cache[p] = [r[0] for r in cur.fetchall() if r and len(r) > 0]
                        _provider_categories_time[p] = now
                    if p not in _provider_count_cache:
                        cur.execute("SELECT COUNT(*) FROM channels WHERE provider = %s", (p,))
                        c_row = cur.fetchone()
                        _provider_count_cache[p] = c_row[0] if c_row else 0
                        _provider_count_time[p] = now
        except Exception as e:
            logger.debug(f"Cache pre-warm note: {e}")
    threading.Thread(target=_warm, daemon=True).start()

def invalidate_provider_cache(provider=None):
    global _provider_categories_cache, _provider_categories_time, _provider_count_cache, _provider_count_time
    global _all_categories_cache, _all_categories_time, _provider_counts_summary_cache, _provider_counts_summary_time
    _all_categories_cache = None
    _all_categories_time = 0
    _provider_counts_summary_cache = None
    _provider_counts_summary_time = 0
    if provider:
        p_clean = provider.strip()
        _provider_categories_cache.pop(p_clean, None)
        _provider_categories_time.pop(p_clean, None)
        _provider_count_cache.pop(p_clean, None)
        _provider_count_time.pop(p_clean, None)
    else:
        _provider_categories_cache.clear()
        _provider_categories_time.clear()
        _provider_count_cache.clear()
        _provider_count_time.clear()

def get_provider_channels(provider, q=None, category=None, page=1, per_page=100, db_path=None):
    if not provider:
        return {"total": 0, "categories": [], "channels": [], "page": 1, "per_page": per_page, "pages": 1}

    page = max(1, int(page))
    per_page = min(200, max(10, int(per_page)))
    offset = (page - 1) * per_page
    prov_str = provider.strip()

    if is_postgres():
        with get_db_cursor() as (cur, _):
            now = time.time()
            # 1. Categories - use in-memory cache to avoid repeated 20-second HashAggregates
            categories = _provider_categories_cache.get(prov_str)
            if categories is None and not q:
                # Only query categories synchronously if user is browsing without a search query
                cur.execute(
                    "SELECT DISTINCT category FROM channels WHERE provider = %s AND category IS NOT NULL AND category != '' ORDER BY category ASC",
                    (prov_str,)
                )
                categories = [r[0] for r in cur.fetchall() if r and len(r) > 0]
                if not categories:
                    cur.execute(
                        "SELECT DISTINCT category FROM channels WHERE LOWER(provider) = LOWER(%s) AND category IS NOT NULL AND category != '' ORDER BY category ASC",
                        (prov_str,)
                    )
                    categories = [r[0] for r in cur.fetchall() if r and len(r) > 0]
                _provider_categories_cache[prov_str] = categories
                _provider_categories_time[prov_str] = now
            elif categories is None:
                categories = []

            # 2. Exact provider equality enables direct index seek on idx_channels_prov_name / idx_channels_prov_cat
            conditions = ["provider = %s"]
            params = [prov_str]

            if q:
                q_clean = q.strip()
                if q_clean.upper() in ('ID', 'IDN', 'INA'):
                    conditions.append("(name ILIKE %s OR name ILIKE %s OR name ILIKE %s OR category ILIKE %s OR category ILIKE %s)")
                    params.extend(['ID %', 'ID:%', 'ID|%', 'Indonesia%', '%Indo%'])
                elif q_clean.lower() in ('indonesia', 'indonesian'):
                    conditions.append("(category ILIKE %s OR category ILIKE %s OR name ILIKE %s OR name ILIKE %s OR name ILIKE %s OR name ILIKE %s)")
                    params.extend(['Indonesia%', '%Indo%', 'ID %', 'ID:%', 'ID|%', f"%{q_clean}%"])
                else:
                    conditions.append("(name ILIKE %s OR category ILIKE %s)")
                    params.extend([f"%{q_clean}%", f"%{q_clean}%"])

            if category:
                conditions.append("category = %s")
                params.append(category)

            where_clause = " AND ".join(conditions)

            # 3. Fetch channels with limit
            fetch_limit = per_page + 1
            cur.execute(
                f"SELECT id, name, url, category, logo, is_playable, latency_ms, last_checked, error_msg FROM channels WHERE {where_clause} ORDER BY name ASC LIMIT %s OFFSET %s",
                params + [fetch_limit, offset]
            )
            raw_rows = cur.fetchall()

            # Case fallback if 0 rows returned on first page
            if not raw_rows and not q and not category and page == 1:
                cur.execute("SELECT DISTINCT provider FROM channels WHERE LOWER(provider) = LOWER(%s) LIMIT 1", (prov_str,))
                exact_prov_row = cur.fetchone()
                if exact_prov_row and exact_prov_row[0] != prov_str:
                    prov_str = exact_prov_row[0]
                    params[0] = prov_str
                    cur.execute(
                        f"SELECT id, name, url, category, logo, is_playable, latency_ms, last_checked, error_msg FROM channels WHERE {where_clause} ORDER BY name ASC LIMIT %s OFFSET %s",
                        params + [fetch_limit, offset]
                    )
                    raw_rows = cur.fetchall()

            has_more = len(raw_rows) > per_page
            display_rows = raw_rows[:per_page] if has_more else raw_rows

            # 4. Total count optimization
            if not q and not category:
                total = _provider_count_cache.get(prov_str)
                if total is None or (now - _provider_count_time.get(prov_str, 0) > 300):
                    cur.execute("SELECT COUNT(*) FROM channels WHERE provider = %s", [prov_str])
                    t_row = cur.fetchone()
                    total = t_row[0] if t_row else len(display_rows)
                    _provider_count_cache[prov_str] = total
                    _provider_count_time[prov_str] = now
            elif page == 1 and not has_more:
                total = len(display_rows)
            else:
                cur.execute(f"SELECT COUNT(*) FROM channels WHERE {where_clause}", params)
                row = cur.fetchone()
                total = row[0] if row and len(row) > 0 else len(display_rows)

            channels = [
                {
                    "id": r[0],
                    "name": r[1] or "",
                    "url": r[2] or "",
                    "category": r[3] or "",
                    "logo": r[4] or "",
                    "is_playable": r[5],
                    "latency_ms": r[6],
                    "last_checked": str(r[7]) if (len(r) > 7 and r[7]) else "",
                    "error_msg": r[8] if (len(r) > 8 and r[8]) else ""
                }
                for r in display_rows
            ]
            return {
                "total": total,
                "page": page,
                "per_page": per_page,
                "pages": max(1, (total + per_page - 1) // per_page),
                "categories": categories,
                "channels": channels
            }
    else:
        path = db_path or get_default_sqlite_path()
        if not os.path.exists(path):
            return {"total": 0, "categories": [], "channels": [], "page": page, "per_page": per_page, "pages": 1}
        conn = sqlite3.connect(path, timeout=10.0)
        try:
            cur = conn.cursor()
            conditions = ["provider = ? COLLATE NOCASE"]
            params = [provider]
            if q:
                q_clean = q.strip()
                if q_clean.upper() in ('ID', 'IDN', 'INA'):
                    conditions.append("(name LIKE 'ID %' OR name LIKE 'ID:%' OR name LIKE 'ID|%' OR category LIKE 'Indonesia%' OR category LIKE '%Indo%')")
                elif q_clean.lower() in ('indonesia', 'indonesian'):
                    conditions.append("(category LIKE 'Indonesia%' OR category LIKE '%Indo%' OR name LIKE 'ID %' OR name LIKE 'ID:%' OR name LIKE 'ID|%' OR name LIKE ?)")
                    params.append(f"%{q_clean}%")
                else:
                    conditions.append("(name LIKE ? OR category LIKE ?)")
                    params.extend([f"%{q_clean}%", f"%{q_clean}%"])
            if category:
                conditions.append("category = ?")
                params.append(category)

            where_clause = " AND ".join(conditions)

            cur.execute(f"SELECT COUNT(*) FROM channels WHERE {where_clause}", params)
            total = cur.fetchone()[0]

            cur.execute(
                "SELECT DISTINCT category FROM channels WHERE provider = ? COLLATE NOCASE AND category IS NOT NULL AND category != '' ORDER BY category ASC",
                [provider]
            )
            categories = [r[0] for r in cur.fetchall()]

            cur.execute(
                f"SELECT id, name, url, category, logo, is_playable, latency_ms, last_checked, error_msg FROM channels WHERE {where_clause} ORDER BY name ASC LIMIT ? OFFSET ?",
                params + [per_page, offset]
            )
            channels = [
                {
                    "id": r[0],
                    "name": r[1],
                    "url": r[2],
                    "category": r[3] or "",
                    "logo": r[4] or "",
                    "is_playable": r[5],
                    "latency_ms": r[6],
                    "last_checked": str(r[7]) if r[7] else "",
                    "error_msg": r[8] or ""
                }
                for r in cur.fetchall()
            ]
            return {
                "total": total,
                "page": page,
                "per_page": per_page,
                "pages": max(1, (total + per_page - 1) // per_page),
                "categories": categories,
                "channels": channels
            }
        finally:
            conn.close()

def insert_channels_batch(batch, db_path=None):
    """
    Inserts a list of tuples (name, url, category, tvg_id, logo, provider)
    into the active database (PostgreSQL or SQLite).
    """
    if not batch:
        return
    if is_postgres():
        with get_db_cursor(commit=True) as (cur, _):
            insert_sql = "INSERT INTO channels (name, url, category, tvg_id, logo, provider) VALUES %s"
            extras.execute_values(cur, insert_sql, batch, page_size=2000)
    else:
        path = db_path or get_default_sqlite_path()
        conn = sqlite3.connect(path, timeout=60.0)
        try:
            cur = conn.cursor()
            cur.executemany("INSERT INTO channels (name, url, category, tvg_id, logo, provider) VALUES (?, ?, ?, ?, ?, ?)", batch)
            conn.commit()
        finally:
            conn.close()

def update_channel_status(url, is_playable, latency=0, err_text="", db_path=None):
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if is_postgres():
        with get_db_cursor(commit=True) as (cur, _):
            cur.execute("""
                UPDATE channels
                SET is_playable = %s,
                    latency_ms = %s,
                    last_checked = CURRENT_TIMESTAMP,
                    error_msg = %s
                WHERE url = %s
            """, (1 if is_playable else 0, latency, str(err_text)[:100], url))
    else:
        path = db_path or get_default_sqlite_path()
        if not os.path.exists(path):
            return
        conn = sqlite3.connect(path, timeout=5.0)
        try:
            conn.execute("""
                UPDATE channels
                SET is_playable = ?,
                    latency_ms = ?,
                    last_checked = CURRENT_TIMESTAMP,
                    error_msg = ?
                WHERE url = ?
            """, (1 if is_playable else 0, latency, str(err_text)[:100], url))
            conn.commit()
        finally:
            conn.close()

def find_replacement_channel(name, current_url, db_path=None):
    """Searches for candidate healthy channels for preflight healing."""
    candidates = []
    if is_postgres():
        with get_db_cursor() as (cur, _):
            lower_name = name.lower()
            curated_lookups = []
            for key, pattern, prov in curated_lookups:
                if key in lower_name:
                    cur.execute("SELECT url, name, provider FROM channels WHERE name ILIKE %s AND url != %s ORDER BY id ASC LIMIT 5", (pattern, current_url))
                    rows = cur.fetchall()
                    candidates.extend(rows)
                    if rows:
                        break

            if not candidates:
                cur.execute("SELECT url, name, provider FROM channels WHERE name = %s AND url != %s ORDER BY is_playable DESC NULLS LAST, id ASC LIMIT 5", (name, current_url))
                candidates.extend(cur.fetchall())

            if not candidates:
                clean = re.sub(r'[\U00010000-\U0010ffff]', '', name)
                clean = re.sub(r'\b(UHD|FHD|HD|SD|East|West|LHD|24/7|Live|Selects)\b', '', clean, flags=re.IGNORECASE)
                clean = clean.replace('*', '').replace('|', '').replace('-', ' ').strip()
                clean = re.sub(r'\s+', ' ', clean)
                if len(clean) >= 3:
                    cur.execute("SELECT url, name, provider FROM channels WHERE name ILIKE %s AND url != %s ORDER BY is_playable DESC NULLS LAST, id ASC LIMIT 8", (f"%{clean}%", current_url))
                    candidates.extend(cur.fetchall())
    else:
        path = db_path or get_default_sqlite_path()
        if os.path.exists(path):
            conn = sqlite3.connect(path, timeout=5.0)
            try:
                cur = conn.cursor()
                lower_name = name.lower()
                curated_lookups = []
                for key, pattern, prov in curated_lookups:
                    if key in lower_name:
                        rows = cur.execute("SELECT url, name, provider FROM channels WHERE name LIKE ? AND url != ? ORDER BY id ASC LIMIT 5", (pattern, current_url)).fetchall()
                        candidates.extend(rows)
                        if rows:
                            break

                if not candidates:
                    rows = cur.execute("SELECT url, name, provider FROM channels WHERE name = ? AND url != ? ORDER BY is_playable DESC, id ASC LIMIT 5", (name, current_url)).fetchall()
                    candidates.extend(rows)

                if not candidates:
                    clean = re.sub(r'[\U00010000-\U0010ffff]', '', name)
                    clean = re.sub(r'\b(UHD|FHD|HD|SD|East|West|LHD|24/7|Live|Selects)\b', '', clean, flags=re.IGNORECASE)
                    clean = clean.replace('*', '').replace('|', '').replace('-', ' ').strip()
                    clean = re.sub(r'\s+', ' ', clean)
                    if len(clean) >= 3:
                        rows = cur.execute("SELECT url, name, provider FROM channels WHERE name LIKE ? AND url != ? ORDER BY is_playable DESC, id ASC LIMIT 8", (f"%{clean}%", current_url)).fetchall()
                        candidates.extend(rows)
            finally:
                conn.close()
    return candidates
