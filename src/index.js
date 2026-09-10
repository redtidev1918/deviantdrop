const DEVIANTART = "https://www.deviantart.com/";
import { sourceLineText } from "./rendering/caption.js";
import { publishArtwork } from "./publishing/gallery.js";
import { fetchPublicMedia } from "./preview/server.js";
import { getOfficialToken, clearOAuthAccessToken } from "./auth/token.js";
import { NetworkError, failureText } from "./auth/errors.js";
import { DeviantArtAdapter, parseDeviantArtTarget, parseDeviantArtTarget as parseAdapterTarget } from "./deviantart/adapter.js";
import { normalizeArtwork, titleWithAuthor } from "./deviantart/media-normalizer.js";
import { probeWebSession } from "./deviantart/web-session.js";
import { WEB_SESSION_STATUS } from "./auth/cookie-store.js";
import { sendArtworkPlan, sendFileIdPlan, sendSourceLine as sendPlanSourceLine, filesFromResults } from "./telegram/sender.js";
import { telegram } from "./telegram/api.js";
import { DA_HEADERS } from "./deviantart/http.js";
const MAX_LINKS = 5;
const encoder = new TextEncoder();
const daAdapters = new WeakMap();
function daAdapter(env) {
  let adapter = daAdapters.get(env);
  if (!adapter) {
    adapter = new DeviantArtAdapter({ cacheGet, cacheSet });
    daAdapters.set(env, adapter);
  }
  return adapter;
}

const REPO = "https://github.com/redtidev1918/deviantdrop";
const HELP_TEXT = `发送 DeviantArt 单作品链接或 fav.me 短链，我会回复其中的图片、视频或 GIF。单条消息最多处理 ${MAX_LINKS} 个链接；图片/视频的 caption 里带链接也可以。\n\n/start 开始 · /help 用法 · /about 项目与源码`;
const ABOUT_TEXT = `DeviantDrop：把 DeviantArt 作品「丢」进 Telegram 的 Bot。\n\n发送 DeviantArt 作品页或 fav.me 短链，即可收到图片、视频或 GIF；每条回复的媒体都会附带原作品页链接。\n\n开源项目（MIT）：${REPO}\n源码、部署与使用说明都在仓库里，欢迎 star、提 issue。`;
const HINT_TEXT = `没有找到可下载的 DeviantArt 链接。\n\n发送 DeviantArt 作品页或 fav.me 短链，即可收到图片、视频或 GIF。\n/help 查看用法，/about 查看项目与源码。`;

// 生产加固参数（README「限流与可靠性」有说明）。
const UPDATE_DEDUPE_SECONDS = 90; // 同一 Telegram update 去重窗口（防超时重试重复发送）
const GROUP_DEDUPE_SECONDS = 60; // 同一相册只处理第一条带链接的消息
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_LINKS = 15; // 每个聊天每分钟最多处理的链接数
const RATE_TEXT = `操作太快了：这个聊天每分钟最多处理 ${RATE_MAX_LINKS} 个作品链接，请稍后再试。`;

// —— 官方 OAuth API（DA 的 WAF 按出口 IP 封锁网页接口，官方 API 面放行；部署必须走这条）——

// —— 结构化调试日志：docker logs 里 grep [media]/[send]/[oauth] 定位打码/回退根因 ——
function dlog(tag, ...args) {
  console.error(new Date().toISOString(), `[${tag}]`, ...args);
}
function shortUrl(value) {
  const s = String(value || "");
  try { const u = new URL(s); return `${u.host}${u.pathname}`.slice(0, 90); } catch { return s.slice(0, 90); }
}
// 相册（多图）的来源入口：补发一条 JSON 文本，来源用 text_link（JSON 路径 UTF-16 可靠，
// 绕开 multipart caption_entities 的 offset bug）。单图用 inline 按钮、不走这里。
async function sendSourceLine(message, env, sourceUrl) {
  if (!sourceUrl) return;
  const { text, entities } = sourceLineText(sourceUrl);
  if (!text) return;
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text,
    entities,
    // text_link 在部分客户端会展开成链接预览，占地方；来源只是个入口，显式关闭预览。
    link_preview_options: { is_disabled: true },
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.message_thread_id ? { message_thread_id: message.message_thread_id } : {}),
  });
}

