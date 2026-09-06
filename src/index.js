const TELEGRAM_API = "https://api.telegram.org";
const DEVIANTART = "https://www.deviantart.com/";
import { renderArtworkCaption, sourceLinkEntity, openButtonMarkup as buildOpenMarkup, buildCapFromMedia, normalizeEntitiesForMultipart } from "./rendering/caption.js";
import { publishArtwork } from "./publishing/gallery.js";
import { fetchPublicMedia } from "./preview/server.js";
import { getOfficialToken, clearOAuthAccessToken } from "./auth/token.js";
import { AuthError, CookieExpiredError, PermissionDeniedError, RateLimitError, NetworkError, NotFoundError, publicError, failureText } from "./auth/errors.js";
// 浏览器 UA：DeviantArt 的 WAF 会拦明显的爬虫 UA（尤其是数据中心出口 IP）。
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_LINKS = 5;
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const DA_HEADERS = {
  "Accept-Encoding": "gzip, br",
  "User-Agent": USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
};
const encoder = new TextEncoder();

const REPO = "https://github.com/redtidev1918/deviantdrop";
const HELP_TEXT = `发送 DeviantArt 单作品链接或 fav.me 短链，我会回复其中的图片、视频或 GIF。单条消息最多处理 ${MAX_LINKS} 个链接；图片/视频的 caption 里带链接也可以。\n\n/start 开始 · /help 用法 · /about 项目与源码`;
const ABOUT_TEXT = `DeviantDrop：把 DeviantArt 作品「丢」进 Telegram 的 Bot。\n\n发送 DeviantArt 作品页或 fav.me 短链，即可收到图片、视频或 GIF；每条回复的媒体都会附带原作品页链接。\n\n开源项目（MIT）：${REPO}\n源码、部署与使用说明都在仓库里，欢迎 star、提 issue。`;
const HINT_TEXT = `没有找到可下载的 DeviantArt 链接。\n\n发送 DeviantArt 作品页或 fav.me 短链，即可收到图片、视频或 GIF。\n/help 查看用法，/about 查看项目与源码。`;

// 生产加固参数（README「限流与可靠性」有说明）。
const SESSION_TTL_SECONDS = 90; // DA session 跨消息复用时长（csrf 寿命短，别缓存太久）
const UPDATE_DEDUPE_SECONDS = 90; // 同一 Telegram update 去重窗口（防超时重试重复发送）
const GROUP_DEDUPE_SECONDS = 60; // 同一相册只处理第一条带链接的消息
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_LINKS = 15; // 每个聊天每分钟最多处理的链接数
const RATE_TEXT = `操作太快了：这个聊天每分钟最多处理 ${RATE_MAX_LINKS} 个作品链接，请稍后再试。`;

// —— 官方 OAuth API（DA 的 WAF 按出口 IP 封锁网页接口，官方 API 面放行；部署必须走这条）——
const DA_API_BASE = "https://www.deviantart.com/api/v1/oauth2/";
const DA_MINOR_VERSION = "20240701";

// —— 结构化调试日志：docker logs 里 grep [media]/[send]/[oauth] 定位打码/回退根因 ——
function dlog(tag, ...args) {
  console.error(new Date().toISOString(), `[${tag}]`, ...args);
}
function shortUrl(value) {
  const s = String(value || "");
  try { const u = new URL(s); return `${u.host}${u.pathname}`.slice(0, 90); } catch { return s.slice(0, 90); }
}
async function sendPublishedLink(message, env, id, sourceUrl, publishedUrl) {
  if (!publishedUrl) return;
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: "在 Telegraph 查看全部",
    entities: [{ type: "text_link", offset: 0, length: "在 Telegraph 查看全部".length, url: publishedUrl }],
    reply_markup: buildOpenMarkup(sourceUrl, [{ text: "在 Telegraph 查看全部", url: publishedUrl }]),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.message_thread_id ? {message_thread_id:message.message_thread_id} : {}),
    ...(env.PUBLIC_BASE_URL ? {link_preview_options:{url:`${env.PUBLIC_BASE_URL}/d/${id}`,prefer_large_media:true,show_above_text:false}} : {}),
  });
}
// PREFER_ORIGINAL=1 才优先抓原图（默认关闭：免费账号原图有日配额，常 403/429）。
function preferOriginal(env) {
  return /^(1|true|yes)$/i.test(String(env?.PREFER_ORIGINAL || ""));
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ ok: true, service: "deviantdrop" });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "deviantdrop" });
    }
    if (url.pathname.startsWith("/d/") && env.preview) return env.preview.handle(request);
    // Web OAuth 登录（/auth/deviantart/start|callback）：由 main.js 装配的 env.handleAuthRequest 处理。
    // poll 与 webhook 模式都会启动 HTTP server，因此该路由两种模式都可用。
    if (url.pathname.startsWith("/auth/")) {
      if (typeof env.handleAuthRequest === "function") return env.handleAuthRequest(request);
      return new Response("Not configured", { status: 404 });
    }
    if (["GET", "HEAD"].includes(request.method) && url.pathname === "/media") {
      return proxyMedia(request, env);
    }
    if (request.method === "GET" && url.pathname === "/probe") {
      // 运维诊断：验证各上游从 CF 出口的可达性（用 WEBHOOK_SECRET 作为探针密钥）。
      if (request.headers.get("X-Probe-Key") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      return probeNetwork(env);
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    await handleUpdate(update, env, url.origin);
    return new Response("OK");
  },
};

// 处理单个 Telegram update。webhook 与长轮询共用同一入口。
// origin 为 null 时（长轮询、无公网反代）下载媒体后上传到 Telegram。
export async function handleUpdate(update, env, origin = null) {
  const message = update?.message ?? update?.channel_post;
  if (!message?.chat?.id) return;

  // Telegram 在超时/断连后会重试同一个 update：若已处理完成过，直接跳过，
  // 避免把同一批作品重复发送。登记发生在处理完成之后，因此中途被掐断的
  // 重试仍会重新处理——宁可部分重复，也不丢消息。
  if (Number.isInteger(update.update_id) && await cacheGet("upd", `u:${update.update_id}`)) return;

  try {
    await handleMessage(message, env, origin);
  } catch (error) {
    console.error("update failed", error?.name || "Error", error?.stage || "handler");
    try {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: failureText(error),
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      });
    } catch {
      // Telegram 自身不可用时没有第二条可靠通知通道。
    }
  }
  if (Number.isInteger(update.update_id)) {
    await cacheSet("upd", `u:${update.update_id}`, true, UPDATE_DEDUPE_SECONDS);
  }
}

async function handleMessage(message, env, origin) {
  const allowed = String(env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (allowed.length && !allowed.includes(String(message.from?.id ?? ""))) {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "你没有使用这个 Bot 的权限。",
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    });
    return;
  }

  // 管理员命令：/login（Web OAuth 重新授权）、/status（各组件状态）。
  const adminCommand = (message.text ?? "").match(/^\/(login|status|cookies)(?:@\w+)?(?:\s|$)/i)?.[1]?.toLowerCase();
  if (adminCommand) {
    await handleAdminCommand(adminCommand, message, env);
    return;
  }

  // 转发自本 Bot 的消息（用户把上一条回复转发回来）会带着 caption 里的来源链接：
  // 静默忽略，避免把刚下载过的作品再抓一遍。
  if (isOwnForward(message, env)) return;

  const text = message.text ?? message.caption ?? "";
  const entities = message.text != null ? message.entities : message.caption_entities;
  const command = text.match(/^\/(start|help|about)(?:@\w+)?(?:\s|$)/i)?.[1]?.toLowerCase();
  const links = extractDeviantArtUrls(text, entities);
  if (command && !links.length) {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: command === "about" ? ABOUT_TEXT : HELP_TEXT,
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    });
    return;
  }
  if (!links.length) {
    // 无 caption 的图片、贴纸等消息不打扰；只有明确的文字（私聊文本或 /命令）
    // 才回一条用法提示，群聊里的闲聊保持安静。
    if (!text.trim()) return;
    if (message.chat.type === "private" || text.startsWith("/")) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: HINT_TEXT,
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      });
    }
    return;
  }

  // ponytail: 单条消息最多 5 个链接；高吞吐/长时间任务应接 Queue，而不是拖长 webhook。
  const selected = links.slice(0, MAX_LINKS);

  // 相册里多张照片若都带链接，只处理最先到达的那条，避免对同一组图连发多份。
  if (message.media_group_id) {
    const groupKey = `g:${message.chat.id}:${message.media_group_id}`;
    if (await cacheGet("grp", groupKey)) return;
    await cacheSet("grp", groupKey, true, GROUP_DEDUPE_SECONDS);
  }

  // 每聊天每分钟的链接预算：超出部分发提示后跳过，防止单聊把 DeviantArt/Telegram 打爆。
  const budget = await takeLinkBudget(message.chat.id, selected.length);
  const pending = selected.slice(0, budget);

  // “处理中”临时状态提示：带进度，全部完成后自动删除（尽力而为，失败不影响主体）。
  const total = pending.length;
  // “处理中”临时状态提示：阶段化（获取信息 → 下载进度% → 发送中），完成后自动删除。
  let statusId = null;
  let statusLastEdit = 0;
  let statusLastText = "";
  const statusShow = async (text) => {
    if (!statusId) return;
    const now = Date.now();
    const elapsed = now - statusLastEdit;
    // 下载百分比节流；获取、压缩、发送等阶段切换必须可见。
    if (text === statusLastText || (/\d+%$/.test(text) && elapsed < 900)) return;
    statusLastEdit = now;
    statusLastText = text;
    try {
      await telegram(env, "editMessageText", { chat_id: message.chat.id, message_id: statusId, text });
    } catch {
      // 状态消息可能已被删除或过期，忽略
    }
  };
  const statusDelete = async () => {
    if (!statusId) return;
    try {
      await telegram(env, "deleteMessage", { chat_id: message.chat.id, message_id: statusId });
    } catch {
      // 忽略
    }
    statusId = null;
  };
  if (total > 0) {
    try {
      const sent = await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: "⏳ 正在获取作品信息…",
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      });
      statusId = sent?.message_id ?? null;
    } catch {
      statusId = null;
    }
  }
  try {
    const sessionMemo = {};
    for (let index = 0; index < pending.length; index += 1) {
      const label = pending.length > 1 ? `第 ${index + 1}/${pending.length} 个作品：` : "";
      const onStatus = (text) => statusShow(`⏳ ${label}${text}`);
      try {
        await sendDeviantArt(new URL(pending[index]), message, env, origin, sessionMemo, onStatus);
      } catch (error) {
        await telegram(env, "sendMessage", {
          chat_id: message.chat.id,
          text: `${pending.length > 1 ? `第 ${index + 1} 个链接：` : ""}${failureText(error)}`,
          reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
          ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
        });
      }
    }
    if (budget < selected.length) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: RATE_TEXT,
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      });
    }
    if (links.length > selected.length) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `单条消息最多处理 ${MAX_LINKS} 个链接，其余 ${links.length - selected.length} 个未处理。`,
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
      });
    }
  } finally {
    await statusDelete(); // 全部完成：删除状态提示
  }
}

