---
name: add-iptv-provider
description: Add an IPTV provider (M3U URL or Xtream Codes login) to homelab-iptv and load its channels. Use when the user wants to add, connect or import an IPTV provider, playlist URL or Xtream account.
---

# Add an IPTV provider

The user must only add sources they are entitled to use. Never paste their provider URL,
username or password into commits, docs, issues or chat summaries; refer to it as "your provider".

## Preferred: web UI
1. Open `http://<host>:8080/stream-iptv/` and log in as the admin.
2. Go to the **Providers** section → **+ Add Provider**.
3. Choose the type:
   - **M3U**: paste the playlist URL.
   - **Xtream**: server URL (e.g. `http://provider.example:8080`), username, password, format `ts`
     (or `m3u8` if the provider only serves HLS). An M3U URL containing `get.php?username=…&password=…`
     is detected as Xtream automatically.
4. Save. The first channel import runs in the background; large providers take a few minutes.

## Via the API (when the user prefers the terminal)
Log in first to get a session cookie, then post the provider. Read the password from the user
interactively; don't put it on the command line history.
```sh
B=http://localhost:8080/stream-iptv
read -rp "user: " U; read -rsp "password: " P; echo
curl -s -c /tmp/iptv.cookies -H 'Content-Type: application/json' \
  -d "{\"username\":\"$U\",\"password\":\"$P\"}" $B/api/auth/login
# Xtream example; for M3U use {"name":"...","type":"m3u","url":"..."}
curl -s -b /tmp/iptv.cookies -H 'Content-Type: application/json' \
  -d '{"name":"My Provider","type":"xtream","server":"http://provider.example:8080","username":"...","password":"...","stream_format":"ts"}' \
  $B/api/providers/add
rm -f /tmp/iptv.cookies
```

## Check
- `curl -s "$B/api/channels/search?q=news&limit=5"` returns channels from the new provider.
- If the provider allows only one connection at a time, set `PROVIDER_LIMITS="My Provider=1"` in
  `.env` and `docker compose up -d manager`.
- Channels that play in the manager but not on another network: the provider may block your IP
  or datacenter IPs; nothing in this app can fix that.
