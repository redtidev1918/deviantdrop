const TELEGRAM_API = "https://api.telegram.org";
const DEVIANTART = "https://www.deviantart.com/";
const USER_AGENT = "deviantdrop/1.0";
const MAX_LINKS = 5;
const DA_HEADERS = {
  "Accept-Encoding": "gzip, br",
  "User-Agent": USER_AGENT,
};
const encoder = new TextEncoder();

const REPO = "https://github.com/redtidev1918/deviantdrop";
const HELP_TEXT = `发送 DeviantArt 单作品链接或 fav.me 短链，我会回复其中的图片、视频或 GIF。单条消息最多处理 ${MAX_LINKS} 个链接；图片/视频的 caption 里带链接也可以。\n\n/start 开始 · /help 用法 · /about 项目与源码`;
const ABOUT_TEXT = `DeviantDrop：把 DeviantArt 作品「丢」进 Telegram 的 Bot。\n\n发送 DeviantArt 作品页或 fav.me 短链，即可收到图片、视频或 GIF；每条回复的媒体都会附带原作品页链接。\n\n开源项目（MIT）：${REPO}\n源码、部署与使用说明都在仓库里，欢迎 star、提 issue。`;
const HINT_TEXT = `没有找到可下载的 DeviantArt 链接。\n\n发送 DeviantArt 作品页或 fav.me 短链，即可收到图片、视频或 GIF。\n/help 查看用法，/about 查看项目与源码。`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ ok: true, service: "deviantdrop" });
    }
    if (["GET", "HEAD"].includes(request.method) && url.pathname === "/media") {
      return proxyMedia(request, env);
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
    const message = update.message;
    if (!message?.chat?.id) return new Response("OK");

    try {
      await handleMessage(message, env, url.origin);
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
    return new Response("OK");
  },
};

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

  // ponytail: 单次最多 5 个链接；高吞吐场景应接 Queue，而不是拖长 webhook 请求。
  const selected = links.slice(0, MAX_LINKS);
  const session = await createDeviantArtSession();
  for (let index = 0; index < selected.length; index += 1) {
    try {
      await sendDeviantArt(new URL(selected[index]), message, env, origin, session);
    } catch (error) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: `${selected.length > 1 ? `第 ${index + 1} 个链接` : ""}处理失败：${publicError(error)}`,
        reply_parameters: { message_id: message.message_id },
      });
    }
  }
  if (links.length > selected.length) {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `单条消息最多处理 ${MAX_LINKS} 个链接，其余 ${links.length - selected.length} 个未处理。`,
      reply_parameters: { message_id: message.message_id },
    });
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

async function createDeviantArtSession() {
  const home = await fetchDeviantArt(DEVIANTART, { headers: { Accept: "text/html", ...DA_HEADERS } });
  await throwForDeviantArtStatus(home);
  const html = await home.text();
  const csrf = html.match(/window\.__CSRF_TOKEN__ = '([^']+)'/)?.[1];
  if (!csrf) throw new Error("DeviantArt 页面结构可能已变化，无法读取 CSRF token");
  return { csrf, cookies: getCookies(home.headers) };
}

async function sendDeviantArt(url, message, env, origin, session) {
  const target = parseDeviantArtTarget(url);
  const endpoint = new URL("/_puppy/dadeviation/init", DEVIANTART);
  endpoint.searchParams.set("deviationid", target.id);
  if (target.username) endpoint.searchParams.set("username", target.username);
  endpoint.searchParams.set("include_session", "false");
  endpoint.searchParams.set("csrf_token", session.csrf);
  endpoint.searchParams.set("mature_content", "true");
  const data = await fetchDeviantArtJson(endpoint, {
    Accept: "application/json",
    Referer: url.href,
    ...DA_HEADERS,
    ...(session.cookies ? { Cookie: session.cookies } : {}),
  });
  const item = extractDeviantArtMedia(data.deviation);
  const mediaUrl = await createProxyUrl(origin, item.url, env.WEBHOOK_SECRET);
  await sendOne(item.kind, mediaUrl, `${item.title}\n${url.href}`, message, env);
}

async function sendOne(kind, mediaUrl, caption, message, env) {
  const fields = {
    photo: ["sendPhoto", "photo"],
    video: ["sendVideo", "video"],
    animation: ["sendAnimation", "animation"],
  }[kind];
  if (!fields) throw new Error("不支持的媒体类型");
  await telegram(env, fields[0], {
    chat_id: message.chat.id,
    [fields[1]]: mediaUrl,
    caption: String(caption).slice(0, 1024),
    reply_parameters: { message_id: message.message_id },
  });
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

export function extractDeviantArtMedia(deviation) {
  if (!deviation || typeof deviation !== "object") {
    throw new Error("DeviantArt 没有返回作品数据");
  }
  const media = deviation.media || {};
  const types = Array.isArray(media.types) ? media.types : [];
  const videos = types
    .filter((item) => item?.t === "video" && item.b)
    .sort((a, b) => videoRank(b.q) - videoRank(a.q));
  let url = videos[0]?.b;
  let kind = url ? "video" : null;

  if (!url) {
    const full = types.find((item) => item?.t === "fullview");
    url = full?.b ? appendToken(full.b, media.token) : buildMediaUrl(media, full?.c);
    kind = extensionKind(url);
  }
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
    return new Response("Upstream error", { status: 502 });
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