// 管理员命令处理：/login（Web OAuth 重新授权）、/status（组件状态，不泄漏任何 secret）。
async function handleAdminCommand(command, message, env) {
  const replyOpts = {
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
  };
  const send = (text, extra = {}) => telegram(env, "sendMessage", { chat_id: message.chat.id, text, ...replyOpts, ...extra });

  // 门禁：管理命令只允许 Bot 所有者（ADMIN_IDS = Bot 所有者的 Telegram 用户 id）。
  // 不配置 ADMIN_IDS 时一律拒绝；普通用户白名单（ALLOWED_USER_IDS）不等于管理员。
  const adminIds = String(env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!adminIds.length) {
    await send("管理命令未启用：请在 .env 设置 ADMIN_IDS（Bot 所有者的 Telegram 用户 id）。");
    return;
  }
  if (!adminIds.includes(String(message.from?.id ?? ""))) {
    await send("这个命令仅 Bot 所有者可用。");
    return;
  }

  if (message.chat.type !== "private") {
    await send("请在私聊中使用管理命令。");
    return;
  }

  // /cookies 已并入一键登录（/login）：登录一次同时拿到 OAuth 与网页 Cookie，
  // 无需再手动复制 Cookie。保留命令名作为引导别名。
  if (command === "cookies") {
    await send(
      "无需再手动复制 Cookie：在电脑上运行一条命令，浏览器登录一次即可同时登录账号和网页，多图全部未打码。\n\n" +
      "在你的电脑（需装 Chrome/Edge）进入 DeviantDrop 目录，运行：\n`VPS=root@<你的服务器> npm run login`\n\n" +
      "弹出的 Chrome 里登录 DeviantArt 并点「Authorize/允许」，登录状态会自动推送到服务器并立即生效。",
    );
    return;
  }

  if (command === "login") {
    const authFlow = env.authFlow;
    // 有公网域名：浏览器一键授权（OAuth）。
    if (env.PUBLIC_BASE_URL && authFlow?.configured?.()) {
      const token = authFlow.issueLoginToken();
      const startUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/deviantart/start?t=${encodeURIComponent(token)}`;
      await send("DeviantArt 登录需要更新。点击下方按钮，在浏览器里授权即可（无需重启服务）：\n\n提示：想让多图作品的附加页也发未打码画面，请改用电脑一键登录（见 /login 说明里的命令），它会同时登录网页账号。", {
        reply_markup: { inline_keyboard: [[{ text: "重新登录 DeviantArt", url: startUrl }]] },
      });
      return;
    }
    // 无公网域名（ssh 隧道/家用机）：用本机一键登录器，浏览器登录一次同时拿 OAuth + 网页 Cookie。
    await send(
      "DeviantArt 一键登录（同时登录账号 + 网页，多图作品全部未打码）：\n\n" +
      "1. 在你的电脑上打开终端，进入 DeviantDrop 目录；\n" +
      "2. 运行：`VPS=root@<你的服务器> node scripts/dd-login.mjs`；\n" +
      "3. 会自动打开 Chrome，在 DeviantArt 官方页登录并点「Authorize/允许」；\n" +
      "4. 脚本自动把登录状态推送到服务器并立即生效，无需重启、无需手动复制 Cookie。\n\n" +
      "需要电脑装有 Chrome；服务器地址按实际填写。完成后发 /status 应显示 OAuth: valid、Cookie: available。",
    );
    return;
  }

  if (command === "status") {
    const store = env.credentialStore;
    const authState = store ? store.getState() : null;
    const authText = authState
      ? (authState.state === "valid" && authState.hasToken ? "valid（已登录）" : authState.state === "invalid" ? "invalid（需 /login）" : "absent（未登录）")
      : (env.DA_REFRESH_TOKEN ? "env 配置" : "未配置");
    const cookieText = env.cookieStore ? (env.cookieStore.available() ? "available" : "none") : (env.DA_COOKIES ? "env 配置" : "none");
    const teleText = env.telepress ? env.telepress.mode : "disabled";
    const lines = [
      "DeviantDrop Status",
      "",
      `Telegram: OK`,
      `DeviantArt Web: 按请求检查`,
      `OAuth: ${authText}`,
      `Cookie: ${cookieText}`,
      `TelePress: ${teleText}`,
      `Cache: ${cacheApi() ? "已配置" : "未配置"}`,
    ];
    await send(lines.join("\n"));
    return;
  }
}

// BOT_TOKEN 形如 "123456:…"，冒号前的数字就是 Bot 自身的用户 id。
function isOwnForward(message, env) {
  const botId = Number(String(env.BOT_TOKEN ?? "").split(":")[0]);
  if (!botId) return false;
  const senderIds = [
    message.forward_origin?.sender_user?.id,
    message.forward_from?.id,
    message.via_bot?.id,
  ];
  return senderIds.includes(botId);
}

// —— 轻量共享存储层 ——
// Cloudflare Cache API（caches.default）每个 Worker 默认可用且跨请求共享，
// TTL 由 Cache-Control 控制；纯 Node 测试/本地无缓存环境里 cacheGet/cacheSet
// 自动为空操作，相关加固随之停用，不影响原有正确性。
function cacheApi() {
  return typeof globalThis.caches?.default?.match === "function" ? globalThis.caches.default : null;
}

async function cacheGet(namespace, key) {
  const store = cacheApi();
  if (!store) return null;
  const hit = await store.match(cacheUrl(namespace, key));
  return hit ? hit.json().catch(() => null) : null;
}

async function cacheSet(namespace, key, value, ttlSeconds) {
  const store = cacheApi();
  if (!store) return;
  await store.put(cacheUrl(namespace, key), new Response(JSON.stringify(value), {
    headers: { "Cache-Control": `public, max-age=${ttlSeconds}` },
  }));
}

function cacheUrl(namespace, key) {
  return `https://deviantdrop.cache.internal/${namespace}/${encodeURIComponent(key)}`;
}

// DA 匿名 session（CSRF + cookie）与聊天无关，跨消息、跨聊天复用可显著减少
// 对 DeviantArt 的请求总量，降低触发自适应限流的概率。配置 DA_COOKIES 时
// 当前生效的 DA cookie：优先热更新 CookieStore，回退 env.DA_COOKIES（兼容旧配置）。
function currentDaCookies(env) {
  if (env.cookieStore) return env.cookieStore.getCookies();
  return env.DA_COOKIES || null;
}

// 注入登录会话（用于成熟内容），并单独缓存避免与匿名 csrf 串用。
async function getDeviantArtSession(env) {
  const cookies = currentDaCookies(env);
  const key = cookies ? `session:${await hmac(cookies, env.WEBHOOK_SECRET)}` : "session";
  const cached = await cacheGet("da", key);
  if (cached?.csrf) return cached;
  const session = await createDeviantArtSession(env);
  await cacheSet("da", key, session, SESSION_TTL_SECONDS);
  return session;
}

// 每聊天滑动窗口限流：返回本次允许处理的链接数（<= count）。
async function takeLinkBudget(chatId, count) {
  if (!cacheApi()) return count;
  const now = Date.now();
  let state = await cacheGet("rl", `chat:${chatId}`);
  if (!state || now - state.start >= RATE_WINDOW_MS) state = { start: now, used: 0 };
  const allowed = Math.min(count, Math.max(0, RATE_MAX_LINKS - state.used));
  state.used += allowed;
  // ponytail: 读改写非原子；webhook max_connections=1 使同一聊天的请求基本串行，够用。
  await cacheSet("rl", `chat:${chatId}`, state, Math.ceil(RATE_WINDOW_MS / 1000));
  return allowed;
}

async function createDeviantArtSession(env) {
  const headers = { Accept: "text/html", ...DA_HEADERS };
  const cookies = currentDaCookies(env);
  if (cookies) headers.Cookie = cookies;
  const home = await fetchDeviantArt(DEVIANTART, { headers });
  if (cookies && (home.status === 401 || /\/users\/login(?:[/?]|$)/.test(home.url || ""))) {
    await home.body?.cancel();
    if (!env.cookieStore) throw new CookieExpiredError();
    env.cookieStore.clear();
    await env.authNotifier?.notifyInvalid("cookie expired", "cookie");
    return createDeviantArtSession(env);
  }
  await throwForDeviantArtStatus(home);
  const html = await home.text();
  const csrf = html.match(/window\.__CSRF_TOKEN__ = '([^']+)'/)?.[1];
  if (!csrf) throw new Error("DeviantArt 页面结构可能已变化，无法读取 CSRF token");
  return { csrf, cookies: currentDaCookies(env) || getCookies(home.headers) };
}

// 解析并发送单个作品。双通道级联：
//   1) 网页 _puppy 接口（出口可达时能力最全：新作品/视频/GIF/无需凭据，session 已缓存复用）；
//   2) 网页不可达时，若配置了官方 API 凭据则走「官方 API + archive.org 存档映射」兜底。
async function sendDeviantArt(url, message, env, origin, sessionMemo = {}, onStatus = null) {
  const target = parseDeviantArtTarget(url);
  // 媒体级去重：同一作品首次发过后缓存 Telegram file_id，再发直接用 file_id（零下载）。
  const cached = await cacheGet("fid", `d2:${target.id}`);
  if (cached?.kind === "album" && Array.isArray(cached.files) && cached.files.length) {
    dlog("send", `replay album id=${target.id} files=${cached.files.length}`);
    // 重放也用统一渲染：caption 无裸 URL，来源用 text_link；相册另补发入口消息。
    const { capTitle, capAuthor } = splitTitleAuthor(cached.title);
    const replayCap = cached.cap ? { ...cached.cap, sourceUrl: url.href } : capObject({ title: capTitle, author: capAuthor, sourceUrl: url.href, mediaCount: cached.files.length });
    await sendAlbumByFileIds(cached.files, "", message, env, replayCap);
    return;
  }
  if (cached?.file_id) {
    dlog("send", `replay file id=${target.id} kind=${cached.kind}`);
    const { capTitle, capAuthor } = splitTitleAuthor(cached.title);
    const replayCap = cached.cap ? { ...cached.cap, sourceUrl: url.href } : capObject({ title: capTitle, author: capAuthor, sourceUrl: url.href });
    await sendFileById(cached.kind, cached.file_id, "", message, env, replayCap);
    return;
  }
  let media;
  try {
    media = await resolveWebMedia(url, env, null, sessionMemo);
  } catch (error) {
    if (!env.CLIENT_ID || !env.CLIENT_SECRET || !(error instanceof NetworkError) && !/连接失败|超时|无法连接/.test(error.message)) throw error;
    media = await resolveOfficialMedia(url, env, null);
  }
  const cap = buildCapFromMedia(media, url.href);
  if (media.skippedExtras > 0 || media.matureBlurred) cap.status = { ...cap.status, blurredPreview: true };
  try { await env.preview?.remember({id:target.id,...cap}); } catch { /* preview must not block delivery */ }
  const rawItems=[{kind:media.kind,url:media.url,display:media.display},...(media.extras||[])];
  const items=await Promise.all(rawItems.map(async item=>({...item,url:await createProxyUrl(origin,item.url,env.WEBHOOK_SECRET)})));
  try {
    if(items.length>1 && items.every(i=>i.kind==='photo'||i.kind==='video')) {
      const results=[];
      for(let i=0;i<items.length;i+=10) results.push(...await sendAlbum(items.slice(i,i+10),'',message,env,!origin,onStatus,cap));
      if(items.length<=10)await rememberAlbumFileIds(target.id,media.title,results,env,cap);
    } else {
      for(const item of items){
        const result=await sendOne(item.kind,item.url,'',message,env,!origin,onStatus,item.display,cap);
        if(items.length===1)await rememberFileId(target.id,item.kind,media.title,result,env,cap);
      }
    }
  } catch(error) {
    const published=await publishArtwork(env,target.id,media,url.href,true);
    if(!published)throw error;
    await sendPublishedLink(message,env,target.id,url.href,published);
    return;
  }
  const published=await publishArtwork(env,target.id,media,url.href);
  if(published){try{await sendPublishedLink(message,env,target.id,url.href,published);}catch{/* optional action */}}
}

// 成熟多图作品的附加页是否应跳过：仅当「成熟作品 + 无网页登录 Cookie + 确有附加页」时。
// 有网页登录 Cookie 时 init 下发的附加页是未打码原始文件，必须解析发送（这是多图全未打码的关键）。
function shouldSkipMatureExtras({ isMature, hasWebCookie, raw }) {
  return isMature && !hasWebCookie && Array.isArray(raw) && raw.length > 0;
}

// "标题 — 作者" 拆回标题/作者（供 file_id 重放时重建 cap）。
function splitTitleAuthor(title) {
  const m = String(title || "").match(/^(.*?)\s+—\s+([^—]+)$/);
  return m ? { capTitle: m[1].trim(), capAuthor: m[2].trim() } : { capTitle: title || "DeviantArt 作品", capAuthor: undefined };
}
// 构建发送函数用的 cap 对象（含初始 text=null，由发送函数渲染）。
function capObject({ title, author, sourceUrl, mediaCount, status = {} }) {
  return { title, author, sourceUrl, mediaCount, status, text: null };
}

// fav.me / view / view.php 等短链不带作者名，而 _puppy/init 自 2026 年起把 username 也列为必填
// （缺失 400「username is required」）。跟随 fav.me 重定向拿规范链接里的作者名；出口无法连 fav.me 时给明确提示。
async function resolveTargetUsername(url, env) {
  try {
    const response = await fetch(url, {
      headers: { ...DA_HEADERS, Accept: "text/html" },
        signal: AbortSignal.timeout(8_000),
    });
    const finalUrl = response.url || url.href;
    response.body?.cancel();
    const parts = new URL(finalUrl).pathname.split("/").filter(Boolean);
    // 规范链接：/<username>/art/<slug>-<id>
    return parts.length >= 3 && parts[1] === "art" ? parts[0] : parts[0] || null;
  } catch (error) {
    dlog("media", `fav.me 重定向解析作者失败: ${error instanceof Error ? error.cause?.code || error.name : String(error)}`);
    return null;
  }
}

async function resolveWebMedia(url, env, origin, sessionMemo) {
  // username 必填：短链先解析作者名，失败则明确提示（而不是落进 init 的谜之 400）。
  let target = parseDeviantArtTarget(url);
  if (!target.username) target.username = await resolveTargetUsername(url, env);
  if (!target.username) {
    throw new Error("这个短链（fav.me/view）无法自动解析作者信息：请打开链接后，把完整的作品页网址（deviantart.com/作者/art/…）发给我。");
  }
  // CSRF 会话有效期较短，缓存的 csrf 可能已过期导致 init 400：过期时清缓存换新会话重试一次。
  for (let attempt = 0; ; attempt += 1) {
    const cookieRevision = currentDaCookies(env);
    if (sessionMemo.cookieRevision !== cookieRevision) { sessionMemo.session = null; sessionMemo.cookieRevision = cookieRevision; }
    if (!sessionMemo.session) sessionMemo.session = await getDeviantArtSession(env);
    const session = sessionMemo.session;
    try {
      const endpoint = new URL("/_puppy/dadeviation/init", DEVIANTART);
      endpoint.searchParams.set("deviationid", target.id);
      endpoint.searchParams.set("username", target.username);
      // 该接口自 2026 年起把 type 列为必填（art/journal 等枚举值），缺失会返回 400。
      endpoint.searchParams.set("type", "art");
      endpoint.searchParams.set("include_session", "false");
      endpoint.searchParams.set("csrf_token", session.csrf);
      endpoint.searchParams.set("mature_content", "true");
      const data = await fetchDeviantArtJson(endpoint, {
        Accept: "application/json",
        Referer: url.href,
        ...DA_HEADERS,
        ...(session.cookies ? { Cookie: session.cookies } : {}),
      });
      const deviation = data.deviation;
      // 有用户 OAuth（CredentialStore 里的 refresh token）或登录 Cookie 都视为已登录，放行成熟内容
      const hasOAuth = !!(env.credentialStore ? env.credentialStore.getRefreshToken() : env.DA_REFRESH_TOKEN);
      const hasWebCookie = Boolean(currentDaCookies(env));
      const allowMature = Boolean(hasWebCookie || hasOAuth);
      const item = extractDeviantArtMedia(deviation, allowMature);
      dlog("media", `dev=${target.id} mature=${deviation?.isMature === true} allowMature=${allowMature} webCookie=${hasWebCookie} webKind=${item.kind} webUrl=${shortUrl(item.url)} blur=${/blur_/.test(item.url || "")}`);
      // 成熟作品主图未打码来源：
      //   - 有网页登录 Cookie：init 下发的主图 baseUri 即未打码原始文件（实测签名 CDN 可直连下载，
      //     不占 /download 原图配额），直接认定已到手——不再走官方 OAuth override（多图作品官方
      //     API 常 404/只返回主图），也不降级成小 preview。
      //   - 无网页 Cookie 但有 OAuth：尝试官方接口取未打码原图替代打码网页预览（旧路径）。
      let matureBlurred = false;
      let matureOverrideOk = false;
      if (deviation?.isMature === true && hasWebCookie) {
        matureOverrideOk = true;
        dlog("media", `mature 网页登录态 dev=${target.id} kind=${item.kind} url=${shortUrl(item.url)} blur=${/blur_/.test(item.url || "")}`);
      } else if (deviation?.isMature === true && hasOAuth) {
        const uuid = deviation?.extended?.deviationUuid;
        try {
          if (uuid) {
            const official = await officialApiGet(env, `deviation/${uuid}`);
            const original = await pickOfficialMediaUrl(env, official, uuid, preferOriginal(env));
            if (original) {
              item.url = original;
              item.kind = extensionKind(original) || item.kind;
              matureOverrideOk = true;
              dlog("media", `mature override OK dev=${target.id} uuid=${uuid} kind=${item.kind} url=${shortUrl(original)} blur=${/blur_/.test(original)}`);
            } else {
              matureBlurred = true;
              dlog("media", `mature override EMPTY dev=${target.id} uuid=${uuid} → 回退网页预览`);
            }
          } else {
            matureBlurred = true;
            dlog("media", `mature override SKIP dev=${target.id} 无 uuid → 回退网页预览`);
          }
        } catch (error) {
          matureBlurred = true;
          dlog("media", `mature override FAILED dev=${target.id} → ${error instanceof Error ? error.message : String(error)} → 回退网页预览`);
        }
      }
      const display = displayMediaUrl(deviation.media || {});
      // 默认不抓原图：免费账号原图下载有日配额（403/429「Free download limit reached」），
      // 每次都先撞额度再回退既慢又吵。照片直接用最高清展示图（preview）；PREFER_ORIGINAL=1 才优先原图。
      // 成熟作品已拿到未打码原图（matureOverrideOk：网页登录态的 baseUri，或 OAuth 官方图）时，
      // 绝不能被网页的小 preview 覆盖。
      if (!preferOriginal(env) && !matureOverrideOk && item.kind === "photo" && display && display !== item.url) {
        item.url = display;
        item.kind = extensionKind(display) || "photo";
        dlog("media", `photo → 最高清展示图 dev=${target.id} url=${shortUrl(display)}`);
      }
      const extras = [];
      const isMature = deviation?.isMature === true;
      // 成熟作品附加页能否未打码，取决于是否带「网页登录 Cookie」请求 init：
      //   - 有登录 Cookie（/login 一键登录拿到的 auth/auth_secure/userinfo）：init 下发的
      //     additionalMedia token 即未打码原始文件，正常解析发送；
      //   - 无登录 Cookie（匿名 / 仅 OAuth）：附加页 token 带 blur 声明、原始文件 403，
      //     官方 OAuth API 又不返回 additionalMedia——拿不到未打码版，跳过并计数，
      //     让上层提示去作品页看其余画面（而不是发用户明确不要的打码图）。
      //     hasWebCookie 在上方主图判定处已定义。
      let skippedExtras = 0;
      // 多文件作品：其余画面在 init 响应的 deviation.extended.additionalMedia 里
      // （daviewer/dakit 同源结论），每项嵌套 Wix 媒体描述符；解析失败仅发主图。
      if (deviation?.isMultiMedia === true) {
        const raw = deviation?.extended?.additionalMedia;
        if (shouldSkipMatureExtras({ isMature, hasWebCookie, raw })) {
          skippedExtras = Array.isArray(raw) ? raw.length : 0;
          dlog("media", `mature 附加页跳过 dev=${target.id} count=${skippedExtras}（无网页登录 Cookie：附加页匿名仅打码、OAuth 无此字段）`);
        } else {
          try {
            if (Array.isArray(raw)) {
              for (const entry of raw) {
                const media = (entry && typeof entry === "object") ? entry.media : null;
                const extraUrl = pickMultimediaUrl(media);
                if (extraUrl) {
                  extras.push({
                    kind: extensionKind(extraUrl) || "photo",
                    url: await createProxyUrl(origin, extraUrl, env.WEBHOOK_SECRET),
                    display: displayMediaUrl(media) || null,
                  });
                }
              }
            }
          } catch (error) {
            console.error("多图解析失败，仅发主图:", error instanceof Error ? error.message : String(error));
          }
        }
      }
      return {
        kind: item.kind,
        url: await createProxyUrl(origin, item.url, env.WEBHOOK_SECRET),
        display,
        title: item.title,
        extras,
        skippedExtras,
        // 成熟作品未能用 OAuth 取到未打码原图时置真，供上层在 caption 里提示“登录已过期”。
        matureBlurred,
      };
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && /HTTP 400/.test(text)) {
        // csrf 过期/被抢占：清掉缓存会话，下一次循环用新会话重试
        const cookie = currentDaCookies(env);
        const key = cookie ? `session:${await hmac(cookie, env.WEBHOOK_SECRET)}` : "session";
        await cacheSet("da", key, null, 1);
        sessionMemo.session = null;
        console.error("init 400，刷新会话重试:", text);
        continue;
      }
      throw error;
    }
  }
}


