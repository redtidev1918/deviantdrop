// Node 版入口：让同一套 bot 逻辑跑在普通服务器（VPS/家用机）。
//
// 用法（先跑 scripts/detect-da.mjs 确认这台机器的出口，再决定配不配官方凭据）：
//   BOT_TOKEN=... WEBHOOK_SECRET=... \
//   CLIENT_ID=... CLIENT_SECRET=... PUBLIC_BASE_URL=https://your-host \
//   MODE=poll|webhook \
//   HTTP_PROXY=http://127.0.0.1:7890   # 国内服务器经 clash 等代理访问 Telegram/DA 时填
//   node src/main.js
//
// MODE:
//   - poll    （默认）getUpdates 长轮询；同时启动 HTTP server 提供 /health 与 Web OAuth 登录；
//   - webhook  仅启动 HTTP server（/webhook + /health + /auth/*），需公网 HTTPS 反代。
// 两种模式都会起 HTTP server：OAuth 回调 /auth/deviantart/callback 在 poll 模式下也可用。
import { createHttpServer } from "./http-server.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, ProxyAgent } from "undici";
import { createProxyFetch } from "./network.js";
import worker, { handleUpdate, sendTelegram, clearOAuthAccessToken } from "./index.js";
import { CredentialStore } from "./auth/credential-store.js";
import { CookieStore } from "./auth/cookie-store.js";
import { AuthNotifier, resolveAdminIds } from "./auth/auth-notifier.js";
import { OAuthLoginFlow } from "./auth/oauth-login.js";
import { createAuthRequestHandler } from "./auth/http-auth.js";
import { createDiskCache } from "./storage/cache.js";
import { PreviewService } from "./preview/server.js";
import { TelePress } from "./publishing/telepress.js";
import { registerCommands } from "./telegram/api.js";
import { event, setComponent, bump } from "./runtime/status.js";

// 版本号只用于启动日志与 /health，不参与任何决策；读不到就留空。
let VERSION = null;
try {
  VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
} catch {
  VERSION = null;
}

// —— 代理：国内服务器经 clash 等出口访问被墙的 Telegram/DeviantArt ——
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const directAgent = new Agent();
if (proxyUrl) {
  // 媒体 CDN（wixmp/deviantart.net）国内可直连且更稳，网络层双通道兜底见 network.js。
  const proxyAgent = new ProxyAgent(proxyUrl);
  globalThis.fetch = createProxyFetch(proxyAgent, directAgent);
  console.log(`outbound proxy: ${proxyUrl} (媒体直连，连接失败自动切换)`);
}

// Durable metadata/file IDs; credentials never enter the general cache file.
if (!globalThis.caches) {
  const cache = createDiskCache(process.env.CACHE_FILE || join(tmpdir(), "deviantdrop-cache.json"));
  cache.flush(); // Strip legacy token/session entries from the general cache file.
  globalThis.caches = { default: cache };
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { cache.flush(); process.exit(0); });
}

// —— 认证存储：CredentialStore（refresh token 单一事实来源）+ CookieStore（热更新）——
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";
// 旧版 refresh token 文件（/data/refresh_token）作为首次迁移来源之一（已部署的 token 不用重新登录）。
const legacyTokenFile = process.env.REFRESH_TOKEN_FILE || "/data/refresh_token";
function migrationSeedToken() {
  try {
    const v = readFileSync(legacyTokenFile, "utf8").trim();
    return v || process.env.DA_REFRESH_TOKEN || null;
  } catch { return process.env.DA_REFRESH_TOKEN || null; }
}
// cacheGet/cacheSet 复用 index.js 的缓存语义（AuthNotifier 冷却、TelePress URL 缓存共用）。
const cacheGet = async (ns, k) => {
  const store = globalThis.caches?.default;
  if (!store) return null;
  const hit = await store.match(`https://deviantdrop.cache.internal/${ns}/${encodeURIComponent(k)}`);
  return hit ? hit.json().catch(() => null) : null;
};
const cacheSet = async (ns, k, value, ttl) => {
  const store = globalThis.caches?.default;
  if (!store) return;
  await store.put(
    `https://deviantdrop.cache.internal/${ns}/${encodeURIComponent(k)}`,
    new Response(JSON.stringify(value), { headers: { "Cache-Control": `public, max-age=${ttl}` } }),
  );
};

