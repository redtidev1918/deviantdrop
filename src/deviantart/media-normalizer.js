// DeviantArt private DTO -> stable artwork model used outside the adapter.

export function extensionKind(value = "") {
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

export function shouldSkipMatureExtras(input = {}) {
  const { isMature, hasWebCookie, webStatus, raw } = input;
  const authorized = Object.hasOwn(input, "webStatus") ? webStatus === "valid" : Boolean(hasWebCookie);
  return isMature && !authorized && Array.isArray(raw) && raw.length > 0;
}

export function normalizeArtwork(deviation, { sourceUrl, webStatus = "missing" } = {}) {
  if (!deviation || typeof deviation !== "object") throw new Error("DeviantArt 没有返回作品数据");
  const mature = deviation.isMature === true || deviation.is_mature === true;
  const primaryDescriptor = deviation.media || {};
  const main = pickDescriptorMedia(primaryDescriptor);
  if (!main) throw new Error("DeviantArt 作品没有可用媒体");

  let media = [{
    kind: main.kind,
    url: main.url,
    fallbackUrl: displayMediaUrl(primaryDescriptor),
    mimeType: mimeForKind(main.kind),
    originalAvailable: !/blur_/.test(main.url),
  }];

  let skippedMedia = 0;
  const rawExtras = deviation.extended?.additionalMedia;
  if (deviation.isMultiMedia === true) {
    if (shouldSkipMatureExtras({ isMature: mature, webStatus, raw: rawExtras })) {
      skippedMedia = Array.isArray(rawExtras) ? rawExtras.length : 0;
    } else {
      for (const entry of Array.isArray(rawExtras) ? rawExtras : []) {
        const descriptor = entry && typeof entry === "object" ? entry.media : null;
        const picked = descriptor && pickDescriptorMedia(descriptor);
        if (!picked) continue;
        media.push({
          kind: picked.kind,
          url: picked.url,
          fallbackUrl: displayMediaUrl(descriptor),
          mimeType: mimeForKind(picked.kind),
          originalAvailable: !/blur_/.test(picked.url),
        });
      }
    }
  }

  if (mature && webStatus !== "valid") media[0].originalAvailable = false;

  return {
    id: String(deviation.deviationId || deviation.deviationid || deviation.id || ""),
    uuid: deviation.extended?.deviationUuid || null,
    title: deviation.title || "DeviantArt",
    author: deviation.author?.username || null,
    sourceUrl,
    mature,
    accessStatus: isMatureLoggedOut(deviation) ? "mature_loggedout" : "available",
    media,
    skippedMedia,
    webStatus,
  };
}

export function titleWithAuthor(artwork) {
  return artwork.author ? `${artwork.title} — ${artwork.author}` : artwork.title;
}

function mimeForKind(kind) {
  return { photo: "image/jpeg", video: "video/mp4", animation: "image/gif", document: "application/octet-stream" }[kind] || "application/octet-stream";
}
