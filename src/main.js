// Node 版入口：让同一套 worker 逻辑跑在普通服务器（VPS/家用机）上。
//
// 用法：
//   BOT_TOKEN=... WEBHOOK_SECRET=... \
//   CLIENT_ID=... CLIENT_SECRET=... ALLOWED_USER_IDS=... \
//   node src/main.js
// 先跑 scripts/detect-da.mjs 判断这台机器被 DeviantArt 放行到什么程度：
//   - 官方 API 数据面可达（推荐）：CLIENT_ID/CLIENT_SECRET 必填；
//   - 连网页面都可达：不填 CLIENT_ID/CLIENT_SECRET 走匿名网页路径亦可。
import { createServer } from "node:http";
import worker from "./index.js";

// Cloudflare Cache API 的进程内实现：去重/限流在单机同样生效（TTL 由 Cache-Control 决定）。
if (!globalThis.caches) {
  const entries = new Map();
  globalThis.caches = {
    default: {
      async match(input) {
        const hit = entries.get(new URL(String(input)).href);
        if (!hit || hit.expires <= Date.now()) return undefined;
        return new Response(hit.body, { status: 200, headers: hit.headers });
      },
      async put(input, response) {
        const maxAge = Number(
          response.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] ?? 0,
        );
        entries.set(new URL(String(input)).href, {
          body: await response.text(),
          expires: Date.now() + maxAge * 1000,
          headers: new Headers(response.headers),
        });
      },
    },
  };
}

const port = Number(process.env.PORT || 8080);
const env = {
  BOT_TOKEN: process.env.BOT_TOKEN,
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  ALLOWED_USER_IDS: process.env.ALLOWED_USER_IDS,
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
};
for (const key of ["BOT_TOKEN", "WEBHOOK_SECRET"]) {
  if (!env[key]) {
    console.error(`缺少必需环境变量 ${key}`);
    process.exit(1);
  }
}

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
}).listen(port, () => console.log(`DeviantDrop listening on :${port}`));
