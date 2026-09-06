// 统一的作品 caption / 按钮渲染。
//
// 设计：作品来源只通过「一个可点击的 caption 链接」呈现，全场景一致（单图/相册/
// 上传/重放/转发）。不再配 inline 键盘按钮——原因：①相册 sendMediaGroup 不支持
// inline 按钮，单图却支持，两者不一致；②按钮和 caption 链接指向同一 URL，并存是
// 冗余；③caption 链接随消息转发、不会丢失。可点文字是「在 DeviantArt 打开」里的
// DeviantArt，边界由 text_link entity 的 offset/length 精确控制，caption 里无裸 URL。

const CAPTION_LIMIT = 1024;

// 可点文字（text_link 覆盖的标签）。渲染与 entity 计算共用同一常量，保证边界一致。
export const SOURCE_LABEL = "DeviantArt";

// 把作品元数据 + 状态说明渲染成 Telegram caption 文本（不含裸 URL）。
// 返回 { text }。来源链接由 sourceLinkEntity 另行计算（multipart/JSON 通用）。
export function renderArtworkCaption(meta = {}, status = {}) {
  const lines = [];
  const title = (meta.title || "DeviantArt 作品").trim();
  lines.push(`🎨 ${title}`);
  if (meta.author) lines.push(`👤 ${meta.author}`);
  if (Number.isInteger(meta.mediaCount) && meta.mediaCount > 1) {
    lines.push(`🖼 ${meta.mediaCount} 个媒体`);
  }
  const notes = [];
  if (status.compressed) notes.push("部分图片超过 10MB，已压缩发送");
  if (status.blurredPreview) notes.push("部分成熟内容无法获取未打码画面，请在原站查看");
  if (status.previewOnly) notes.push("原图暂不可用，已使用高清展示图");
  if (status.docFallback) notes.push("图片过大，已作为文件发送");
  if (notes.length) lines.push(`⚠️ ${notes.join("；")}`);
  // 来源行：其中的「DeviantArt」会被 text_link entity 指向作品页（见 sourceLinkEntity）。
  const source = `\n\n🔗 在 ${SOURCE_LABEL} 打开`;
  const body = lines.join("\n").slice(0, CAPTION_LIMIT - source.length).replace(/[\uD800-\uDBFF]$/, "");
  return { text: body + source };
}

// 计算来源行「DeviantArt」文字的 text_link entity（offset 按 UTF-16 code unit，Telegram 规范）。
export function sourceLinkEntity(captionText, sourceUrl) {
  if (!sourceUrl) return null;
  const idx = captionText.lastIndexOf(SOURCE_LABEL);
  if (idx < 0) return null;
  return { type: "text_link", offset: idx, length: SOURCE_LABEL.length, url: sourceUrl };
}

// 单媒体的 inline 键盘（相册 sendMediaGroup 会静默丢弃，不要给相册用）。
// 仅非媒体消息（如 Telegraph 兜底入口）按需使用；普通作品发送统一用 caption 链接、不带按钮。
export function openButtonMarkup(sourceUrl, extraButtons = []) {
  if (!sourceUrl) return undefined;
  const row = [{ text: "在 DeviantArt 打开", url: sourceUrl }, ...extraButtons];
  return { inline_keyboard: [row] };
}

// 把 resolveWebMedia 的 media 对象 + 作品页 URL 归一化成发送函数使用的 cap：
// { title, author, mediaCount, sourceUrl }。下载/压缩阶段的状态由发送函数内部重渲染。
export function buildCapFromMedia(media, sourceUrl) {
  // media.title 形如 "标题 — 作者"，拆回标题/作者；拆不出就整串当标题。
  let title = media?.title || "DeviantArt 作品";
  let author;
  const m = String(title).match(/^(.*?)\s+—\s+([^—]+)$/);
  if (m) { title = m[1].trim(); author = m[2].trim(); }
  const mediaCount = 1 + (media?.extras?.length || 0) + (media?.skippedExtras || 0);
  return {
    title, author, sourceUrl,
    mediaCount: mediaCount > 1 ? mediaCount : undefined,
    status: { ...(media?.status || {}) },
    text: null,
  };
}

// 用 cap 直接产出 { text, entities }（渲染 + entity 一次完成）。
export function renderCap(cap, statusOverride = {}) {
  const status = { ...(cap.status || {}), ...statusOverride };
  const { text } = renderArtworkCaption(
    { title: cap.title, author: cap.author, mediaCount: cap.mediaCount },
    status,
  );
  const entity = sourceLinkEntity(text, cap.sourceUrl);
  return { text, entities: entity ? [entity] : [] };
}

// Telegram 官方 MessageEntity 的 offset/length 语义是 UTF-16 code unit，sourceLinkEntity
// 产出的正是标准 UTF-16 entity，JSON Bot API 请求应原样发送。
//
// 但线上实测发现 Bot API 的 multipart 上传端点（sendPhoto/sendMediaGroup 带 attach:// 文件，
// caption 走 form-data 字段）对实体偏移按 Unicode code point 校验：同一 caption（含 emoji/
// 中文），JSON 用 UTF-16 offset 成功，multipart 用同一 offset 报 "entity begins in a middle
// of a UTF-16 symbol"。这是实测出来的 transport 兼容行为（不是对协议的重新定义），所以只在
// multipart 路径做一次归一化：把 UTF-16 offset/length 换算成 code point。
// 若将来 Telegram 修复该差异，删掉此层即可，JSON 路径不受影响。
export function normalizeEntitiesForMultipart(text, entities) {
  if (!entities?.length) return entities || [];
  return entities.map((entity) => {
    if (entity.offset == null) return entity;
    const before = text.slice(0, entity.offset);
    const segment = entity.length != null ? text.slice(entity.offset, entity.offset + entity.length) : "";
    return {
      ...entity,
      offset: [...before].length,
      length: entity.length != null ? [...segment].length : entity.length,
    };
  });
}
// 兼容别名（v1.5.1 之前的导出名，避免外部/历史引用破裂）。
export const toMultipartEntities = normalizeEntitiesForMultipart;
