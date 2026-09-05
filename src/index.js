const TELEGRAM_API = "https://api.telegram.org";
const DEVIANTART = "https://www.deviantart.com/";
// 浏览器 UA：DeviantArt 的 WAF 会拦明显的爬虫 UA（尤其是数据中心出口 IP）。
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_LINKS = 5;
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
const SESSION_TTL_SECONDS = 600; // DA 匿名 session 跨消息复用时长
const UPDATE_DEDUPE_SECONDS = 90; // 同一 Telegram update 去重窗口（防超时重试重复发送）
const GROUP_DEDUPE_SECONDS = 60; // 同一相册只处理第一条带链接的消息
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_LINKS = 15; // 每个聊天每分钟最多处理的链接数
const RATE_TEXT = `操作太快了：这个聊天每分钟最多处理 ${RATE_MAX_LINKS} 个作品链接，请稍后再试。`;

// —— 官方 OAuth API（DA 的 WAF 按出口 IP 封锁网页接口，官方 API 面放行；部署必须走这条）——
const DA_TOKEN_URL = "https://www.deviantart.com/oauth2/token";
const DA_API_BASE = "https://www.deviantart.com/api/v1/oauth2/";
const DA_MINOR_VERSION = "20240701";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ ok: true, service: "deviantdrop" });
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
// origin 为 null 时（长轮询、无公网反代）媒体直接使用原始 URL 交给 Telegram 下载。
export async function handleUpdate(update, env, origin = null) {
  const message = update?.message;
  if (!message?.chat?.id) return;

  // Telegram 在超时/断连后会重试同一个 update：若已处理完成过，直接跳过，
  // 避免把同一批作品重复发送。登记发生在处理完成之后，因此中途被掐断的
  // 重试仍会重新处理——宁可部分重复，也不丢消息。
  if (Number.isInteger(update.update_id) && await cacheGet("upd", `u:${update.update_id}`)) return;

  try {
    await handleMessage(message, env, origin);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    try {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `处理失败：${publicError(error)}`,
        reply_parameters: { message_id: message.message_id },
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
      reply_parameters: { message_id: message.message_id },
    });
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
      reply_parameters: { message_id: message.message_id },
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
        reply_parameters: { message_id: message.message_id },
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
  let statusId = null;
  if (total > 0) {
    try {
      const sent = await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `⏳ 正在获取第 1/${total} 个作品的媒体…`,
        reply_parameters: { message_id: message.message_id },
      });
      statusId = sent?.message_id ?? null;
    } catch {
      statusId = null;
    }
  }
  const updateStatus = async (nextIndex) => {
    if (!statusId) return;
    try {
      if (nextIndex >= total) {
        await telegram(env, "deleteMessage", { chat_id: message.chat.id, message_id: statusId });
        statusId = null; // 已删除，finally 不再重复删
      } else {
        await telegram(env, "editMessageText", {
          chat_id: message.chat.id,
          message_id: statusId,
          text: `⏳ 正在获取第 ${nextIndex + 1}/${total} 个作品的媒体…`,
        });
      }
    } catch {
      // 状态消息可能已被删除或过期，忽略
    }
  };
  try {
    // 一条消息内的多个链接共享同一个网页 session（备忘录；跨消息仍有 Cache 层复用）。
    const sessionMemo = {};
    for (let index = 0; index < pending.length; index += 1) {
      try {
        await sendDeviantArt(new URL(pending[index]), message, env, origin, sessionMemo);
      } catch (error) {
        await telegram(env, "sendMessage", {
          chat_id: message.chat.id,
          text: `${pending.length > 1 ? `第 ${index + 1} 个链接` : ""}处理失败：${publicError(error)}`,
          reply_parameters: { message_id: message.message_id },
        });
      }
      await updateStatus(index + 1);
    }
    if (budget < selected.length) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: RATE_TEXT,
        reply_parameters: { message_id: message.message_id },
      });
    }
    if (links.length > selected.length) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `单条消息最多处理 ${MAX_LINKS} 个链接，其余 ${links.length - selected.length} 个未处理。`,
        reply_parameters: { message_id: message.message_id },
      });
    }
  } finally {
    await updateStatus(total); // 完成：删除状态提示
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
// 注入登录会话（用于成熟内容），并单独缓存避免与匿名 csrf 串用。
async function getDeviantArtSession(env) {
  const key = env.DA_COOKIES ? "session:auth" : "session";
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
  if (env.DA_COOKIES) headers.Cookie = env.DA_COOKIES;
  const home = await fetchDeviantArt(DEVIANTART, { headers });
  await throwForDeviantArtStatus(home);
  const html = await home.text();
  const csrf = html.match(/window\.__CSRF_TOKEN__ = '([^']+)'/)?.[1];
  if (!csrf) throw new Error("DeviantArt 页面结构可能已变化，无法读取 CSRF token");
  return { csrf, cookies: env.DA_COOKIES || getCookies(home.headers) };
}

