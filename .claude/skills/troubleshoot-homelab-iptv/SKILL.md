---
name: troubleshoot-homelab-iptv
description: Diagnose homelab-iptv problems such as the site not loading, login failures, black or frozen kiosk, channels not playing, or slow search. Use when the user reports anything not working in homelab-iptv.
---

# Troubleshoot homelab-iptv

Gather facts before changing anything. Don't print `.env` or files in `data/`.

## 1. Is it running?
```sh
docker compose ps
docker compose logs --tail 80 manager
docker compose logs --tail 40 proxy
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:${IPTV_HTTP_PORT:-8080}/stream-iptv/api/playlist/version
```
- Manager restarting with "set IPTV_ADMIN_PASSWORD": first start without a password in `.env`.
- `Permission denied` on `/data`: `sudo chown -R $(id -u):$(id -g) data` then restart.
- 502 from the proxy: the manager is down or still starting; read its logs.

## 2. Can't log in
- Users live in `data/users.htpasswd` (hashed). Reset the admin password:
  ```sh
  docker compose exec manager python3 -c "import user_manager,getpass; user_manager.set_password('admin', getpass.getpass())"
  ```
  (replace `admin` with `IPTV_ADMIN_USER` if changed).
- If `FLASK_SECRET_KEY` changed, everyone is logged out once; that's expected.

## 3. Kiosk black screen / channel won't play
- Open the channel in the manager's player first. If it fails there too, test the relay:
  `docker compose logs --tail 50 manager | grep api/proxy` and look at the status codes.
- `503` "allows N connection(s)": the provider's connection limit is in use (`PROVIDER_LIMITS`).
- `401`/`403`/`511` from the provider: the account, IP or region is blocked by the provider.
- Kiosk stuck after an update: reload the page (F5) on the TV.

## 4. Slow search
SQLite gets slow with several hundred thousand channels. Switch to Postgres: uncomment the
Postgres lines in `.env`, `docker compose --profile postgres up -d`, then re-import providers.

## 5. Still stuck
Collect `docker compose ps`, the last 100 manager log lines (remove any URLs that contain
usernames or passwords), and the browser console errors, and share those.
