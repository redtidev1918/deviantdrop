# Authentication, preview and optional Telegraph publishing

**Language / 语言:** [中文](/AUTH_AND_PREVIEW.md) · English

## First-time setup and sign-in

### With a public domain (recommended; enables the in-Telegram `/login` and the preview page)

1. Point the domain at the VPS and configure an HTTPS reverse proxy to `127.0.0.1:8080`. The app
   listens only on localhost by default; there is no need to expose the raw HTTP port.
2. Set `PUBLIC_BASE_URL=https://bot.example.com`, `CLIENT_ID`, `CLIENT_SECRET` and `ADMIN_IDS`
   (Telegram user IDs). With no administrator specified and an empty user allowlist, all admin
   commands are refused; do not treat ordinary users as administrators.
3. Add the full `https://bot.example.com/auth/deviantart/callback` to the DeviantArt
   application's redirect whitelist.
4. The initial environment change requires rebuilding the container; afterwards an administrator
   sends `/login` in a **private chat with the bot**, opens the 5-minute one-shot link and
   authorises on DeviantArt's official site.
5. The callback validates state, the browser session and PKCE; on success it takes effect
   immediately and sends one recovery notification. A failed write to disk never reports success.
   The OAuth protocol is documented in the
   [official authentication docs](https://deviantart.readme.io/docs/authentication).

### Public IP but no domain (one-click desktop login, recommended)

No public port, no domain, no manual cookie copying, no restart. The DA application's redirect
whitelist already includes `http://127.0.0.1:8787/callback`. On **your own computer**
(Chrome/Edge installed, able to reach deviantart.com), in the DeviantDrop directory:

```bash
VPS=root@<VPS-IP> npm run login        # equivalent to node scripts/dd-login.mjs
```

The script drives local Chrome through the Chrome DevTools Protocol: it opens DeviantArt's
official login page, and once you sign in and click "Authorize" it captures, at the network
layer, both ① the OAuth callback `code` and ② the web login cookies
(`auth/auth_secure/userinfo`). It pushes them over ssh to the server, where
`scripts/dd-exchange.mjs` exchanges the code for a refresh token using `CLIENT_SECRET` and
atomically writes OAuth plus cookies to disk — **effective immediately, hot**.

Why the browser runs on your computer rather than the server: DA's login page has an AWS WAF
human check (`detectIp`/`validateHostname`) whose token is bound to the browser's own
environment; a real browser signing in on the **real DA domain** passes naturally, whereas a
server-side reverse proxy of the login page or a server-side headless browser is blocked by the
WAF — and a low-memory VPS is a poor host for Chromium anyway. The script adds zero dependencies
(Node ≥22 ships WebSocket/fetch), and the browser profile persists in
`~/.config/deviantdrop/chrome-login-profile`, so a machine that has signed in to DA before may
not need to sign in again.

- Chain: `dd-login.mjs` (local) → ssh → `scripts/dd-receive.sh` (VPS host) → `docker cp` +
  `dd-exchange.mjs` (inside the container, writing `/data/auth` as the `node` user).
- Failures never pollute credentials: if the exchange fails (an expired code, for example) the
  script exits with an error and does not overwrite the existing token/cookies.

With a public domain, `/login` offers separate OAuth and "update multi-image extension" entries:
if OAuth is still valid there is no need to re-authorise, and the extension session is only
needed for complete multi-image extra pages. A browser cannot write cookies cross-origin to
deviantart.com, so the public entry uses a one-shot paste form; if you would rather not copy
manually, the one-click desktop login establishes both. The two are written separately to
`/data/auth/deviantart.json` and `deviantart-cookies.json`, and rotation/expiry notifications are
handled separately too.

The app cannot sign in or grant consent on your behalf — the browser always completes sign-in on
the real DA site, and the script only reads the result.

Without a public domain and without a computer, you can send `/cookie <whole cookie line>` in a
private chat: the bot hot-updates through `CookieStore.set()`, then forces one probe and reports
`valid`/`unknown`, and makes a best effort to delete the credential-bearing message. The
trade-off is that the session credential travels through Telegram; if needed, use DA's "log out
of all devices" to invalidate it. What it restores is **multi-image extension capability**, not
"mature content permission".

The reverse proxy should disable query-bearing access logs for `/auth/` so one-shot tokens/codes
are not recorded; `access_log off` on that path works. This site's auth responses are `no-store`,
`no-referrer` and forbid iframes.

## Authentication model: OAuth as primary, optional web extension

The two capability layers are independent, and the code implements that boundary (the single
decision point is `src/deviantart/adapter.js`):

| Layer | Responsibility |
| --- | --- |
| **OAuth (official API)** | Primary content-access auth: metadata, the **mature main image**, official download/content, refresh-token renewal |
| **Web extension session** | Optional enhancement: `deviation.extended.additionalMedia` (pages 2…N of multi-image works), which the official API does not provide |

Requirement: **an expired cookie must never fail a mature work as a whole.** Availability of the
mature main image is therefore decided by OAuth, and web-extension failures are localised to the
extra pages.

- Resolution flow: the website's `_puppy/dadeviation/init` provides the work structure (direct
  numeric ID, no UUID mapping needed) and `extended.deviationUuid`; the **main image** of a mature
  work is always preferentially overridden with the official API's `content`/`download`, so the
  absence of censoring is independent of cookies.