// 附加媒体的 URL 选择：与主媒体一致，优先 baseUri 原始文件，其次模板。
function pickMultimediaUrl(media) {
  if (!media || typeof media !== "object") return null;
  if (extensionKind(media.baseUri || "")) return appendToken(media.baseUri, media.token);
  const types = Array.isArray(media.types) ? media.types : [];
  const full = types.find((item) => item?.t === "fullview");
  if (full?.b) return appendToken(full.b, media.token);
  if (full?.c) return buildMediaUrl(media, full.c);
  const preview = types.find((item) => item?.t === "preview" && (item.c || item.b));
  if (preview?.b) return appendToken(preview.b, media.token);
  if (preview?.c) return buildMediaUrl(media, preview.c);
  return null;
}


// 原图不可得（如免费账号原图额度用尽）时的最高清展示图：preview 变体优先，
// 其次最大的宽缩略图；fullview 变体（mature 打码/400）不用。
function displayMediaUrl(media) {
  if (!media || typeof media !== "object") return null;
  const types = Array.isArray(media.types) ? media.types : [];
  const prefer = ["preview", "414W", "375W", "400T", "350T", "300W"];
  for (const name of prefer) {
    const type = types.find((item) => item?.t === name);
    if (!type) continue;
    if (type.b) return appendToken(type.b, media.token);
    if (type.c) return buildMediaUrl(media, type.c);
  }
  return null;
}

