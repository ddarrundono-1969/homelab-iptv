---
name: upgrade-homelab-iptv
description: Upgrade homelab-iptv to the latest version from git with a backup first and a rollback path. Use when the user asks to update, upgrade or pull the latest homelab-iptv.
---

# Upgrade homelab-iptv

1. Back up first: run the `backup-homelab-iptv` skill (or at least copy `data/` and `.env`).
2. Note the current version for rollback: `git rev-parse --short HEAD`.
3. `git pull --ff-only`. If it refuses because of local edits, show `git status` and ask the user
   before stashing or discarding anything.
4. Compare settings: `diff <(grep -oE '^#? ?[A-Z_]+=' .env.example | tr -d '# ' | sort -u) <(grep -oE '^[A-Z_]+=' .env | sort -u)`
   and tell the user about new settings in `.env.example`.
5. Rebuild and restart: `docker compose up -d --build`.
6. Verify like the install skill: containers healthy, `/stream-iptv/api/playlist/version` returns JSON,
   kiosk returns 200, the user can log in and their playlists are still there.
7. Rollback if broken: `git checkout <old-commit>` then `docker compose up -d --build`; restore `data/`
   from the backup only if data was damaged.
