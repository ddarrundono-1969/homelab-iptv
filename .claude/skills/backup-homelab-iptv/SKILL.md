---
name: backup-homelab-iptv
description: Back up or restore homelab-iptv data (playlists, users, channel database, settings). Use when the user asks to back up, restore, migrate or move homelab-iptv to another machine.
---

# Back up / restore homelab-iptv

Everything that matters is `data/` plus `.env`. Both contain secrets: keep backups private,
never commit them, and `chmod 600` the archive.

## Back up
```sh
ts=$(date +%Y%m%d-%H%M)
docker compose stop manager          # consistent SQLite copy (a few seconds of downtime)
tar czf ../homelab-iptv-backup-$ts.tgz data .env
docker compose start manager
chmod 600 ../homelab-iptv-backup-$ts.tgz
```
With Postgres also dump it: `docker compose exec db pg_dump -U iptv iptv | gzip > ../iptv-pg-$ts.sql.gz`.

## Restore (same or new machine)
1. Clone the repo, `cd` into it.
2. `tar xzf /path/to/homelab-iptv-backup-<ts>.tgz` (restores `data/` and `.env`).
3. `docker compose up -d --build`, then verify as in the install skill. Users, playlists and the
   secret key come back unchanged, so existing logins keep working.