// —— 官方 OAuth API 解析路径（数字 id → archive.org 快照里的 UUID → deviation 取媒体）——

async function resolveOfficialMedia(url, env, origin) {
  const target = parseDeviantArtTarget(url);
  const uuid = await resolveDeviationUuid(target, url, env);
  const deviation = await officialApiGet(env, `deviation/${uuid}`);
  const mediaUrl = await pickOfficialMediaUrl(env, deviation, uuid, preferOriginal(env));
  if (!mediaUrl) throw new Error("作品没有可用的公开媒体");
  const title = deviation?.title || "DeviantArt";
  const author = deviation?.author?.username;
  return {
    kind: extensionKind(mediaUrl) || "photo",
    url: await createProxyUrl(origin, mediaUrl, env.WEBHOOK_SECRET),
    title: `${title}${author ? ` — ${author}` : ""}`,
  };
}

// 数字作品 id → UUID。官方 API 只认 UUID；唯一已知的公开映射藏在作品页内嵌 JSON 里，
// 而 DA 网页对云出口封锁——archive.org 的快照里保留了这份映射（deviationExtended.<数字>.deviationUuid）。
async function resolveDeviationUuid(target, url, env) {
  const { id, username } = target;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;

  const cached = await cacheGet("uuid", `d:${id}`);
  if (cached) return cached;

  // 需要作品页规范链接（作者+slug）才能定位存档；fav.me/view 之类没有 slug 的旧链给明确提示。
  const candidates = archivePageCandidates(url, username);
  if (candidates.length === 0) {
    throw new Error("这种旧式/短链链接暂无法解析（DeviantArt 已限制匿名转换）：请打开链接后把完整的作品页网址发给我。");
  }
  for (const page of candidates) {
    const uuid = await archiveUuidFromPage(page, id);
    if (uuid) {
      await cacheSet("uuid", `d:${id}`, uuid, 30 * 24 * 3600); // UUID 恒定，长缓存
      return uuid;
    }
  }
  throw new Error("暂无法解析该作品：archive.org 还没有它的页面快照（作品可能太新），请稍后再试。");
}

// 用于 CDX 查询的作品页 URL 候选。fav.me、/view、view.php 之类没有作者/slug 的
// 旧式链接无法在 archive.org 定位存档页，返回空数组由调用方给明确提示。
function archivePageCandidates(url, username) {
  if (!username) return [];
  const input = url.href.split("#")[0];
  const host = url.hostname.toLowerCase();
  const isLegacySubdomain = host.endsWith(".deviantart.com") &&
    !["www", "m", "fav"].includes(host.split(".")[0]) && host !== "deviantart.com";
  const canonical = isLegacySubdomain ? `https://www.deviantart.com/${username}${url.pathname}` : null;
  return [input, canonical].filter(Boolean);
}