const credentialStore = new CredentialStore({
  path: join(AUTH_DIR, "deviantart.json"),
  seedEnvToken: migrationSeedToken(),
});
const cookieStore = new CookieStore({
  path: join(AUTH_DIR, "deviantart-cookies.json"),
  seedEnvCookie: process.env.DA_COOKIES || null,
});

credentialStore.load();
cookieStore.getCookies();

// —— TelePress（可选）：仅 large-gallery/fallback，默认 off；失败不影响 Telegram 主链路 ——
const telepress = new TelePress({
  url: process.env.TELEPRESS_URL || "",
  apiKey: process.env.TELEPRESS_API_KEY || "",
  mode: process.env.TELEPRESS_MODE || "fallback",
  cacheGet, cacheSet,
});

// —— Web OAuth 登录流程 + 认证通知 ——
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
if (publicBaseUrl) {
  const u = new URL(publicBaseUrl);
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.pathname !== "/") throw new Error("PUBLIC_BASE_URL must be an HTTPS origin");
}
const redirectUri = publicBaseUrl ? `${publicBaseUrl}/auth/deviantart/callback` : "";
const adminIds = resolveAdminIds({ ADMIN_IDS: process.env.ADMIN_IDS });

const loginStartBase = publicBaseUrl ? `${publicBaseUrl}/auth/deviantart/start` : null;
let authNotifier; // 先声明：flow 回调在运行时才用到，此时已完成赋值

const authFlow = new OAuthLoginFlow({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  redirectUri,
  credentialStore,
  onTokenSaved: async () => {
    clearOAuthAccessToken(env);      // 清短期 access token，下次用新 refresh token 签发
    await authNotifier?.notifyRecovered("oauth", true);
  },
});

authNotifier = new AuthNotifier({
  cacheGet, cacheSet,
  sendTelegram: (method, body) => sendTelegram(env, method, body),
  adminIds,
  // 失效通知按钮：签发一次性 login token 拼成 /auth/deviantart/start?t=...（5 分钟有效）。
  loginUrlBuilder: (kind) => {
    if (!loginStartBase || !authFlow.configured()) return null;
    return kind === "cookie"
      ? `${publicBaseUrl}/auth/deviantart/cookies?t=${authFlow.issueLoginToken("cookies")}`
      : `${loginStartBase}?t=${authFlow.issueLoginToken()}`;
  },
});

const env = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  ALLOWED_USER_IDS: process.env.ALLOWED_USER_IDS,
  ADMIN_IDS: process.env.ADMIN_IDS,
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  DA_COOKIES: process.env.DA_COOKIES,           // 仅首次迁移；运行时以 CookieStore 为准
  DA_REFRESH_TOKEN: process.env.DA_REFRESH_TOKEN, // 仅首次迁移 seed
  PREFER_ORIGINAL: process.env.PREFER_ORIGINAL,
  PUBLIC_BASE_URL: publicBaseUrl || null,
  credentialStore,
  cookieStore,
  authFlow,
  authNotifier,
  telepress,
  preview: publicBaseUrl ? new PreviewService({ baseUrl: publicBaseUrl, cacheGet, cacheSet }) : null,
  handleAuthRequest: createAuthRequestHandler(authFlow, cookieStore, () => authNotifier.notifyRecovered("cookie")),
};
for (const key of ["BOT_TOKEN", "WEBHOOK_SECRET"]) {
  if (!env[key]) {
    // 配置缺失是可观察事件，不是崩溃条件：以前这里 process.exit(1) + restart 策略
    // 会把「少配一个变量」放大成无限重启，连 /health 都拿不到。
    console.error(`缺少必需环境变量 ${key}`);
    event("config_missing", { variable: key });
  }
}

registerCommands(env, adminIds);

const port = Number(process.env.PORT || 8080);
const mode = (process.env.MODE || "poll").toLowerCase();