// 解析并发送单个作品。双通道级联：
//   1) 网页 _puppy 接口（出口可达时能力最全：新作品/视频/GIF/无需凭据，session 已缓存复用）；
//   2) 网页不可达时，若配置了官方 API 凭据则走「官方 API + archive.org 存档映射」兜底。
async function sendDeviantArt(url, message, env, origin, sessionMemo = {}) {
  const target = parseDeviantArtTarget(url);
  // 媒体级去重：同一作品首次发过后缓存 Telegram file_id，再发直接用 file_id（零下载）。
  const cached = await cacheGet("fid", `d:${target.id}`);
  if (cached?.file_id) {
    await sendFileById(cached.kind, cached.file_id, `${cached.title}\n${url.href}`, message, env);
    return;
  }
  try {
    const media = await resolveWebMedia(url, env, origin, sessionMemo);
    const sent = await sendOne(media.kind, media.url, `${media.title}\n${url.href}`, message, env, !origin);
    await rememberFileId(target.id, media.kind, media.title, sent, env);
    return;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // 只有“网络/超时”类失败才值得换官方通道重试；403/404/内容类错误如实抛出，
    // 否则会把“需要登录/未收录”误报成存档缺失。
    if (!env.CLIENT_ID || !env.CLIENT_SECRET || !/连接失败|超时|无法连接/.test(text)) throw error;
    console.error("网页解析失败(网络)，转官方 API:", text);
  }
  const official = await resolveOfficialMedia(url, env, origin);
  const sent = await sendOne(official.kind, official.url, `${official.title}\n${url.href}`, message, env, !origin);
  await rememberFileId(target.id, official.kind, official.title, sent, env);
}

async function resolveWebMedia(url, env, origin, sessionMemo) {
  if (!sessionMemo.session) sessionMemo.session = await getDeviantArtSession(env);
  const session = sessionMemo.session;
  const target = parseDeviantArtTarget(url);
  const endpoint = new URL("/_puppy/dadeviation/init", DEVIANTART);
  endpoint.searchParams.set("deviationid", target.id);
  if (target.username) endpoint.searchParams.set("username", target.username);
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
  const allowMature = Boolean(env.DA_COOKIES);
  const item = extractDeviantArtMedia(deviation, allowMature);
  return {
    kind: item.kind,
    url: await createProxyUrl(origin, item.url, env.WEBHOOK_SECRET),
    title: item.title,
  };
}


// —— 官方 OAuth API 解析路径（数字 id → archive.org 快照里的 UUID → deviation 取媒体）——

async function resolveOfficialMedia(url, env, origin) {
  const target = parseDeviantArtTarget(url);
  const uuid = await resolveDeviationUuid(target, url, env);
  const deviation = await officialApiGet(env, `deviation/${uuid}`);
  const mediaUrl = await pickOfficialMediaUrl(env, deviation, uuid);
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
    throw new Error(`${label}连接失败或超时，请稍后再试`);
  }
}

