#!/bin/sh
# Wire the code's data paths to the /data volume, create the first admin, start.
set -e
D=/data
S=/app/stream_iptv
mkdir -p "$D/playlists"

[ -f "$D/playlist.yaml" ] || cp /app/defaults/playlist.yaml "$D/playlist.yaml"
[ -f "$D/passwords.json" ] || echo '{}' > "$D/passwords.json"

# The app keeps its data next to the code; point those names at the volume.
for n in playlist.yaml playlists channels.db provider_refresh_meta.json; do
  rm -rf "$S/$n"; ln -s "$D/$n" "$S/$n"
done
rm -f "$S/manager/passwords.json"; ln -s "$D/passwords.json" "$S/manager/passwords.json"

# First start: create the admin from IPTV_ADMIN_USER / IPTV_ADMIN_PASSWORD.
python3 - <<'PY'
import os, sys
sys.path.insert(0, "/app/stream_iptv/manager")
import user_manager
admin = os.environ.get("IPTV_ADMIN_USER", "admin").strip().lower() or "admin"
users = [u["username"] for u in user_manager.list_users()]
if admin not in users:
    pw = os.environ.get("IPTV_ADMIN_PASSWORD", "")
    if len(pw) < 10:
        sys.exit(f"First start: set IPTV_ADMIN_PASSWORD (10+ characters) in .env to create user '{admin}'.")
    user_manager.add_user(admin, pw)
    print(f"Created admin user '{admin}'. You can remove IPTV_ADMIN_PASSWORD from .env now.")
PY

exec "$@"