// 从 archive.org 的“最近一次快照”里解析作品页内嵌的 deviationUuid。
// 用 /web/2/ 前缀让 replay 302 到最近快照（archive.org 的 CDX 索引对云出口限流 503，
// 但快照 replay 本身可达）；UUID 以 {\"<数字id>\":{...}} 形式藏在 deviationExtended JSON 里。
async function archiveUuidFromPage(pageUrl, numeric) {
  const response = await guardedFetch(`https://web.archive.org/web/2/${pageUrl}`, {
    headers: DA_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  }, "archive.org 快照");
  if (response.status === 404) {
    response.body?.cancel();
    return null; // 该页从未被收录
  }
  if (!response.ok) {
    response.body?.cancel();
    throw new Error(`archive.org 快照请求失败（HTTP ${response.status}）`);
  }
  const html = await response.text();
  // 页面 JSON 里引号被转义（\"），取一层还原后匹配；找不到再试其它层。
  for (const text of [html, html.replace(/\\"/g, '"')]) {
    const needle = `"deviationExtended":{"${numeric}":{"deviationUuid":"`;
    const start = text.indexOf(needle);
    if (start >= 0) {
      const uuid = text.slice(start + needle.length, start + needle.length + 36);
      if (/^[0-9a-f-]{36}$/i.test(uuid)) return uuid;
    }
  }
  return null;
}

// 网络层异常统一转成带阶段的中文错误，便于用户反馈时定位是超时还是被拒。
async function guardedFetch(url, init, label) {
  try {
    return await fetch(url, init);
  } catch {
    throw new NetworkError(`${label}连接失败或超时，请稍后再试`);
  }
}

async function officialApiGet(env, path, retried = false) {
  const endpoint = new URL(path, DA_API_BASE);
  endpoint.searchParams.set("mature_content", "true");
  const headers = {
    Authorization: `Bearer ${await getOfficialToken(env)}`,
    ...DA_HEADERS,
    "dA-minor-version": DA_MINOR_VERSION,
  };
  const response = await guardedFetch(endpoint, { headers, signal: AbortSignal.timeout(20_000) }, "DeviantArt 官方 API");
  if (response.status === 401) {
    // token 失效：清缓存后按“无缓存”语义再取一次即可（下一请求会重新签发）。
    clearOAuthAccessToken(env);
    if (!retried) return officialApiGet(env, path, true);
    throw new AuthError("DeviantArt 拒绝了访问凭据");
  }
  if (response.status === 404) throw new NotFoundError("作品不存在、已删除或链接无效");
  if (response.status === 403) throw new PermissionDeniedError();
  if (response.status === 429) throw new RateLimitError();
  if (!response.ok) throw new Error(`DeviantArt 请求失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("DeviantArt 返回了无效数据");
  return data;
}

// 媒体选择：默认用 content/preview（无需原图下载额度）；仅 PREFER_ORIGINAL=1 时才走原图下载端点。
async function pickOfficialMediaUrl(env, deviation, uuid, wantOriginal = false) {
  const downloadable = deviation?.is_downloadable === true;
  dlog("media", `official pick uuid=${uuid} downloadable=${downloadable} wantOriginal=${wantOriginal} hasContent=${!!deviation?.content?.src} hasPreview=${!!deviation?.preview?.src} thumbs=${Array.isArray(deviation?.thumbs) ? deviation.thumbs.length : 0}`);
  if (wantOriginal && downloadable) {
    try {
      const download = await officialApiGet(env, `deviation/download/${uuid}`);
      if (download?.src) return download.src;
    } catch {
      // 订阅限制等场景下拿不到原图：落到 content
    }
  }
  const content = deviation?.content?.src;
  const preview = deviation?.preview?.src;
  if (content) return content;
  const thumbs = deviation?.thumbs;
  if (Array.isArray(thumbs) && thumbs.length) return thumbs[0]?.src || thumbs.at(-1)?.src;
  return preview || null;
}

async function sendOne(kind, mediaUrl, caption, message, env, upload = false, onStatus = null, fallbackUrl = null, cap = null) {
  const fields = MEDIA_FIELDS[kind];
  if (!fields) throw new Error("不支持的媒体类型");
  const rendered = renderArtworkCaption(cap, cap.status || {});
  const text = rendered.text.slice(0, 1024);
  const entities = cap ? [sourceLinkEntity(text, cap.sourceUrl)].filter(Boolean) : [];
  const sourceUrl = cap.sourceUrl;
  const markup = buildOpenMarkup(sourceUrl);
  if (upload) {
    // 轮询模式：Telegram 服务器拉不动 wixmp（需 Referer/UA），由 Bot 先下载再上传。
    return uploadMedia(env, kind, mediaUrl, text, message, onStatus, fallbackUrl, cap);
  }
  const baseBody = {
    chat_id: message.chat.id,
    caption: text,
    ...(entities.length ? { caption_entities: entities } : {}),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(markup ? { reply_markup: markup } : {}),
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
  };
  try {
    return await telegram(env, fields[0], { [fields[1]]: mediaUrl, ...baseBody });
  } catch (error) {
    // 照片 URL 超过 10 MiB：改以文档方式让 Telegram 下载（文档上限 50 MiB）。
    if (kind === "photo" && isTooBigError(error)) {
      const [docMethod, docField] = MEDIA_FIELDS.document;
      cap.status = { ...cap.status, docFallback: true };
      baseBody.caption = renderArtworkCaption(cap, cap.status).text;
      baseBody.caption_entities = [sourceLinkEntity(baseBody.caption, cap.sourceUrl)].filter(Boolean);
      return telegram(env, docMethod, { [docField]: mediaUrl, ...baseBody });
    }
    throw error;
  }
}

// 以 Telegram 相册（sendMediaGroup）发送一组媒体：upload 模式（轮询）自行下载后
// multipart 附加（attach://），否则直接把 URL 交给 Telegram。caption 只放第一张。
async function sendAlbum(items, caption, message, env, upload, onStatus = null, cap = null) {
  if (items.length === 1) return [await sendOne(items[0].kind, items[0].url, caption, message, env, upload, onStatus, items[0].display, cap)];
  const typeOf = { photo: "photo", video: "video", animation: "animation" };
  // 所有发送路径共用结构化 caption。
  const renderCapNow = () => {
    const { text } = renderArtworkCaption(
      { title: cap.title, author: cap.author, mediaCount: cap.mediaCount },
      cap.status || {},
    );
    return text;
  };
  const baseText = renderCapNow();
  const capEntities = cap ? [sourceLinkEntity(baseText, cap.sourceUrl)].filter(Boolean) : [];
  if (!upload) {
    const result = await telegram(env, "sendMediaGroup", {
      chat_id: message.chat.id,
      media: items.map((item, index) => ({
        type: typeOf[item.kind] || "photo",
        media: item.url,
        ...(index === 0 ? { caption: baseText, ...(capEntities.length ? { caption_entities: capEntities } : {}) } : {}),
      })),
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
    });
    return Array.isArray(result) ? result : [result];
  }

  // 轮询（上传）模式：逐张下载（带进度）→ 超限照片压缩后再进相册 → 压缩失败降级为文档
  const entries = [];
  const docFalls = [];
  let compressedAny = false;
  let usedFallbackAny = false;
  let usedBlurredAny = false;
  for (let i = 0; i < items.length; i += 1) {
    const indexLabel = `第 ${i + 1}/${items.length} 张`;
    let response = await guardedFetch(items[i].url, {
      headers: { ...DA_HEADERS, Referer: DEVIANTART },
      signal: AbortSignal.timeout(180_000),
    }, "媒体下载");
    let itemFallback = false;
    if (!response.ok) {
      response.body?.cancel();
      if ((response.status === 403 || response.status === 429) && items[i].display && items[i].display !== items[i].url) {
        const fallback = await guardedFetch(items[i].display, {
          headers: { ...DA_HEADERS, Referer: DEVIANTART },
          signal: AbortSignal.timeout(120_000),
        }, "展示图下载");
        if (!fallback.ok) {
          fallback.body?.cancel();
          throw quotaOrMediaError(response.status);
        }
        response = fallback;
        itemFallback = true;
      } else {
        throw quotaOrMediaError(response.status);
      }
    }
    const totalBytes = Number(response.headers.get("Content-Length")) || 0;
    const fileChunks = [];
    let received = 0;
    let lastPct = -1;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      fileChunks.push(value);
      received += value.byteLength;
      if (onStatus && totalBytes > 0) {
        const pct = Math.floor((received / totalBytes) * 100);
        if (pct % 5 === 0 && pct > lastPct) {
          lastPct = pct;
          await onStatus(`正在下载 ${indexLabel} ${pct}%`);
        }
      }
    }
    let bytes = concatBytes(fileChunks);
    let extension = guessExtension(itemFallback ? items[i].display : items[i].url, items[i].kind);
    if (itemFallback) {
      extension = "jpg";
      usedFallbackAny = true;
      if (/blur_/.test(items[i].display || "")) usedBlurredAny = true;
    }
    if (items[i].kind === "photo" && bytes.length > PHOTO_MAX_BYTES) {
      if (onStatus) await onStatus(`正在压缩 ${indexLabel}…`);
      const compressed = await compressPhoto(bytes);
      if (compressed) {
        bytes = compressed;
        extension = "jpg";
        compressedAny = true;
      } else {
        docFalls.push({ url: items[i].url, bytes, extension });
        continue;
      }
    }
    entries.push({ bytes, extension, kind: items[i].kind });
  }
  // 下载阶段收集状态，再用统一渲染器生成 caption。
  const status = {};
  if (compressedAny) status.compressed = true;
  if (usedBlurredAny) status.blurredPreview = true;
  else if (usedFallbackAny) status.previewOnly = true;
  if (docFalls.length) status.docFallback = true;
  cap.status = { ...(cap.status || {}), ...status };
  const fullCaption = renderCapNow();
  const fullEntities = [sourceLinkEntity(fullCaption, cap.sourceUrl)].filter(Boolean);
  const results = [];
  const mediaForm = () => {
    const form = new FormData();
    form.set("chat_id", String(message.chat.id));
    form.set("reply_parameters", JSON.stringify({ message_id: message.message_id, allow_sending_without_reply: true }));
    // 相册不支持 inline 按钮（sendMediaGroup 静默丢弃），不要发 reply_markup。
    if (message.message_thread_id) form.set("message_thread_id", String(message.message_thread_id));
    return form;
  };
  if (entries.length >= 2) {
    if (onStatus) await onStatus("正在发送相册…");
    const sent = await telegramForm(env, "sendMediaGroup", () => {
      const form = mediaForm();
      form.set("media", JSON.stringify(entries.map((entry, i) => ({
        type: entry.kind,
        media: `attach://file${i}`,
        ...(i === 0 ? {
          caption: fullCaption,
          // multipart 端点按 code point 校验实体偏移（见 caption.js toMultipartEntities）
          ...(fullEntities.length ? { caption_entities: normalizeEntitiesForMultipart(fullCaption, fullEntities) } : {}),
        } : {}),
      }))));
      entries.forEach(({ bytes, extension }, i) => {
        form.set(`file${i}`, new Blob([bytes], { type: MIME_BY_EXTENSION[extension] || "application/octet-stream" }), `file${i}.${extension}`);
      });
      return form;
    });
    results.push(...sent);
  } else if (entries.length === 1) {
    const { bytes, extension, kind } = entries[0];
    const [method, field] = MEDIA_FIELDS[kind];
    if (onStatus) await onStatus("正在发送…");
    results.push(await telegramForm(env, method, () => {
      const f = mediaForm();
      f.set("caption", fullCaption);
      if (fullEntities.length) f.set("caption_entities", JSON.stringify(normalizeEntitiesForMultipart(fullCaption, fullEntities)));
      // 单张（entries 只剩 1，其余降级文档）支持 inline 按钮：补上来源按钮。
      const markup = buildOpenMarkup(cap.sourceUrl);
      if (markup) f.set("reply_markup", JSON.stringify(markup));
      f.set(field, new Blob([bytes], { type: MIME_BY_EXTENSION[extension] || "application/octet-stream" }), `${field}.${extension}`);
      return f;
    }));
  }
  for (const doc of docFalls) {
    if (onStatus) await onStatus("正在发送（超大原图以文件发送）…");
    results.push(await telegramForm(env, "sendDocument", () => {
      const f = mediaForm();
      f.set("caption", fullCaption);
      if (fullEntities.length) f.set("caption_entities", JSON.stringify(normalizeEntitiesForMultipart(fullCaption, fullEntities)));
      const markup = buildOpenMarkup(cap.sourceUrl);
      if (markup) f.set("reply_markup", JSON.stringify(markup));
      f.set("document", new Blob([doc.bytes], { type: "application/octet-stream" }), `original.${doc.extension}`);
      return f;
    }));
  }
  return results;
}

