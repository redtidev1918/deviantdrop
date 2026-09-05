// Node 版入口：让同一套 bot 逻辑跑在普通服务器（VPS/家用机）上。
//
// 用法（先跑 scripts/detect-da.mjs 确认这台机器的出口，再决定配不配官方凭据）：
//   BOT_TOKEN=... WEBHOOK_SECRET=... \
//   CLIENT_ID=... CLIENT_SECRET=... ALLOWED_USER_IDS=... \
//   MODE=poll|webhook \
//   HTTP_PROXY=http://127.0.0.1:7890   # 国内服务器经 clash 等代理访问 Telegram/DA 时必填
//   node src/main.js
//
// MODE:
//   - poll    （默认）getUpdates 长轮询，无需公网入口/域名/证书；
//   - webhook 本机起 HTTP 服务，需自行提供公网 HTTPS 反代并注册 setWebhook。
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";
import worker, { handleUpdate } from "./index.js";

// —— 代理：国内服务器经 clash 等出口访问被墙的 Telegram/DeviantArt ——
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
const directAgent = new Agent();
if (proxyUrl) {
  // 媒体 CDN（wixmp/deviantart.net）国内可直连且更稳：不走机场出口；
  // DA 页面 / 官方 API / Telegram / archive 仍走代理。
  const proxyAgent = new ProxyAgent(proxyUrl);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    let url;
    try {
      url = new URL(typeof input === "string" ? input : input?.url);
    } catch {
      return originalFetch(input, init);
    }
    const host = url.hostname.toLowerCase();
    const mediaDirect =
      host.endsWith(".wixmp.com") ||
      host.endsWith(".deviantart.net") ||
      host.endsWith(".wixstatic.com");
    return undiciFetch(input, { ...(init || {}), dispatcher: mediaDirect ? directAgent : proxyAgent });
  };
  console.log(`outbound proxy: ${proxyUrl} (媒体直连)`);
}

// —— 进程内 Cache API（Cloudflare 语义的轻量实现）：去重/限流在单机同样生效 ——
// 并持久化到磁盘，重启后 file_id 去重、限流窗口等仍保留。
if (!globalThis.caches) {
  const CACHE_FILE =
    process.env.CACHE_FILE || join(tmpdir(), "deviantdrop-cache.json");
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

const port = Number(process.env.PORT || 8080);
const mode = (process.env.MODE || "poll").toLowerCase();
const env = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  ALLOWED_USER_IDS: process.env.ALLOWED_USER_IDS,
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  DA_COOKIES: process.env.DA_COOKIES,
};
for (const key of ["BOT_TOKEN", "WEBHOOK_SECRET"]) {
  if (!env[key]) {
    console.error(`缺少必需环境变量 ${key}`);
    process.exit(1);
  }
}

if (mode === "webhook") {
  createServer(async (req, res) => {
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
      console.error("unhandled:", error);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal error");
    }
  }).listen(port, () => console.log(`DeviantDrop webhook mode listening on :${port}`));
} else {
  // 长轮询：不需要公网入口，Telegram 主动推送会被我们拉取。
  await pollUpdates(env);
}

async function pollUpdates(env) {
  console.log("DeviantDrop poll mode: getUpdates loop");
  let offset = 0;
  while (true) {
    try {
      const query = new URLSearchParams({
        timeout: "25",
        offset: String(offset),
        allowed_updates: '["message"]',
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
        const msg = update.message;
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
