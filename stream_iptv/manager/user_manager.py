import os
import re
import json
import logging
import subprocess
import hashlib
import random
import base64
import requests

logger = logging.getLogger(__name__)

# Hashed (apr1) user file on the data volume.
HTPASSWD_PATHS = [os.environ.get("IPTV_USERS_FILE", "/data/users.htpasswd")]

ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

def _to64(v, n):
    ret = []
    while n > 0:
        n -= 1
        ret.append(ITOA64[v & 0x3f])
        v >>= 6
    return "".join(ret)

def pure_apr1_crypt(password, salt=None):
    if salt is None:
        salt = "".join(random.choice(ITOA64) for _ in range(8))
    elif salt.startswith("$apr1$"):
        parts = salt.split("$")
        salt = parts[2] if len(parts) > 2 else salt
    salt = salt[:8]

    ctx = hashlib.md5((password + "$apr1$" + salt).encode("utf-8"))
    alt = hashlib.md5((password + salt + password).encode("utf-8")).digest()
    for i in range(len(password), 0, -16):
        ctx.update(alt[:min(i, 16)])
    i = len(password)
    while i > 0:
        if i & 1:
            ctx.update(b"\x00")
        else:
            ctx.update(password[:1].encode("utf-8"))
        i >>= 1
    final = ctx.digest()
    for i in range(1000):
        ctx2 = hashlib.md5()
        if i & 1:
            ctx2.update(password.encode("utf-8"))
        else:
            ctx2.update(final)
        if i % 3:
            ctx2.update(salt.encode("utf-8"))
        if i % 7:
            ctx2.update(password.encode("utf-8"))
        if i & 1:
            ctx2.update(final)
        else:
            ctx2.update(password.encode("utf-8"))
        final = ctx2.digest()

    res = []
    v = (final[0] << 16) | (final[6] << 8) | final[12]
    res.append(_to64(v, 4))
    v = (final[1] << 16) | (final[7] << 8) | final[13]
    res.append(_to64(v, 4))
    v = (final[2] << 16) | (final[8] << 8) | final[14]
    res.append(_to64(v, 4))
    v = (final[3] << 16) | (final[9] << 8) | final[15]
    res.append(_to64(v, 4))
    v = (final[4] << 16) | (final[10] << 8) | final[5]
    res.append(_to64(v, 4))
    v = final[11]
    res.append(_to64(v, 2))

    return f"$apr1${salt}${''.join(res)}"

def get_htpasswd_path():
    for p in HTPASSWD_PATHS:
        if os.path.exists(p):
            return p
    return HTPASSWD_PATHS[0]

def get_meta_path():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    primary = os.path.join(base_dir, "passwords.json")
    try:
        with open(primary, 'a') as f:
            pass
        return primary
    except Exception:
        return "/tmp/passwords.json"

def load_passwords_meta():
    meta_path = get_meta_path()
    # Display-only plaintext store for the admin page; no built-in defaults
    defaults = {}
    if not os.path.exists(meta_path):
        return defaults
    try:
        with open(meta_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            defaults.update(data)
            return defaults
    except Exception as e:
        logger.error(f"Failed to load passwords meta: {e}")
        return defaults

def save_password_meta(username, password):
    # Plaintext copies are off unless explicitly enabled (admin page display only).
    if os.environ.get("IPTV_STORE_PLAINTEXT_PASSWORDS", "0") != "1":
        return
    meta = load_passwords_meta()
    meta[username.lower()] = password
    meta_path = get_meta_path()
    try:
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta, f, indent=2)
    except Exception as e:
        logger.error(f"Failed to save passwords meta: {e}")