// 相册整组缓存：同一作品再次发送时直接用 file_id 组（零下载、零重传）。
async function rememberAlbumFileIds(id, title, results, env, cap) {
  if (!Array.isArray(results) || results.length === 0) return;
  const files = [];
  for (const result of results) {
    const detected = detectFile(result);
    if (detected?.file_id) files.push(detected);
  }
  // 相册只支持 photo/video；若混入了降级发送的 document（压缩失败），整组不缓存，
  // 避免用文档 file_id 按相册回放出错。
  if (files.length === results.length && files.every((f) => f.kind === "photo" || f.kind === "video")) {
    await cacheSet("fid", `d2:${id}`, { kind: "album", title, files, cap }, 30 * 24 * 3600);
  }
}

async function sendAlbumByFileIds(files, caption, message, env, cap = null) {
  const typeOf = { photo: "photo", video: "video", animation: "animation" };
  const rendered = renderArtworkCaption(cap, cap.status || {});
  const firstCaption = rendered.text.slice(0, 1024);
  const entities = cap ? [sourceLinkEntity(firstCaption, cap.sourceUrl)].filter(Boolean) : [];
  await telegram(env, "sendMediaGroup", {
    chat_id: message.chat.id,
    media: files.map((file, index) => ({
      type: typeOf[file.kind] || "photo",
      media: file.file_id,
      ...(index === 0 ? {
        caption: firstCaption,
        ...(entities.length ? { caption_entities: entities } : {}),
      } : {}),
    })),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
  });
}

// 用已缓存 file_id 直接重发（不再下载，Telegram 服务端去重）。
async function sendFileById(kind, fileId, caption, message, env, cap = null) {
  const fields = MEDIA_FIELDS[kind];
  if (!fields) throw new Error("不支持的媒体类型");
  const rendered = renderArtworkCaption(cap, cap.status || {});
  const text = rendered.text.slice(0, 1024);
  const entities = cap ? [sourceLinkEntity(text, cap.sourceUrl)].filter(Boolean) : [];
  const markup = buildOpenMarkup(cap.sourceUrl);
  await telegram(env, fields[0], {
    chat_id: message.chat.id,
    [fields[1]]: fileId,
    caption: text,
    ...(entities.length ? { caption_entities: entities } : {}),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(markup ? { reply_markup: markup } : {}),
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
  });
}

// 记住作品 → file_id 的映射，供后续复用（file_id 同 Bot 长期有效）。
// 记录实际送达类型（照片过大被 Telegram 转成文档时也是 document）。
async function rememberFileId(id, kindHint, title, sent, env, cap) {
  const detected = detectFile(sent) || { kind: kindHint, file_id: null };
  if (!detected.file_id) return;
  await cacheSet("fid", `d2:${id}`, { file_id: detected.file_id, kind: detected.kind, title, cap }, 30 * 24 * 3600);
}

// 从 sendXxx 返回的 Message 里探测实际送达类型与 file_id。
function detectFile(result) {
  if (!result) return null;
  if (result.document?.file_id) return { kind: "document", file_id: result.document.file_id };
  if (result.video?.file_id) return { kind: "video", file_id: result.video.file_id };
  if (result.animation?.file_id) return { kind: "animation", file_id: result.animation.file_id };
  const photos = result.photo;
  if (Array.isArray(photos) && photos.length) {
    return { kind: "photo", file_id: photos.at(-1)?.file_id || photos[0]?.file_id };
  }
  return null;
}

// 下载媒体并作为 multipart 上传给 Telegram（带 DA 所需 Referer/UA，规避 Telegram 拉不动）。
// 照片字节超过 Telegram 上限时提前改发文档（TelePost 同款阈值策略），失败也会兜底再发一次文档。
async function uploadMedia(env, kind, mediaUrl, caption, message, onStatus = null, fallbackUrl = null, cap = null) {
  let response = await guardedFetch(mediaUrl, {
    headers: { ...DA_HEADERS, Referer: DEVIANTART },
    signal: AbortSignal.timeout(180_000),
  }, "媒体下载");
  let usedFallback = false;
  if (!response.ok) {
    response.body?.cancel();
    if ((response.status === 403 || response.status === 429) && fallbackUrl && fallbackUrl !== mediaUrl) {
      const fallback = await guardedFetch(fallbackUrl, {
        headers: { ...DA_HEADERS, Referer: DEVIANTART },
        signal: AbortSignal.timeout(120_000),
      }, "展示图下载");
      if (!fallback.ok) {
        fallback.body?.cancel();
        throw quotaOrMediaError(response.status);
      }
      response = fallback;
      usedFallback = true;
    } else {
      throw quotaOrMediaError(response.status);
    }
  }
  // 流式读取以报告下载进度（Telegram Bot API 没有上传进度事件，进度只能反映“下载”阶段）
  const totalBytes = Number(response.headers.get("Content-Length")) || 0;
  const chunks = [];
  let received = 0;
  let lastPct = -1;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    if (onStatus && totalBytes > 0) {
      const pct = Math.floor((received / totalBytes) * 100);
      if (pct % 5 === 0 && pct > lastPct) {
        lastPct = pct;
        await onStatus(`正在下载 ${pct}%`);
      }
    }
  }
  let bytes = concatBytes(chunks);
  let extension = guessExtension(mediaUrl, kind);
  let sendAs = kind;
  // 收集状态后一次渲染。
  const capStatus = { ...(cap?.status || {}) };
  let captionText = caption;
  let captionEntities = [];
  // 照片超过阈值：优先压缩成可内嵌预览的照片发（Telegram 显示为图片）；压缩不可用才转文档
  if (kind === "photo" && bytes.length > PHOTO_MAX_BYTES) {
    if (onStatus) await onStatus("原图较大，正在压缩…");
    const compressed = await compressPhoto(bytes);
    if (compressed) {
      bytes = compressed;
      extension = "jpg";
      capStatus.compressed = true;
    } else {
      sendAs = "document";
      capStatus.docFallback = true;
    }
  }
  if (usedFallback) {
    extension = "jpg";
    const blurred = /blur_/.test(fallbackUrl || "");
    if (blurred) capStatus.blurredPreview = true;
    else capStatus.previewOnly = true;
  }
  cap.status = capStatus;
  captionText = renderArtworkCaption(cap, capStatus).text;
  captionEntities = [sourceLinkEntity(captionText, cap.sourceUrl)].filter(Boolean);
  const openMarkup = buildOpenMarkup(cap.sourceUrl);
  const makeForm = (field) => {
    const form = new FormData();
    form.set("chat_id", String(message.chat.id));
    form.set("caption", captionText);
    if (captionEntities.length) form.set("caption_entities", JSON.stringify(normalizeEntitiesForMultipart(captionText, captionEntities)));
    form.set("reply_parameters", JSON.stringify({ message_id: message.message_id, allow_sending_without_reply: true }));
    if (openMarkup) form.set("reply_markup", JSON.stringify(openMarkup));
    if (message.message_thread_id) form.set("message_thread_id", String(message.message_thread_id));
    form.set(field, new Blob([bytes], { type: MIME_BY_EXTENSION[extension] || "application/octet-stream" }), `${field}.${extension}`);
    return form;
  };
  if (onStatus) await onStatus("正在发送…");
  const [method, field] = MEDIA_FIELDS[sendAs];
  try {
    return await telegramForm(env, method, makeForm(field));
  } catch (error) {
    // 照片（含压缩后）仍被拒时再按文档试一次
    if (kind === "photo" && isTooBigError(error)) {
      if (cap) {
        cap.status = { ...cap.status, docFallback: true };
        captionText = renderArtworkCaption(cap, cap.status).text;
        captionEntities = [sourceLinkEntity(captionText, cap.sourceUrl)].filter(Boolean);
      }
      return telegramForm(env, MEDIA_FIELDS.document[0], () => makeForm("document"));
    }
    throw error;
  }
}

