# homelab-iptv — notes for AI assistants

Self-hosted IPTV manager (Flask + gunicorn) behind a Caddy proxy, run with Docker Compose.

## Layout
- `stream_iptv/manager/` — app (`app.py`), DB layer (`db.py`), users (`user_manager.py`), templates, static JS/CSS
- `stream_iptv/iptv_cli.py` — provider import / channel DB refresh (called by the app)
- `docker/entrypoint.sh` — links the app's data paths to `/data`, creates the first admin
- `docker/Caddyfile` — strips the `/stream-iptv/` prefix; the app's links assume that prefix
- `data/` (runtime, gitignored) — `playlist.yaml`, `playlists/`, `channels.db`, `users.htpasswd`, secret key, credential map

## Rules
- Never commit or print `.env` or anything in `data/` (passwords, provider logins, secret key).
- Never put provider URLs with credentials in examples, docs, issues or commits.
- The app must be reached under `/stream-iptv/`; don't remove the proxy prefix handling.
- Settings come from `.env` (see `.env.example`). Don't hardcode hosts, users or paths.
- After code changes: `docker compose up -d --build manager`, then check
  `curl -s localhost:${IPTV_HTTP_PORT:-8080}/stream-iptv/api/playlist/version`.

## Skills
`.claude/skills/`: install, upgrade, add provider, troubleshoot, backup. Use them for those tasks.
