# VPS / server deployment handbook

**Language / 语言:** [中文](/VPS.md) · English

DeviantArt blocks Cloudflare Workers egress entirely, so the bot runs on an ordinary server.
This handbook targets a **mainland-China server** (Alibaba Cloud cannot reach deviantart.com
directly, as measured); the main points are: egress must go through a proxy (clash/mihomo), and
the proxy's egress must be one DeviantArt allows.

> Measured in 2026-09: Alibaba Cloud times out reaching DA directly (blocked); through an
> airport (HK) egress both the official DA API data plane and the website return 200. Cloudflare
> Workers / Fly egress is blocked by DA on datacenter IPs.

## 0. Check your egress in 30 seconds

```bash
cd deviantart-telegram-worker && npm install --omit=dev
node scripts/detect-da.mjs <client_id> <client_secret>
```

If a direct connection fails (blocked in mainland China), test through a proxy first; on an
airport egress the official API data plane normally returns 200.

## 1. Mainland networking (clash/mihomo)

Day-to-day operations when the server already runs a system-level clash
(`/usr/local/bin/clash -d /etc/mihomo`, managed by systemd, `mixed-port 7890` bound to
`127.0.0.1`):

- **Hot subscription refresh** (no restart, no dropped connections):

  ```bash
  SUB_URL="https://your-airport/subscription" ./scripts/refresh-clash.sh
  ```

  If the airport endpoint cannot be fetched from that server (403 / backend timeout), fetch it
  on a machine that can and copy it over:
  `scp sub.yaml root@server:/tmp/`, then over ssh `cp` it onto `/etc/mihomo/config.yaml` and
  `systemctl restart clash`.
- **WebUI (open in your local browser, no public port)**: tunnel 9090 over SSH to your machine:

  ```bash
  ssh -L 9090:127.0.0.1:9090 root@server
  # open http://127.0.0.1:9090/ui (mihomo needs external-ui configured, see scripts/setup-clash-webui.sh)
  ```

  Without the WebUI you can still inspect and switch nodes:
  `curl http://127.0.0.1:9090/proxies`, and
  `curl -X PUT "http://127.0.0.1:9090/proxies/%F0%9F%8E%AF%20%E8%8A%82%E7%82%B9%E9%80%89%E6%8B%A9/delay?timeout=4000&url=http://www.gstatic.com/generate_204"`.

## 2. Deploy (docker compose recommended)

```bash
cp .env.example .env        # fill in BOT_TOKEN / WEBHOOK_SECRET / CLIENT_ID / CLIENT_SECRET
# mainland egress must route the bot through a proxy:
#   HTTP_PROXY=http://127.0.0.1:7890  HTTPS_PROXY=http://127.0.0.1:7890  (compose uses network_mode: host)
docker compose up -d --build
docker compose logs -f deviantdrop
```

Without Docker, run it directly:

```bash
export BOT_TOKEN=... WEBHOOK_SECRET=... CLIENT_ID=... CLIENT_SECRET=...
export MODE=poll HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890
node src/main.js            # MODE=poll is the default: getUpdates long polling, no public ingress needed
```

## 3. Ingress: polling or webhook

- **`MODE=poll` (default, recommended for mainland servers)**: polls Telegram for messages; no
  public HTTPS, domain or certificate required, and no inbound port on the host. Media is handed
  to Telegram as a token-bearing CDN URL for Telegram to download.
- **`MODE=webhook`**: the bot starts an HTTP service, so you need a public HTTPS reverse proxy
  (Caddy/Nginx/Cloudflare Tunnel) pointing at `127.0.0.1:8080`, and must register the webhook:

  ```bash
  curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
    --data-urlencode "url=https://bot.example.com/webhook" \
    --data-urlencode "secret_token=${WEBHOOK_SECRET}" \
    --data-urlencode 'allowed_updates=["message"]'
  ```

> Pick one, never both. Before switching between polling and webhook, run `deleteWebhook` or stop
> the polling process.

## 4. Command menu (one-off)

```bash
curl -fsS "https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands" \
  -H 'Content-Type: application/json' \
  -d '[{"command":"start","description":"开始使用"},{"command":"help","description":"查看用法"},{"command":"about","description":"项目介绍与源码仓库"}]'
```

## 4.5 One-click login (OAuth + web extension session)

One sign-in gives the bot both DeviantArt official API authorisation (OAuth, the primary
content-access layer) and a web extension session (cookies, used only for the multi-image extra
pages the official API does not provide). A mature work's main image is delivered unmasked with
OAuth alone; an expired web extension session only affects the extra pages of some multi-image
works and never fails the mature work as a whole. Both take effect immediately on the server —
no manual cookie copying, no restart.

On **your own computer** (Chrome/Edge installed, able to reach deviantart.com), inside the
DeviantDrop directory:

```bash
VPS=root@<your server> npm run login     # equivalent to node scripts/dd-login.mjs
```

The script opens Chrome at DeviantArt's official login page → you sign in and click
"Authorize" → the page shows success. Through the Chrome DevTools Protocol it captures both the
OAuth authorisation code and the web login cookies, pushes them over ssh to the server, exchanges
them inside the container and hot-writes `/data/auth/`. Afterwards a Telegram private chat with
`/status` should show `OAuth API: ✅ valid` and `Multi-image web expansion: ✅ valid`.