// 用 sharp 把超大图片压到 Telegram 照片上限内（JPEG，白底摊平透明、质量阶梯下降）。
async function compressPhoto(bytes) {
  try {
    const sharp = (await import("sharp")).default;
    const meta = await sharp(bytes, { failOn: "none" }).metadata();
    if (!meta.width || !meta.height) return null;
    for (const quality of [85, 75, 65, 55, 45]) {
      const out = await sharp(bytes, { failOn: "none" })
        .rotate()
        .flatten({ background: "#ffffff" })
        .jpeg({ quality, progressive: true })
        .toBuffer();
      if (out.length <= PHOTO_MAX_BYTES) return out;
    }
    return null;
  } catch {
    return null; // 压缩不可用（缺依赖/不支持格式）→ 走文档兜底
  }
}

// 计算 Telegram 限流后的退避秒数（参考 TelePost：等满 retry_after、指数退避、上限 60s）
function telegramBackoffSeconds(status, result, attempt) {
  const retryAfter = Number(result?.parameters?.retry_after);
  if (status === 429 && retryAfter > 0) return Math.min(retryAfter, 60);
  const description = String(result?.description || "");
  if (/flood|retry after|too many/i.test(description)) return Math.min(2 ** attempt, 60);
  return null;
}

async function telegramForm(env, method, formOrFactory) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let form;
    try {
      form = typeof formOrFactory === "function" ? formOrFactory() : formOrFactory;
    } catch (error) {
      throw error;
    }
    let response;
    try {
      response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (error) {
      if (attempt < 2) {
        console.error(`[tg] ${method} 网络错误，重试 ${attempt + 1}`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new Error("Telegram 连接失败或超时，请稍后再试");
    }
    const result = await response.json().catch(() => null);
    const retryAfter = Number(result?.parameters?.retry_after);
    if (response.status === 429 && retryAfter > 0) {
      await sleep(Math.min(retryAfter, 10) * 1000);
      continue;
    }
    if (!response.ok || !result?.ok) {
      const description = result?.description || `HTTP ${response.status}`;
      console.error(`[tg] ${method} 失败: ${description}`);
      throw new Error(description);
    }
    return result.result;
  }
  throw new Error("Telegram 上传失败，请稍后重试");
}



// wixmp 原图下载被拒：403/429 多为 DA 免费账号的原图下载限额已用尽（daviewer/dakit
// 同款语义：“Free download limit reached”）。
function quotaOrMediaError(status) {
  if (status === 403 || status === 429) {
    return new Error("原图下载被 DeviantArt 限制：免费账号每日原图下载有限额，今天可能已用尽（稍后或明日重试，订阅 Core 可提升额度）");
  }
  return new Error(`媒体下载失败（HTTP ${status}）`);
}

function isTooBigError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return /file (?:is|of size .* is) too big|image is too big|too large|PHOTO_INVALID_DIMENSIONS/i.test(text);
}

function concatBytes(chunks) {
  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

const MEDIA_FIELDS = {
  photo: ["sendPhoto", "photo"],
  video: ["sendVideo", "video"],
  animation: ["sendAnimation", "animation"],
  document: ["sendDocument", "document"],
};

const MIME_BY_EXTENSION = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  gif: "image/gif", mp4: "video/mp4", m4v: "video/mp4",
};

function guessExtension(mediaUrl, kind) {
  const leaf = new URL(mediaUrl).pathname.split("/").pop() || "";
  const ext = leaf.includes(".") ? leaf.split(".").pop().toLowerCase() : "";
  if (/^[a-z0-9]{2,5}$/.test(ext)) return ext;
  return { photo: "jpg", video: "mp4", animation: "gif" }[kind] || "bin";
}

async function telegram(env, method, body) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let response;
    try {
      response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      if (attempt < 3) {
        console.error(`[tg] ${method} 网络错误，重试 ${attempt + 1}`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new Error("Telegram 连接失败或超时，请稍后再试");
    }
    const result = await response.json().catch(() => null);
    const backoff = telegramBackoffSeconds(response.status, result, attempt);
    if (backoff !== null) {
      console.error(`[tg] ${method} 限流，${backoff}s 后重试 ${attempt + 1}`);
      await sleep(backoff * 1000);
      continue;
    }
    if (!response.ok || !result?.ok) {
      const description = result?.description || `Telegram 返回 HTTP ${response.status}`;
      console.error(`[tg] ${method} 失败: ${description}`);
      throw new Error(description);
    }
    return result.result;
  }
  throw new Error("Telegram 暂时限流，请稍后重试");
}

async function fetchDeviantArtJson(url, headers) {
  const response = await fetchDeviantArt(url, { headers });
  await throwForDeviantArtStatus(response);
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("DeviantArt 返回了无效数据");
  return data;
}

async function fetchDeviantArt(url, init) {
  let response;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if (attempt === 2) throw new Error("无法连接 DeviantArt，请稍后重试", { cause: error });
      await sleep(2 ** attempt * 1000);
      continue;
    }
    if (![429, 500, 503].includes(response.status) || attempt === 2) return response;
    const retryAfter = Number(response.headers.get("Retry-After"));
    response.body?.cancel();
    await sleep(Math.min(retryAfter > 0 ? retryAfter : 2 ** attempt, 5) * 1000);
  }
  return response;
}

