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
import { RuntimeSecretStore, DEFAULT_TELEGRAM_TOKEN_PATH } from "./runtime/secrets.js";
import { TelegramIngressController, validateBotToken, TOKEN_VALIDATION } from "./telegram/ingress.js";

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

// —— 运行时 secret：BOT_TOKEN 的第一事实来源是文件，env 只是 bootstrap / fallback ——
// 事故（2026-09-12）：token 被吊销后恢复手段只有「改 .env + docker compose up -d
// --force-recreate」，因为 token 直接来自 process.env，而运行中的容器环境变量是只读的。
// 现在 priority = file > env：把新 token 原子写进 BOT_TOKEN_FILE 即可热恢复，
// 进程、HTTP server、DA auth、cache、preview、OAuth 全部不动。
const secretPath = process.env.BOT_TOKEN_FILE || DEFAULT_TELEGRAM_TOKEN_PATH;
const tokenStore = new RuntimeSecretStore({
  name: "telegram_bot_token",
  path: secretPath,
  envValue: process.env.BOT_TOKEN,
  envVar: "BOT_TOKEN",
  pollIntervalMs: Number(process.env.BOT_TOKEN_POLL_MS || 1500),
});
// 目录按需建立（0700），但不写任何内容：env 用户不会被自动迁移到磁盘。
tokenStore.ensureDir();

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
  // 运行时事实来源：文件优先，env 兜底。所有 Telegram 调用都在调用时读 env.BOT_TOKEN，
  // 所以热更新只需要改这一个字段。
  BOT_TOKEN: tokenStore.value,
  runtimeSecrets: tokenStore,
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
for (const key of ["WEBHOOK_SECRET"]) {
  if (!env[key]) {
    // 配置缺失是可观察事件，不是崩溃条件：以前这里 process.exit(1) + restart 策略
    // 会把「少配一个变量」放大成无限重启，连 /health 都拿不到。
    console.error(`缺少必需环境变量 ${key}`);
    event("config_missing", { variable: key });
  }
}
if (!env.BOT_TOKEN) {
  console.error(`缺少 BOT_TOKEN（既没有 ${secretPath} 也没有环境变量）`);
  event("config_missing", { variable: "BOT_TOKEN", secret_path: secretPath });
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

// /health 里带上版本与模式：否则排障时无法确认「线上到底跑的是哪个 commit」。
env.DD_VERSION = VERSION;
env.MODE = mode;

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

// —— Telegram 入口控制器：token 热更新时只重建入口，进程与其它子系统不动 ——
const ingress = new TelegramIngressController({ env, mode, adminIds, handleUpdate });

// 订阅者 = 「验证后切换」的全部策略。store 只在明确 valid 之后才提交候选值。
tokenStore.subscribe(async (candidate) => {
  event("secret_reload_validating", { name: "telegram_bot_token", validator: "telegram.getMe" });
  const result = await validateBotToken(candidate);
  if (result.status === TOKEN_VALIDATION.DEFERRED) {
    // 429 / 5xx / 超时 / DNS：既不提交也不作废候选，退避后重试同一个值。
    event("secret_reload_validation_deferred", { reason: result.reason, http_status: result.httpStatus });
    return { ok: false, defer: true, reason: result.reason };
  }
  if (result.status === TOKEN_VALIDATION.INVALID) {
    event("secret_reload_validation_failed", { reason: result.reason, http_status: result.httpStatus });
    return { ok: false, reason: "invalid_token", detail: { http_status: result.httpStatus } };
  }
  await ingress.adopt({
    token: candidate,
    botId: result.botId,
    botUsername: result.botUsername,
    reason: "runtime_secret",
  });
  return { ok: true, botId: result.botId, botUsername: result.botUsername };
});

if (mode === "webhook") {
  // webhook 模式：Telegram 推送到 /webhook（需公网 HTTPS 反代并 setWebhook）。HTTP server 已在上面启动。
  console.log("webhook mode: 请用 https://<host>/webhook 注册 Telegram setWebhook（X-Telegram-Bot-Api-Secret-Token=WEBHOOK_SECRET）");
}

// 启动入口（预检 + 唯一 poll loop），随后开始观察运行时 secret 文件。
await ingress.start();
tokenStore.start();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    tokenStore.stop();
    void ingress.stop(signal).catch(() => {});
  });
}