async function sendPublishedLink(message, env, id, sourceUrl, publishedUrl) {
  if (!publishedUrl) return;
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: "在 Telegraph 查看全部",
    entities: [{ type: "text_link", offset: 0, length: "在 Telegraph 查看全部".length, url: publishedUrl }],
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    ...(message.message_thread_id ? {message_thread_id:message.message_thread_id} : {}),
    ...(env.PUBLIC_BASE_URL ? {link_preview_options:{url:`${env.PUBLIC_BASE_URL}/d/${id}`,prefer_large_media:true,show_above_text:false}} : {}),
  });
}
// PREFER_ORIGINAL=1 才优先抓原图（默认关闭：免费账号原图有日配额，常 403/429）。
function preferOriginal(env) {
  return /^(1|true|yes)$/i.test(String(env?.PREFER_ORIGINAL || ""));
}
// 技术性 ⚠️ 提示（压缩/打码/原图不可用/转文件）是否显示在 caption 里。
// 默认 auto：私聊（自己/运营排查）显示，群聊/频道（看图的人）隐藏——对他们是噪音，
// 且已有「在 DeviantArt 打开」入口可去看原图。CAPTION_NOTES=always/never 强制覆盖。
function captionNotesEnabled(env, message) {
  const mode = String(env?.CAPTION_NOTES || "auto").trim().toLowerCase();
  if (mode === "always" || /^(1|true|yes)$/.test(mode)) return true;
  if (mode === "never" || /^(0|false|no|off)$/.test(mode)) return false;
  return message?.chat?.type === "private";
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
    // 无 caption 的图片、贴纸等消息不打扰；私聊文本才回用法提示。
    // 群聊里的闲聊和其他 Bot 命令保持安静。
    if (!text.trim()) return;
    if (message.chat.type === "private") {
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
    if (env.PUBLIC_BASE_URL && authFlow?.configured?.()) {
      const oauthToken = authFlow.issueLoginToken();
      const oauthUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/deviantart/start?t=${encodeURIComponent(oauthToken)}`;
      const hasOauth = env.credentialStore?.getState().hasToken || env.DA_REFRESH_TOKEN;
      const keyboard = [[{ text: hasOauth ? "重新授权 OAuth" : "登录 DeviantArt", url: oauthUrl }]];
      if (hasOauth) {
        const cookieToken = authFlow.issueLoginToken("cookies");
        const cookieUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/auth/deviantart/cookies?t=${encodeURIComponent(cookieToken)}`;
        keyboard.push([{ text: "粘贴更新 Cookie", url: cookieUrl }]);
      }
      await send(
        hasOauth
          ? "OAuth 仍有效。成熟多图需要 DeviantArt 网页会话；可点「粘贴更新 Cookie」，或用电脑一键登录自动更新。"
          : "点击「登录 DeviantArt」完成 OAuth 授权。成熟多图还需要网页会话；无公网浏览器登录时用电脑一键登录同时更新两者。",
        { reply_markup: { inline_keyboard: keyboard } },
      );
      return;
    }
    await send(
      "DeviantArt 一键登录（同时登录账号 + 网页，多图作品全部未打码）：\n\n" +
      "1. 在你的电脑上打开终端，进入 DeviantDrop 目录；\n" +
      "2. 运行：`VPS=root@<你的服务器> node scripts/dd-login.mjs`；\n" +
      "3. 会自动打开 Chrome，在 DeviantArt 官方页登录并点「Authorize/允许」；\n" +
      "4. 脚本自动把登录状态推送到服务器并立即生效，无需重启、无需手动复制 Cookie。\n\n" +
      "需要电脑装有 Chrome；服务器地址按实际填写。完成后发 /status 应显示 OAuth: valid、Web session: valid。",
    );
    return;
  }

  if (command === "status") {
    const store = env.credentialStore;
    const authState = store ? store.getState() : null;
    const oauthText = authState
      ? (authState.state === "valid" && authState.hasToken ? "valid" : authState.state === "invalid" ? "invalid（需 /login）" : "missing")
      : (env.DA_REFRESH_TOKEN ? "unknown" : "missing");
    let webText = (env.cookieStore?.available() || env.DA_COOKIES) ? "checking…" : "missing";
    let apiText = "checking…";
    const teleText = env.telepress ? env.telepress.mode : "disabled";
    const renderLines = () => [
      "DeviantDrop Status", "", "Telegram: OK", `DeviantArt API: ${apiText}`,
      `OAuth: ${oauthText}`, `Web session: ${webText}`, `TelePress: ${teleText}`,
      `Cache: ${cacheApi() ? "OK" : "未配置"}`,
      ...(webText.startsWith("expired") ? ["", "成熟多图需要重新网页登录：/login"] : []),
    ].join("\n");
    const statusMessage = await send(renderLines());
    let webStatus = WEB_SESSION_STATUS.UNKNOWN;
    try {
      webStatus = webText === "checking…" ? await probeWebSession(env, { force: true, cacheGet, cacheSet }) : WEB_SESSION_STATUS.MISSING;
    } catch { webStatus = WEB_SESSION_STATUS.UNKNOWN; }
    webText = {
      [WEB_SESSION_STATUS.VALID]: "valid",
      [WEB_SESSION_STATUS.EXPIRED]: "expired",
      [WEB_SESSION_STATUS.MISSING]: "missing",
      [WEB_SESSION_STATUS.UNKNOWN]: "unknown（DA 当前无法验证）",
    }[webStatus] || "unknown";
    apiText = webStatus === WEB_SESSION_STATUS.UNKNOWN ? "unknown" : "OK";
    if (statusMessage?.message_id) {
      await telegram(env, "editMessageText", { chat_id: message.chat.id, message_id: statusMessage.message_id, text: renderLines() }).catch(() => {});
    }
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

// 解析并发送单个作品。双通道级联：
//   1) 网页 _puppy 接口（出口可达时能力最全：新作品/视频/GIF/无需凭据，session 已缓存复用）；
//   2) 网页不可达时，若配置了官方 API 凭据则走「官方 API + archive.org 存档映射」兜底。
async function sendDeviantArt(url, message, env, origin, sessionMemo = {}, onStatus = null) {
  const target = parseAdapterTarget(url);
  const cached = await cacheGet("fid", `d3:${target.id}`);
  if (Array.isArray(cached?.files) && cached.files.length && cached.files.every((file) => file?.file_id)) {
    dlog("delivery", `replay file ids id=${target.id} files=${cached.files.length}`);
    await sendFileIdPlan(cached.files, message, env, { ...cached.cap, sourceUrl: url.href, status: cached.cap?.status || {} });
    if (cached.files.length > 1) await sendPlanSourceLine(message, env, url.href);
    return;
  }

  let artwork;
  try {
    artwork = await daAdapter(env).getArtwork(url.href, env, sessionMemo);
  } catch (error) {
    const canFallback = env.CLIENT_ID && env.CLIENT_SECRET
      && (error instanceof NetworkError || /连接失败|超时|无法连接/.test(error.message));
    if (!canFallback) throw error;
    artwork = await daAdapter(env).getOfficialArtwork(url.href, env);
  }

  const mediaCount = artwork.media.length + artwork.skippedMedia;
  const cap = {
    title: artwork.title,
    author: artwork.author,
    sourceUrl: url.href,
    mediaCount: mediaCount > 1 ? mediaCount : undefined,
    status: {},
    text: null,
  };
  if (artwork.skippedMedia > 0 || (artwork.mature && artwork.media.some((item) => !item.originalAvailable))) cap.status.blurredPreview = true;
  try { await env.preview?.remember({ id: target.id, ...cap }); } catch { /* preview must not block delivery */ }

  const items = await Promise.all(artwork.media.map(async (item) => ({
    kind: item.kind,
    url: await createProxyUrl(origin, item.url, env.WEBHOOK_SECRET),
    fallbackUrl: item.fallbackUrl ? await createProxyUrl(origin, item.fallbackUrl, env.WEBHOOK_SECRET) : null,
  })));

  let results;
  try {
    results = await sendArtworkPlan(items, message, env, { upload: !origin, onStatus, cap });
    if (items.length > 1) await sendPlanSourceLine(message, env, url.href);
  } catch (error) {
    const publisherMedia = toPublisherMedia(artwork);
    const published = await publishArtwork(env, target.id, publisherMedia, url.href, true);
    if (!published) throw error;
    await sendPublishedLink(message, env, target.id, url.href, published);
    return;
  }

  const files = filesFromResults(results);
  if (files.length) await cacheSet("fid", `d3:${target.id}`, { kind: files.length === 1 ? files[0].kind : "album", title: artwork.titleLabel, files, cap }, 30 * 24 * 3600);
  const published = await publishArtwork(env, target.id, toPublisherMedia(artwork), url.href);
  if (published) await sendPublishedLink(message, env, target.id, url.href, published).catch(() => {});
}

function toPublisherMedia(artwork) {
  return {
    title: artwork.titleLabel,
    kind: artwork.media[0]?.kind || "photo",
    url: artwork.media[0]?.url,
    extras: artwork.media.slice(1).map((item) => ({ kind: item.kind, url: item.url })),
  };
}

export function extractDeviantArtMedia(deviation, allowMature = false) {
  if ((deviation?.isMature === true || deviation?.is_mature === true) && !allowMature) {
    throw new Error("该作品是需登录查看的成熟内容，匿名无法获取原图（只能看到打码预览）");
  }
  const artwork = normalizeArtwork(deviation, { webStatus: allowMature ? "valid" : "missing" });
  return { url: artwork.media[0].url, kind: artwork.media[0].kind, title: titleWithAuthor(artwork) };
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

// 运维诊断：从当前出口实测关键上游的可达性（不再需要猜测卡在哪一跳）。
async function probeNetwork(env) {
  const jobs = [
    ["da-web", "https://www.deviantart.com/", "GET"],
    ["wixmp", "https://images-wixmp-ed30a86b8c4ca887773594c2.wixmp.com/", "HEAD"],
  ];
  const probes = [];
  for (const [name, target, method] of jobs) {
    const start = Date.now();
    try {
      const response = await fetch(target, { method, headers: DA_HEADERS, redirect: "follow", signal: AbortSignal.timeout(10_000) });
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
export { parseDeviantArtTarget };
export { shouldSkipMatureExtras, isMatureLoggedOut } from "./deviantart/media-normalizer.js";