// —— HTTP server：poll 与 webhook 都启动。统一转给 worker.fetch（/health /media /webhook /auth/*）——
if (!["poll", "webhook"].includes(mode)) throw new Error("MODE must be poll or webhook");
const httpHost = process.env.HTTP_HOST || "127.0.0.1";
const server = createHttpServer(worker.fetch, env);
server.listen(port, httpHost, () => console.log(`DeviantDrop HTTP listening on ${httpHost}:${server.address().port} (mode=${mode})`));

// —— 故障域登记：HTTP 服务 / Telegram 入口 / Telegram 凭据 / DeviantArt 各自独立 ——
// HTTP 服务只要在监听就算健康；DeviantArt 认证失败属于非关键域，绝不能把整个 Bot 判成 down。
setComponent("http_server", { state: "listening", ok: true, critical: true });
setComponent("telegram_ingress", { state: "starting", ok: false, critical: true });
setComponent("telegram_auth", { state: "unknown", ok: false, critical: true });
setComponent("telegram_bot", { state: "unknown", ok: false, critical: false });
setComponent("deviantart_auth", { state: "unknown", ok: false, critical: false });
event("runtime_started", {
  service: "deviantdrop",
  version: VERSION,
  mode,
  port: server.address()?.port ?? port,
  proxy: proxyUrl ? "configured" : "none",
  bot_token: env.BOT_TOKEN ? "configured" : "missing",
  webhook_secret: env.WEBHOOK_SECRET ? "configured" : "missing",
  public_base_url: publicBaseUrl ? "configured" : "missing",
  allowed_user_ids: String(env.ALLOWED_USER_IDS || "").trim() ? "configured" : "unset",
});

// 进程级兜底：任何未捕获异常都不允许把入口链路带走（以前一个 401 就 process.exit(1)）。
process.on("uncaughtException", (error) => {
  event("process_uncaught_exception", { error: error?.name || "Error", message: error?.message });
});
process.on("unhandledRejection", (reason) => {
  event("process_unhandled_rejection", {
    error: reason?.name || "Error",
    message: reason instanceof Error ? reason.message : String(reason),
  });
});

if (mode === "webhook") {
  // webhook 模式：Telegram 推送到 /webhook（需公网 HTTPS 反代并 setWebhook）。HTTP server 已在上面启动。
  console.log("webhook mode: 请用 https://<host>/webhook 注册 Telegram setWebhook（X-Telegram-Bot-Api-Secret-Token=WEBHOOK_SECRET）");
  setComponent("telegram_ingress", { state: "webhook", ok: true, critical: true });
  await reportWebhookState(env);
} else {
  // 长轮询 + HTTP server 并行：poll 拉更新，HTTP server 提供 /health 与 OAuth 回调。
  await pollUpdates(env);
}

/**
 * 只读探测：Telegram 当前是否注册了 webhook。
 * 只输出「有没有」与主机名，不输出完整 URL（URL 路径里可能带凭据）。
 */