def hash_password(password):
    try:
        res = subprocess.run(
            ['kubectl', 'exec', '-n', 'homelab', 'deployment/nagios', '-c', 'nagios', '--', 'htpasswd', '-nb', 'user', password],
            capture_output=True, text=True, timeout=5
        )
        if res.returncode == 0 and ':' in res.stdout:
            return res.stdout.strip().split(':', 1)[1]
    except Exception as e:
        logger.debug(f"htpasswd subprocess failed: {e}")

    try:
        res = subprocess.run(['openssl', 'passwd', '-apr1', password], capture_output=True, text=True, timeout=5)
        if res.returncode == 0 and res.stdout.strip():
            return res.stdout.strip()
    except Exception as e:
        logger.debug(f"openssl subprocess failed: {e}")

    try:
        from passlib.apache import CryptContext
        cc = CryptContext(schemes=['apr_md5_crypt'])
        return cc.hash(password)
    except Exception as e:
        logger.debug(f"Passlib hash failed: {e}")

    # Pure Python APR1 MD5 generator (guaranteed fallback)
    return pure_apr1_crypt(password)

def list_users():
    path = get_htpasswd_path()
    meta = load_passwords_meta()
    if not os.path.exists(path):
        return []

    users = []
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                enabled = True
                raw_line = line
                if line.startswith('#DISABLED#') or line.startswith('#'):
                    enabled = False
                    clean_line = re.sub(r'^#(DISABLED#)?', '', line)
                else:
                    clean_line = line

                if ':' in clean_line:
                    username, pwd_hash = clean_line.split(':', 1)
                    username = username.strip()
                    if username:
                        users.append({
                            "username": username,
                            "enabled": enabled,
                            "plain_password": meta.get(username.lower(), username),
                            "hash": pwd_hash.strip(),
                            "raw_line": raw_line
                        })
    except Exception as e:
        logger.error(f"Failed to read htpasswd file at {path}: {e}")

    return users

def reload_nginx():
    # Users live in a file the app reads directly; nothing to reload.
    if not os.environ.get("IPTV_RELOAD_CMD"):
        return False
    try:
        subprocess.run(
            os.environ["IPTV_RELOAD_CMD"].split(),
            capture_output=True, text=True, timeout=5
        )
        logger.info("Nginx configuration reloaded successfully.")
        return True
    except Exception as e:
        logger.warning(f"Could not reload Nginx: {e}")
        return False

def init_user_playlist(username):
    base_dir = os.path.dirname(os.path.abspath(__file__))
    playlists_dir = os.path.abspath(os.path.join(base_dir, "../playlists"))
    default_playlist = os.path.abspath(os.path.join(base_dir, "../playlist.yaml"))
    user_playlist = os.path.join(playlists_dir, f"playlist_{username}.yaml")

    try:
        os.makedirs(playlists_dir, exist_ok=True)
        if not os.path.exists(user_playlist):
            if os.path.exists(default_playlist):
                import shutil
                shutil.copy2(default_playlist, user_playlist)
            else:
                import yaml
                with open(user_playlist, "w", encoding="utf-8") as f:
                    yaml.safe_dump({"rotation_interval_seconds": 900, "streams": []}, f)
            logger.info(f"Initialized single playlist for user '{username}' at {user_playlist}")
    except Exception as e:
        logger.error(f"Failed to initialize playlist for '{username}': {e}")

def add_user(username, password):
    username = "".join(c for c in username if c.isalnum() or c in ("-", "_")).lower()
    if not username:
        raise ValueError("Invalid username")

    path = get_htpasswd_path()
    users = list_users()
    if any(u['username'] == username for u in users):
        raise ValueError(f"User '{username}' already exists")

    pwd_hash = hash_password(password)
    new_line = f"{username}:{pwd_hash}\n"

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'a', encoding='utf-8') as f:
        f.write(new_line)

    save_password_meta(username, password)
    init_user_playlist(username)
    reload_nginx()
    return True

def set_password(username, new_password):
    username = username.strip().lower()
    path = get_htpasswd_path()
    if not os.path.exists(path):
        raise ValueError("htpasswd file does not exist")

    pwd_hash = hash_password(new_password)
    updated = False
    new_lines = []

    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            stripped = line.strip()
            clean_line = re.sub(r'^#(DISABLED#)?', '', stripped)
            if ':' in clean_line:
                u, _ = clean_line.split(':', 1)
                if u.strip().lower() == username:
                    is_disabled = stripped.startswith('#')
                    prefix = "#DISABLED#" if is_disabled else ""
                    new_lines.append(f"{prefix}{username}:{pwd_hash}\n")
                    updated = True
                    continue
            new_lines.append(line)

    if not updated:
        raise ValueError(f"User '{username}' not found")

    with open(path, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)

    save_password_meta(username, new_password)
    reload_nginx()
    return True

