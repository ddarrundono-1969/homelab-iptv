# homelab-iptv

A self-hosted IPTV manager for a home lab: build playlists from your own IPTV
providers, run a full-screen kiosk player on a TV, and watch on phones. The
server relays every stream, so provider logins never reach the browser and
plain-HTTP streams play on HTTPS pages.

**Bring your own sources.** No channels, playlists or provider accounts are
included. You add the providers you are entitled to use, and you are responsible
for complying with their terms and with the law where you live. This project
does not host, sell or link to any content.

## What you get

- Web manager: playlists per user, provider import (M3U / Xtream), channel search, EPG
- Kiosk player (`/stream-iptv/kiosk`) that rotates channels on a schedule
- Stream relay with provider-login masking and per-provider connection limits
- Local users (hashed), optional LLDAP login
- SQLite by default, Postgres optional

## Requirements

- Docker with the Compose plugin (`docker compose version`)
- About 300 MB RAM, 1 GB disk (more if your provider lists are huge)

## Install (5 minutes)

```sh
git clone <this repo> homelab-iptv && cd homelab-iptv
cp .env.example .env
python3 -c "import secrets; print(secrets.token_hex(32))"   # paste as FLASK_SECRET_KEY in .env
# set IPTV_ADMIN_PASSWORD (10+ characters) in .env
docker compose up -d --build
docker compose logs manager | grep -i "admin"               # "Created admin user ..."
```

Open `http://<host>:8080/stream-iptv/` and log in. Then remove
`IPTV_ADMIN_PASSWORD` from `.env`.

Kiosk on a TV: open `http://<host>:8080/stream-iptv/kiosk?interval=900` in a
full-screen browser.

## Using Claude Code (or another AI assistant)

This repo ships skills for [Claude Code](https://claude.com/claude-code) in
`.claude/skills/`. Open the repo in Claude Code and ask, for example:

- "install homelab-iptv" — checks Docker, writes `.env`, starts it, verifies
- "add an IPTV provider"
- "upgrade homelab-iptv"
- "the kiosk shows a black screen" — guided troubleshooting
- "back up homelab-iptv"

Other assistants: see `AGENTS.md`.

## Data and backups

Everything lives in `./data/` (playlists, users, channel database, secret key).
Back up that folder and `.env`. Never commit either.

## HTTPS / remote access

Set `IPTV_SITE_ADDRESS=tv.example.com` in `.env`, point the DNS name at your
public IP, forward ports 80 and 443 to this host, and change the proxy ports in
`docker-compose.yml` to `80:80` and `443:443`. Caddy gets a Let's Encrypt
certificate automatically. Or keep it LAN-only and use a VPN such as Tailscale.

## Settings

See `.env.example`. The important ones:

| Setting | Meaning |
|---|---|
| `IPTV_ADMIN_USER` | Name of the admin account (default `admin`) |
| `IPTV_ADMIN_PASSWORD` | Used once to create the admin |
| `FLASK_SECRET_KEY` | Signs logins and hides provider credentials in URLs |
| `PROVIDER_LIMITS` | Max relay connections per provider, e.g. `My Provider=1` |
| `DATABASE_URL`, `REQUIRE_POSTGRES` | Use Postgres instead of SQLite |
| `LLDAP_AUTH_URL` | Log in with LLDAP accounts |

## License

MIT, see `LICENSE`.