- When the web DTO lacks a uuid (common in blocked responses), a second uuid resolution runs, so
  "OAuth only, no cookies" still retrieves the unmasked main image.
- An official API failure (network/quota/credentials) does not interrupt sending: the web result
  is kept and sending continues, with a structured log line `[da] OAuth main-image replacement
  failed`.
- Extension capability is **decided by the current response only**, never by cached state: a
  usable cookie with unknown status does not lose pages, and an old cookie recorded as valid does
  not pretend it can fetch. Censored URLs (`blur_`) are checked per entry in the response and only
  that page is skipped.
- `mature_loggedout` (`isMature=true` + `isBlocked=true` + `blockReasons` containing it) is used
  only for **session accounting**: mark `expired`, clear the cache, notify once, retry
  anonymously. It is never used to reject a work. Timeouts, WAF and 5xx keep the status
  `unknown`.
- Exactly one path produces the "censored preview" notice: when there is no OAuth and the web
  response is also unauthorised. The main image is then marked unavailable with the explicit note
  that only a censored preview is available — never dressed up as a complete result.

## Persistence and migration

| Path | Contents |
| --- | --- |
| `/data/auth/deviantart.json` | Current refresh token, status and update time; written atomically, 0600 |
| `/data/auth/deviantart-cookies.json` | Current cookies; written atomically, 0600 |
| `/data/cache.json` | file_id, rate limits, notification cooldowns, preview metadata, Telegraph URLs |

Reuse the existing Docker `cache:/data` volume; no new volume is needed. Never delete the volume
to upgrade. Back up the whole volume before upgrading.

The access token and the website `_puppy` session (CSRF + cookie reuse) live in memory only; any
token/session in the old generic cache is cleared at startup. Refresh-token renewal is
serialised, avoiding two simultaneous exchanges of the same rotating credential. First
migration prefers the old `/data/refresh_token` (compatible with `REFRESH_TOKEN_FILE`), then
`DA_REFRESH_TOKEN`; once a store exists it never falls back to env. A corrupt file counts as
invalid and forces a new sign-in; an explicit `invalid_grant` clears the token. A failed disk
write reports an error rather than claiming success.

`DA_COOKIES` and `DA_REFRESH_TOKEN` are kept as first-time seeds only; use the admin entry points
for later updates. `npm run login` is a local-development aid: it writes to the local
CredentialStore, never prints tokens, and never uploads to a VPS automatically.

`/status` shows two independent statuses, `OAuth API:` and
`Multi-image web expansion: missing|unknown|valid|expired`; the former looks only at OAuth
credentials and only the latter probes the web session. Cookies merely existing in a file means
"an extension session pending verification" rather than valid; a network failure neither clears
cookies nor demands a new sign-in and never affects OAuth status.

## Preview Fixer