async function officialApiGet(env, path) {
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
    await cacheSet("api", "token", null, 1);
    throw new Error("DeviantArt 会话已过期，请再试一次");
  }
  if (response.status === 404) throw new Error("作品不存在、已删除或链接无效");
  if (response.status === 403) throw new Error("作品需要登录、无权访问，或 DeviantArt 拒绝了请求");
  if (response.status === 429) throw new Error("DeviantArt 暂时限流，请稍后重试");
  if (!response.ok) throw new Error(`DeviantArt 请求失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("DeviantArt 返回了无效数据");
  return data;
}

async function getOfficialToken(env) {
  const cached = await cacheGet("api", "token");
  if (cached?.token) return cached.token;
  const endpoint = new URL(DA_TOKEN_URL);
  endpoint.search = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.CLIENT_ID,
    client_secret: env.CLIENT_SECRET,
  });
  const response = await guardedFetch(endpoint, { method: "POST", headers: DA_HEADERS, signal: AbortSignal.timeout(15_000) }, "DeviantArt 官方 API");
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.access_token) {
    throw new Error("DeviantArt 官方 API 凭据无效或已被拒绝，请检查 CLIENT_ID/CLIENT_SECRET");
  }
  const ttl = Math.max(120, Number(data.expires_in ?? 3600) - 60);
  await cacheSet("api", "token", { token: data.access_token }, ttl);
  return data.access_token;
}

// 媒体选择：优先官方原图下载端点（含 mp4/gif 原文件），失败回落到 content/preview 地址。
async function pickOfficialMediaUrl(env, deviation, uuid) {
  const downloadable = deviation?.is_downloadable === true;
  if (downloadable) {
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

async function sendOne(kind, mediaUrl, caption, message, env, upload = false) {
  const fields = {
    photo: ["sendPhoto", "photo"],
    video: ["sendVideo", "video"],
    animation: ["sendAnimation", "animation"],
  }[kind];
  if (!fields) throw new Error("不支持的媒体类型");
  const text = String(caption).slice(0, 1024);
  if (upload) {
    // 轮询模式：Telegram 服务器拉不动 wixmp（需 Referer/UA），由 Bot 先下载再上传。
    return uploadMedia(env, fields[0], fields[1], mediaUrl, text, message);
  }
  return telegram(env, fields[0], {
    chat_id: message.chat.id,
    [fields[1]]: mediaUrl,
    caption: text,
    reply_parameters: { message_id: message.message_id },
  });
}

// 用已缓存 file_id 直接重发（不再下载，Telegram 服务端去重）。
async function sendFileById(kind, fileId, caption, message, env) {
  const fields = {
    photo: ["sendPhoto", "photo"],
    video: ["sendVideo", "video"],
    animation: ["sendAnimation", "animation"],
  }[kind];
  if (!fields) throw new Error("不支持的媒体类型");
  await telegram(env, fields[0], {
    chat_id: message.chat.id,
    [fields[1]]: fileId,
    caption: String(caption).slice(0, 1024),
    reply_parameters: { message_id: message.message_id },
  });
}

// 记住作品 → file_id 的映射，供后续复用（file_id 同 Bot 长期有效）。
async function rememberFileId(id, kind, title, sent, env) {
  const fileId = fileIdOf(sent, kind);
  if (!fileId) return;
  await cacheSet("fid", `d:${id}`, { file_id: fileId, kind, title }, 30 * 24 * 3600);
}

function fileIdOf(result, kind) {
  const field = { photo: "photo", video: "video", animation: "animation" }[kind];
  const value = result?.[field];
  if (!value) return null;
  if (kind === "photo") return Array.isArray(value) ? value.at(-1)?.file_id : value.file_id;
  return value.file_id || null;
}

// 下载媒体并作为 multipart 文件上传给 Telegram（带 DA 所需 Referer/UA，规避 Telegram 拉不动）。
async function uploadMedia(env, method, field, mediaUrl, caption, message) {
  const response = await guardedFetch(mediaUrl, {
    headers: { ...DA_HEADERS, Referer: DEVIANTART },
    signal: AbortSignal.timeout(120_000),
  }, "媒体下载");
  if (!response.ok) {
    response.body?.cancel();
    throw new Error(`媒体下载失败（HTTP ${response.status}）`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const extension = guessExtension(mediaUrl, field);
  const form = new FormData();
  form.set("chat_id", String(message.chat.id));
  form.set("caption", caption);
  form.set("reply_parameters", JSON.stringify({ message_id: message.message_id }));
  form.set(field, new Blob([bytes], { type: MIME_BY_EXTENSION[extension] || "application/octet-stream" }), `${field}.${extension}`);
  return telegramForm(env, method, form);
}

async function telegramForm(env, method, form) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const result = await response.json().catch(() => null);
    const retryAfter = Number(result?.parameters?.retry_after);
    if (response.status === 429 && retryAfter > 0 && attempt === 0) {
      await sleep(Math.min(retryAfter, 10) * 1000);
      continue;
    }
    if (!response.ok || !result?.ok) {
      throw new Error(result?.description || `Telegram 返回 HTTP ${response.status}`);
    }
    return result.result;
  }
  throw new Error("Telegram 暂时限流，请稍后重试");
}

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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const result = await response.json().catch(() => null);
    const retryAfter = Number(result?.parameters?.retry_after);
    if (response.status === 429 && retryAfter > 0 && attempt === 0) {
      await sleep(Math.min(retryAfter, 10) * 1000);
      continue;
    }
    if (!response.ok || !result?.ok) {
      throw new Error(result?.description || `Telegram 返回 HTTP ${response.status}`);
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
  if (response.status === 404) throw new Error("作品不存在、已删除或链接无效");
  if ([401, 403].includes(response.status)) throw new Error("作品需要登录、无权访问，或 DeviantArt 拒绝了请求");
  if (response.status === 429) throw new Error("DeviantArt 暂时限流，请稍后重试");
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
  const response = await fetch(url, {
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

function publicError(error) {
  const message = error instanceof Error ? error.message : "未知错误";
  if (/file is too big/i.test(message)) return "媒体超过 Telegram Bot 的文件大小限制";
  if (/failed to get http url content|wrong type of the web page content/i.test(message)) {
    return "Telegram 无法读取该媒体，作品可能受限或媒体格式不受支持";
  }
  if (/timeout|timed out|abort/i.test(message)) return "请求超时，请稍后重试";
  return message.slice(0, 300);
}
