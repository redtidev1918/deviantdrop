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
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, ProxyAgent } from "undici";
import { createProxyFetch } from "./network.js";
import worker, { handleUpdate, sendTelegram, clearOAuthAccessToken } from "./index.js";
import { CredentialStore } from "./auth/credential-store.js";
import { CookieStore } from "./auth/cookie-store.js";
import { AuthNotifier, resolveAdminIds } from "./auth/auth-notifier.js";
import { OAuthLoginFlow } from "./auth/oauth-login.js";
import { createAuthRequestHandler } from "./auth/http-auth.js";

// —— 代理：国内服务器经 clash 等出口访问被墙的 Telegram/DeviantArt ——
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const directAgent = new Agent();
if (proxyUrl) {
  // 媒体 CDN（wixmp/deviantart.net）国内可直连且更稳，网络层双通道兜底见 network.js。
  const proxyAgent = new ProxyAgent(proxyUrl);
  globalThis.fetch = createProxyFetch(proxyAgent, directAgent);
  console.log(`outbound proxy: ${proxyUrl} (媒体直连，连接失败自动切换)`);
}

// —— 进程内 Cache API（Cloudflare 语义的轻量实现）：去重/限流/通知冷却在单机同样生效 ——
// 并持久化到磁盘，重启后 file_id 去重、限流窗口、auth 通知冷却等仍保留。
if (!globalThis.caches) {
  const CACHE_FILE = process.env.CACHE_FILE || join(tmpdir(), "deviantdrop-cache.json");
  const entries = new Map();
  try {
    const saved = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    for (const [url, entry] of Object.entries(saved)) {
      if (entry && entry.expires > Date.now()) entries.set(url, entry);
    }
  } catch {
    // 首次运行 / 文件不存在
  }
  let writeTimer = null;
  const persist = () => {
    try {
      mkdirSync(dirname(CACHE_FILE), { recursive: true });
      writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(entries)), "utf8");
    } catch (error) {
      console.error("缓存落盘失败:", error.message);
    }
  };
  const schedulePersist = () => {
    if (writeTimer) return;
    writeTimer = setTimeout(() => { writeTimer = null; persist(); }, 500);
  };
  process.on("SIGTERM", () => { if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; } persist(); });
  process.on("SIGINT", () => { persist(); process.exit(0); });

  globalThis.caches = {
    default: {
      async match(input) {
        const hit = entries.get(new URL(String(input)).href);
        if (!hit || hit.expires <= Date.now()) return undefined;
        return new Response(hit.body, { status: 200, headers: new Headers(hit.headers) });
      },
      async put(input, response) {
        const maxAge = Number(
          response.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] ?? 0,
        );
        entries.set(new URL(String(input)).href, {
          body: await response.text(),
          expires: Date.now() + maxAge * 1000,
          headers: Object.fromEntries(response.headers),
        });
        schedulePersist();
      },
    },
  };
}

// —— 认证存储：CredentialStore（refresh token 单一事实来源）+ CookieStore（热更新）——
const AUTH_DIR = process.env.AUTH_DIR || "/data/auth";
// 旧版 refresh token 文件（/data/refresh_token）作为首次迁移来源之一（已部署的 token 不用重新登录）。
const legacyTokenFile = process.env.REFRESH_TOKEN_FILE || "/data/refresh_token";
function migrationSeedToken() {
  if (process.env.DA_REFRESH_TOKEN) return process.env.DA_REFRESH_TOKEN;
  try {
    const v = readFileSync(legacyTokenFile, "utf8").trim();
    return v || null;
  } catch { return null; }
}
const credentialStore = new CredentialStore({
  path: join(AUTH_DIR, "deviantart.json"),
  seedEnvToken: migrationSeedToken(),
});
const cookieStore = new CookieStore({
  path: join(AUTH_DIR, "deviantart-cookies.json"),
  seedEnvCookie: process.env.DA_COOKIES || null,
});