async function webhookState(env) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`, {
      signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) return { readable: false, status: response.status };
    const info = data.result || {};
    let host = null;
    try { host = info.url ? new URL(info.url).host : null; } catch { host = "unparseable"; }
    return {
      readable: true,
      has_webhook: Boolean(info.url),
      host,
      pending_update_count: Number(info.pending_update_count ?? 0),
      last_error_date: info.last_error_date ?? null,
      last_error_message: info.last_error_message ?? null,
    };
  } catch (error) {
    return { readable: false, transport: error?.cause?.code || error?.name || "error" };
  }
}

async function reportWebhookState(env) {
  const state = await webhookState(env);
  event("telegram_webhook_state", { mode: "webhook", ...state });
  return state;
}

async function pollUpdates(env) {
  console.log("DeviantDrop poll mode: getUpdates loop (HTTP server 同时运行)");

  // poll 与 webhook 互斥：残留 webhook 会让 getUpdates 直接 409，表现就是「Bot 完全不回复」。
  // 启动时先读回状态，再显式摘掉，保证 poll 模式不会与 webhook 抢更新。
  const before = await webhookState(env);
  event("telegram_webhook_state", { mode: "poll", phase: "before_cleanup", ...before });
  if (before.readable && before.has_webhook) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/deleteWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ drop_pending_updates: false }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = await response.json().catch(() => null);
      event("telegram_webhook_cleared", { ok: Boolean(response.ok && data?.ok), status: response.status });
    } catch (error) {
      event("telegram_webhook_clear_failed", { transport: error?.cause?.code || error?.name || "error" });
    }
  }

  let offset = 0;
  let unauthorizedAttempts = 0;
  while (true) {
    try {
      const query = new URLSearchParams({
        timeout: "25",
        offset: String(offset),
        allowed_updates: '["message","channel_post"]',
      });
      const response = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/getUpdates?${query}`,
        { signal: AbortSignal.timeout(35_000) },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        const description = data?.description || `HTTP ${response.status}`;
        console.error("getUpdates 失败:", description);
        if (response.status === 401) {
          // 关键：不退出。退出 + restart 策略 = 无限重启循环，连 /health 都读不到，
          // 而且修复凭据后仍然每 60 秒重来一次。这里保持进程存活、明确标记 degraded、
          // 用退避重试；操作员换好 token 重启容器即可恢复。
          unauthorizedAttempts += 1;
          setComponent("telegram_ingress", { state: "unauthorized", ok: false, critical: true, detail: description });
          setComponent("telegram_auth", { state: "unauthorized", ok: false, critical: true, detail: description });
          bump("telegram_unauthorized");
          event("telegram_ingress_unauthorized", {
            stage: "getUpdates",
            attempt: unauthorizedAttempts,
            hint: "BOT_TOKEN 已失效/被吊销：在 @BotFather 重新签发后写入 .env 并重启容器；服务保持运行以便 /health 可读",
          });
          await sleep(backoffMs(unauthorizedAttempts, 5_000, 60_000));
          continue;
        }
        if (response.status === 409) {
          setComponent("telegram_ingress", { state: "conflict", ok: false, critical: true, detail: description });
          bump("telegram_conflict");
          event("telegram_ingress_conflict", {
            stage: "getUpdates",
            hint: "另一个 getUpdates 长轮询实例在跑，或仍残留 webhook；两者都会让更新被抢走",
          });
          await sleep(5_000);
          continue;
        }
        setComponent("telegram_ingress", { state: "error", ok: false, critical: true, detail: description });
        event("telegram_ingress_error", { stage: "getUpdates", status: response.status });
        await sleep(3_000);
        continue;
      }

      unauthorizedAttempts = 0;
      setComponent("telegram_ingress", { state: "polling", ok: true, critical: true, detail: null });
      setComponent("telegram_auth", { state: "ok", ok: true, critical: true, detail: null });

      for (const update of data.result || []) {
        const msg = update.message ?? update.channel_post;
        console.log(
          `[upd] id=${update.update_id} chat=${msg?.chat?.type ?? "?"}(${msg?.chat?.id ?? "?"}) ` +
          `from=${msg?.from?.id ?? "?"} hasText=${!!(msg?.text || msg?.caption)}`,
        );
        bump("updates_received");
        try {
          await handleUpdate(update, env, null);
        } catch (error) {
          bump("update_handler_errors");
          event("update_handler_failed", {
            update_id: update.update_id,
            error: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
          });
          console.error("update 处理异常:", error instanceof Error ? error.message : String(error));
        }
        offset = Math.max(offset, Number(update.update_id ?? 0) + 1);
      }
      if ((data.result || []).length === 0) await sleep(500);
    } catch (error) {
      // 网络域故障：只影响取更新，不影响 HTTP 服务与出站发送能力。
      setComponent("telegram_ingress", {
        state: "network_error", ok: false, critical: true,
        detail: error?.cause?.code || error?.name || "error",
      });
      bump("telegram_ingress_network_errors");
      event("telegram_ingress_error", {
        stage: "getUpdates", transport: error?.cause?.code || error?.name || "error",
      });
      console.error("getUpdates 网络错误:", error.cause?.code || error.name, "3 秒后重试");
      await sleep(3_000);
    }
  }
}

/** 有上限的指数退避：5s → 10s → 20s → 40s → 60s（封顶），避免热循环刷日志。 */
function backoffMs(attempt, base, cap) {
  return Math.min(base * 2 ** Math.max(0, attempt - 1), cap);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