> Why the browser runs on your computer rather than the server: the AWS WAF human check on DA's
> login page binds its token to the browser's own environment (`detectIp`/`validateHostname`), so
> a real browser signing in on the real DA domain passes naturally, while a server-side reverse
> proxy of the login page or a server-side headless browser is blocked — and a low-memory VPS is
> a poor host for Chromium anyway. The script adds **zero** npm dependencies (Node ≥22 ships
> WebSocket/fetch). The chain: local `dd-login.mjs` → ssh → VPS host `scripts/dd-receive.sh` →
> container `dd-exchange.mjs` (writing `/data/auth` as the `node` user).

## 4.6 Sign in to DeviantArt (Telegram button, when you have a public domain)

Configure `PUBLIC_BASE_URL` (an HTTPS domain reverse-proxied to `127.0.0.1:8080`), add
`<domain>/auth/deviantart/callback` to the DA application whitelist, then send `/login` in a
private chat with the bot and tap the button — effective within seconds, no restart.

Note: the in-Telegram button performs pure OAuth and **only establishes account authorisation,
without web cookies** — to get unmasked extra pages on mature works, use the one-click desktop
login in 4.5 (it signs in to the website as well). Details:
[docs/AUTH_AND_PREVIEW.md](/AUTH_AND_PREVIEW.md)（中文）.

### `.env` seed for a first deployment (one-off)

Before either flow above has run, you can put an existing refresh token into `.env` as
`DA_REFRESH_TOKEN` as the first-migration source; the container writes it to
`/data/auth/deviantart.json` on first start and never reads it back from `.env` afterwards.

> Original downloads are still limited by the DeviantArt free account's daily quota; signing in
> solves the "signed-in / censored" question, not the quota.

## 4.7 Deploy on push (optional)

In the GitHub repository, under Settings → Secrets and variables → Actions, add three secrets:

- `VPS_HOST` = `your-server.example`
- `VPS_USER` = `root`
- `VPS_SSH_KEY` = the deployment private key contents (generate a dedicated one)

Generate a dedicated deployment key (on a machine that can reach the VPS):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/deviantdrop_deploy -N ""
ssh-copy-id -i ~/.ssh/deviantdrop_deploy.pub root@your-server.example
cat ~/.ssh/deviantdrop_deploy        # paste the contents into VPS_SSH_KEY
```

After that, any change on `main` to `src/`, `scripts/`, `package*.json`, `Dockerfile` or
`docker-compose.yml` makes GitHub Actions run `git pull + docker compose up -d --build`
automatically — no manual deployment.

## 5. Verification and troubleshooting

```bash
docker compose logs -f deviantdrop     # polling mode keeps calling getUpdates
# send a DA work page link to @DeviantDropBot to test end to end
```

Common problems:

- `getUpdates failed: 401` → the `BOT_TOKEN` is invalid.
- "connection failed or timed out" → the proxy is not in effect, or all airport nodes are down.
  Verify with
  `curl -x http://127.0.0.1:7890 https://www.gstatic.com/generate_204`.
- DA returns 403/500-class errors → that egress (or that airport node) is blocked by DA; switch
  node/egress and retry.
- Wrong official credentials → "invalid credentials"; the anonymous website path only works when
  the egress is not blocked by DA.

### Upload and group-chat diagnostics

- Node's native `fetch` and native `FormData` must be used together; the proxy is specified via
  `dispatcher`. Mixing in a standalone `undici.fetch` can send the literal text
  `[object FormData]`, making Telegram report a missing photo/media.
- Albums must use `sendMediaGroup`; adding `media_group_id` to several `sendPhoto` calls does not
  merge them into an album.
- Group topic replies preserve `message_thread_id`, and a channel's `channel_post` is handled the
  same way. With `ALLOWED_USER_IDS` set, authorisation is still by sender user ID; anonymous
  admin/channel identities cannot impersonate an allowed user.
- **Ordinary links are not received in a group**: first confirm the bot's group privacy mode is
  off in BotFather (`/mybots` → Bot Settings → Group Privacy → Turn off), then remove the bot from
  the group and re-add it, or make it an administrator. With privacy mode on, Telegram does not
  deliver non-command group messages to the bot and `getMe`'s
  `can_read_all_group_messages` reads `false`.
- Groups and channels hide the technical ⚠️ status notes by default (`CAPTION_NOTES=auto`); set
  `CAPTION_NOTES=always` to show them everywhere, or `never` to hide them entirely.
- If the log has no matching `[upd]`, check Telegram delivery and whether another polling instance
  is running; if `[upd]` is present, check send permissions and the error log. Reaching `/about`
  alone does not prove ordinary links are delivered.
- `npm test` includes local tests for real HTTP multipart serialisation and polling albums; it
  never sends messages to a real Telegram chat.

Docker Compose keeps the file_id cache in a dedicated `cache` volume, so updating the container
does not clear it. Older deployments with `/tmp/deviantdrop-cache.json` should back it up and
migrate it to `/data/cache.json` in the volume before upgrading; never run
`docker compose down -v`, which deletes the cache volume.
