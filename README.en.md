# DeviantDrop

**Language / 语言:** [中文](README.md) · English · [📖 Documentation](https://redtidev1918.github.io/deviantdrop/) · [Changelog](CHANGELOG.md)

A Telegram bot that "drops" DeviantArt works into your chat: send a work link and
DeviantDrop replies with the artwork's image, video or GIF unchanged.

[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/Docs-documentation_site-6366f1?style=flat-square)](https://redtidev1918.github.io/deviantdrop/)

> ⚠️ **Deployment constraint**: DeviantArt blocks datacenter egress (Cloudflare Workers and
> most cloud hosts are blocked). Run the bot on an **egress DeviantArt allows** (a residential
> network, or one of the VPS providers that has passed the check) — see
> [docs/VPS.md](docs/VPS.md).

## Quick deployment

```bash
cp .env.example .env    # fill in BOT_TOKEN / WEBHOOK_SECRET / official API credentials; set a proxy on mainland-China hosts
docker compose up -d --build
```

## What it handles

- Recognises work links inside messages and captions (`https` / `www` / legacy domains /
  `fav.me`), processing up to 5 at once.
- **The website `_puppy` endpoints come first** (video / GIF / new works / `additionalMedia`
  all come from the same adapter); when the network is unreachable and OAuth is configured,
  the official API is the fallback.
- Photo/video sequences are sent as `sendMediaGroup` albums (auto-batched above 10 items);
  GIF/animation always uses a standalone `sendAnimation` so captions are never split or
  duplicated; oversized images are compressed first and sent as documents if that fails; when
  Telegram cannot reach the CDN, the file is downloaded and uploaded as multipart.
- `/start` `/help` `/about` commands; per-chat rate limiting, de-duplication, and
  429/500/503 backoff retries.

### Groups and channels

- The bot has **group privacy mode on by default**, so in groups it only sees commands. To let
  it act on work links in a group: in **BotFather** use `/mybots` → pick the bot →
  **Bot Settings → Group Privacy → Turn off**, then remove and re-add the bot (or make it an
  administrator) for the change to take effect.
- In a channel, make the bot an administrator and post the link "to the channel"
  (`channel_post` is handled the same way).
- Groups and channels **hide** technical status notes by default (see "Reply layout"), which
  keeps captions cleaner.

### Sign-in and owner commands

Admin commands (`/login`, `/cookie`, `/status`) are restricted to the **bot owner**: set
`ADMIN_IDS=<your Telegram user id>` in `.env`. Without it, admin commands are always refused;
the regular user allowlist (`ALLOWED_USER_IDS`) is not an admin list.

DeviantArt has two **independent** capability layers — do not conflate them:

| Layer | Role | Covers |
| --- | --- | --- |
| **OAuth (official API)** | **Primary content-access auth** | Work metadata, **mature main image**, official download/content, unattended refresh-token renewal |
| **Web extension session** (`auth`/`auth_secure`/`userinfo`) | **Optional enhancement** | Only fills in the website's `deviation.extended.additionalMedia` (pages 2…N of multi-image works), which the official API does not provide |

Therefore: **NSFW ≠ requires cookies.**

- A single-image mature work is fully deliverable with OAuth alone — the unmasked main image
  is fetched without any web session.
- An expired web session only affects **extra pages of some multi-image works**; it never fails
  the whole mature work and never substitutes a censored image for an OAuth original already
  obtained.
- When extra pages are unavailable, the bot adds a single note ("some additional images are
  temporarily unavailable, please view them on the original site") rather than claiming the
  sign-in failed.

- **Recommended: one-click desktop login (works without a public domain).** On your computer
  (Chrome/Edge installed), inside the DeviantDrop directory run:
  ```bash
  VPS=root@<your server> npm run login
  ```
  The script opens Chrome at DeviantArt's official login page: sign in and click
  "Authorize"; it saves both the OAuth and web extension sessions and hot-applies them.
  DeviantArt's login page has an AWS WAF human check, which passes normally when you sign in
  with your real browser. Afterwards `/status` shows `OAuth API: ✅ valid` and
  `Multi-image web expansion: ✅ valid`.
- **With a public domain (`PUBLIC_BASE_URL`)**: send `/login` in a private chat; click the
  OAuth authorize button on first setup or when the refresh token expires. A public page
  cannot write DA cookies cross-origin, so the extension-session entry uses a one-shot paste
  form.
- **Phone only, no computer**: in a browser already signed in to DA, copy the whole
  `Cookie:` line and send `/cookie auth=…; auth_secure=…; userinfo=…` in a private chat. The
  bot stores it, probes immediately and reports status. Note this credential passes through
  Telegram — delete the message afterwards (the bot tries to delete it for you); if you are
  worried, use "log out of all devices" in DA settings to invalidate it.
- **`/status` (owner private chat)**: shows two independent statuses, `OAuth API:` and
  `Multi-image web expansion: missing|unknown|valid|expired` (no secrets shown). Network
  timeouts, WAF and 5xx only make the extension capability `unknown` — never a false `expired`
  — and never affect OAuth status; only a login redirect or `mature_loggedout` marks it
  `expired`.
- `DA_REFRESH_TOKEN` / `DA_COOKIES` are only a **first-migration seed**: on startup they are
  written to the OAuth and web-session files respectively; a rotated refresh token is persisted
  immediately, and cookies hot-update without falling back to the old `.env` value.
- When the OAuth session or the web extension session expires, the bot owner is notified
  separately, each message stating its own scope of impact (6-hour cooldown, plus a recovery
  notification when it comes back).

### Reply layout

- Consistent layout: `🎨 title / 👤 author / 🖼 N media`, plus exactly one reliable source entry.
- The source entry is **singular and never duplicated**: for single images/videos it is the
  "🔗 Open on DeviantArt" inline button below the image (reliable across direct URL pass-through,
  `file_id` replay, and multipart upload); for albums (`sendMediaGroup` silently drops buttons)
  a clickable "🔗 Open on DeviantArt" text line is **sent as a follow-up** with link preview
  disabled.
- Technical status notes (`⚠️ compressed / original temporarily unavailable / sent as a file`,
  etc.) are shown only in **private chats** by default, for operations troubleshooting; groups
  and channels hide them automatically (noise for viewers, who can just tap the source entry).
  Force with `CAPTION_NOTES=auto` (default: private shows / group hides), `always`, `never`.

### TelePress (optional)

For oversized galleries (>10 images) or Telegram send failures, a
[TelePress](https://github.com/redtidev1918/telepress) Telegraph page can be generated. It is
disabled when no URL is configured; once configured it defaults to failure fallback only
(`TELEPRESS_MODE=fallback`), while large galleries require `large-gallery`. A failure never
affects native Telegram sending. For same-host deployments prefer
`TELEPRESS_URL=http://127.0.0.1:<port>` with the same `TELEPRESS_API_KEY` on both sides.

The full parsing mechanics, dual-channel details, rate limiting, deployment and
troubleshooting live on the **documentation site**:

👉 https://redtidev1918.github.io/deviantdrop/

### Public preview page

With an HTTPS `PUBLIC_BASE_URL`, the bot serves `/d/:id` for Telegram/Discord to read OG
metadata. It only publishes the public thumbnail from the anonymous oEmbed payload and never
exposes signed-in media.

Full operation, data migration and limits: [authentication and preview guide](docs/AUTH_AND_PREVIEW.md);
release orchestration (ReleaseGraph integration status and next-protocol switchover checklist):
[release orchestration](docs/RELEASEGRAPH.md); deployment and egress-check conclusions:
[VPS deployment guide](docs/VPS.md).