async function throwForDeviantArtStatus(response) {
  if (response.ok) return;
  response.body?.cancel();
  if (response.status === 404) throw new NotFoundError("作品不存在、已删除或链接无效");
  if ([401, 403].includes(response.status)) throw new PermissionDeniedError();
  if (response.status === 429) throw new RateLimitError();
  if (response.status >= 500) throw new Error("DeviantArt 服务暂时不可用，请稍后重试");
  throw new Error(`DeviantArt 请求失败（HTTP ${response.status}）`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function extractDeviantArtUrls(text, entities = []) {
  const value = String(text);
  const candidates = [];
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (entity?.type === "text_link" && entity.url && Number.isInteger(entity.offset)) {
      candidates.push({ value: entity.url, offset: entity.offset });
    }
    if (entity?.type === "url" && Number.isInteger(entity.offset) && Number.isInteger(entity.length)) {
      // Telegram 的 offset/length 是 UTF-16 code units，正好与 JS slice 一致。
      candidates.push({ value: value.slice(entity.offset, entity.offset + entity.length), offset: entity.offset });
    }
  }
  for (const match of value.matchAll(/(?:(?:https?:\/\/)?(?:[\w-]+\.)*deviantart\.com\/[^\s<>"'，。！？；：（）【】]+|(?:https?:\/\/)?fav\.me\/[0-9a-z]+)/gi)) {
    candidates.push({ value: match[0], offset: match.index });
  }

  const links = new Set();
  for (const candidate of candidates.sort((left, right) => left.offset - right.offset)) {
    const url = normalizeDeviantArtUrl(candidate.value);
    if (url) links.add(url);
  }
  return [...links];
}

function normalizeDeviantArtUrl(value) {
  const cleaned = String(value).trim().replace(/[)\],.!?;:。）】，！？；：]+$/, "");
  try {
    const url = new URL(/^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`);
    if (!isHost(url.hostname, "deviantart.com") && url.hostname !== "fav.me") return null;
    url.protocol = "https:";
    url.hash = "";
    return isSafePublicUrl(url) ? url.href : null;
  } catch {
    return null;
  }
}

export function parseDeviantArtTarget(url) {
  if (url.hostname === "fav.me") {
    const code = url.pathname.split("/").filter(Boolean)[0]?.replace(/^d/i, "");
    if (!code || !/^[0-9a-z]+$/i.test(code)) throw new Error("无效的 fav.me 链接");
    return { id: base36ToBigInt(code).toString(10) };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "view" && parts[1]) return { id: parts[1] };
  if (parts[0] === "view.php" && url.searchParams.get("id")) {
    return { id: url.searchParams.get("id") };
  }
  const id = parts.at(-1)?.match(/(?:^|-)(\d+)$/)?.[1];
  if (!id) throw new Error("无法从 DeviantArt 链接识别作品 ID");
  const subdomain = url.hostname.endsWith(".deviantart.com") && !["www", "m"].includes(url.hostname.split(".")[0])
    ? url.hostname.split(".")[0]
    : null;
  return { id, username: subdomain || parts[0] };
}

function base36ToBigInt(value) {
  let result = 0n;
  for (const character of value.toLowerCase()) {
    result = result * 36n + BigInt(parseInt(character, 36));
  }
  return result;
}

export function extractDeviantArtMedia(deviation, allowMature = false) {
  if (!deviation || typeof deviation !== "object") {
    throw new Error("DeviantArt 没有返回作品数据");
  }
  // 成熟内容对匿名访问只提供重度打码的 fullview（fetch 会 400/打码），无法拿原图：
  // 直接给用户可理解的说明，而不是一个谜之 400。带登录 Cookie（DA_COOKIES）时才放行。
  if ((deviation.isMature === true || deviation.is_mature === true) && !allowMature) {
    throw new Error("该作品是需登录查看的成熟内容，匿名无法获取原图（只能看到打码预览）");
  }
  const media = deviation.media || {};
  const types = Array.isArray(media.types) ? media.types : [];
  const videos = types
    .filter((item) => item?.t === "video" && item.b)
    .sort((a, b) => videoRank(b.q) - videoRank(a.q));
  let url = videos[0]?.b;
  let kind = url ? "video" : null;

  // baseUri 本身就是原始文件（现代接口形态，以扩展名结尾，如 .png/.jpg/.gif）：
  // 直接 baseUri + token 下载原图。别去拼 /v1/fit 变体——那些 URL 带 token 也会 400/404。
  if (!url && extensionKind(media.baseUri || "")) {
    url = appendToken(media.baseUri, media.token);
  }
  if (!url) {
    const full = types.find((item) => item?.t === "fullview");
    if (full?.b) url = appendToken(full.b, media.token);
    else if (full?.c) url = buildMediaUrl(media, full.c);
  }
  // fullview 不可用（登录后原图即 baseUri 文件、或该作品没给模板）时用 preview 兜底
  if (!url) {
    const preview = types.find((item) => item?.t === "preview" && (item.c || item.b));
    if (preview?.b) url = appendToken(preview.b, media.token);
    else if (preview?.c) url = buildMediaUrl(media, preview.c);
  }
  if (url && !kind) kind = extensionKind(url); // gif→animation、jpg→photo 等
  if (!url) throw new Error("DeviantArt 作品没有可用媒体");
  return {
    url,
    kind: kind || "photo",
    title: `${deviation.title || "DeviantArt"}${deviation.author?.username ? ` — ${deviation.author.username}` : ""}`,
  };
}

function buildMediaUrl(media, template) {
  if (!media.baseUri) return null;
  const url = template
    ? `${media.baseUri}${String(template).replace("<prettyName>", media.prettyName || "image")}`
    : media.baseUri;
  return appendToken(url, media.token);
}

function appendToken(url, rawToken) {
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  return token ? `${url}${url.includes("?") ? "&" : "?"}token=${token}` : url;
}

function videoRank(value) {
  return { "1080p": 4, "720p": 3, "480p": 2, "360p": 1 }[value] || 0;
}

function extensionKind(value = "") {
  let pathname;
  try {
    pathname = new URL(value).pathname.toLowerCase();
  } catch {
    pathname = String(value).split("?", 1)[0].toLowerCase();
  }
  if (pathname.endsWith(".gif")) return "animation";
  if (pathname.endsWith(".mp4")) return "video";
  if (/\.(?:jpe?g|png|webp|avif)$/.test(pathname)) return "photo";
  return null;
}

// 运维诊断：从当前出口实测关键上游的可达性（不再需要猜测卡在哪一跳）。
async function probeNetwork(env) {
  const jobs = [
    ["da-api", "https://www.deviantart.com/api/v1/oauth2/placebo", "GET"],
    ["archive-snapshot", "https://web.archive.org/web/2/https://www.deviantart.com/loish/art/underwater-913624585", "GET"],
    ["wixmp", "https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/", "HEAD"],
  ];
  const probes = [];
  for (const [name, target, method] of jobs) {
    const start = Date.now();
    try {
      const response = await guardedFetch(target, {
        method,
        headers: DA_HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      }, name);
      response.body?.cancel();
      probes.push({ name, http: response.status, ms: Date.now() - start });
    } catch (error) {
      probes.push({ name, error: error instanceof Error ? error.message : String(error), ms: Date.now() - start });
    }
  }
  if (env.CLIENT_ID && env.CLIENT_SECRET) {
    try {
      const token = await getOfficialToken(env);
      probes.push({ name: "oauth-token", token: token ? "ok" : "missing", ms: 0 });
    } catch (error) {
      probes.push({ name: "oauth-token", error: error instanceof Error ? error.message : String(error) });
    }
    try {
      const uuid = await archiveUuidFromPage("https://www.deviantart.com/loish/art/underwater-913624585", "913624585");
      probes.push({ name: "uuid-map", uuid: uuid || null });
      if (uuid) {
        const token = await getOfficialToken(env);
        const endpointProbes = [
          ["deviation-upper", `deviation/${uuid}`],
          ["metadata", `deviation/metadata?deviationids%5B%5D=${uuid}`],
          ["download", `deviation/download/${uuid}`],
          ["gallery", `gallery/all?username=loish&limit=1`],
        ];
        for (const [label, path] of endpointProbes) {
          try {
            const response = await guardedFetch(new URL(path, DA_API_BASE), {
              headers: { Authorization: `Bearer ${token}`, ...DA_HEADERS, "dA-minor-version": DA_MINOR_VERSION },
              signal: AbortSignal.timeout(20_000),
            }, "DeviantArt 官方 API");
            const body = (await response.text()).slice(0, 90);
            probes.push({ name: label, http: response.status, body });
          } catch (error) {
            probes.push({ name: label, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    } catch (error) {
      probes.push({ name: "deviation-fetch", error: error instanceof Error ? error.message : String(error) });
    }
  }
  return Response.json({ ok: true, probes });
}

async function createProxyUrl(origin, upstream, secret) {
  let url;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error("DeviantArt 返回了无效媒体地址");
  }
  if (!isSafePublicUrl(url) || !isMediaHost(url.hostname)) {
    throw new Error("媒体地址不在受信任的 DeviantArt CDN 上");
  }
  // 长轮询模式没有公网地址：直接把（带 token 的）媒体 URL 交给 Telegram 下载。
  if (!origin) return url.href;
  const expires = Math.floor(Date.now() / 1000) + 15 * 60;
  const payload = `${expires}\n${url.href}`;
  const proxy = new URL("/media", origin);
  proxy.searchParams.set("url", url.href);
  proxy.searchParams.set("expires", String(expires));
  proxy.searchParams.set("sig", await hmac(payload, secret));
  return proxy.href;
}

async function proxyMedia(request, env) {
  const requestUrl = new URL(request.url);
  const upstream = requestUrl.searchParams.get("url");
  const expires = Number(requestUrl.searchParams.get("expires"));
  const signature = requestUrl.searchParams.get("sig") || "";
  const now = Math.floor(Date.now() / 1000);
  if (!upstream || !Number.isInteger(expires)) return new Response("Bad request", { status: 400 });
  if (expires < now || expires > now + 16 * 60) return new Response("Expired", { status: 403 });

  let url;
  try {
    url = new URL(upstream);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (!isSafePublicUrl(url) || !isMediaHost(url.hostname)) {
    return new Response("Forbidden", { status: 403 });
  }
  if (!await verifyHmac(`${expires}\n${url.href}`, signature, env.WEBHOOK_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }

  const range = request.headers.get("Range");
  const response = await fetchPublicMedia(url, {
    method: request.method,
    headers: { Referer: DEVIANTART, ...DA_HEADERS, ...(range ? { Range: range } : {}) },
    redirect: "follow",
  });
  if (!response.ok) {
    response.body?.cancel();
    // 透传上游状态码（403/404/429…），便于诊断与让 Telegram 侧区分失败原因；
    // 5xx 统一折叠成 502，避免把网关故障误报成内容问题。
    const status = response.status >= 500 ? 502 : response.status;
    return new Response("Upstream error", { status });
  }
  const finalUrl = new URL(response.url || url);
  if (!isSafePublicUrl(finalUrl) || !isMediaHost(finalUrl.hostname)) {
    response.body?.cancel();
    return new Response("Forbidden", { status: 403 });
  }
  const type = response.headers.get("Content-Type") || "application/octet-stream";
  if (!/^(?:image|video)\//i.test(type) && type !== "application/octet-stream") {
    response.body?.cancel();
    return new Response("Unsupported media", { status: 415 });
  }
  const headers = new Headers({ "Content-Type": type, "Cache-Control": "private, max-age=300" });
  for (const name of ["Content-Length", "Content-Disposition", "Accept-Ranges", "Content-Range"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return toBase64Url(bytes);
}

async function verifyHmac(value, signature, secret) {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    return crypto.subtle.verify("HMAC", key, fromBase64Url(signature), encoder.encode(value));
  } catch {
    return false;
  }
}

function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function getCookies(headers) {
  const values = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : [headers.get("Set-Cookie")].filter(Boolean);
  return values.map((value) => value.split(";", 1)[0]).join("; ");
}

function isSafePublicUrl(url) {
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && !url.username && !url.password &&
    host !== "localhost" && !host.endsWith(".local") && !host.endsWith(".internal") &&
    !/^\d+(?:\.\d+){3}$/.test(host) && !host.includes(":");
}

function isMediaHost(host) {
  return ["wixmp.com", "deviantart.net", "deviantart.com", "wixstatic.com"]
    .some((domain) => isHost(host, domain));
}

function isHost(host, domain) {
  const value = host.toLowerCase();
  return value === domain || value.endsWith(`.${domain}`);
}

// 供 main.js 装配 AuthNotifier / OAuth 登录流程使用。
export { telegram as sendTelegram };
export { clearOAuthAccessToken } from "./auth/token.js";
export { shouldSkipMatureExtras };
