// DeviantArt private DTO -> stable artwork model used outside the adapter.

function extensionKind(value = "") {
  let pathname;
  try {
    pathname = new URL(value).pathname.toLowerCase();
  } catch {
    pathname = String(value).split("?", 1)[0].toLowerCase();
  }
  if (pathname.endsWith(".gif")) return "animation";
  if (pathname.endsWith(".mp4") || pathname.endsWith(".m4v")) return "video";
  if (/\.(?:jpe?g|png|webp|avif)$/.test(pathname)) return "photo";
  return null;
}

export function appendToken(url, rawToken) {
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  return token ? `${url}${url.includes("?") ? "&" : "?"}token=${token}` : url;
}

function buildMediaUrl(media, template) {
  if (!media.baseUri) return null;
  const url = template
    ? `${media.baseUri}${String(template).replaceAll("<prettyName>", media.prettyName || "image")}`
    : media.baseUri;
  return appendToken(url, media.token);
}

function videoRank(value) {
  return { "1080p": 4, "720p": 3, "480p": 2, "360p": 1 }[value] || 0;
}

export function pickDescriptorMedia(descriptor = {}) {
  const types = Array.isArray(descriptor.types) ? descriptor.types : [];
  const videos = types
    .filter((item) => item?.t === "video" && item.b)
    .sort((a, b) => videoRank(b.q) - videoRank(a.q));
  let url = videos[0]?.b;
  if (!url && extensionKind(descriptor.baseUri || "")) url = appendToken(descriptor.baseUri, descriptor.token);
  if (!url) {
    const full = types.find((item) => item?.t === "fullview");
    if (full?.b) url = appendToken(full.b, descriptor.token);
    else if (full?.c) url = buildMediaUrl(descriptor, full.c);
  }
  if (!url) {
    const preview = types.find((item) => item?.t === "preview" && (item.c || item.b));
    if (preview?.b) url = appendToken(preview.b, descriptor.token);
    else if (preview?.c) url = buildMediaUrl(descriptor, preview.c);
  }
  const kind = (url && extensionKind(url)) || (videos.length ? "video" : null);
  return url ? { kind: kind || "photo", url } : null;
}

export function displayMediaUrl(descriptor = {}) {
  const types = Array.isArray(descriptor.types) ? descriptor.types : [];
  for (const name of ["preview", "414W", "375W", "400T", "350T", "300W"]) {
    const type = types.find((item) => item?.t === name);
    if (!type) continue;
    if (type.b) return appendToken(type.b, descriptor.token);
    if (type.c) return buildMediaUrl(descriptor, type.c);
  }
  return null;
}

export function isMatureLoggedOut(deviation = {}) {
  return deviation.isMature === true
    && (deviation.isBlocked === true || Array.isArray(deviation.blockReasons))
    && (deviation.blockReasons || []).includes("mature_loggedout");
}

// DeviantArt 对未授权的成熟内容会下发打码版本，URL 里带 blur_ 标记。
// 这是「响应事实」，比任何缓存的会话状态都可靠。
export function isBlurredUrl(value = "") {
  return /blur_/.test(String(value));
}

// 媒体 URL -> 发送类型（GIF 必须走 animation，不能混进 photo 相册）。
export function kindOfUrl(value) {
  if (/\.gif($|\?)/i.test(value)) return "animation";
  if (/\.(mp4|m4v)($|\?)/i.test(value)) return "video";
  return "photo";
}

// 附加页（additionalMedia）是否整体不可用：只看本次响应是否明确说「未登录」。
// 与 mature 主图可用性完全无关——主图由 OAuth 负责。
export function shouldSkipMatureExtras(input = {}) {
  const { isMature, expansionAuthorized = true, raw } = input;
  return isMature === true && expansionAuthorized === false && Array.isArray(raw) && raw.length > 0;
}

// 网页 DTO -> 稳定 artwork 模型。
// expansionAuthorized 是「本次响应是否授权了网页端扩展能力」，
// 不参与主图可用性判断：成熟主图由 OAuth 提供，Cookie 缺失只影响附加页。
export function normalizeArtwork(deviation, { sourceUrl, expansionAuthorized = true } = {}) {
  if (!deviation || typeof deviation !== "object") throw new Error("DeviantArt 没有返回作品数据");
  const mature = deviation.isMature === true || deviation.is_mature === true;
  const primaryDescriptor = deviation.media || {};
  const main = pickDescriptorMedia(primaryDescriptor);
  if (!main) throw new Error("DeviantArt 作品没有可用媒体");

  const media = [{
    kind: main.kind,
    url: main.url,
    fallbackUrl: displayMediaUrl(primaryDescriptor),
    mimeType: mimeForKind(main.kind),
    originalAvailable: !isBlurredUrl(main.url),
  }];

  let skippedMedia = 0;
  const rawExtras = deviation.extended?.additionalMedia;
  if (deviation.isMultiMedia === true) {
    if (shouldSkipMatureExtras({ isMature: mature, expansionAuthorized, raw: rawExtras })) {
      skippedMedia = Array.isArray(rawExtras) ? rawExtras.length : 0;
    } else {
      for (const entry of Array.isArray(rawExtras) ? rawExtras : []) {
        const descriptor = entry && typeof entry === "object" ? entry.media : null;
        const picked = descriptor && pickDescriptorMedia(descriptor);
        if (!picked) continue;
        // 逐条按响应判断：打码的那一页单独跳过，不影响其它页。
        if (mature && isBlurredUrl(picked.url)) {
          skippedMedia += 1;
          continue;
        }
        media.push({
          kind: picked.kind,
          url: picked.url,
          fallbackUrl: displayMediaUrl(descriptor),
          mimeType: mimeForKind(picked.kind),
          originalAvailable: !isBlurredUrl(picked.url),
        });
      }
    }
  }

  return {
    id: String(deviation.deviationId || deviation.deviationid || deviation.id || ""),
    uuid: deviation.extended?.deviationUuid || null,
    title: deviation.title || "DeviantArt",
    author: deviation.author?.username || null,
    sourceUrl,
    mature,
    expansionAuthorized,
    mainSource: "web",
    media,
    skippedMedia,
  };
}

export function titleWithAuthor(artwork) {
  return artwork.author ? `${artwork.title} — ${artwork.author}` : artwork.title;
}

export function mimeForKind(kind) {
  return { photo: "image/jpeg", video: "video/mp4", animation: "image/gif", document: "application/octet-stream" }[kind] || "application/octet-stream";
}
