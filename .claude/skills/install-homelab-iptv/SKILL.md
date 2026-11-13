---
name: install-homelab-iptv
description: Install and start homelab-iptv on this machine with Docker Compose, create the admin account, and verify the manager and kiosk work. Use when the user asks to install, set up, deploy or run homelab-iptv for the first time.
---

# Install homelab-iptv

Work from the repo root. Never print the contents of `.env` or `data/` back to the user.

1. **Check prerequisites.**
   - `docker --version` and `docker compose version` must both work. If Compose is missing on
     Debian/Ubuntu: `sudo apt-get install -y docker-compose-v2` (or the Docker docs for other OSes).
   - `docker ps` must work without errors. If it needs sudo, either use `sudo docker ...` throughout
     or add the user to the `docker` group (`sudo usermod -aG docker $USER`, then log out and in).
   - Ports: `IPTV_HTTP_PORT` (default 8080) must be free: `ss -ltn | grep ':8080 '` returns nothing.

2. **Create `.env`** if it doesn't exist: `cp .env.example .env`. Then set:
   - `FLASK_SECRET_KEY` to the output of `python3 -c "import secrets; print(secrets.token_hex(32))"`.
   - `IPTV_ADMIN_USER` (default `admin`) and `IPTV_ADMIN_PASSWORD`: ask the user for a password of
     10+ characters, or generate one with `python3 -c "import secrets; print(secrets.token_urlsafe(16))"`
     and tell the user to store it. Write it with an editor or `sed`, not by echoing it in a log.
   - `TZ` to the user's timezone.
   - `chmod 600 .env`.

3. **Start:** `docker compose up -d --build`. First build takes 1–3 minutes.

4. **Verify:**
   - `docker compose ps` shows `iptv-manager` healthy and `iptv-proxy` up (health can take ~30 s).
   - `docker compose logs manager | grep -i "admin user"` shows the admin was created. If it says
     "set IPTV_ADMIN_PASSWORD", fix `.env` and `docker compose up -d manager`.
   - `curl -s http://localhost:8080/stream-iptv/api/playlist/version` returns JSON with `"version"`.
   - `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/stream-iptv/kiosk` returns `200`.

5. **Finish:**
   - Remove the `IPTV_ADMIN_PASSWORD=` value from `.env` (the account already exists).
   - Tell the user the URLs: manager `http://<host-ip>:8080/stream-iptv/`, kiosk
     `http://<host-ip>:8080/stream-iptv/kiosk?interval=900`. Find the host IP with `hostname -I`.
   - Next step: the `add-iptv-provider` skill.

## If something fails
Use the `troubleshoot-homelab-iptv` skill. Common first-run issues: port already in use (change
`IPTV_HTTP_PORT`), `data/` not writable (`sudo chown -R $USER data`), Docker not running.