`/d/:id` provides the title, author, canonical original-site link and OG metadata; a normal bot
resolution incidentally remembers the work ID and source. On a crawler's first visit one
anonymous [oEmbed](https://deviantart.readme.io/docs/oembed) call fills in the metadata, cached
for an hour. Unknown IDs get a limited canonical resolution against the original site. Failures
are cached briefly so repeated crawls do not hammer DA.

`/d/:id/image` proxies only the public thumbnail corresponding to that metadata; it accepts no
arbitrary upstream URL and requires no cookies or Referer. The CDN allows only HTTPS
DeviantArt/Wix domains, validated before every redirect, which blocks redirect SSRF. Page titles
and authors are HTML-escaped.

When there is no public thumbnail, only text and the original-site entry are provided — never an
original image visible only to signed-in accounts. If DA refuses anonymous oEmbed, this site
cannot guarantee a rich preview; the main Telegram media send is unaffected. This page is not a
work mirror site.

## Telegram layout and TelePress

A single pure planner decides the send units: consecutive photos/videos enter `sendMediaGroup` in
groups of 2–10; GIF/animation can never enter a Telegram media group and always uses a standalone
`sendAnimation`. The caption, status and source attach only to the first send unit, and later
media carry no duplicate caption. Direct URL sending, multipart upload and file_id replay share
the same planner, so the three paths never diverge. The source is **one reliable, non-duplicated
clickable entry**: inline button for a single media, and a follow-up `text_link` source message
after an album.

With `TELEPRESS_URL` unset there is no extra dependency. Once set, `TELEPRESS_MODE=fallback` is
the default; `large-gallery` generates an optional gallery for image-only sets above 10,
`always` is used only when explicitly chosen, and `off` disables it entirely. Videos and GIFs are
never converted to Telegraph. The URL for the same work is cached for 90 days and reused rather
than recreating pages. Only an extra Telegraph entry sends a button message; when a public
preview domain is configured, that message's `link_preview_options` points at this site.

A failed TelePress attempt does not affect a successful native Telegram result; when Telegram
fails but TelePress succeeds, a gallery entry is provided. The optional publish is currently
limited to 50 images / 50 MiB total; beyond that the optional publish is skipped and the original
path continues. The optional publish downloads the images again; it has not yet been converted to
a cross-service streaming relay.

The TelePress endpoint is `POST /publish/gallery` — repeated `files` multipart plus title/link —
returning a URL. Configure the same `TELEPRESS_API_KEY` (Bearer) on both sides. The service binds
only to loopback/internal networks; never expose a key-less publish endpoint to the public
internet. Without a service URL, image-host configuration and valid Telegraph credentials, no
online gallery is created.

## Configuration changes and modules

Added/refined: `PUBLIC_BASE_URL`, `HTTP_HOST`, `ADMIN_IDS`, `AUTH_DIR`, `TELEPRESS_URL`,
`TELEPRESS_API_KEY`, `TELEPRESS_MODE`. Kept: `MODE=poll|webhook`, proxy, cookie/OAuth seeds and
the existing cache-directory settings. `SERVER` must be set explicitly; the repository no longer
ships a real deployment address as a default.

```text
src/
  main.js                  # lifecycle and dependency assembly
  index.js                 # the original bot / DA flow, retained incrementally rather than rewritten
  http-server.js           # streaming HTTP and request-body limits
  network.js               # native fetch, proxy and connection-failure fallback
  auth/
    atomic-json.js
    credential-store.js
    cookie-store.js
    token.js               # in-memory access token / serialised refresh
    oauth-login.js
    http-auth.js
    auth-notifier.js
    errors.js
  preview/server.js        # OG, anonymous metadata and the secure media proxy
  publishing/
    telepress.js
    gallery.js             # optional policy and send-flow wiring
  rendering/caption.js
  storage/cache.js         # persistent cache, excluding credentials
```

The original problems behind this refactor and their conclusions are folded into this document
and the [CHANGELOG](https://github.com/redtidev1918/deviantdrop/blob/main/CHANGELOG.md).
Validation runs `npm run check`; the tests cover real HTTP multipart, poll + HTTP, credential
rotation/corruption/hot-update, OAuth state/expiry/failure, caption/album, preview/SSRF,
TelePress policy and failure isolation. A successful deployment does not mean the user's OAuth
authorisation is complete; the two are accepted separately.