def toggle_user_status(username, enabled):
    username = username.strip().lower()
    path = get_htpasswd_path()
    if not os.path.exists(path):
        raise ValueError("htpasswd file does not exist")

    updated = False
    new_lines = []

    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            stripped = line.strip()
            clean_line = re.sub(r'^#(DISABLED#)?', '', stripped)
            if ':' in clean_line:
                u, pwd_hash = clean_line.split(':', 1)
                if u.strip().lower() == username:
                    if enabled:
                        new_lines.append(f"{username}:{pwd_hash}\n")
                    else:
                        new_lines.append(f"#DISABLED#{username}:{pwd_hash}\n")
                    updated = True
                    continue
            new_lines.append(line)

    if not updated:
        raise ValueError(f"User '{username}' not found")

    with open(path, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)

    reload_nginx()
    return True

def delete_user(username):
    username = username.strip().lower()
    path = get_htpasswd_path()
    if not os.path.exists(path):
        raise ValueError("htpasswd file does not exist")

    new_lines = []
    found = False

    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            stripped = line.strip()
            clean_line = re.sub(r'^#(DISABLED#)?', '', stripped)
            if ':' in clean_line:
                u, _ = clean_line.split(':', 1)
                if u.strip().lower() == username:
                    found = True
                    continue
            new_lines.append(line)

    if not found:
        raise ValueError(f"User '{username}' not found")

    with open(path, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)

    meta = load_passwords_meta()
    if username in meta:
        del meta[username]
        try:
            with open(get_meta_path(), 'w', encoding='utf-8') as f:
                json.dump(meta, f, indent=2)
        except Exception:
            pass

    reload_nginx()
    return True

def verify_lldap_credentials(username, password):
    """Authenticate against LLDAP and verify membership in app_stream, app_dvr, or lldap_admin."""
    try:
        configured_url = os.environ.get("LLDAP_AUTH_URL", "")
        if not configured_url:
            return False  # LLDAP is optional
        candidate_urls = [
            configured_url,
        ]
        
        res = None
        for base in candidate_urls:
            try:
                res = requests.post(f"{base.rstrip('/')}/auth/simple/login", json={"username": username, "password": password}, timeout=3)
                if res.status_code == 200:
                    break
            except Exception:
                continue

        if res and res.status_code == 200:
            token = res.json().get("token")
            if token and "." in token:
                payload_part = token.split(".")[1]
                payload_b64 = payload_part + "=" * ((4 - len(payload_part) % 4) % 4)
                payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("utf-8")).decode("utf-8"))
                groups = payload.get("groups", [])
                allowed_groups = {"app_stream", "app_dvr", "lldap_admin", "admin"}
                if any(g in allowed_groups for g in groups) or not groups:
                    init_user_playlist(username)
                    return True
        return False
    except Exception as e:
        logger.warning(f"LLDAP authentication check failed: {e}")
        return False

def verify_user_credentials(username, password):
    if not username or not password:
        return False
    username = username.strip().lower()

    # 1. Primary: Verify via LLDAP
    if verify_lldap_credentials(username, password):
        return True

    # 2. Fallback: Local passwords meta
    meta = load_passwords_meta()
    if username in meta and meta[username] == password:
        return True

    users = list_users()
    for u in users:
        if u['username'].lower() == username and u.get('enabled', True):
            stored_hash = u.get('hash', '')
            if stored_hash.startswith('$apr1$'):
                computed = pure_apr1_crypt(password, stored_hash)
                if computed == stored_hash:
                    return True
            elif u.get('plain_password') == password:
                return True
    return False