// —— Web OAuth 登录流程 + 认证通知 ——
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const redirectUri = publicBaseUrl ? `${publicBaseUrl}/auth/deviantart/callback` : "";
const adminIds = resolveAdminIds({ ADMIN_IDS: process.env.ADMIN_IDS, ALLOWED_USER_IDS: process.env.ALLOWED_USER_IDS });

// cacheGet/cacheSet 供 AuthNotifier 复用 index.js 的缓存语义。
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

const loginStartBase = publicBaseUrl ? `${publicBaseUrl}/auth/deviantart/start` : null;
let authNotifier; // 先声明：flow 回调在运行时才用到，此时已完成赋值

const authFlow = new OAuthLoginFlow({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  redirectUri,
  credentialStore,
  onTokenSaved: async () => {
    await clearOAuthAccessToken();      // 清短期 access token，下次用新 refresh token 签发
    await authNotifier?.notifyRecovered();
  },
});

authNotifier = new AuthNotifier({
  cacheGet, cacheSet,
  sendTelegram: (method, body) => sendTelegram(env, method, body),
  adminIds,
  // 失效通知按钮：签发一次性 login token 拼成 /auth/deviantart/start?t=...（5 分钟有效）。
  loginUrlBuilder: () => {
    if (!loginStartBase || !authFlow.configured()) return null;
    return `${loginStartBase}?t=${encodeURIComponent(authFlow.issueLoginToken())}`;
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
  telepress: null, // 由 publishing/telepress.js 装配（可选）
  handleAuthRequest: createAuthRequestHandler(authFlow),
};
for (const key of ["BOT_TOKEN", "WEBHOOK_SECRET"]) {
  if (!env[key]) {
    console.error(`缺少必需环境变量 ${key}`);
    process.exit(1);
  }
}

const port = Number(process.env.PORT || 8080);
const mode = (process.env.MODE || "poll").toLowerCase();

// —— HTTP server：poll 与 webhook 都启动。统一转给 worker.fetch（/health /media /webhook /auth/*）——
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const request = new Request(url, {
      method: req.method,
      headers: new Headers(req.headers),
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("http unhandled:", error instanceof Error ? error.message : String(error));
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Internal error");
  }
});
server.listen(port, () => console.log(`DeviantDrop HTTP server listening on :${port} (mode=${mode})`));

if (mode === "webhook") {
  // webhook 模式：Telegram 推送到 /webhook（需公网 HTTPS 反代并 setWebhook）。HTTP server 已在上面启动。
  console.log("webhook mode: 请用 https://<host>/webhook 注册 Telegram setWebhook（X-Telegram-Bot-Api-Secret-Token=WEBHOOK_SECRET）");
} else {
  // 长轮询 + HTTP server 并行：poll 拉更新，HTTP server 提供 /health 与 OAuth 回调。
  await pollUpdates(env);
}

async function pollUpdates(env) {
  console.log("DeviantDrop poll mode: getUpdates loop (HTTP server 同时运行)");
  let offset = 0;
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
        if (response.status === 409) {
          console.error("另一个 getUpdates 长轮询实例在运行？5 秒后重试");
          await sleep(5000);
        } else if (response.status === 401) {
          console.error("BOT_TOKEN 无效，退出");
          process.exit(1);
        } else {
          await sleep(3000);
        }
        continue;
      }
      for (const update of data.result || []) {
        const msg = update.message ?? update.channel_post;
        console.log(
          `[upd] id=${update.update_id} chat=${msg?.chat?.type ?? "?"}(${msg?.chat?.id ?? "?"}) ` +
          `from=${msg?.from?.id ?? "?"} text=${(msg?.text ?? msg?.caption ?? "").slice(0, 40).replace(/\n/g, " ") || "<no-text>"}`,
        );
        try {
          await handleUpdate(update, env, null);
        } catch (error) {
          console.error("update 处理异常:", error instanceof Error ? error.message : String(error));
        }
        offset = Math.max(offset, Number(update.update_id ?? 0) + 1);
      }
      if ((data.result || []).length === 0) await sleep(500);
    } catch (error) {
      console.error("getUpdates 网络错误:", error.cause?.code || error.name, "3 秒后重试");
      await sleep(3000);
    }
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
